---
description: how to create, run, and manage git worktrees for parallel development
---

// turbo-all

# Git Worktree Workflow

## Create a new worktree

```bash
cd /Users/mike/Project/GitHub
git worktree add ./research-agent-<name> -b <branch-name>
```

## Bootstrap the worktree

```bash
cd research-agent-<name>
bash scripts/worktree-setup.sh
```

This installs Node + Python dependencies and copies `.env.local` from the main worktree.

## Start dev servers

```bash
pnpm dev:worktree
```

Ports are auto-assigned per worktree (unique frontend + backend). The script prints the URLs.

## Start with an IDE

Open the worktree in Antigravity alongside the dev servers:

```bash
pnpm dev:worktree -- --ide agy
```

Supported values: `agy` (Antigravity), `code` (VS Code).

## (Optional) Install auto-setup hook

Run once from any worktree to auto-bootstrap on `git worktree add`:

```bash
bash scripts/worktree-setup.sh --install-hook
```

## List worktrees

```bash
git worktree list
```

## Remove a worktree

```bash
cd /Users/mike/Project/GitHub
git worktree remove research-agent-<name>
git branch -d <branch-name>   # if no longer needed
```

## Common gotchas

- **Shared `.git`**: All worktrees share the same git database. You cannot checkout the same branch in two worktrees.
- **`node_modules` / `.ra-venv`**: These are per-worktree; each worktree needs its own `bash scripts/worktree-setup.sh`.
- **`.env` files**: Copied from the main worktree during setup. Edit the copy in your worktree if you need different values.
- **Ports**: `scripts/dev-worktree.sh` hashes the worktree path to pick unique ports. Override with `FRONTEND_PORT` / `BACKEND_PORT` env vars.
