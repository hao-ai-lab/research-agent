'use client'

import {
  MessageSquare,
  FlaskConical,
  Settings,
  HelpCircle,
  BarChart3,
  Lightbulb,
  Plus,
  ChevronLeft,
  Bell,
  Sparkles,
  Clock,
  Code,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'

export type RunsSubTab = 'overview' | 'details' | 'manage'
export type JourneySubTab = 'story' | 'devnotes'

// Mock chat history data
const mockChatHistory = [
  {
    id: 'chat-1',
    title: 'GPT-4 Fine-tuning Analysis',
    preview: 'Can you analyze the loss curve for my GPT-4 fine-tuning run?',
    timestamp: new Date(Date.now() - 10 * 60 * 1000),
    messageCount: 8,
  },
  {
    id: 'chat-2',
    title: 'Hyperparameter Optimization',
    preview: 'What learning rate should I use for my transformer model?',
    timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000),
    messageCount: 12,
  },
  {
    id: 'chat-3',
    title: 'Debugging OOM Errors',
    preview: 'My training keeps running out of memory on the A100...',
    timestamp: new Date(Date.now() - 24 * 60 * 60 * 1000),
    messageCount: 15,
  },
  {
    id: 'chat-4',
    title: 'Dataset Preprocessing',
    preview: 'How should I tokenize my dataset for BERT fine-tuning?',
    timestamp: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    messageCount: 6,
  },
  {
    id: 'chat-5',
    title: 'Model Comparison',
    preview: 'Compare the performance of GPT-3.5 vs GPT-4 on my task',
    timestamp: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    messageCount: 20,
  },
]

interface NavPageProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSettingsClick: () => void
  activeTab: 'chat' | 'runs' | 'charts' | 'insights' | 'events' | 'journey'
  runsSubTab: RunsSubTab
  journeySubTab: JourneySubTab
  onTabChange: (tab: 'chat' | 'runs' | 'charts' | 'insights' | 'events' | 'journey') => void
  onRunsSubTabChange: (subTab: RunsSubTab) => void
  onJourneySubTabChange: (subTab: JourneySubTab) => void
}

export function NavPage({
  open,
  onOpenChange,
  onSettingsClick,
  activeTab,
  runsSubTab,
  journeySubTab,
  onTabChange,
  onRunsSubTabChange,
  onJourneySubTabChange,
}: NavPageProps) {
  const handleNavClick = (
    tab: 'chat' | 'runs' | 'charts' | 'insights' | 'events' | 'journey',
    subTab?: RunsSubTab | JourneySubTab
  ) => {
    onTabChange(tab)
    if (tab === 'runs' && subTab) {
      onRunsSubTabChange(subTab as RunsSubTab)
    }
    if (tab === 'journey' && subTab) {
      onJourneySubTabChange(subTab as JourneySubTab)
    }
    onOpenChange(false)
  }

  const formatRelativeTime = (date: Date) => {
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / (1000 * 60))
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays < 7) return `${diffDays}d ago`
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col animate-in slide-in-from-left duration-200">
      {/* Header */}
      <header className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <FlaskConical className="h-5 w-5 text-primary" />
            <span className="font-semibold text-foreground">Research Lab</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            className="gap-2"
          >
            <ChevronLeft className="h-4 w-4" />
            Back
          </Button>
        </div>
      </header>

      {/* Main Content - Split into two halves */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top Half - Navigation Pages */}
        <div className="flex-1 min-h-0 border-b border-border">
          <div className="p-4 h-full flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Pages</h2>
              <Button size="sm" className="gap-1.5 h-8">
                <Plus className="h-3.5 w-3.5" />
                New Chat
              </Button>
            </div>
            
            {/* Navigation Grid */}
            <div className="grid grid-cols-2 gap-2 flex-1 content-start">
              {/* Chat */}
              <button
                type="button"
                onClick={() => handleNavClick('chat')}
                className={`flex items-center gap-3 rounded-lg p-3 text-sm transition-colors text-left ${
                  activeTab === 'chat'
                    ? 'bg-primary/10 text-primary border border-primary/20'
                    : 'bg-secondary/50 text-foreground hover:bg-secondary'
                }`}
              >
                <MessageSquare className="h-5 w-5 shrink-0" />
                <span className="font-medium">Chat</span>
              </button>

              {/* Runs */}
              <button
                type="button"
                onClick={() => handleNavClick('runs', 'overview')}
                className={`flex items-center gap-3 rounded-lg p-3 text-sm transition-colors text-left ${
                  activeTab === 'runs'
                    ? 'bg-primary/10 text-primary border border-primary/20'
                    : 'bg-secondary/50 text-foreground hover:bg-secondary'
                }`}
              >
                <FlaskConical className="h-5 w-5 shrink-0" />
                <span className="font-medium">Runs</span>
              </button>

              {/* Events */}
              <button
                type="button"
                onClick={() => handleNavClick('events')}
                className={`flex items-center gap-3 rounded-lg p-3 text-sm transition-colors text-left ${
                  activeTab === 'events'
                    ? 'bg-primary/10 text-primary border border-primary/20'
                    : 'bg-secondary/50 text-foreground hover:bg-secondary'
                }`}
              >
                <Bell className="h-5 w-5 shrink-0" />
                <span className="font-medium">Events</span>
              </button>

              {/* Charts */}
              <button
                type="button"
                onClick={() => handleNavClick('charts')}
                className={`flex items-center gap-3 rounded-lg p-3 text-sm transition-colors text-left ${
                  activeTab === 'charts'
                    ? 'bg-primary/10 text-primary border border-primary/20'
                    : 'bg-secondary/50 text-foreground hover:bg-secondary'
                }`}
              >
                <BarChart3 className="h-5 w-5 shrink-0" />
                <span className="font-medium">Charts</span>
              </button>

              {/* Insights */}
              <button
                type="button"
                onClick={() => handleNavClick('insights')}
                className={`flex items-center gap-3 rounded-lg p-3 text-sm transition-colors text-left ${
                  activeTab === 'insights'
                    ? 'bg-primary/10 text-primary border border-primary/20'
                    : 'bg-secondary/50 text-foreground hover:bg-secondary'
                }`}
              >
                <Lightbulb className="h-5 w-5 shrink-0" />
                <span className="font-medium">Insights</span>
              </button>

              {/* Journey */}
              <button
                type="button"
                onClick={() => handleNavClick('journey', 'story')}
                className={`flex items-center gap-3 rounded-lg p-3 text-sm transition-colors text-left ${
                  activeTab === 'journey'
                    ? 'bg-primary/10 text-primary border border-primary/20'
                    : 'bg-secondary/50 text-foreground hover:bg-secondary'
                }`}
              >
                <Sparkles className="h-5 w-5 shrink-0" />
                <span className="font-medium">Journey</span>
              </button>
            </div>

            {/* Quick Actions Row */}
            <div className="flex gap-2 mt-4 pt-3 border-t border-border/50">
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false)
                  onSettingsClick()
                }}
                className="flex items-center gap-2 px-3 py-2 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
              >
                <Settings className="h-3.5 w-3.5" />
                Settings
              </button>
              <button
                type="button"
                className="flex items-center gap-2 px-3 py-2 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
              >
                <HelpCircle className="h-3.5 w-3.5" />
                Help
              </button>
              <button
                type="button"
                onClick={() => handleNavClick('journey', 'devnotes')}
                className="flex items-center gap-2 px-3 py-2 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
              >
                <Code className="h-3.5 w-3.5" />
                Dev Notes
              </button>
            </div>
          </div>
        </div>

        {/* Bottom Half - Chat History */}
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="px-4 py-3 border-b border-border/50">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Recent Chats</h2>
          </div>
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-1">
              {mockChatHistory.map((chat) => (
                <button
                  key={chat.id}
                  type="button"
                  onClick={() => handleNavClick('chat')}
                  className="w-full text-left p-3 rounded-lg hover:bg-secondary/50 transition-colors group"
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <h3 className="font-medium text-sm text-foreground truncate group-hover:text-primary transition-colors">
                      {chat.title}
                    </h3>
                    <span className="text-[10px] text-muted-foreground shrink-0 flex items-center gap-1" suppressHydrationWarning>
                      <Clock className="h-3 w-3" />
                      {formatRelativeTime(chat.timestamp)}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground truncate mb-1.5">
                    {chat.preview}
                  </p>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground/70">
                      {chat.messageCount} messages
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>
  )
}
