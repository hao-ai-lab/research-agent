# Research Agent Server

A FastAPI-based chat server that connects to OpenCode for AI-powered conversations with streaming support.

## Recommended Onboarding

From your research project root:

```bash
research-agent start --project-root "$PWD"
```

## Quick Setup

```
export RESEARCH_AGENT_KEY="your-gateway-token"
export RESEARCH_AGENT_WORKDIR="<path/to/your/research/projectt>"
export RESEARCH_AGENT_SERVERDIR="<path/to/server>"
```

```bash
# 1. Start tmux session (required for job execution)
tmux new-session -s research-agent

# 2. Start OpenCode with custom config
cd $RESEARCH_AGENT_WORKDIR
OPENCODE_CONFIG=${RESEARCH_AGENT_SERVERDIR}/opencode.json opencode serve

# 3. In another terminal, start the server
cd $RESEARCH_AGENT_SERVERDIR
pip install -r requirements.txt
python server.py --workdir /path/to/your/project

# 4. Start the frontend (from project root)
npm run dev
```

## Detailed Setup

### Prerequisites

- Python 3.10+
- Node.js 20.9+ (for frontend)
- tmux (for job execution)
- OpenCode CLI installed (`npm install -g opencode-ai`)

### 1. Configure OpenCode

The server uses a custom `opencode.json` configuration that defines the AI provider and models. The config points to a Modal-deployed Anthropic gateway:

```json
{
    "provider": {
        "research-agent": {
            "npm": "@ai-sdk/anthropic",
            "options": {
                "baseURL": "https://hao-ai-lab--anthropic-gateway-api.modal.run/v1",
                "apiKey": "{env:RESEARCH_AGENT_KEY}"
            },
            "models": { ... }
        }
    }
}
```

### 2. Set Environment Variables

Create a `.env` file or export:

```bash
# Required: API key for the gateway
export RESEARCH_AGENT_KEY="your-gateway-token"

# Optional: Override OpenCode URL (default: http://localhost:4096)
export OPENCODE_URL="http://localhost:4096"

# Optional: HTTP Basic Auth for OpenCode (if configured)
export OPENCODE_PASSWORD="your-password"
```

### 3. Start OpenCode

OpenCode must be started with the custom config to use the gateway-configured models:

```bash
# Important: Use OPENCODE_CONFIG to specify the config file
OPENCODE_CONFIG=/path/to/server/opencode.json opencode serve
```

This starts OpenCode on port 4096 (default). The server connects to this for chat completions.

### 4. Start the Server

```bash
cd server
python server.py --workdir /path/to/your/project
```

Options:

- `--workdir`: Working directory for job execution (default: current directory)
- `--port`: Server port (default: 10000)

### 5. Start tmux (for Jobs)

The server uses tmux for background job execution:

```bash
# Create session if not exists
tmux new-session -s research-agent -d
```

## API Reference

### Chat Endpoints

| Endpoint         | Method | Description                              |
| ---------------- | ------ | ---------------------------------------- |
| `/`              | GET    | Health check                             |
| `/sessions`      | GET    | List all chat sessions                   |
| `/sessions`      | POST   | Create a new chat session                |
| `/sessions/{id}` | GET    | Get session with messages                |
| `/sessions/{id}` | DELETE | Delete a session                         |
| `/chat`          | POST   | Send message, receive streaming response |

### Run/Job Endpoints

| Endpoint           | Method | Description        |
| ------------------ | ------ | ------------------ |
| `/runs`            | GET    | List all runs      |
| `/runs`            | POST   | Create a new run   |
| `/runs/{id}`       | GET    | Get run details    |
| `/runs/{id}/start` | POST   | Start a queued run |
| `/runs/{id}/stop`  | POST   | Stop a running job |
| `/runs/{id}/logs`  | GET    | Get run logs       |

### Sweep Endpoints

| Endpoint             | Method | Description                        |
| -------------------- | ------ | ---------------------------------- |
| `/sweeps`            | GET    | List all sweeps                    |
| `/sweeps`            | POST   | Create a sweep with parameter grid |
| `/sweeps/{id}`       | GET    | Get sweep details                  |
| `/sweeps/{id}/start` | POST   | Start sweep runs                   |

## Streaming Protocol

The `/chat` endpoint returns NDJSON (newline-delimited JSON) with these event types:

| Event Type       | Description                                |
| ---------------- | ------------------------------------------ |
| `part_delta`     | Text or reasoning content delta            |
| `part_update`    | Tool call status update                    |
| `session_status` | Session state (e.g., "idle" when complete) |
| `error`          | Error message                              |

## Architecture

```
┌─────────────┐    ┌─────────────┐    ┌──────────────────┐    ┌─────────────┐
│   Frontend  │───▶│   Server    │───▶│     OpenCode     │───▶│   Gateway   │
│  (Next.js)  │    │  (FastAPI)  │    │  (localhost:4096)│    │   (Modal)   │
└─────────────┘    └─────────────┘    └──────────────────┘    └─────────────┘
     :3000             :10000                                        │
                                                                     ▼
                                                              ┌─────────────┐
                                                              │  Anthropic  │
                                                              │     API     │
                                                              └─────────────┘
```

## Troubleshooting

### Streaming not working / text doesn't appear

1. Check OpenCode is running: `curl http://localhost:4096/`
2. Check `RESEARCH_AGENT_KEY` is set correctly
3. Check server logs for connection errors

### Jobs not starting

1. Ensure tmux session exists: `tmux list-sessions`
2. Create if missing: `tmux new-session -s research-agent -d`

### OpenCode config not loading

Make sure to use the full path:

```bash
OPENCODE_CONFIG=/absolute/path/to/opencode.json opencode serve
```
