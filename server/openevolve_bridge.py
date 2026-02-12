"""
OpenEvolve Bridge — integrates OpenEvolve library with Research Agent.

Maps OpenEvolve's evolutionary code optimization onto the Research Agent's
run/sweep infrastructure:
  - Each evolution generation → a sweep
  - Each candidate program evaluation → a run within that sweep
  - Program database → persisted to .agents/openevolve/

Design decisions:
  - OpenEvolve runs as a library (not subprocess) for simplicity
  - Evaluator = Research Agent runs (evaluator writes score to stdout)
  - Independent LLM calls (OpenEvolve manages its own API keys)
"""

import asyncio
import copy
import json
import logging
import os
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional

from pydantic import BaseModel

logger = logging.getLogger("openevolve_bridge")


# =============================================================================
# Pydantic Models (API-facing)
# =============================================================================

class EvolutionConfig(BaseModel):
    """Configuration for an OpenEvolve evolution session."""
    # Required
    initial_program: str            # Source code or path to initial program
    evaluator_command: str          # Shell command to evaluate a candidate (receives program path as arg)
    goal: str                       # Human-readable goal description

    # OpenEvolve settings
    iterations: int = 50            # Number of evolution generations
    population_size: int = 20       # Size of the program population
    num_islands: int = 2            # MAP-Elites island count

    # LLM settings (independent from Research Agent's OpenCode)
    llm_model: str = "gemini-2.5-flash"
    llm_api_base: Optional[str] = None  # Defaults to Gemini endpoint
    temperature: float = 0.7

    # Research Agent integration
    workdir: Optional[str] = None   # Working directory for evaluations
    sweep_name: Optional[str] = None  # Custom name for the evolution sweep

    # Evaluation settings
    timeout_seconds: int = 300      # Max time per candidate evaluation
    score_parse_mode: str = "last_float"  # How to extract score: "last_float", "json", "exit_code"


class EvolutionCandidate(BaseModel):
    """A single candidate program in the evolution."""
    id: str
    generation: int
    code: str
    parent_id: Optional[str] = None
    score: Optional[float] = None
    run_id: Optional[str] = None    # Research Agent run ID
    status: str = "pending"         # pending, evaluating, scored, failed
    metadata: dict = {}


class EvolutionStatus(BaseModel):
    """Current status of an evolution session."""
    session_id: str
    status: str                     # idle, running, paused, complete, failed
    generation: int
    total_generations: int
    population_size: int
    best_score: Optional[float] = None
    best_candidate_id: Optional[str] = None
    candidates_evaluated: int = 0
    candidates_total: int = 0
    sweep_id: Optional[str] = None
    started_at: Optional[float] = None
    elapsed_seconds: float = 0
    config: Optional[EvolutionConfig] = None


class StartEvolutionRequest(BaseModel):
    """Request to start an evolution session."""
    config: EvolutionConfig


class EvolutionEvent(BaseModel):
    """An event from the evolution process, for the wild loop event queue."""
    type: str                       # "generation_complete", "new_best", "evaluation_done", "evolution_complete"
    generation: int
    message: str
    candidate_id: Optional[str] = None
    score: Optional[float] = None
    best_score: Optional[float] = None


# =============================================================================
# Evolution Session State
# =============================================================================

class EvolutionPhase(str, Enum):
    IDLE = "idle"
    INITIALIZING = "initializing"
    GENERATING = "generating"       # LLM creating candidates
    EVALUATING = "evaluating"       # Candidates being evaluated as runs
    SELECTING = "selecting"         # Selecting best candidates for next gen
    COMPLETE = "complete"
    FAILED = "failed"
    PAUSED = "paused"


@dataclass
class EvolutionSession:
    """In-memory state for an active evolution session."""
    session_id: str
    config: EvolutionConfig
    phase: EvolutionPhase = EvolutionPhase.IDLE
    generation: int = 0
    candidates: Dict[str, dict] = field(default_factory=dict)  # id → candidate dict
    best_score: Optional[float] = None
    best_candidate_id: Optional[str] = None
    candidates_evaluated: int = 0
    sweep_id: Optional[str] = None
    started_at: Optional[float] = None
    task: Optional[asyncio.Task] = None  # Background task handle
    _stop_requested: bool = False

    def request_stop(self):
        self._stop_requested = True

    @property
    def stop_requested(self) -> bool:
        return self._stop_requested


# Module-level state
_active_session: Optional[EvolutionSession] = None


# =============================================================================
# Core Bridge Logic
# =============================================================================

def get_session() -> Optional[EvolutionSession]:
    """Get the active evolution session, if any."""
    return _active_session


def get_status() -> EvolutionStatus:
    """Get current evolution status."""
    session = _active_session
    if session is None:
        return EvolutionStatus(
            session_id="",
            status="idle",
            generation=0,
            total_generations=0,
            population_size=0,
        )

    elapsed = time.time() - session.started_at if session.started_at else 0
    return EvolutionStatus(
        session_id=session.session_id,
        status=session.phase.value,
        generation=session.generation,
        total_generations=session.config.iterations,
        population_size=session.config.population_size,
        best_score=session.best_score,
        best_candidate_id=session.best_candidate_id,
        candidates_evaluated=session.candidates_evaluated,
        candidates_total=len(session.candidates),
        sweep_id=session.sweep_id,
        started_at=session.started_at,
        elapsed_seconds=elapsed,
        config=session.config,
    )


async def start_evolution(
    config: EvolutionConfig,
    create_run_fn: Callable,
    start_run_fn: Callable,
    get_run_fn: Callable,
    get_run_logs_fn: Callable,
    create_sweep_fn: Callable,
    event_callback: Optional[Callable] = None,
) -> EvolutionStatus:
    """Start a new evolution session.

    The callback functions bridge OpenEvolve into the Research Agent's
    run/sweep system without creating circular imports.

    Args:
        config: Evolution configuration
        create_run_fn: async fn(name, command, workdir, sweep_id, auto_start) → run_dict
        start_run_fn: async fn(run_id) → None
        get_run_fn: fn(run_id) → run_dict or None
        get_run_logs_fn: async fn(run_id) → str
        create_sweep_fn: async fn(name, base_command, workdir, parameters, goal, status) → sweep_dict
        event_callback: fn(EvolutionEvent) → None, called on significant events
    """
    global _active_session

    if _active_session is not None and _active_session.phase in (
        EvolutionPhase.GENERATING, EvolutionPhase.EVALUATING, EvolutionPhase.SELECTING
    ):
        raise ValueError("An evolution session is already running. Stop it first.")

    session_id = uuid.uuid4().hex[:12]
    session = EvolutionSession(
        session_id=session_id,
        config=config,
        phase=EvolutionPhase.INITIALIZING,
        started_at=time.time(),
    )
    _active_session = session

    # Create a sweep to group all evolution runs
    sweep_name = config.sweep_name or f"Evolution: {config.goal[:50]}"
    try:
        sweep = await create_sweep_fn(
            name=sweep_name,
            base_command=config.evaluator_command,
            workdir=config.workdir,
            parameters={},
            goal=config.goal,
            status="draft",
        )
        session.sweep_id = sweep["id"]
    except Exception as e:
        logger.error(f"Failed to create evolution sweep: {e}")
        session.phase = EvolutionPhase.FAILED
        raise

    # Start the evolution loop as a background task
    session.task = asyncio.create_task(
        _evolution_loop(
            session=session,
            create_run_fn=create_run_fn,
            start_run_fn=start_run_fn,
            get_run_fn=get_run_fn,
            get_run_logs_fn=get_run_logs_fn,
            event_callback=event_callback,
        )
    )

    logger.info(f"Started evolution session {session_id} with sweep {session.sweep_id}")
    return get_status()


async def stop_evolution() -> EvolutionStatus:
    """Stop the active evolution session."""
    global _active_session
    if _active_session is None:
        return get_status()

    _active_session.request_stop()

    if _active_session.task and not _active_session.task.done():
        _active_session.task.cancel()
        try:
            await _active_session.task
        except (asyncio.CancelledError, Exception):
            pass

    _active_session.phase = EvolutionPhase.COMPLETE
    logger.info(f"Stopped evolution session {_active_session.session_id}")
    return get_status()


def get_candidates(generation: Optional[int] = None) -> List[dict]:
    """Get candidates, optionally filtered by generation."""
    if _active_session is None:
        return []
    candidates = list(_active_session.candidates.values())
    if generation is not None:
        candidates = [c for c in candidates if c.get("generation") == generation]
    return sorted(candidates, key=lambda c: (c.get("generation", 0), c.get("score") or float("inf")))


def get_best_program() -> Optional[dict]:
    """Get the best-scoring candidate program."""
    if _active_session is None or _active_session.best_candidate_id is None:
        return None
    return _active_session.candidates.get(_active_session.best_candidate_id)


# =============================================================================
# Evolution Loop (runs as asyncio.Task)
# =============================================================================

async def _evolution_loop(
    session: EvolutionSession,
    create_run_fn: Callable,
    start_run_fn: Callable,
    get_run_fn: Callable,
    get_run_logs_fn: Callable,
    event_callback: Optional[Callable] = None,
):
    """Main evolution loop. Runs population-based evolutionary optimization.

    Simplified MVP loop (not full MAP-Elites):
    1. Start with initial program
    2. For each generation:
       a. Generate N mutated candidates via LLM
       b. Evaluate each candidate as a Research Agent run
       c. Select top-k candidates for next generation
    3. Report best result
    """
    config = session.config
    workdir = config.workdir or os.getcwd()

    # Ensure evolution output directory exists
    evo_dir = os.path.join(workdir, ".agents", "openevolve", session.session_id)
    os.makedirs(evo_dir, exist_ok=True)

    try:
        # Initialize population with the initial program
        initial_candidate = {
            "id": f"gen0-seed",
            "generation": 0,
            "code": config.initial_program,
            "parent_id": None,
            "score": None,
            "run_id": None,
            "status": "pending",
            "metadata": {"is_seed": True},
        }
        session.candidates[initial_candidate["id"]] = initial_candidate

        # Evaluate the seed program
        session.phase = EvolutionPhase.EVALUATING
        await _evaluate_candidate(
            session, initial_candidate, create_run_fn, start_run_fn,
            get_run_fn, get_run_logs_fn, config, evo_dir,
        )

        # Main evolution loop
        population = [initial_candidate]  # Current parent pool

        for gen in range(1, config.iterations + 1):
            if session.stop_requested:
                break

            session.generation = gen
            session.phase = EvolutionPhase.GENERATING
            logger.info(f"[Evolution {session.session_id}] Generation {gen}/{config.iterations}")

            # Generate mutated candidates from the current population
            # For MVP: use simple prompt-based mutation via OpenEvolve library
            new_candidates = await _generate_candidates(
                session, population, gen, config, evo_dir,
            )

            if not new_candidates:
                logger.warning(f"[Evolution {session.session_id}] No candidates generated in gen {gen}")
                continue

            # Evaluate all new candidates
            session.phase = EvolutionPhase.EVALUATING
            eval_tasks = []
            for candidate in new_candidates:
                session.candidates[candidate["id"]] = candidate
                eval_tasks.append(
                    _evaluate_candidate(
                        session, candidate, create_run_fn, start_run_fn,
                        get_run_fn, get_run_logs_fn, config, evo_dir,
                    )
                )

            # Run evaluations (could be parallel via sweep, but sequential for MVP)
            for task in eval_tasks:
                if session.stop_requested:
                    break
                await task

            # Selection: keep top candidates for next generation
            session.phase = EvolutionPhase.SELECTING
            scored = [c for c in session.candidates.values()
                      if c.get("score") is not None and c["generation"] <= gen]
            scored.sort(key=lambda c: c["score"], reverse=True)  # Higher = better

            # Update best
            if scored and (session.best_score is None or scored[0]["score"] > session.best_score):
                session.best_score = scored[0]["score"]
                session.best_candidate_id = scored[0]["id"]

                if event_callback:
                    event_callback(EvolutionEvent(
                        type="new_best",
                        generation=gen,
                        message=f"New best score: {session.best_score:.4f}",
                        candidate_id=session.best_candidate_id,
                        score=session.best_score,
                        best_score=session.best_score,
                    ))

            # Use top-k as parents for next generation
            k = max(2, config.population_size // 4)
            population = scored[:k] if scored else [initial_candidate]

            if event_callback:
                event_callback(EvolutionEvent(
                    type="generation_complete",
                    generation=gen,
                    message=f"Generation {gen} complete. Best: {session.best_score:.4f}" if session.best_score else f"Generation {gen} complete.",
                    best_score=session.best_score,
                ))

            # Save checkpoint
            _save_checkpoint(session, evo_dir)

        # Evolution complete
        session.phase = EvolutionPhase.COMPLETE
        logger.info(
            f"[Evolution {session.session_id}] Complete. "
            f"Best score: {session.best_score}, "
            f"Candidate: {session.best_candidate_id}"
        )

        if event_callback:
            event_callback(EvolutionEvent(
                type="evolution_complete",
                generation=session.generation,
                message=f"Evolution complete! Best score: {session.best_score:.4f}" if session.best_score else "Evolution complete.",
                best_score=session.best_score,
                candidate_id=session.best_candidate_id,
            ))

    except asyncio.CancelledError:
        session.phase = EvolutionPhase.PAUSED
        logger.info(f"[Evolution {session.session_id}] Cancelled")
    except Exception as e:
        session.phase = EvolutionPhase.FAILED
        logger.error(f"[Evolution {session.session_id}] Failed: {e}", exc_info=True)
        raise


async def _generate_candidates(
    session: EvolutionSession,
    parents: List[dict],
    generation: int,
    config: EvolutionConfig,
    evo_dir: str,
) -> List[dict]:
    """Generate mutated candidate programs using the LLM.

    For MVP, this uses a simple prompt asking the LLM to mutate the best programs.
    Full OpenEvolve integration would use the library's prompt sampler + MAP-Elites.
    """
    candidates = []

    try:
        # Try to use OpenEvolve library if available
        from openevolve import evolve_function  # noqa: F401
        logger.info("[Evolution] OpenEvolve library available — using library API")
        # TODO: Wire up full OpenEvolve library integration here
        # For now, fall through to simple LLM mutation
    except ImportError:
        logger.info("[Evolution] OpenEvolve not installed — using simple LLM mutation")

    # Simple LLM mutation fallback
    # Use litellm or direct API call for LLM-based mutation
    try:
        import litellm
        has_litellm = True
    except ImportError:
        has_litellm = False

    for i in range(min(config.population_size, len(parents) * 3)):
        parent = parents[i % len(parents)]
        candidate_id = f"gen{generation}-{i}"

        if has_litellm:
            try:
                mutated_code = await _llm_mutate(parent["code"], config, generation, i)
            except Exception as e:
                logger.warning(f"[Evolution] LLM mutation failed for {candidate_id}: {e}")
                mutated_code = parent["code"]  # Fallback: clone parent
        else:
            # Without litellm, just clone the parent (placeholder for actual mutation)
            mutated_code = parent["code"]
            logger.warning("[Evolution] No LLM library available for mutation; cloning parent")

        candidate = {
            "id": candidate_id,
            "generation": generation,
            "code": mutated_code,
            "parent_id": parent["id"],
            "score": None,
            "run_id": None,
            "status": "pending",
            "metadata": {"parent_score": parent.get("score")},
        }
        candidates.append(candidate)

        # Save candidate code to disk
        code_path = os.path.join(evo_dir, f"{candidate_id}.py")
        with open(code_path, "w") as f:
            f.write(mutated_code)

    return candidates


async def _llm_mutate(
    parent_code: str,
    config: EvolutionConfig,
    generation: int,
    candidate_index: int,
) -> str:
    """Use an LLM to mutate a parent program."""
    import litellm

    prompt = f"""You are an evolutionary code optimizer. Your task is to improve the following program.

## Goal
{config.goal}

## Current Program (Generation {generation - 1})
```python
{parent_code}
```

## Instructions
- Make a targeted improvement to this program
- The program will be evaluated by: `{config.evaluator_command}`
- Higher scores are better
- Keep the program functional — it must still run correctly
- Be creative but not reckless — small targeted changes tend to work best
- Variation {candidate_index}: try a {'different strategy' if candidate_index > 0 else 'focused optimization'}

## Output
Return ONLY the improved Python code, no explanations. Start directly with the code.
"""

    api_base = config.llm_api_base or "https://generativelanguage.googleapis.com/v1beta/openai/"
    response = await litellm.acompletion(
        model=config.llm_model,
        messages=[{"role": "user", "content": prompt}],
        temperature=config.temperature + (candidate_index * 0.05),  # Diversity via temperature
        api_base=api_base,
    )

    code = response.choices[0].message.content.strip()
    # Strip markdown code fences if present
    if code.startswith("```"):
        lines = code.split("\n")
        # Remove first and last lines if they are fences
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        code = "\n".join(lines)

    return code


async def _evaluate_candidate(
    session: EvolutionSession,
    candidate: dict,
    create_run_fn: Callable,
    start_run_fn: Callable,
    get_run_fn: Callable,
    get_run_logs_fn: Callable,
    config: EvolutionConfig,
    evo_dir: str,
):
    """Evaluate a candidate program by creating and running a Research Agent run."""
    candidate["status"] = "evaluating"

    # Write candidate code to a temp file
    code_path = os.path.join(evo_dir, f"{candidate['id']}.py")
    with open(code_path, "w") as f:
        f.write(candidate["code"])

    # Build evaluation command
    eval_command = f"{config.evaluator_command} {code_path}"

    try:
        # Create a run in the Research Agent
        run = await create_run_fn(
            name=f"evo-{candidate['id']}",
            command=eval_command,
            workdir=config.workdir,
            sweep_id=session.sweep_id,
            auto_start=True,
        )
        candidate["run_id"] = run["id"]

        # Wait for run to complete (poll)
        score = await _wait_for_run_and_score(
            run["id"], get_run_fn, get_run_logs_fn, config, timeout=config.timeout_seconds,
        )

        candidate["score"] = score
        candidate["status"] = "scored"
        session.candidates_evaluated += 1
        logger.info(f"[Evolution] Candidate {candidate['id']} scored: {score}")

    except Exception as e:
        candidate["status"] = "failed"
        candidate["metadata"]["error"] = str(e)
        logger.warning(f"[Evolution] Candidate {candidate['id']} evaluation failed: {e}")


async def _wait_for_run_and_score(
    run_id: str,
    get_run_fn: Callable,
    get_run_logs_fn: Callable,
    config: EvolutionConfig,
    timeout: int = 300,
) -> Optional[float]:
    """Poll until a run completes, then parse its score from logs."""
    start = time.time()

    while time.time() - start < timeout:
        run = get_run_fn(run_id)
        if run is None:
            raise ValueError(f"Run {run_id} not found")

        status = run.get("status", "")
        if status in ("finished", "failed", "stopped"):
            break

        await asyncio.sleep(3)  # Poll every 3 seconds
    else:
        raise TimeoutError(f"Run {run_id} timed out after {timeout}s")

    if run.get("status") == "failed":
        return None  # Failed runs get no score

    # Parse score from logs
    try:
        logs = await get_run_logs_fn(run_id)
        score = _parse_score(logs, config.score_parse_mode)
        return score
    except Exception as e:
        logger.warning(f"[Evolution] Failed to parse score for run {run_id}: {e}")
        return None


def _parse_score(logs: str, mode: str = "last_float") -> Optional[float]:
    """Parse a numeric score from run logs.

    Modes:
    - last_float: Find the last floating-point number in the output
    - json: Parse a JSON object and look for "score" key
    - exit_code: Score is 1.0 for success, 0.0 for failure (handled elsewhere)
    """
    if not logs:
        return None

    if mode == "json":
        # Try to parse last JSON object in logs
        import re
        json_matches = re.findall(r'\{[^{}]*\}', logs)
        for match in reversed(json_matches):
            try:
                obj = json.loads(match)
                if "score" in obj:
                    return float(obj["score"])
            except (json.JSONDecodeError, ValueError, TypeError):
                continue
        return None

    elif mode == "last_float":
        # Find the last number in the output
        import re
        numbers = re.findall(r'[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?', logs)
        if numbers:
            try:
                return float(numbers[-1])
            except ValueError:
                return None
        return None

    elif mode == "exit_code":
        return 1.0  # Success (failures handled upstream)

    return None


def _save_checkpoint(session: EvolutionSession, evo_dir: str):
    """Save evolution state to disk."""
    checkpoint = {
        "session_id": session.session_id,
        "generation": session.generation,
        "best_score": session.best_score,
        "best_candidate_id": session.best_candidate_id,
        "candidates_evaluated": session.candidates_evaluated,
        "candidates": session.candidates,
        "config": session.config.model_dump(),
    }
    path = os.path.join(evo_dir, "checkpoint.json")
    with open(path, "w") as f:
        json.dump(checkpoint, f, indent=2, default=str)


# =============================================================================
# Serialization helpers (for save/load settings)
# =============================================================================

def get_serializable_state() -> dict:
    """Return state dict suitable for JSON serialization."""
    status = get_status()
    return {"openevolve": status.model_dump()}


def load_from_saved(data: dict):
    """Restore state from a previously saved dict (no-op for now — sessions are ephemeral)."""
    # Evolution sessions are not persisted across server restarts in MVP
    pass
