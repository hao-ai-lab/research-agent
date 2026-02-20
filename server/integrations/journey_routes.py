"""
Research Agent Server — Journey Endpoints

Extracted from server.py. All /journey/* endpoints live here.
"""

import json
import logging
import os
import re
import time
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, HTTPException, Query

from core import config
from core.config import (
    OPENCODE_URL,
    MODEL_PROVIDER,
    MODEL_ID,
    apply_runtime_research_agent_key,
    get_auth,
)
from core.models import (
    JourneyNextActionsRequest,
    JourneyEventCreate,
    JourneyRecommendationCreate,
    JourneyRecommendationRespondRequest,
    JourneyDecisionCreate,
    JOURNEY_PRIORITY_VALUES,
    JOURNEY_REC_STATUS_VALUES,
    JOURNEY_DECISION_STATUS_VALUES,
)
from core.state import (
    journey_events,
    journey_recommendations,
    journey_decisions,
    save_journey_state,
    _journey_new_id,
)

logger = logging.getLogger("research-agent-server")
router = APIRouter()

# ---------------------------------------------------------------------------
# Module-level references.  Wired at init().
# ---------------------------------------------------------------------------
_record_journey_event = None
_send_prompt_to_opencode = None
_stream_opencode_events = None


def init(
    record_journey_event_fn,
    send_prompt_to_opencode_fn,
    stream_opencode_events_fn,
):
    """Wire in shared callbacks from server.py."""
    global _record_journey_event, _send_prompt_to_opencode, _stream_opencode_events
    _record_journey_event = record_journey_event_fn
    _send_prompt_to_opencode = send_prompt_to_opencode_fn
    _stream_opencode_events = stream_opencode_events_fn


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _extract_actions_from_text(raw_text: str, max_actions: int) -> list[str]:
    text = str(raw_text or "").strip()
    if not text:
        return []

    def _normalize(actions: list[Any]) -> list[str]:
        cleaned: list[str] = []
        for item in actions:
            if isinstance(item, str):
                value = item.strip()
                if value:
                    cleaned.append(value)
            if len(cleaned) >= max_actions:
                break
        return cleaned

    # 1) Best case: full JSON object.
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            actions = parsed.get("next_best_actions")
            if isinstance(actions, list):
                normalized = _normalize(actions)
                if normalized:
                    return normalized
    except Exception:
        pass

    # 2) Extract JSON object embedded in prose.
    match = re.search(r"\{[\s\S]*\}", text)
    if match:
        try:
            parsed = json.loads(match.group(0))
            if isinstance(parsed, dict):
                actions = parsed.get("next_best_actions")
                if isinstance(actions, list):
                    normalized = _normalize(actions)
                    if normalized:
                        return normalized
        except Exception:
            pass

    # 3) Fallback: bullets / numbered lines.
    fallback: list[str] = []
    for line in text.splitlines():
        candidate = re.sub(r"^\s*(?:[-*]|\d+[.)])\s*", "", line).strip()
        if candidate:
            fallback.append(candidate)
        if len(fallback) >= max_actions:
            break
    return fallback


def _journey_record_matches(item: dict, session_id: Optional[str], run_id: Optional[str]) -> bool:
    if session_id and item.get("session_id") != session_id:
        return False
    if run_id and item.get("run_id") != run_id:
        return False
    return True


def _journey_summary(filtered_events: List[dict], filtered_recommendations: List[dict], filtered_decisions: List[dict]) -> dict:
    rec_total = len(filtered_recommendations)
    accepted = sum(1 for r in filtered_recommendations if r.get("status") == "accepted")
    executed = sum(1 for r in filtered_recommendations if r.get("status") == "executed")
    rejected = sum(1 for r in filtered_recommendations if r.get("status") == "rejected")
    return {
        "events": len(filtered_events),
        "recommendations": rec_total,
        "decisions": len(filtered_decisions),
        "accepted_recommendations": accepted,
        "executed_recommendations": executed,
        "rejected_recommendations": rejected,
        "acceptance_rate": (accepted / rec_total) if rec_total > 0 else 0.0,
    }


# ---------------------------------------------------------------------------
# Journey Endpoints
# ---------------------------------------------------------------------------

@router.post("/journey/next-actions")
async def journey_next_actions(req: JourneyNextActionsRequest):
    """Generate next-best research directions from journey context using OpenCode."""
    journey = req.journey if isinstance(req.journey, dict) else {}
    max_actions = int(req.max_actions or 3)

    title = str(journey.get("title") or "User Research Journey").strip()
    summary = journey.get("summary") if isinstance(journey.get("summary"), dict) else {}
    reflections = journey.get("reflections") if isinstance(journey.get("reflections"), dict) else {}
    events = journey.get("events") if isinstance(journey.get("events"), list) else []
    steps = journey.get("steps") if isinstance(journey.get("steps"), list) else []

    compact_events: list[dict[str, Any]] = []
    for event in events[-20:]:
        if not isinstance(event, dict):
            continue
        compact_events.append({
            "time": event.get("time"),
            "actor": event.get("actor"),
            "event": event.get("event"),
            "note": event.get("note"),
        })

    compact_steps: list[dict[str, Any]] = []
    for step in steps[-20:]:
        if not isinstance(step, dict):
            continue
        compact_steps.append({
            "type": step.get("type"),
            "status": step.get("status"),
            "title": step.get("title"),
            "effort_minutes": step.get("effort_minutes"),
            "confidence": step.get("confidence"),
        })

    prompt_payload = {
        "title": title,
        "summary": summary,
        "reflections": reflections,
        "recent_steps": compact_steps,
        "recent_events": compact_events,
        "constraints": {
            "max_actions": max_actions,
            "audience": "researcher",
            "style": "concrete, actionable, non-generic",
        },
    }

    prompt = (
        "You are a senior research planning assistant. "
        "Given a research journey, propose the next best actions.\n\n"
        "Return strict JSON only with this schema:\n"
        "{\n"
        '  "next_best_actions": ["action 1", "action 2", "action 3"],\n'
        '  "reasoning": "brief 1-2 sentence rationale"\n'
        "}\n\n"
        f"The list must have at most {max_actions} items.\n"
        "Each action must be specific and testable.\n"
        "Avoid generic advice.\n\n"
        f"Journey context:\n{json.dumps(prompt_payload, ensure_ascii=False)}"
    )

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, read=60.0)) as client:
            await apply_runtime_research_agent_key(client)
            session_resp = await client.post(
                f"{OPENCODE_URL}/session",
                params={"directory": os.path.abspath(config.WORKDIR)},
                json={},
                auth=get_auth(),
            )
            session_resp.raise_for_status()
            opencode_session_id = session_resp.json().get("id")
            if not opencode_session_id:
                raise RuntimeError("OpenCode session creation returned no id")

            await _send_prompt_to_opencode(client, opencode_session_id, prompt, MODEL_PROVIDER, MODEL_ID)

            chunks: list[str] = []
            async for event, text_delta, _thinking_delta, _tool_update in _stream_opencode_events(client, opencode_session_id):
                if event.get("type") == "part_delta" and event.get("ptype") == "text" and text_delta:
                    chunks.append(text_delta)
                if event.get("type") == "session_status" and event.get("status") == "idle":
                    break

            raw_text = "".join(chunks).strip()
            actions = _extract_actions_from_text(raw_text, max_actions)
            if not actions:
                raise RuntimeError("Model output did not contain usable next actions")

            reasoning = ""
            try:
                parsed = json.loads(raw_text)
                if isinstance(parsed, dict) and isinstance(parsed.get("reasoning"), str):
                    reasoning = parsed.get("reasoning", "").strip()
            except Exception:
                pass

            return {
                "next_best_actions": actions,
                "reasoning": reasoning,
                "source": "llm",
            }
    except Exception as e:
        logger.warning("journey_next_actions failed: %s", e, exc_info=True)
        raise HTTPException(status_code=502, detail=f"Failed to generate next actions: {e}")


@router.get("/journey/loop")
async def get_journey_loop(
    session_id: Optional[str] = Query(None, description="Filter by chat session id"),
    run_id: Optional[str] = Query(None, description="Filter by run id"),
    limit: int = Query(300, ge=1, le=2000, description="Max records per list"),
):
    """Return structured journey loop data for growth tracking."""
    filtered_events = [
        event for event in journey_events.values()
        if _journey_record_matches(event, session_id, run_id)
    ]
    filtered_recommendations = [
        rec for rec in journey_recommendations.values()
        if _journey_record_matches(rec, session_id, run_id)
    ]
    filtered_decisions = [
        decision for decision in journey_decisions.values()
        if _journey_record_matches(decision, session_id, run_id)
    ]

    filtered_events.sort(key=lambda x: x.get("timestamp", 0), reverse=True)
    filtered_recommendations.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    filtered_decisions.sort(key=lambda x: x.get("created_at", 0), reverse=True)

    return {
        "events": filtered_events[:limit],
        "recommendations": filtered_recommendations[:limit],
        "decisions": filtered_decisions[:limit],
        "summary": _journey_summary(filtered_events, filtered_recommendations, filtered_decisions),
    }


@router.post("/journey/events")
async def create_journey_event(req: JourneyEventCreate):
    """Append a structured journey event."""
    return _record_journey_event(
        kind=req.kind,
        actor=req.actor,
        session_id=req.session_id,
        run_id=req.run_id,
        chart_id=req.chart_id,
        recommendation_id=req.recommendation_id,
        decision_id=req.decision_id,
        note=req.note,
        metadata=req.metadata,
        timestamp=req.timestamp,
    )


@router.get("/journey/recommendations")
async def list_journey_recommendations(
    session_id: Optional[str] = Query(None, description="Filter by chat session id"),
    run_id: Optional[str] = Query(None, description="Filter by run id"),
    limit: int = Query(200, ge=1, le=2000),
):
    rows = [
        row for row in journey_recommendations.values()
        if _journey_record_matches(row, session_id, run_id)
    ]
    rows.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    return rows[:limit]


@router.post("/journey/recommendations")
async def create_journey_recommendation(req: JourneyRecommendationCreate):
    """Create a recommendation record for user/agent planning loop."""
    priority = req.priority if req.priority in JOURNEY_PRIORITY_VALUES else "medium"
    rec_id = _journey_new_id("jrec")
    created_at = time.time()
    payload = {
        "id": rec_id,
        "title": req.title.strip(),
        "action": req.action.strip(),
        "rationale": (req.rationale or "").strip() or None,
        "source": (req.source or "agent").strip() or "agent",
        "priority": priority,
        "confidence": req.confidence,
        "status": "pending",
        "session_id": req.session_id,
        "run_id": req.run_id,
        "chart_id": req.chart_id,
        "evidence_refs": [str(x) for x in req.evidence_refs[:20]],
        "created_at": created_at,
        "updated_at": created_at,
        "responded_at": None,
        "user_note": None,
        "modified_action": None,
    }
    journey_recommendations[rec_id] = payload
    save_journey_state()
    _record_journey_event(
        kind="agent_recommendation_issued",
        actor="agent",
        session_id=req.session_id,
        run_id=req.run_id,
        chart_id=req.chart_id,
        recommendation_id=rec_id,
        note=req.title,
        metadata={"priority": priority, "source": payload["source"]},
    )
    return payload


@router.post("/journey/recommendations/{recommendation_id}/respond")
async def respond_journey_recommendation(recommendation_id: str, req: JourneyRecommendationRespondRequest):
    """Update recommendation lifecycle status with user decision."""
    recommendation = journey_recommendations.get(recommendation_id)
    if recommendation is None:
        raise HTTPException(status_code=404, detail="Recommendation not found")

    next_status = (req.status or "").strip().lower()
    if next_status not in JOURNEY_REC_STATUS_VALUES:
        raise HTTPException(status_code=400, detail=f"Invalid status: {req.status}")

    recommendation["status"] = next_status
    recommendation["responded_at"] = time.time()
    recommendation["updated_at"] = recommendation["responded_at"]
    recommendation["user_note"] = (req.user_note or "").strip() or None
    recommendation["modified_action"] = (req.modified_action or "").strip() or None
    save_journey_state()

    event_kind = {
        "accepted": "user_accepted_recommendation",
        "rejected": "user_rejected_recommendation",
        "modified": "user_modified_recommendation",
        "executed": "recommendation_executed",
        "dismissed": "recommendation_dismissed",
    }.get(next_status, "recommendation_updated")

    _record_journey_event(
        kind=event_kind,
        actor="human",
        session_id=recommendation.get("session_id"),
        run_id=recommendation.get("run_id"),
        chart_id=recommendation.get("chart_id"),
        recommendation_id=recommendation_id,
        note=recommendation.get("title"),
        metadata={"status": next_status},
    )
    return recommendation


@router.post("/journey/recommendations/generate")
async def generate_journey_recommendations(req: JourneyNextActionsRequest):
    """Generate next actions with LLM, then persist them as recommendation records."""
    generated = await journey_next_actions(req)
    actions = generated.get("next_best_actions", []) if isinstance(generated, dict) else []
    reasoning = generated.get("reasoning", "") if isinstance(generated, dict) else ""
    source = generated.get("source", "llm") if isinstance(generated, dict) else "llm"

    if not isinstance(actions, list):
        actions = []

    session_id = None
    run_id = None
    if isinstance(req.journey, dict):
        session_id = req.journey.get("session_id") if isinstance(req.journey.get("session_id"), str) else None
        run_id = req.journey.get("run_id") if isinstance(req.journey.get("run_id"), str) else None

    created: list[dict] = []
    for action in actions[: req.max_actions]:
        text = str(action).strip()
        if not text:
            continue
        recommendation = await create_journey_recommendation(
            JourneyRecommendationCreate(
                title=text[:120],
                action=text,
                rationale=reasoning or None,
                source=str(source or "llm"),
                priority="medium",
                session_id=session_id,
                run_id=run_id,
                evidence_refs=[],
            )
        )
        created.append(recommendation)

    return {
        "created": created,
        "reasoning": reasoning,
        "source": source,
    }


@router.get("/journey/decisions")
async def list_journey_decisions(
    session_id: Optional[str] = Query(None, description="Filter by chat session id"),
    run_id: Optional[str] = Query(None, description="Filter by run id"),
    limit: int = Query(200, ge=1, le=2000),
):
    rows = [
        row for row in journey_decisions.values()
        if _journey_record_matches(row, session_id, run_id)
    ]
    rows.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    return rows[:limit]


@router.post("/journey/decisions")
async def create_journey_decision(req: JourneyDecisionCreate):
    """Record a decision and optionally link it to a recommendation."""
    status = req.status if req.status in JOURNEY_DECISION_STATUS_VALUES else "recorded"
    decision_id = _journey_new_id("jdec")
    created_at = time.time()
    payload = {
        "id": decision_id,
        "title": req.title.strip(),
        "chosen_action": req.chosen_action.strip(),
        "rationale": (req.rationale or "").strip() or None,
        "outcome": (req.outcome or "").strip() or None,
        "status": status,
        "recommendation_id": req.recommendation_id,
        "session_id": req.session_id,
        "run_id": req.run_id,
        "chart_id": req.chart_id,
        "created_at": created_at,
        "updated_at": created_at,
    }
    journey_decisions[decision_id] = payload
    save_journey_state()
    _record_journey_event(
        kind="decision_recorded",
        actor="human",
        session_id=req.session_id,
        run_id=req.run_id,
        chart_id=req.chart_id,
        recommendation_id=req.recommendation_id,
        decision_id=decision_id,
        note=req.title,
        metadata={"status": status},
    )
    return payload
