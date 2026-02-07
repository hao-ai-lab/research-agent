# Research Agent (Mobile)

Entrypoint:
https://v0-research-agent-mobile.vercel.app/

*Automatically synced with your [v0.app](https://v0.app) deployments*

[![Deployed on Vercel](https://img.shields.io/badge/Deployed%20on-Vercel-black?style=for-the-badge&logo=vercel)](https://vercel.com/ginda-chens-projects/v0-research-agent-mobile)
[![Built with v0](https://img.shields.io/badge/Built%20with-v0.app-black?style=for-the-badge)](https://v0.app/chat/qiOhfSFJC0s)

## Overview

This repository will stay in sync with your deployed chats on [v0.app](https://v0.app).
Any changes you make to your deployed app will be automatically pushed to this repository from [v0.app](https://v0.app).

## Deployment

Your project is live at:

**[https://vercel.com/ginda-chens-projects/v0-research-agent-mobile](https://vercel.com/ginda-chens-projects/v0-research-agent-mobile)**

## Build your app

Continue building your app on:

**[https://v0.app/chat/qiOhfSFJC0s](https://v0.app/chat/qiOhfSFJC0s)**

## How It Works

1. Create and modify your project using [v0.app](https://v0.app)
2. Deploy your chats from the v0 interface
3. Changes are automatically pushed to this repository
4. Vercel deploys the latest version from this repository

## Local Dev (Worktree-Safe)

Run frontend + backend together with per-worktree isolated ports:

```bash
npm run dev:worktree
```

Notes:
- Frontend and backend ports are derived from the worktree path.
- `NEXT_PUBLIC_API_URL` is set automatically to the matching backend port.
- tmux session name is unique per worktree.

Optional overrides:

```bash
FRONTEND_PORT=3101 BACKEND_PORT=10101 npm run dev:worktree
START_BACKEND=0 npm run dev:worktree
START_FRONTEND=0 npm run dev:worktree
```
