'use client'

import { useState } from 'react'
import {
  MessageSquare,
  FlaskConical,
  Settings,
  BarChart3,
  Lightbulb,
  Plus,
  X,
  Bell,
  Sparkles,
  Clock,
  Code,
  LayoutDashboard,
  Search,
  FileText,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import type { ChatSession } from '@/lib/api'

export type JourneySubTab = 'story' | 'devnotes'

interface NavPageProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSettingsClick: () => void
  activeTab: 'chat' | 'runs' | 'charts' | 'memory' | 'events' | 'journey' | 'report'
  journeySubTab: JourneySubTab
  onTabChange: (tab: 'chat' | 'runs' | 'charts' | 'memory' | 'events' | 'journey' | 'report') => void
  onJourneySubTabChange: (subTab: JourneySubTab) => void
  onNewChat?: () => void
  // Real sessions from backend
  sessions?: ChatSession[]
  onSelectSession?: (sessionId: string) => void
}

export function NavPage({
  open,
  onOpenChange,
  onSettingsClick,
  activeTab,
  journeySubTab,
  onTabChange,
  onJourneySubTabChange,
  onNewChat,
  sessions = [],
  onSelectSession,
}: NavPageProps) {
  const [searchQuery, setSearchQuery] = useState('')

  // Filter sessions based on search query
  const filteredSessions = sessions.filter(session =>
    session.title.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const handleNavClick = (
    tab: 'chat' | 'runs' | 'charts' | 'memory' | 'events' | 'journey' | 'report',
    subTab?: JourneySubTab
  ) => {
    onTabChange(tab)
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
    <div className="fixed inset-0 z-50 lg:hidden">
      <button
        type="button"
        aria-label="Close navigation"
        onClick={() => onOpenChange(false)}
        className="absolute inset-0 bg-black/28 backdrop-blur-[2px]"
      />

      <aside className="absolute inset-y-0 left-0 flex w-[86vw] max-w-[360px] flex-col border-r border-border/80 bg-sidebar/95 shadow-2xl animate-in slide-in-from-left duration-200">
        <header className="shrink-0 border-b border-border/80 px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <FlaskConical className="h-5 w-5 text-primary" />
              <span className="font-semibold text-foreground">Research Lab</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onOpenChange(false)}
              className="h-8 w-8"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </header>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-5 p-3">
            <section>
              <Button
                size="sm"
                className="mb-3 h-8 w-full justify-start gap-1.5"
                onClick={() => {
                  onNewChat?.()
                  onOpenChange(false)
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                New Chat
              </Button>

              <div className="space-y-1">
                <button
                  type="button"
                  onClick={() => handleNavClick('chat')}
                  className={`flex w-full items-center gap-3 rounded-lg p-2.5 text-sm transition-colors text-left ${activeTab === 'chat'
                    ? 'bg-card text-foreground border border-border/80 shadow-xs'
                    : 'text-foreground hover:bg-secondary'
                    }`}
                >
                  <MessageSquare className="h-4 w-4 shrink-0" />
                  <span className="font-medium min-w-0 truncate">Chat</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleNavClick('runs')}
                  className={`flex w-full items-center gap-3 rounded-lg p-2.5 text-sm transition-colors text-left ${activeTab === 'runs'
                    ? 'bg-card text-foreground border border-border/80 shadow-xs'
                    : 'text-foreground hover:bg-secondary'
                    }`}
                >
                  <LayoutDashboard className="h-4 w-4 shrink-0" />
                  <span className="font-medium min-w-0 truncate">Runs</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleNavClick('events')}
                  className={`flex w-full items-center gap-3 rounded-lg p-2.5 text-sm transition-colors text-left ${activeTab === 'events'
                    ? 'bg-card text-foreground border border-border/80 shadow-xs'
                    : 'text-foreground hover:bg-secondary'
                    }`}
                >
                  <Bell className="h-4 w-4 shrink-0" />
                  <span className="font-medium min-w-0 truncate">Events</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleNavClick('charts')}
                  className={`flex w-full items-center gap-3 rounded-lg p-2.5 text-sm transition-colors text-left ${activeTab === 'charts'
                    ? 'bg-card text-foreground border border-border/80 shadow-xs'
                    : 'text-foreground hover:bg-secondary'
                    }`}
                >
                  <BarChart3 className="h-4 w-4 shrink-0" />
                  <span className="font-medium min-w-0 truncate">Charts</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleNavClick('memory')}
                  className={`flex w-full items-center gap-3 rounded-lg p-2.5 text-sm transition-colors text-left ${activeTab === 'memory'
                    ? 'bg-card text-foreground border border-border/80 shadow-xs'
                    : 'text-foreground hover:bg-secondary'
                    }`}
                >
                  <Lightbulb className="h-4 w-4 shrink-0" />
                  <span className="font-medium min-w-0 truncate">Memory</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleNavClick('report')}
                  className={`flex w-full items-center gap-3 rounded-lg p-2.5 text-sm transition-colors text-left ${activeTab === 'report'
                    ? 'bg-card text-foreground border border-border/80 shadow-xs'
                    : 'text-foreground hover:bg-secondary'
                    }`}
                >
                  <FileText className="h-4 w-4 shrink-0" />
                  <span className="font-medium min-w-0 truncate">Report</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onOpenChange(false)
                    onSettingsClick()
                  }}
                  className="flex w-full items-center gap-3 rounded-lg p-2.5 text-sm transition-colors text-left text-foreground hover:bg-secondary"
                >
                  <Settings className="h-4 w-4 shrink-0" />
                  <span className="font-medium min-w-0 truncate">Settings</span>
                </button>
              </div>
            </section>

            <section>
              <h2 className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Recent Chats</h2>

              <div className="relative mb-2">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  type="text"
                  placeholder="Search chats..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="h-8 pl-8 text-xs"
                />
              </div>

              <div className="space-y-1">
                {filteredSessions.length === 0 ? (
                  <div className="rounded-lg px-2 py-4 text-center text-xs text-muted-foreground">
                    {sessions.length === 0 ? 'No chat history' : 'No chats found'}
                  </div>
                ) : (
                  filteredSessions.map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      onClick={() => {
                        if (onSelectSession) {
                          onSelectSession(session.id)
                        }
                        onOpenChange(false)
                      }}
                      className="w-full rounded-lg p-2.5 text-left transition-colors hover:bg-secondary"
                    >
                      <div className="mb-0.5 flex items-start justify-between gap-2">
                        <h3 className="truncate text-sm font-medium text-foreground">
                          {session.title}
                        </h3>
                        <span className="shrink-0 flex items-center gap-1 text-[10px] text-muted-foreground" suppressHydrationWarning>
                          <Clock className="h-3 w-3" />
                          {formatRelativeTime(new Date(session.created_at * 1000))}
                        </span>
                      </div>
                      <span className="text-[10px] text-muted-foreground/70">
                        {session.message_count} messages
                      </span>
                    </button>
                  ))
                )}
              </div>
            </section>
          </div>
        </ScrollArea>
      </aside>
    </div>
  )
}
