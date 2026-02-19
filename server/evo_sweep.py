"""Evolutionary Sweep Controller — population-based code optimization.

Design:
  - Runs as an inner loop within the Wild V2 main loop
  - Creates a tracking sweep via the server API
  - Generates candidate configs, launches runs, collects fitness
  - Uses LLM to mutate top performers → next generation
  - Returns best result for the outer loop to act on

This module is self-contained and communicates with the server via HTTP
(the same API the agent uses).
"""

import json
import logging
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

import httpx

logger = logging.getLogger("evo_sweep")


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------

@dataclass
class EvoSweepConfig:
    """Configuration for an evolutionary sweep."""

    # What to optimise
    target_script: str              # path to the script to run
    fitness_metric: str             # metric name to optimise (e.g. "accuracy", "loss")
    fitness_direction: str = "max"  # "max" or "min"

    # Search space (JSON-serialisable dict of param → range)
    search_space: Dict[str, Any] = field(default_factory=dict)

    # Evolution parameters
    population_size: int = 4
    generations: int = 3
    top_k: int = 2                 # survivors per generation
    mutation_strength: float = 0.3  # hint for the LLM mutator

    # Execution
    sweep_name: str = ""
    timeout_per_run: int = 600     # seconds
    workdir: str = "."


@dataclass
class Candidate:
    """A single candidate in the population."""

    id: str
    config: Dict[str, Any]
    run_id: Optional[str] = None
    fitness: Optional[float] = None
    generation: int = 0
    parent_id: Optional[str] = None


@dataclass
class EvoSweepResult:
    """Result of an evolutionary sweep."""

    best_config: Dict[str, Any]
    best_fitness: Optional[float]
    fitness_history: List[Dict[str, Any]]  # per-generation stats
    all_candidates: List[Dict[str, Any]]
    sweep_id: str
    generations_completed: int
    status: str = "completed"  # completed | failed | cancelled


# ---------------------------------------------------------------------------
# Signal parser — extracts <evo_sweep>...</evo_sweep> from agent output
# ---------------------------------------------------------------------------

def parse_evo_sweep(text: str) -> Optional[EvoSweepConfig]:
    """Parse <evo_sweep>...</evo_sweep> JSON config from agent output.

    Expected format:
        <evo_sweep>
        {
            "target_script": "train.py",
            "fitness_metric": "accuracy",
            "fitness_direction": "max",
            "search_space": {
                "learning_rate": [0.001, 0.01, 0.1],
                "batch_size": [16, 32, 64]
            },
            "population_size": 4,
            "generations": 3
        }
        </evo_sweep>

    Returns EvoSweepConfig if found, None otherwise.
    """
    m = re.search(r"<evo_sweep>([\s\S]*?)</evo_sweep>", text)
    if not m:
        return None

    raw = m.group(1).strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("[evo-sweep] Failed to parse evo_sweep JSON: %s", raw[:200])
        return None

    if "target_script" not in data or "fitness_metric" not in data:
        logger.warning("[evo-sweep] Missing required fields in evo_sweep config")
        return None

    return EvoSweepConfig(
        target_script=data["target_script"],
        fitness_metric=data["fitness_metric"],
        fitness_direction=data.get("fitness_direction", "max"),
        search_space=data.get("search_space", {}),
        population_size=data.get("population_size", 4),
        generations=data.get("generations", 3),
        top_k=data.get("top_k", 2),
        mutation_strength=data.get("mutation_strength", 0.3),
        sweep_name=data.get("sweep_name", ""),
        timeout_per_run=data.get("timeout_per_run", 600),
        workdir=data.get("workdir", "."),
    )


# ---------------------------------------------------------------------------
# Controller
# ---------------------------------------------------------------------------

class EvoSweepController:
    """Runs a population-based evolutionary sweep using the server's sweep/run API."""

    def __init__(
        self,
        server_url: str,
        auth_token: str = "",
        llm_mutate_fn: Optional[Callable] = None,
    ):
        self._server_url = server_url
        self._auth_token = auth_token
        self._llm_mutate_fn = llm_mutate_fn

        self._sweep_id: Optional[str] = None
        self._cancelled = False

    @property
    def sweep_id(self) -> Optional[str]:
        return self._sweep_id

    def cancel(self):
        """Cancel an in-progress sweep."""
        self._cancelled = True

    async def run(self, config: EvoSweepConfig) -> EvoSweepResult:
        """Execute the evolutionary sweep.

        Steps:
          1. Create a tracking sweep
          2. Generate initial population
          3. For each generation:
             a. Launch runs for each candidate
             b. Wait for completion, collect fitness
             c. Select top performers
             d. Mutate winners → next generation
          4. Return best result
        """
        self._cancelled = False
        all_candidates: List[Candidate] = []
        fitness_history: List[Dict[str, Any]] = []

        sweep_name = config.sweep_name or f"evo-sweep-{uuid.uuid4().hex[:6]}"

        # 1. Create tracking sweep
        self._sweep_id = await self._create_sweep(sweep_name, config)
        logger.info("[evo-sweep] Created sweep %s: %s", self._sweep_id, sweep_name)

        # 2. Generate initial population
        population = self._generate_initial_population(config)
        all_candidates.extend(population)
        logger.info("[evo-sweep] Initial population: %d candidates", len(population))

        # 3. Evolution loop
        for gen in range(config.generations):
            if self._cancelled:
                logger.info("[evo-sweep] Cancelled at generation %d", gen)
                break

            logger.info("[evo-sweep] === Generation %d/%d ===", gen + 1, config.generations)

            # 3a. Launch runs
            for candidate in population:
                if self._cancelled:
                    break
                run_id = await self._launch_run(config, candidate)
                candidate.run_id = run_id
                logger.info("[evo-sweep] Launched run %s for candidate %s", run_id, candidate.id)

            # 3b. Wait for completion and collect fitness
            for candidate in population:
                if self._cancelled:
                    break
                if candidate.run_id:
                    fitness = await self._wait_and_collect_fitness(
                        candidate.run_id, config.fitness_metric, config.timeout_per_run
                    )
                    candidate.fitness = fitness
                    logger.info(
                        "[evo-sweep] Candidate %s fitness=%s",
                        candidate.id,
                        fitness if fitness is not None else "N/A",
                    )

            # 3c. Select top performers
            scored = [c for c in population if c.fitness is not None]
            reverse = config.fitness_direction == "max"
            scored.sort(key=lambda c: c.fitness or 0, reverse=reverse)
            survivors = scored[: config.top_k]

            # Record generation stats
            gen_stats = {
                "generation": gen + 1,
                "population_size": len(population),
                "scored": len(scored),
                "best_fitness": survivors[0].fitness if survivors else None,
                "mean_fitness": (
                    sum(c.fitness for c in scored) / len(scored) if scored else None
                ),
            }
            fitness_history.append(gen_stats)
            logger.info("[evo-sweep] Generation %d: %s", gen + 1, gen_stats)

            # 3d. Mutate survivors → next generation (unless last gen)
            if gen < config.generations - 1 and survivors and not self._cancelled:
                next_pop = await self._mutate_population(
                    survivors, config, gen + 1
                )
                all_candidates.extend(next_pop)
                population = next_pop
                logger.info("[evo-sweep] Mutated %d candidates for generation %d", len(next_pop), gen + 2)
            else:
                # On the last generation, keep survivors as final
                population = survivors

        # 4. Find overall best
        all_scored = [c for c in all_candidates if c.fitness is not None]
        reverse = config.fitness_direction == "max"
        all_scored.sort(key=lambda c: c.fitness or 0, reverse=reverse)

        best = all_scored[0] if all_scored else None
        status = "cancelled" if self._cancelled else "completed"

        result = EvoSweepResult(
            best_config=best.config if best else {},
            best_fitness=best.fitness if best else None,
            fitness_history=fitness_history,
            all_candidates=[
                {
                    "id": c.id,
                    "config": c.config,
                    "fitness": c.fitness,
                    "generation": c.generation,
                    "run_id": c.run_id,
                    "parent_id": c.parent_id,
                }
                for c in all_candidates
            ],
            sweep_id=self._sweep_id or "",
            generations_completed=len(fitness_history),
            status=status,
        )

        logger.info(
            "[evo-sweep] %s — best fitness: %s, total candidates: %d",
            status, result.best_fitness, len(all_candidates),
        )
        return result

    # -- Internal helpers --

    def _get_headers(self) -> dict:
        """Build request headers with auth."""
        headers = {"Content-Type": "application/json"}
        if self._auth_token:
            headers["X-Auth-Token"] = self._auth_token
        return headers

    async def _create_sweep(self, name: str, config: EvoSweepConfig) -> str:
        """Create a tracking sweep via the server API."""
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{self._server_url}/sweeps/wild",
                json={
                    "name": name,
                    "goal": f"Evolutionary sweep: optimise {config.fitness_metric} for {config.target_script}",
                },
                headers=self._get_headers(),
            )
            resp.raise_for_status()
            return resp.json().get("id", resp.json().get("sweep_id", ""))

    async def _launch_run(self, config: EvoSweepConfig, candidate: Candidate) -> Optional[str]:
        """Launch a single run for a candidate."""
        # Build command with config params as env vars or CLI args
        config_args = " ".join(
            f"--{k}={v}" for k, v in candidate.config.items()
        )
        command = f"cd {config.workdir} && python {config.target_script} {config_args}"

        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{self._server_url}/runs",
                json={
                    "name": f"evo-{candidate.id}",
                    "command": command,
                    "sweep_id": self._sweep_id,
                    "auto_start": True,
                },
                headers=self._get_headers(),
            )
            resp.raise_for_status()
            data = resp.json()
            return data.get("id") or data.get("run_id")

    async def _wait_and_collect_fitness(
        self, run_id: str, metric: str, timeout: int
    ) -> Optional[float]:
        """Poll run status until complete, then extract the fitness metric."""
        deadline = time.time() + timeout
        async with httpx.AsyncClient() as client:
            while time.time() < deadline:
                if self._cancelled:
                    return None
                try:
                    resp = await client.get(
                        f"{self._server_url}/runs/{run_id}",
                        headers=self._get_headers(),
                    )
                    resp.raise_for_status()
                    run = resp.json()
                    status = run.get("status", "")
                    if status in ("finished", "failed", "stopped"):
                        break
                except Exception as err:
                    logger.warning("[evo-sweep] Poll error for run %s: %s", run_id, err)
                import asyncio
                await asyncio.sleep(5)
            else:
                logger.warning("[evo-sweep] Run %s timed out after %ds", run_id, timeout)
                return None

        # Extract fitness from run metrics
        try:
            resp = await client.get(
                f"{self._server_url}/runs/{run_id}/metrics",
                headers=self._get_headers(),
            )
            if resp.status_code == 200:
                metrics = resp.json()
                series = metrics.get("metricSeries", {})
                if metric in series:
                    values = series[metric]
                    if values:
                        # Return the last value
                        return float(values[-1].get("value", values[-1]) if isinstance(values[-1], dict) else values[-1])
        except Exception as err:
            logger.warning("[evo-sweep] Failed to get metrics for run %s: %s", run_id, err)

        return None

    def _generate_initial_population(self, config: EvoSweepConfig) -> List[Candidate]:
        """Generate initial population from the search space."""
        import random

        candidates = []
        for i in range(config.population_size):
            params = {}
            for param, values in config.search_space.items():
                if isinstance(values, list):
                    params[param] = random.choice(values)
                elif isinstance(values, dict):
                    low = values.get("low", 0)
                    high = values.get("high", 1)
                    if isinstance(low, float) or isinstance(high, float):
                        params[param] = round(random.uniform(low, high), 6)
                    else:
                        params[param] = random.randint(int(low), int(high))
                else:
                    params[param] = values  # fixed value

            cid = f"gen0-{i}-{uuid.uuid4().hex[:4]}"
            candidates.append(Candidate(
                id=cid,
                config=params,
                generation=0,
            ))

        return candidates

    async def _mutate_population(
        self,
        survivors: List[Candidate],
        config: EvoSweepConfig,
        next_generation: int,
    ) -> List[Candidate]:
        """Mutate survivors to create the next generation.

        If an LLM mutate function is provided, use it.
        Otherwise, fall back to simple random perturbation.
        """
        if self._llm_mutate_fn:
            return await self._llm_mutate(survivors, config, next_generation)

        return self._random_mutate(survivors, config, next_generation)

    def _random_mutate(
        self,
        survivors: List[Candidate],
        config: EvoSweepConfig,
        next_generation: int,
    ) -> List[Candidate]:
        """Simple random perturbation of survivor configs."""
        import random

        next_pop = []
        while len(next_pop) < config.population_size:
            parent = random.choice(survivors)
            mutated = dict(parent.config)

            for param, values in config.search_space.items():
                if random.random() < config.mutation_strength:
                    if isinstance(values, list):
                        mutated[param] = random.choice(values)
                    elif isinstance(values, dict):
                        low = values.get("low", 0)
                        high = values.get("high", 1)
                        if isinstance(low, float) or isinstance(high, float):
                            mutated[param] = round(random.uniform(low, high), 6)
                        else:
                            mutated[param] = random.randint(int(low), int(high))

            cid = f"gen{next_generation}-{len(next_pop)}-{uuid.uuid4().hex[:4]}"
            next_pop.append(Candidate(
                id=cid,
                config=mutated,
                generation=next_generation,
                parent_id=parent.id,
            ))

        return next_pop

    async def _llm_mutate(
        self,
        survivors: List[Candidate],
        config: EvoSweepConfig,
        next_generation: int,
    ) -> List[Candidate]:
        """Use the LLM to intelligently mutate survivors."""
        # Prepare context for the LLM
        context = {
            "survivors": [
                {"id": s.id, "config": s.config, "fitness": s.fitness}
                for s in survivors
            ],
            "fitness_metric": config.fitness_metric,
            "fitness_direction": config.fitness_direction,
            "search_space": config.search_space,
            "population_size": config.population_size,
            "generation": next_generation,
        }

        try:
            new_configs = await self._llm_mutate_fn(context)
            if isinstance(new_configs, list):
                candidates = []
                for i, cfg in enumerate(new_configs[: config.population_size]):
                    parent = survivors[i % len(survivors)]
                    cid = f"gen{next_generation}-{i}-{uuid.uuid4().hex[:4]}"
                    candidates.append(Candidate(
                        id=cid,
                        config=cfg if isinstance(cfg, dict) else cfg.get("config", {}),
                        generation=next_generation,
                        parent_id=parent.id,
                    ))
                return candidates
        except Exception as err:
            logger.warning("[evo-sweep] LLM mutation failed: %s, falling back to random", err)

        return self._random_mutate(survivors, config, next_generation)
