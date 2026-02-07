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

- **Node.js** 18+ and **pnpm** (package manager)
- **Python** 3.10+
- **tmux** (for background job execution)
- **OpenCode** CLI (`npm install -g opencode` or `bun install -g opencode`)

## Quick Start

### 1. Clone and install frontend dependencies

```bash
git clone https://github.com/GindaChen/v0-research-agent-mobile.git
cd v0-research-agent-mobile
pnpm install
```

### 2. Install server dependencies

```bash
cd server
pip install -r requirements.txt
```

### 3. Set environment variables

```bash
# Required: Auth token for the frontend ↔ server connection
# Generate one with: source server/generate_auth_token.sh
export RESEARCH_AGENT_USER_AUTH_TOKEN="your-auth-token"

# Optional: API key for the Anthropic gateway (needed for LLM calls)
# For testing, if we use opencode free models, this should be fine.
export RESEARCH_AGENT_KEY="your-gateway-token"
```

### 4. Start OpenCode

In a terminal, navigate to your research project directory and start OpenCode with the custom config. For a quick demo, use the included `tests/story/alert` directory:

```bash
# Demo: use the bundled test project
cd tests/story/alert
export OPENCODE_CONFIG=$(pwd)/../../server/opencode.json
opencode serve

# Or: use your own research project
cd /path/to/your/research/project
export OPENCODE_CONFIG=/path/to/v0-research-agent-mobile/server/opencode.json
opencode serve
```

This starts OpenCode on port `4096` (default).

### 5. Start the backend server

In another terminal:

```bash
# Demo: use the bundled test project
cd server
export MODEL_PROVIDER="opencode"
export MODEL_ID="kimi-k2.5-free"
python server.py --workdir ../tests/story/alert

# Or: use your own research project
python server.py --workdir /path/to/your/research/project
```

The server starts on port `10000` by default.

| Flag        | Description                         | Default           |
| ----------- | ----------------------------------- | ----------------- |
| `--workdir` | Working directory for job execution | Current directory |
| `--port`    | Server port                         | `10000`           |

### 6. Start the frontend

In another terminal, from the project root:

```bash
pnpm dev
```

Open http://localhost:3000 in your browser.

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
| Package Manager | pnpm                                         |

## Development

```bash
pnpm dev          # Start dev server (frontend)
pnpm build        # Production build
pnpm start        # Start production server
pnpm lint         # Run ESLint
```

## Troubleshooting

| Problem                     | Solution                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------- |
| Text not streaming          | Check OpenCode is running: `curl http://localhost:4096/`                            |
| Jobs not starting           | Verify tmux session: `tmux list-sessions`                                           |
| OpenCode config not loading | Use absolute path: `OPENCODE_CONFIG=/absolute/path/to/opencode.json opencode serve` |
| Frontend can't reach server | Ensure server is running on port 10000 and not blocked by firewall                  |
