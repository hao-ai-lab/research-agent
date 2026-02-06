# Issue #8: UI and Functional Enhancement

## Overview
Comprehensive list of UI improvements and functional enhancements for better user experience.

## Issues Breakdown by Category

### 1. Overall / Layout
- [ ] Mobile view min-width doesn't conform to viewport query - overflows to right
- [ ] FE: Make user able to tune the frontend UI layout
- [ ] FE: Add desktop-friendly layout

### 2. Chat Improvements
- [x] Add queue, allow user to queue messages
- [x] Make items across queues moveable
- [ ] BE: Refactor chat data format - properly store sequence of model (think, tool, think, tool, text)
- [ ] FE+BE: Make sequence (think, tool, think, tool, text) render properly
- [ ] FE+BE: Add chat title and show it properly
- [ ] FE: Clicking chat title shows dropdown list of chats
- [ ] FE+BE: Add tag to chat, add favorite to chat
- [ ] FE: Add setting to toggle markdown/MathTex rendering
- [ ] FE: Add code highlighting
- [ ] FE: Add copy button in codeblock (disabled when editing)
- [ ] FE: Add quote feature
- [ ] FE: Add queue interruptability
- [ ] FE: Add page to view/modify agent prompt text
- [ ] FE: Add git-tree like visualization
- [ ] E2E: Add chat summary
- [ ] FE: Guide user to choose next step
- [ ] FE: Running tools detail view

### 3. Alert Integration
- [ ] FE: Should alert get propagated to chat?

### 4. Run / Sweep
- [ ] FE+BE: Make sweep easy to use
- [ ] FE+BE: Add run/stop buttons to run
- [ ] FE+BE: At run, monitor metrics properly

### 5. Settings
- [ ] FE: After entering auth, settings page still shows red failed banner
- [ ] FE: Server URL test connection pings localhost relative to frontend, not server

### 6. Charts
- [ ] Add button to add charts
- [ ] (+ chat) Use AI to add chart - AI defines metrics, edits code, adds chart spec
- [ ] Add setting button - "Toggle visibility" should be in settings
- [x] "Toggle visibility" should be expandable, add manage popup
- [ ] Add custom charts: video comparison @ step n, data mixture hexagon, etc.

### 7. Onboard
- [ ] Check creation of environment / requirements

### 8. Menu
- [ ] Categorize left-panel page items by functionality, use tabs

### 9. Integration
- [ ] Claude Agent SDK: https://platform.claude.com/docs/en/agent-sdk/overview

### 10. Auth and Security
- [ ] Use OAuth (Google/GitHub) for server auth

### 11. Bigger Features
- [ ] File viewer
- [ ] Review Changes
- [ ] Auto version control

## Design Decisions

### Mobile/Desktop Layout
- Implement responsive breakpoints
- Mobile: 300px+ min-width with scaling
- Desktop: Full layout with sidebar

### Chat Data Format Refactor
Current: `(content, thinking)` - limited
Target: Array of parts with type tracking:
```typescript
parts: [
  { type: 'thinking', content: '...' },
  { type: 'tool', toolName: '...', toolState: '...', content: '...' },
  { type: 'text', content: '...' }
]
```

### Code Block Features
- Syntax highlighting via PrismJS or similar
- Copy button with state (idle/copying/copied)
- Line numbers option
- Language detection

### Custom Charts
Need extensible chart system for:
- Video frame comparison
- Multi-dimensional data (hexagon/radar)
- Custom visualizations

## Implementation Priority

### High Priority
1. Mobile overflow fix (critical UX issue)
2. Chat data format refactor (blocks other features)
3. Code highlighting and copy buttons

### Medium Priority
1. Desktop layout
2. Alert propagation to chat
3. Run/stop buttons

### Low Priority
1. OAuth integration
2. Claude Agent SDK
3. Advanced custom charts

## Branch Strategy
```
dev-try-ralph-loop
  ├── ralph/8-mobile-overflow-fix
  ├── ralph/8-chat-data-format
  ├── ralph/8-code-highlighting
  ├── ralph/8-desktop-layout
  ├── ralph/8-alert-chat-propagation
  └── ralph/8-run-controls
```
