---
description: how to create, run, and manage git worktrees for parallel development
---

// turbo-all

# Git Worktree Workflow

## One-command setup

```bash
pnpm worktree:new <branch> [--ide agy] [--start]
```

This single command:

1. Reads `WORKTREE_ROOT` from `.env.worktree` (defaults to parent dir)
2. Creates `$WORKTREE_ROOT/research-agent-<branch>/`
3. Bootstraps Node + Python dependencies
4. Copies `.env.local` from the main worktree
5. Optionally opens an IDE and/or starts dev servers

### Examples

```bash
# Create worktree and open Antigravity
pnpm worktree:new feat-alerts --ide agy

# Create, bootstrap, and start dev servers
pnpm worktree:new feat-alerts --start

# Both
pnpm worktree:new feat-alerts --ide agy --start
```

## Configure worktree root

Create `.env.worktree` at the repo root (gitignored):

```bash
WORKTREE_ROOT=/Users/mike/Project/GitHub
```

## Start dev servers in an existing worktree

```bash
cd /path/to/worktree
pnpm dev:worktree             # auto-assigns unique ports
pnpm dev:worktree -- --ide agy  # also opens Antigravity
```

## List / remove worktrees

```bash
git worktree list
git worktree remove <path>
git branch -d <branch>   # if no longer needed
```

## Common gotchas

- **Shared `.git`**: All worktrees share the same git database. You cannot checkout the same branch in two worktrees.
- **`node_modules` / `.ra-venv`**: Per-worktree; the setup script handles this automatically.
- **`.env` files**: Copied from the main worktree during setup. Edit the copy if you need different values.
- **Ports**: Hash-based unique ports per worktree. Override with `FRONTEND_PORT` / `BACKEND_PORT` env vars.
