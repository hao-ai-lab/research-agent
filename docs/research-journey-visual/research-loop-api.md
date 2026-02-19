# Research Journey Loop API

This API models a closed-loop research workflow:

1. Signals/events are logged (`/journey/events`)
2. Agent recommendations are created (`/journey/recommendations` or `/journey/recommendations/generate`)
3. User decisions are recorded (`/journey/decisions`)
4. Loop state is read in one call (`/journey/loop`)

## Core entities

### Journey event
- `id`: string
- `kind`: string (`run_created`, `run_queued`, `run_running`, `run_failed`, `agent_recommendation_issued`, `decision_recorded`, etc.)
- `actor`: `human | agent | system`
- `session_id?`, `run_id?`, `chart_id?`
- `recommendation_id?`, `decision_id?`
- `note?`: string
- `metadata?`: object
- `timestamp`: unix seconds

### Journey recommendation
- `id`: string
- `title`: short summary
- `action`: concrete next step
- `rationale?`: why this is recommended
- `source`: string (`agent`, `llm`, `rule-engine`)
- `priority`: `low | medium | high | critical`
- `confidence?`: number in `[0,1]`
- `status`: `pending | accepted | rejected | modified | executed | dismissed`
- `session_id?`, `run_id?`, `chart_id?`
- `evidence_refs`: string[]
- `created_at`, `updated_at`, `responded_at?`
- `user_note?`, `modified_action?`

### Journey decision
- `id`: string
- `title`: decision summary
- `chosen_action`: what was done
- `rationale?`, `outcome?`
- `status`: `recorded | executed | superseded`
- `recommendation_id?`
- `session_id?`, `run_id?`, `chart_id?`
- `created_at`, `updated_at`

## Endpoints

- `GET /journey/loop?session_id=&run_id=&limit=`
- `POST /journey/events`
- `GET /journey/recommendations`
- `POST /journey/recommendations`
- `POST /journey/recommendations/{recommendation_id}/respond`
- `POST /journey/recommendations/generate`
- `GET /journey/decisions`
- `POST /journey/decisions`

## Notes

- State is persisted in `.agents/journey_state.json`.
- Run lifecycle events are auto-captured by run endpoints:
  - create/queue/start/stop/status updates emit journey events.
