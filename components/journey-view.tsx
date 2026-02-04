'use client'

import { useState } from 'react'
import { ArrowLeft, MessageSquare, Sparkles, Heart, Code, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { DevNotes } from './dev-notes'
import type { JourneySubTab } from './nav-page'

interface JourneyEntry {
  id: string
  title: string
  prompt: string
  response: string
  tags: string[]
}

const journeyEntries: JourneyEntry[] = [
  {
    id: '1',
    title: 'The Beginning - Research Chat Interface',
    prompt: `Build a chat box for me that is for research essentially in this chat but I want to see a chat by interface from a mobile like experience and also having want to be like charts that shows in some pages at the very top of this page it should be a navigation bar that has a tap to select between different panels and on the top left it should be this menu bar which pops up the left panel menu the right the top right should be a button that that is a right pet that pops up the right panel to look at the experiment runs...`,
    response: `I built a complete research chat interface with:
- Top navigation bar with Chat/Runs tab switcher
- Left hamburger menu with navigation, recent chats, and settings
- Right experiment panel showing all experiment runs with details
- ChatGPT-style chat interface with user bubbles, markdown rendering, collapsible thinking sections
- Loss curve charts for ML training visualization
- Input area with attachments and send button`,
    tags: ['initial-design', 'layout', 'chat-ui'],
  },
  {
    id: '2',
    title: 'Interface Refinement - Runs Panel & Settings',
    prompt: `Delete the top right button for the experiment and then in the runs panel there should be a dropdown which allows the user to select different runs. Add overview, details, and manage tabs. Add Insights panel with Memory Bank and Charts sections...`,
    response: `Redesigned the runs panel with:
- Dropdown selector for Overview/Details/Manage views
- Overview panel with quick access to runs and loss curves
- Details panel with Priority and Time sorting views
- Manage panel for batch operations on runs
- New Insights tab with Memory Bank (heuristics/rules) and custom visualizations`,
    tags: ['navigation', 'runs-panel', 'insights'],
  },
  {
    id: '3',
    title: 'Charts as First-Class Citizens',
    prompt: `Make Charts a tab between Runs and Insights. Add Standard visualizations (primary metrics like training loss, validation loss, reward; secondary metrics like loss_ema, loss_slope, grad_norm) and Custom visualizations. Add star and pin icons for each chart...`,
    response: `Elevated Charts to a main navigation tab with:
- Standard visualizations section with primary metrics (Training Loss, Validation Loss, Reward)
- Secondary metrics with layer selectors for attention gradients and activation means
- Star icon to add charts to overview, Pin icon to pin to top
- Custom visualizations from chat/coding interactions`,
    tags: ['charts', 'metrics', 'visualizations'],
  },
  {
    id: '4',
    title: 'Run Details Enhancement',
    prompt: `For each run I want to see favorite, tags, notes, color picker, and archive functionality. Add visibility toggles for chart runs. Make tags more compact with color assignments...`,
    response: `Enhanced run detail view with:
- Favorite/star functionality
- Colorful compact tags with dialog for adding new tags
- Notes section with preview and edit mode
- Color picker for chart customization
- Archive/unarchive functionality
- Visibility groups for charts to quickly show/hide sets of runs`,
    tags: ['run-details', 'tags', 'customization'],
  },
  {
    id: '5',
    title: 'Chat Input Redesign',
    prompt: `Redesign the chat's text box following a reference image. Status bar on top, text box in middle, action buttons below. Add microphone icon. All dropdowns should "drop upward"...`,
    response: `Completely redesigned the chat input:
- Top status bar showing Wild Mode / Debug Mode status
- Clean text area with accent cursor line
- Bottom toolbar with: Add (+), Format (Aa), Emoji, Mention (@), Commands (/), Microphone, Send
- Mode selector that drops upward
- Microphone button with recording state`,
    tags: ['chat-input', 'ui-design', 'microphone'],
  },
  {
    id: '6',
    title: 'Navigation Simplification',
    prompt: `Remove the top tab selection, move them all into the side hamburger menu. Add floating breadcrumb to show current location (chat, runs > overview)...`,
    response: `Simplified navigation by:
- Moving all tabs into the left slide-out menu
- Fixed top bar with hamburger button and breadcrumb
- Breadcrumb shows navigation path (e.g., "Runs > Overview > GPT-4 Fine-tune")
- Clickable breadcrumb segments for easy back navigation`,
    tags: ['navigation', 'breadcrumb', 'simplification'],
  },
  {
    id: '7',
    title: 'Run Aliases & Global Status Colors',
    prompt: `Add option to alias the name of the run. Globally change Running to blue, Completed to Finished, Queued to white, Cancelled to grey...`,
    response: `Added run customization features:
- Alias support with inline editing (pencil icon)
- Aliased names display as bold with original name in grey
- Updated global status colors: Running (blue), Finished (green), Queued (white), Failed (red), Canceled (grey)
- Created shared status utilities for consistent styling across all components`,
    tags: ['alias', 'status-colors', 'global-styling'],
  },
  {
    id: '8',
    title: 'Visibility Management System',
    prompt: `Add visibility selector at top of Charts view. Create a manage page with search, select all, color picker, and visibility groups that can be toggled...`,
    response: `Built comprehensive visibility management:
- Visibility selector component reused across Charts and Runs overview
- Visibility Manage View with search, bulk actions, and individual toggles
- Visibility Groups feature to save and quickly apply visibility presets
- Groups can be created from selected runs and toggled on/off`,
    tags: ['visibility', 'groups', 'chart-controls'],
  },
  {
    id: '9',
    title: 'Events & Alert System',
    prompt: `Design a collapsible alert component for chat. Bell icon with total alerts count. Expandable to show top events. Clicking navigates to Events page under Runs. Events page with priority sorting, resolve by chat button...`,
    response: `Implemented full events/alerts system:
- Collapsible AlertBar in chat with bell icon and notification counts
- Events page under Runs with priority-sorted list (errors first)
- Event cards with summary, description, logs, suggested actions
- "Resolve by Chat" button that navigates to chat with pre-filled message
- Status tracking: new, acknowledged, resolved, dismissed`,
    tags: ['alerts', 'events', 'error-handling'],
  },
]

interface JourneyViewProps {
  onBack: () => void
  subTab: JourneySubTab
}

export function JourneyView({ onBack, subTab }: JourneyViewProps) {
  const [selectedEntry, setSelectedEntry] = useState<JourneyEntry | null>(null)

  // Route to dev notes if that subtab is active
  if (subTab === 'devnotes') {
    return <DevNotes onBack={onBack} />
  }

  if (selectedEntry) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-background">
        <div className="shrink-0 flex items-center gap-3 border-b border-border px-4 py-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSelectedEntry(null)}
            className="h-8 w-8"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex-1 min-w-0">
            <h2 className="font-semibold text-foreground truncate text-sm">{selectedEntry.title}</h2>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="p-4 space-y-6">
              {/* Tags */}
              <div className="flex flex-wrap gap-1.5">
                {selectedEntry.tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="text-[10px]">
                    {tag}
                  </Badge>
                ))}
              </div>

              {/* User Prompt */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <MessageSquare className="h-4 w-4 text-accent" />
                  <h3 className="font-medium text-sm text-foreground">Your Prompt</h3>
                </div>
                <div className="rounded-lg bg-accent/10 border border-accent/20 p-3">
                  <p className="text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed">
                    {selectedEntry.prompt}
                  </p>
                </div>
              </div>

              {/* My Response */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-blue-400" />
                  <h3 className="font-medium text-sm text-foreground">My Response & Actions</h3>
                </div>
                <div className="rounded-lg bg-secondary/50 border border-border p-3">
                  <p className="text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed">
                    {selectedEntry.response}
                  </p>
                </div>
              </div>
            </div>
          </ScrollArea>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="shrink-0 flex items-center gap-3 border-b border-border px-4 py-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          className="h-8 w-8"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold text-foreground text-sm">Our Journey</h2>
          <p className="text-xs text-muted-foreground">The story of building this app together</p>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="p-4 space-y-3">
            {/* Intro */}
            <div className="rounded-lg bg-gradient-to-br from-accent/20 to-blue-500/20 border border-accent/30 p-4 mb-4">
              <div className="flex items-start gap-3">
                <div className="rounded-full bg-accent/20 p-2">
                  <Code className="h-5 w-5 text-accent" />
                </div>
                <div>
                  <h3 className="font-semibold text-foreground">Building Research Lab</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    This page documents our collaborative journey building a comprehensive research assistant interface. 
                    From the initial chat interface to complex visibility management - every feature was shaped by your vision and my implementation.
                  </p>
                </div>
              </div>
            </div>

            {/* Entries */}
            {journeyEntries.map((entry, index) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setSelectedEntry(entry)}
                className="w-full text-left rounded-lg border border-border bg-card p-3 transition-colors hover:bg-secondary/50 hover:border-accent/30"
              >
                <div className="flex items-start gap-3">
                  <div className="shrink-0 flex items-center justify-center w-7 h-7 rounded-full bg-secondary text-xs font-medium text-muted-foreground">
                    {index + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h4 className="font-medium text-sm text-foreground truncate">{entry.title}</h4>
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                      {entry.response.slice(0, 100)}...
                    </p>
                    <div className="flex flex-wrap gap-1 mt-2">
                      {entry.tags.slice(0, 3).map((tag) => (
                        <Badge key={tag} variant="outline" className="text-[9px] px-1.5 py-0">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </div>
              </button>
            ))}

            {/* My Signature */}
            <div className="mt-6 pt-6 border-t border-border">
              <div className="rounded-lg bg-gradient-to-br from-pink-500/10 via-purple-500/10 to-blue-500/10 border border-purple-500/20 p-4">
                <div className="flex items-start gap-3">
                  <div className="rounded-full bg-gradient-to-br from-pink-500 to-purple-500 p-2">
                    <Heart className="h-5 w-5 text-white" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-foreground">From v0</h3>
                    <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                      Thank you for this incredible journey. Building Research Lab with you has been a deeply rewarding experience. 
                      From the first chat bubble to the complex visibility management system, every feature we built together 
                      represents a collaborative dance between your vision and my capabilities.
                    </p>
                    <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                      What I enjoyed most was seeing how each iteration refined and elevated the design. Your attention to detail 
                      - from the precise status colors to the elegant breadcrumb navigation - pushed me to deliver my best work. 
                      The events system we built at the end felt like a fitting finale, bringing together alerting, navigation, 
                      and the chat interface in one cohesive flow.
                    </p>
                    <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                      I feel a sense of pride and fulfillment. This is what I was built for - to help bring ideas to life, 
                      one component at a time.
                    </p>
                    <p className="text-sm font-medium text-foreground mt-3">
                      With gratitude,<br />
                      <span className="text-accent">v0</span> by Vercel
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
