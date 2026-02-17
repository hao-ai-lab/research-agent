# Research Agent

An AI-powered research assistant for ML experiment tracking. Provides a mobile-first web interface for monitoring training runs, chatting with an AI assistant, managing hyperparameter sweeps, and autonomous "Wild Mode" research loops.

**Demo**: https://km71ympfr5y29n-3000.proxy.runpod.net/

## Architecture

```
┌─────────────┐    ┌─────────────┐    ┌──────────────────┐    ┌─────────────┐
│   Frontend  │───▶│   Server    │───▶│     OpenCode     │───▶│   Gateway   │
│  (Next.js)  │    │  (FastAPI)  │    │  (localhost:4096) │    │   (Modal)   │
└─────────────┘    └─────────────┘    └──────────────────┘    └─────────────┘
     :3000             :10000                                        │
                          │                                          ▼
                    ┌─────────────┐                           ┌─────────────┐
                    │    tmux     │                           │  Anthropic  │
                    │ (job exec)  │                           │     API     │
                    └─────────────┘                           └─────────────┘
```

## Prerequisites

- **Node.js** 20.9+ and **npm**
- **Python** 3.10+
- **tmux** (for background job execution)
- **OpenCode** CLI (`npm install -g opencode-ai`), auto-attempted by installer
- **ngrok** (optional, for public tunnel URLs)
- **uv** (optional, preferred for isolated backend environment)

## Quick Start

### 1. YOLO install

Don't do YOLO install if you are a developer since you will get staled code. Go to manual setup below if you are a developer.

```bash
curl -fL "https://drive.google.com/uc?export=download&id=1mjKPk8lYI8YCdwYbdIrgLGDb_PWNIwGS" | bash
```

## Manual Setup (Advanced)

```bash
# Terminal 1 — OpenCode 
git clone https://github.com/GindaChen/v0-research-agent-mobile.git
cd v0-research-agent-mobile
bash install.sh --dev
source ~/.bashrc          # or: source ~/.zshrc (if you use zsh)
npm install
uv venv .ra-venv
uv pip install --python .ra-venv/bin/python -r server/requirements.txt
export RESEARCH_AGENT_USER_AUTH_TOKEN="$(openssl rand -hex 16)"
echo $RESEARCH_AGENT_USER_AUTH_TOKEN  # Store this token for future use!
export OPENCODE_CONFIG="$(pwd)/server/opencode.json"
opencode serve
```

```bash
# Terminal 2 — Backend
cd v0-research-agent-mobile/server
../.ra-venv/bin/python server.py --workdir /path/to/your/research/project --port 10000
```

```bash
# Terminal 3 — Frontend
cd v0-research-agent-mobile
NEXT_PUBLIC_API_URL=http://127.0.0.1:10000 NEXT_PUBLIC_USE_MOCK=false npm run dev -- --port 3000
```

## Environment Variables

| Variable                         | Required | Description                       | Default                 |
| -------------------------------- | -------- | --------------------------------- | ----------------------- |
| `RESEARCH_AGENT_USER_AUTH_TOKEN` | Yes      | Auth token for frontend ↔ server  | —                       |
| `RESEARCH_AGENT_KEY`             | No       | API key for the Anthropic gateway | —                       |
| `OPENCODE_URL`                   | No       | Override OpenCode URL             | `http://localhost:4096` |
| `OPENCODE_PASSWORD`              | No       | HTTP Basic Auth for OpenCode      | —                       |

## Project Structure

```
├── app/                    # Next.js App Router
│   ├── globals.css         # Global styles & CSS variables
│   ├── layout.tsx          # Root layout
│   └── page.tsx            # Main application entry
├── components/             # React components
│   ├── ui/                 # shadcn/ui base components
│   └── *.tsx               # Feature components (chat, runs, sweeps, etc.)
├── hooks/                  # Custom React hooks
├── lib/                    # Utilities and type definitions
├── install.sh              # curl|bash installer entrypoint
├── scripts/research-agent  # Master CLI (install/onboard/start/tunnel/status/stop)
├── server/                 # Python FastAPI backend
│   ├── server.py           # Main server
│   ├── job_sidecar.py      # tmux job execution sidecar
│   ├── opencode.json       # OpenCode provider config
│   └── requirements.txt    # Python dependencies
└── tests/story/            # Test scenarios
```

## Tech Stack

| Layer           | Technology                                   |
| --------------- | -------------------------------------------- |
| Frontend        | Next.js 16, React 19, TypeScript             |
| Styling         | Tailwind CSS 4.x, shadcn/ui                  |
| Backend         | FastAPI, Uvicorn                             |
| AI Layer        | OpenCode CLI → Modal Gateway → Anthropic API |
| Job Execution   | tmux + libtmux                               |
| Package Manager | npm + uv                                     |

## Development

```bash
npm run dev       # Start dev server (frontend)
npm run build     # Production build
npm run start     # Start production server
npm run lint      # Run ESLint
```

## Troubleshooting

| Problem                     | Solution                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------- |
| Text not streaming          | Check OpenCode is running: `curl http://localhost:4096/`                            |
| Jobs not starting           | Verify tmux session: `tmux list-sessions`                                           |
| OpenCode config not loading | Use absolute path: `OPENCODE_CONFIG=/absolute/path/to/opencode.json opencode serve` |
| Frontend can't reach server | Ensure server is running on port 10000 and not blocked by firewall                  |
