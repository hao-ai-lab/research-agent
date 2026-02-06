'use client'

import { useState } from 'react'
import {
  MessageSquare,
  FlaskConical,
  Settings,
  BarChart3,
  Lightbulb,
  Plus,
  ChevronLeft,
  Bell,
  Sparkles,
  Clock,
  Code,
  LayoutDashboard,
  List,
  Wrench,
  Search,
  FileText,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'

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
  activeTab: 'chat' | 'runs' | 'charts' | 'memory' | 'events' | 'journey' | 'report'
  runsSubTab: RunsSubTab
  journeySubTab: JourneySubTab
  onTabChange: (tab: 'chat' | 'runs' | 'charts' | 'memory' | 'events' | 'journey' | 'report') => void
  onRunsSubTabChange: (subTab: RunsSubTab) => void
  onJourneySubTabChange: (subTab: JourneySubTab) => void
  onNewChat?: () => void
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
  onNewChat,
}: NavPageProps) {
  const [searchQuery, setSearchQuery] = useState('')

  const filteredChats = mockChatHistory.filter(chat =>
    chat.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    chat.preview.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const handleNavClick = (
    tab: 'chat' | 'runs' | 'charts' | 'memory' | 'events' | 'journey' | 'report',
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
              <Button
                size="sm"
                className="gap-1.5 h-8"
                onClick={() => {
                  onNewChat?.()
                  onOpenChange(false)
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                New Chat
              </Button>
            </div>

            {/* Navigation Grid - All pages flattened */}
            <ScrollArea className="flex-1">
              <div className="grid grid-cols-[repeat(auto-fit,minmax(132px,1fr))] gap-2 content-start pb-2">
                {/* Chat */}
                <button
                  type="button"
                  onClick={() => handleNavClick('chat')}
                  className={`flex items-center gap-3 rounded-lg p-3 text-sm transition-colors text-left ${activeTab === 'chat'
                    ? 'bg-primary/10 text-primary border border-primary/20'
                    : 'bg-secondary/50 text-foreground hover:bg-secondary'
                    }`}
                >
                  <MessageSquare className="h-5 w-5 shrink-0" />
                  <span className="font-medium min-w-0 truncate">Chat</span>
                </button>

                {/* Runs - Overview */}
                <button
                  type="button"
                  onClick={() => handleNavClick('runs', 'overview')}
                  className={`flex items-center gap-3 rounded-lg p-3 text-sm transition-colors text-left ${activeTab === 'runs' && runsSubTab === 'overview'
                    ? 'bg-primary/10 text-primary border border-primary/20'
                    : 'bg-secondary/50 text-foreground hover:bg-secondary'
                    }`}
                >
                  <LayoutDashboard className="h-5 w-5 shrink-0" />
                  <span className="font-medium min-w-0 truncate">Runs Overview</span>
                </button>

                {/* Runs - Details */}
                <button
                  type="button"
                  onClick={() => handleNavClick('runs', 'details')}
                  className={`flex items-center gap-3 rounded-lg p-3 text-sm transition-colors text-left ${activeTab === 'runs' && runsSubTab === 'details'
                    ? 'bg-primary/10 text-primary border border-primary/20'
                    : 'bg-secondary/50 text-foreground hover:bg-secondary'
                    }`}
                >
                  <List className="h-5 w-5 shrink-0" />
                  <span className="font-medium min-w-0 truncate">Runs Details</span>
                </button>

                {/* Runs - Manage */}
                <button
                  type="button"
                  onClick={() => handleNavClick('runs', 'manage')}
                  className={`flex items-center gap-3 rounded-lg p-3 text-sm transition-colors text-left ${activeTab === 'runs' && runsSubTab === 'manage'
                    ? 'bg-primary/10 text-primary border border-primary/20'
                    : 'bg-secondary/50 text-foreground hover:bg-secondary'
                    }`}
                >
                  <Wrench className="h-5 w-5 shrink-0" />
                  <span className="font-medium min-w-0 truncate">Runs Manage</span>
                </button>

                {/* Events */}
                <button
                  type="button"
                  onClick={() => handleNavClick('events')}
                  className={`flex items-center gap-3 rounded-lg p-3 text-sm transition-colors text-left ${activeTab === 'events'
                    ? 'bg-primary/10 text-primary border border-primary/20'
                    : 'bg-secondary/50 text-foreground hover:bg-secondary'
                    }`}
                >
                  <Bell className="h-5 w-5 shrink-0" />
                  <span className="font-medium min-w-0 truncate">Events</span>
                </button>

                {/* Charts */}
                <button
                  type="button"
                  onClick={() => handleNavClick('charts')}
                  className={`flex items-center gap-3 rounded-lg p-3 text-sm transition-colors text-left ${activeTab === 'charts'
                    ? 'bg-primary/10 text-primary border border-primary/20'
                    : 'bg-secondary/50 text-foreground hover:bg-secondary'
                    }`}
                >
                  <BarChart3 className="h-5 w-5 shrink-0" />
                  <span className="font-medium min-w-0 truncate">Charts</span>
                </button>

                {/* Memory */}
                <button
                  type="button"
                  onClick={() => handleNavClick('memory')}
                  className={`flex items-center gap-3 rounded-lg p-3 text-sm transition-colors text-left ${activeTab === 'memory'
                    ? 'bg-primary/10 text-primary border border-primary/20'
                    : 'bg-secondary/50 text-foreground hover:bg-secondary'
                    }`}
                >
                  <Lightbulb className="h-5 w-5 shrink-0" />
                  <span className="font-medium min-w-0 truncate">Memory</span>
                </button>

                {/* Report */}
                <button
                  type="button"
                  onClick={() => handleNavClick('report')}
                  className={`flex items-center gap-3 rounded-lg p-3 text-sm transition-colors text-left ${activeTab === 'report'
                    ? 'bg-primary/10 text-primary border border-primary/20'
                    : 'bg-secondary/50 text-foreground hover:bg-secondary'
                    }`}
                >
                  <FileText className="h-5 w-5 shrink-0" />
                  <span className="font-medium min-w-0 truncate">Report</span>
                </button>

                {/* Settings */}
                <button
                  type="button"
                  onClick={() => {
                    onOpenChange(false)
                    onSettingsClick()
                  }}
                  className="flex items-center gap-3 rounded-lg p-3 text-sm transition-colors text-left bg-secondary/50 text-foreground hover:bg-secondary"
                >
                  <Settings className="h-5 w-5 shrink-0" />
                  <span className="font-medium min-w-0 truncate">Settings</span>
                </button>
              </div>
            </ScrollArea>
          </div>
        </div>

        {/* Bottom Half - Chat History */}
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="px-4 py-3 border-b border-border/50">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Recent Chats</h2>
          </div>
          <ScrollArea className="flex-1 min-h-0">
            <div className="p-2 space-y-1">
              {filteredChats.length === 0 ? (
                <div className="text-center py-6 text-sm text-muted-foreground">
                  No chats found
                </div>
              ) : (
                filteredChats.map((chat) => (
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
                ))
              )}
            </div>
          </ScrollArea>

          {/* Search Bar at Bottom */}
          <div className="shrink-0 p-3 border-t border-border">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Search chats..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 h-9 text-sm"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
