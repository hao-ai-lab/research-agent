# Architecture: FE ↔ BE ↔ OpenCode ↔ LLM Gateway

## System Topology

```mermaid
graph TB
    subgraph "User Device"
        FE["Next.js Frontend<br/>(React + Hooks)"]
    end

    subgraph "Local Machine"
        BE["FastAPI Backend<br/>(server.py :10000)"]
        OC["OpenCode Server<br/>(:4096)"]

        subgraph "Tmux Session (research-agent)"
            SC1["Job Sidecar<br/>(job_sidecar.py)"]
            P1["Job Pane<br/>(training command)"]
            SC2["Job Sidecar 2"]
            P2["Job Pane 2"]
        end
    end

    subgraph "Modal Cloud"
        AGW["Anthropic Gateway<br/>(modal_gateway_anthropic.py)"]
        DGW["DeepInfra Gateway<br/>(modal_gateway_deepinfra.py)"]
        LQ["Modal Queue<br/>(gateway-log-queue)"]
        LH["Log Handler<br/>(modal_log_handler.py)"]
        LV["Modal Volume<br/>(SQLite logs)"]
    end

    subgraph "Upstream LLM APIs"
        ANT["Anthropic API<br/>(api.anthropic.com)"]
        DI["DeepInfra API<br/>(api.deepinfra.com)"]
    end

    subgraph "External Integrations"
        SL["Slack"]
        TG["Telegram"]
    end

    FE -- "HTTP + NDJSON stream<br/>X-Auth-Token" --> BE
    BE -- "REST + SSE<br/>Basic Auth" --> OC
    OC -- "Anthropic SDK<br/>x-api-key" --> AGW
    OC -- "OpenAI SDK<br/>Bearer token" --> DGW
    AGW -- "SSE passthrough" --> ANT
    DGW -- "SSE passthrough" --> DI
    AGW -- "put()" --> LQ
    DGW -- "put()" --> LQ
    LH -- "get() cron 1m" --> LQ
    LH -- "write" --> LV

    BE -- "subprocess.Popen<br/>in tmux window" --> SC1
    SC1 -- "split-pane" --> P1
    SC1 -- "POST /runs/{id}/status<br/>POST /runs/{id}/alerts" --> BE
    SC1 -- "reads metrics.jsonl<br/>+ WandB" --> P1

    BE -- "webhooks" --> SL
    BE -- "Bot API" --> TG
```

## Chat & Streaming Flow

```mermaid
sequenceDiagram
    participant User
    participant FE as Next.js Frontend
    participant BE as FastAPI Backend
    participant OC as OpenCode Server
    participant GW as Modal LLM Gateway
    participant LLM as Upstream LLM API

    User->>FE: Type message
    FE->>BE: POST /chat {session_id, message, wild_mode}
    BE->>OC: POST /session/{id}/prompt_async {providerID, modelID, parts}
    BE->>OC: GET /global/event (SSE stream)
    OC->>GW: POST /v1/messages (or /v1/chat/completions)
    GW->>LLM: Forward (swap auth: GATEWAY_TOKEN → real API key)
    LLM-->>GW: SSE stream (token chunks)
    GW-->>OC: SSE passthrough
    OC-->>BE: SSE events (message.part.updated, session.status)
    Note over BE: parse_opencode_event() translates SSE → NDJSON
    BE-->>FE: NDJSON stream (part_delta, part_update, session_status)
    FE-->>User: Render streaming text + tool indicators
```

## Job Execution & Monitoring Flow

```mermaid
sequenceDiagram
    participant Agent as LLM Agent (via Chat)
    participant BE as FastAPI Backend
    participant Tmux as Tmux Session
    participant SC as Job Sidecar
    participant Job as Job Process
    participant WB as WandB / metrics.jsonl

    Agent->>BE: POST /runs (create run)
    Agent->>BE: POST /runs/{id}/start
    BE->>Tmux: new_window(ra-{run_id})
    BE->>Tmux: send_keys(python job_sidecar.py ...)
    Tmux->>SC: Sidecar starts in pane 0
    SC->>Tmux: split-window (pane 1)
    SC->>Job: Execute training command in pane 1
    SC->>BE: POST status=running

    loop Monitor loop (every 5s)
        SC->>Job: Check pane alive
        SC->>WB: Read metrics.jsonl
        SC->>SC: Rule-based alerts (NaN, loss spike)
        SC->>SC: LLM judge alerts (every 30s)
        alt Alert triggered
            SC->>BE: POST /runs/{id}/alerts {message, choices}
            BE->>BE: Create alert record, optionally auto-create chat session
            Note over BE: Agent or user responds to alert via chat
        end
    end

    Job-->>SC: Process exits
    SC->>BE: POST status=finished (exit_code)
```

## Component Reference

### Frontend (`v0-research-agent-mobile/`)

| Layer       | File                        | Role                                            |
| ----------- | --------------------------- | ----------------------------------------------- |
| App Shell   | `app/page.tsx`              | Single hook instance, shared state              |
| Chat Hook   | `hooks/use-chat-session.ts` | Streaming state, 60s timeout, message queue     |
| Wild Loop   | `hooks/use-wild-loop.ts`    | Frontend-driven autonomous loop (v3 Ralph Loop) |
| Runs Hook   | `hooks/use-runs.ts`         | Run/sweep CRUD + polling                        |
| Alerts Hook | `hooks/use-alerts.ts`       | Alert polling + responses                       |
| API Client  | `lib/api.ts`                | NDJSON parsing, `StreamEvent` types             |

### Backend (`server/server.py`)

| Area         | Endpoints                                             | Description                                    |
| ------------ | ----------------------------------------------------- | ---------------------------------------------- |
| Chat         | `POST /chat`, `GET/POST /sessions`                    | NDJSON streaming from OpenCode, session CRUD   |
| Runs         | `POST /runs`, `POST /runs/{id}/start`, `GET /runs`    | Job creation, tmux launch, status tracking     |
| Sweeps       | `POST /sweeps`, `POST /sweeps/{id}/start`             | Hyperparameter sweep orchestration             |
| Alerts       | `POST /runs/{id}/alerts`, `POST /alerts/{id}/respond` | Sidecar-triggered alerts, user/agent responses |
| Wild Mode    | `GET/POST /wild/status`, `POST /wild/configure`       | Autonomous loop state management               |
| Integrations | Slack webhooks, Telegram Bot API                      | External notifications                         |

**Active config**: `MODEL_PROVIDER=research-agent`, `MODEL_ID=claude-sonnet-4-20250514`

### Tmux Job Execution (`server/job_sidecar.py`)

| Component             | Role                                                               |
| --------------------- | ------------------------------------------------------------------ |
| **Sidecar process**   | Spawned by server in tmux window pane 0                            |
| **Job pane**          | Split pane 1 where the actual command runs                         |
| **Status callbacks**  | Reports `launching → running → finished/failed` to server          |
| **Rule-based alerts** | Detects NaN loss, loss spikes (>3× previous), via `metrics.jsonl`  |
| **LLM judge alerts**  | Every 30s, sends last 5 metric lines to LLM for anomaly assessment |
| **Manual trigger**    | Checks for `.alert_trigger` file in workdir                        |
| **WandB detection**   | Scans pane output for wandb run directory                          |

### OpenCode Providers (`server/opencode.json`)

| Provider         | SDK                         | Gateway URL                                   |
| ---------------- | --------------------------- | --------------------------------------------- |
| `research-agent` | `@ai-sdk/anthropic`         | `hao-ai-lab--anthropic-gateway-api.modal.run` |
| `my-openai`      | `@ai-sdk/openai-compatible` | `hao-ai-lab--openai-gateway-v2-api.modal.run` |
| `my-deepinfra`   | `@ai-sdk/openai-compatible` | `api.deepinfra.com` (direct, no gateway)      |

### LLM Gateways (Modal Cloud)

| Gateway                      | Upstream                                | Auth pattern                          |
| ---------------------------- | --------------------------------------- | ------------------------------------- |
| `modal_gateway_anthropic.py` | `api.anthropic.com/v1/messages`         | `GATEWAY_TOKEN` → `ANTHROPIC_API_KEY` |
| `modal_gateway_deepinfra.py` | `api.deepinfra.com/v1/chat/completions` | `GATEWAY_TOKEN` → `DEEPINFRA_TOKEN`   |
| `modal_log_handler.py`       | Modal Queue → SQLite Volume             | Cron every 1 minute                   |

Both gateways act as **auth-swapping proxies** — they verify inbound `GATEWAY_TOKEN`, then substitute the real upstream API key before forwarding. All requests are logged to a shared Modal Queue, consumed by the log handler cron job into persistent SQLite storage.
