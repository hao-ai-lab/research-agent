# Issue #11: Roadmap - Functional Complete v0

## Overview
This issue tracks the roadmap to reach a functionally complete v0 version of the Research Agent Mobile app.

## Current Priority Status

### Top Priority Items
| Item | Assignee | Status | Notes |
|------|----------|--------|-------|
| Chat Persistency | @GindaChen | ✅ Done | Sessions stored and selectable |
| Serving in public net | @GindaChen | ✅ Done | Server configured |
| Alert System | @ZeonLap | ⏳ Pending | Need to implement alert propagation |
| Agent Prompts | @ZeonLap | ⏳ Pending | Create agent prompt management page |
| Notification on webapp | @GindaChen | ⏳ Pending | Web push or in-app notifications |
| Ralph loop | @GindaChen | 🔄 In Progress | This current work |

### Feature Complete Checklist

#### Chat Features
- [x] Chat session should be persistent
- [x] Chat order is sent correctly
- [ ] User alert - Show a good use case
- [ ] Send alert and handle alert
- [ ] Wild mode integration (maybe openevolve)
- [ ] User Story: RL
- [ ] User Story: Agent Prompting
- [ ] User Story: Diffusion Training
- [ ] Customized data visualization
- [ ] Onboarding user

#### Fixes
- [ ] UX: Show sweep section properly
- [ ] E2E: Collect metrics and show it
- [x] Run: Show charts
- [ ] Run: Show key charts at top
- [ ] Run: Remember if user collapsed/expanded sections

### Cross-Cutting Concerns
- **WeChat integration** - Good to have
- **Claude code integration** - Good to have
- **Cursor/IDE extension** - Good to have
- **Cluster GPU utilization** - Real-time monitoring

## Design Decisions

### Alert System Design
The alert system needs to:
1. Capture run events (error, warning, info)
2. Propagate alerts to chat interface
3. Allow users to acknowledge/dismiss alerts
4. Provide suggested actions

### Notification Strategy
Options:
1. **In-app notifications**: Toast messages, alert badges
2. **Web push notifications**: Browser notifications when app in background
3. **Integration notifications**: Slack, WeChat, Telegram

### Agent Prompts
Need a dedicated page to:
- View current agent prompts
- Edit system prompts
- Version control prompts
- Test prompts in isolation

## Implementation Phases

### Phase 1: Core Features
1. Complete alert system (propagation to chat)
2. Add notification UI (toast, badges)
3. Create agent prompts page

### Phase 2: UX Improvements
1. Sweep section visibility
2. Key charts at top of runs
3. Persist user preferences (collapsed sections)

### Phase 3: User Stories
1. RL training workflow
2. Agent prompting workflow
3. Diffusion training workflow

### Phase 4: Polish
1. Onboarding flow
2. WeChat integration
3. Custom data visualization

## Branch Strategy for Issue #11
```
dev-try-ralph-loop
  ├── ralph/11-alert-system
  ├── ralph/11-notifications
  ├── ralph/11-agent-prompts
  ├── ralph/11-sweep-section
  ├── ralph/11-run-charts-memory
  └── ralph/11-onboarding
```

## Progress Tracking
See `progress.md` for current status.
