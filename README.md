# Research Agent v2

AI-powered research assistant built on [pi-agent-core](https://github.com/mariozechner/pi-agent-core).

## Architecture

```
server.js              → Express 5 app (~100 LOC)
lib/agent-engine.js    → Agent factory + soul loader
lib/agent-mailbox.js   → JSONL inbox/outbox + steer/queue
lib/agent-sessions.js  → Session manager with TTL
lib/worker-entry.js    → Subprocess worker entry point
lib/tools/             → Tool registry (bash, fs, communication, orchestration)
agent-seeds/           → Persona template folders (soul.md + tools.json + defaults.json)
routes/                → HTTP routes (chat, agents)
frontend/              → Minimal chat UI (pure HTML/CSS/JS)
tests/                 → Unit + integration + eval tests
```

## Quick Start

```bash
npm install
ANTHROPIC_API_KEY=<key> npm run dev
```

## Key Concepts

- **Wild Loop** = pi-mono agent loop. Two primitives: **steer** (course-correct) and **queue** (next task).
- **Agent Seeds** = persona template folders. `createAgentFromSeed('researcher', {vars})`.
- **Souls** = markdown system prompts with `{{variable}}` interpolation.
- **Mailbox** = JSONL file-based inter-agent communication.

## Testing

```bash
npm test                              # Unit tests (no API key needed)
ANTHROPIC_API_KEY=<key> npm run eval  # Agent integration tests
```
