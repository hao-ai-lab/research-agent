# 04-antigravity-ralph

Playground for running an [open-ralph-wiggum](https://github.com/Th0rgal/open-ralph-wiggum)-style autonomous loop using **Google Gemini CLI** as the agent.

## Why Gemini CLI?

Google Antigravity is a GUI IDE — it has no standalone CLI binary. **Gemini CLI** (`gemini`) is Google's terminal-native counterpart with non-interactive mode (`gemini -p "prompt"`), making it the viable headless agent for a Ralph loop.

## Prerequisites

1. **Gemini CLI** installed and authenticated:
   ```bash
   npm install -g @anthropic-ai/gemini-cli
   # or see https://github.com/google-gemini/gemini-cli
   ```
2. Python 3.10+

## Usage

```bash
# Basic loop
python playground/04-antigravity-ralph/ralph_gemini.py "Build a REST API" --max-iterations 10

# Specific model + auto-approve tools
python playground/04-antigravity-ralph/ralph_gemini.py "Fix tests" --model gemini-2.5-pro --yolo

# Check status from another terminal
python playground/04-antigravity-ralph/ralph_gemini.py --status

# Inject a hint mid-loop
python playground/04-antigravity-ralph/ralph_gemini.py --add-context "Focus on auth module"
```

## How It Works

```
┌─────────────────────────────────────────────────┐
│                                                 │
│  ┌──────────┐  same prompt  ┌──────────────┐   │
│  │  ralph   │ ────────────► │  gemini -p   │   │
│  │  loop    │ ◄──────────── │  (Gemini CLI)│   │
│  └──────────┘  stdout       └──────────────┘   │
│       │                           │             │
│  check for                  modify files        │
│  <promise>                        │             │
│       ▼                           ▼             │
│  ┌──────────┐              ┌──────────┐        │
│  │ Complete │              │   Git    │        │
│  │ or Retry │              │  (state) │        │
│  └──────────┘              └──────────┘        │
│                                                 │
└─────────────────────────────────────────────────┘
```

1. Sends your prompt to Gemini CLI (`gemini -p "..."`)
2. Gemini works on the task, modifies files
3. Ralph checks output for `<promise>COMPLETE</promise>`
4. If not found, repeats with the same prompt
5. Gemini sees its previous work in files & git history
6. Loop continues until completion or max iterations

## Features (from open-ralph-wiggum)

- **Self-correcting loop** — agent sees previous work via files/git
- **Completion detection** — `<promise>COMPLETE</promise>` tag
- **State persistence** — resume after interruption via `.ralph/`
- **Struggle detection** — warns on no-progress or short iterations
- **Context injection** — add hints mid-loop with `--add-context`
- **Auto-commit** — git commits after each iteration
- **Status dashboard** — check loop progress from another terminal

## Environment Variables

| Variable              | Description                                      |
| --------------------- | ------------------------------------------------ |
| `RALPH_GEMINI_BINARY` | Path to gemini binary (overrides `which gemini`) |
