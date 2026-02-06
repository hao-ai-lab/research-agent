# Issue #15: Onboarding Experience

## Overview
Create a smooth onboarding experience that minimizes setup friction and guides users to their first successful research workflow.

## UX Goals
1. **Minimize user setup** - Reduce configuration steps
2. **Get accurate user goal** - Understand what research they're conducting
3. **First step guidance** - Ensure users know how to begin
4. **Effortless server setup** - Easy integration with Slack/WeChat if needed
5. **Balance AI autopilot vs manual control** - Smart defaults with override options

## Current Approach
Currently relies heavily on the bot for onboarding. Need to evaluate if this is the right approach.

## Design Decisions

### Onboarding Flow Options

#### Option A: Bot-Driven (Current)
- AI bot asks questions
- Guides through setup
- Pros: Conversational, flexible
- Cons: Requires backend, slower

#### Option B: Guided Wizard
- Step-by-step forms
- Clear progress indicators
- Pros: Fast, works offline, predictable
- Cons: Less flexible

#### Option C: Hybrid
- Start with quick wizard for basics
- Bot for advanced configuration
- Pros: Best of both worlds
- Cons: More complex to implement

### Recommended: Hybrid Approach

#### Phase 1: Quick Start (1-2 minutes)
1. Welcome screen with value proposition
2. Research goal selection (RL, Diffusion, etc.)
3. Server connection (local vs cloud)
4. Auth setup (if needed)

#### Phase 2: First Run (Optional, bot-assisted)
1. Bot suggests first experiment based on goal
2. Guides through sweep or single run setup
3. Shows how to monitor and analyze

#### Phase 3: Integration Setup (Optional)
1. Slack/WeChat notification setup
2. Advanced settings

## Key Features Needed

### 1. Welcome Screen
- App value proposition
- Quick tour option
- Skip for experienced users

### 2. Goal Selection
Categories:
- Reinforcement Learning
- Diffusion Models
- LLM Fine-tuning
- Computer Vision
- Custom/Other

### 3. Server Setup Helper
- Auto-detect local server
- Cloud deployment guides
- Connection testing

### 4. Progressive Disclosure
- Show basic options first
- "Advanced" toggle for power users
- Contextual help tooltips

### 5. Environment Verification
- Check Python environment
- Verify requirements.txt
- Suggest missing dependencies

## Implementation Plan

### Phase 1: Basic Onboarding
1. Create `OnboardingDialog` component
2. Add welcome screen with goal selection
3. Implement server connection flow
4. Add completion celebration

### Phase 2: Smart Defaults
1. Auto-configure based on goal selection
2. Suggest first experiment
3. Pre-fill common sweep configs

### Phase 3: Integration
1. Add Slack/WeChat setup
2. Notification preferences
3. Advanced settings access

## Branch Strategy
```
dev-try-ralph-loop
  ├── ralph/15-onboarding-dialog
  ├── ralph/15-goal-selection
  ├── ralph/15-server-setup-helper
  └── ralph/15-environment-check
```

## Success Metrics
- Time to first experiment < 3 minutes
- User completes onboarding > 80%
- First experiment runs successfully > 70%
