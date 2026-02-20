# Research Agent

AI-powered research assistant for ML experiment tracking.

It combines:

- A Next.js frontend for runs, sweeps, charts, events, and chat
- A FastAPI backend for orchestration and APIs
- OpenCode for agent execution and streaming
- tmux-based background execution for long-running jobs

Try it yourself
```bash
curl -fsSL "https://raw.githubusercontent.com/hao-ai-lab/research-agent/v0.1.0-0219/install.sh" | bash
```

Demo: https://hao-ai-lab--research-agent-main-preview-app.modal.run

## Architecture

```text
┌─────────────┐    ┌─────────────┐    ┌──────────────────┐    ┌─────────────┐
│   Frontend  │───▶│   Server    │───▶│     OpenCode     │───▶│   Gateway   │
│  (Next.js)  │    │  (FastAPI)  │    │  (localhost:4096)│    │   (Modal)   │
└─────────────┘    └─────────────┘    └──────────────────┘    └─────────────┘
     :3000+            :10000+                                       │
                          │                                          ▼
                    ┌─────────────┐                           ┌─────────────┐
                    │    tmux     │                           │  Anthropic  │
                    │ (job exec)  │                           │     API     │
                    └─────────────┘                           └─────────────┘
```

## Prerequisites

- Node.js 20+
- npm
- Python 3.10+
- tmux
- OpenCode CLI (`opencode`)
- `uv` (recommended for backend env setup)
- `ngrok` (optional, only for `research-agent tunnel`)

## Quick Start (Recommended)

Use the lifecycle manager:

```bash
research-agent start --project-root "$PWD"
```

This starts OpenCode, backend, and frontend in a tmux session and writes runtime info to `.agents/ra-runtime.env`.

Useful commands:

```bash
research-agent status
research-agent tunnel
research-agent stop
```

## Local Developer Setup (Source Mode)

```bash
# from repo root
bash install.sh --dev
nvm use 20
npm install

uv venv .ra-venv
uv pip install --python .ra-venv/bin/python -r server/requirements.txt
```

Start each service in its own terminal:

```bash
# Terminal 1: OpenCode
export RESEARCH_AGENT_USER_AUTH_TOKEN="$(openssl rand -hex 16)"
export OPENCODE_CONFIG="$(pwd)/server/opencode.json"
opencode serve
```

```bash
# Terminal 2: Backend
cd server
../.ra-venv/bin/python server.py --workdir /path/to/your/research/project --port 10000
```

```bash
# Terminal 3: Frontend
NEXT_PUBLIC_API_URL=http://127.0.0.1:10000 NEXT_PUBLIC_USE_MOCK=false npm run dev -- --hostname 127.0.0.1 --port 3000
```

## Environment Variables

| Variable                         | Required | Description                                                                 | Default                 |
| -------------------------------- | -------- | --------------------------------------------------------------------------- | ----------------------- |
| `RESEARCH_AGENT_USER_AUTH_TOKEN` | No       | Auth token enforced by backend when set                                     | unset                   |
| `RESEARCH_AGENT_KEY`             | No       | API key for Anthropic gateway used by provider config                       | unset                   |
| `OPENCODE_URL`                   | No       | OpenCode base URL used by backend                                           | `http://127.0.0.1:4096` |
| `OPENCODE_SERVER_PASSWORD`       | No       | HTTP Basic Auth password for OpenCode server                                | unset                   |
| `NEXT_PUBLIC_API_URL`            | Yes*     | Frontend API base URL in source dev mode                                    | none                    |
| `NEXT_PUBLIC_USE_MOCK`           | No       | Use demo/mock frontend data (`true`/`false`)                                | `false` in local setup  |
| `RESEARCH_AGENT_STATE_DIR`       | No       | Manager state directory (`config.env`, token, onboarding marker)            | `~/.research-agent`     |
| `RESEARCH_AGENT_INSTALL_DIR`     | No       | Manager install directory for app runtime                                   | `~/.research-agent/app` |

\* Required when running frontend from source with `npm run dev`.

## Project Structure

```text
├── app/                    # Next.js App Router
├── components/             # React components
├── hooks/                  # Custom hooks
├── lib/                    # Shared utilities and API config
├── cli/research-agent.mjs  # Node launcher for CLI runtime bootstrap
├── scripts/research-agent  # Lifecycle manager (install/onboard/start/tunnel/status/stop)
├── server/                 # FastAPI backend + agent runtime
├── tests/                  # Python tests
└── install.sh              # Installer / developer prerequisite setup
```

## Frontend Commands

```bash
npm run dev
npm run build
npm run start
npm run lint
```

## Troubleshooting

| Problem                     | Check |
| --------------------------- | ----- |
| Text not streaming          | `curl http://127.0.0.1:4096/` and verify OpenCode is up |
| Jobs not starting           | `tmux list-sessions` and confirm research-agent session exists |
| OpenCode config ignored     | start with `OPENCODE_CONFIG=/absolute/path/to/server/opencode.json opencode serve` |
| Frontend cannot reach API   | verify backend port and `NEXT_PUBLIC_API_URL` value |
| Runtime status unclear      | run `research-agent status` and inspect `.agents/ra-runtime.env` |
