# CLAUDE.md

This file provides guidance for AI assistants working with this codebase.

## Project Overview

**Research Agent Mobile** is a Next.js web application designed as an AI-powered research assistant for ML experiment tracking. It provides a mobile-first interface for monitoring training runs, analyzing metrics, chatting with an AI assistant, and managing hyperparameter sweeps.

## Tech Stack

- **Framework**: Next.js 16 with App Router
- **React**: React 19
- **Styling**: Tailwind CSS 4.x with OKLCH color system
- **UI Components**: shadcn/ui (Radix primitives + custom styling)
- **TypeScript**: Strict mode enabled
- **Package Manager**: pnpm
- **Deployment**: Vercel (synced with v0.app)

## Project Structure

```
├── app/                    # Next.js App Router
│   ├── globals.css         # Global styles & CSS variables (OKLCH colors)
│   ├── layout.tsx          # Root layout with Geist fonts
│   └── page.tsx            # Main application entry point
├── components/             # React components
│   ├── ui/                 # 57 shadcn/ui base components
│   └── *.tsx               # 29 custom feature components
├── lib/                    # Utilities and types
│   ├── types.ts            # TypeScript type definitions
│   ├── mock-data.ts        # Mock data for development
│   ├── status-utils.ts     # Status helper functions
│   └── utils.ts            # General utilities (cn function)
└── hooks/                  # Custom React hooks
    ├── use-mobile.ts       # Mobile detection hook
    └── use-toast.ts        # Toast notification hook
```

## Key Commands

```bash
# Development server
npm run dev

# Production build
npm run build

# Start production server
npm start

# Run linting
npm run lint
```

## Architecture Overview

### Main Views (Tabs)

The app uses a tab-based navigation system defined in `app/page.tsx`:

| Tab | Component | Purpose |
|-----|-----------|---------|
| Chat | `ChatView` | AI assistant chat with experiment context |
| Runs | `RunsView` | Experiment run management (overview/details/manage) |
| Charts | `ChartsView` | Metric visualization with customizable charts |
| Insights | `InsightsView` | Memory rules and heuristics management |
| Events | `EventsView` | Alerts and run events with priority filtering |
| Journey | `JourneyView` | Development journey documentation |
| Report | `ReportView` | Automated experiment reports |

### Core Types (lib/types.ts)

- `ExperimentRun` - Training run with status, metrics, config, artifacts
- `Sweep` / `SweepConfig` - Hyperparameter sweep configuration
- `ChatMessage` - Messages with optional charts and sweep configs
- `RunEvent` - Alerts with priority, status, and suggested actions
- `InsightChart` - User-created visualization charts
- `MemoryRule` - Persistent heuristics for the AI assistant

### State Management

All state is managed locally in `app/page.tsx` using React hooks:
- No external state management library
- Mock data from `lib/mock-data.ts` for development
- State passed down via props to child components

## Styling Guidelines

### Color System

The app uses OKLCH colors defined in `app/globals.css`:
- Dark theme by default (`class="dark"` on html element)
- CSS variables for semantic colors (background, foreground, accent, etc.)
- Chart colors: `--chart-1` through `--chart-5`

### Component Styling

- Use Tailwind CSS utility classes
- Use `cn()` utility from `lib/utils.ts` for conditional classes
- shadcn/ui components in `components/ui/` follow consistent patterns

## Development Notes

### Mobile-First Design

The app is designed mobile-first with:
- Minimum viewport: 300x644px
- Responsive scaling for very small screens
- Touch-friendly interactions

### Path Aliases

The `@/` alias maps to the project root (configured in `tsconfig.json`):
```typescript
import { Button } from '@/components/ui/button'
import { ExperimentRun } from '@/lib/types'
```

### TypeScript

- Strict mode enabled
- Build errors currently ignored in `next.config.mjs`
- Types defined centrally in `lib/types.ts`

## Common Patterns

### Creating a New View Component

```tsx
'use client'

import { useState } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { ExperimentRun } from '@/lib/types'

interface MyViewProps {
  runs: ExperimentRun[]
  onUpdateRun?: (run: ExperimentRun) => void
}

export function MyView({ runs, onUpdateRun }: MyViewProps) {
  const [selectedRun, setSelectedRun] = useState<ExperimentRun | null>(null)
  
  return (
    <ScrollArea className="h-full">
      {/* View content */}
    </ScrollArea>
  )
}
```

### Using UI Components

The project uses shadcn/ui components. Common imports:
```tsx
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
```

## Testing

No test framework is currently configured. Consider adding:
- Jest or Vitest for unit tests
- React Testing Library for component tests
- Playwright for E2E tests

## Deployment

The project auto-deploys via Vercel when changes are pushed to the repository than it syncs from v0.app deployments.
