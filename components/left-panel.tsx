'use client'

import {
  MessageSquare,
  FlaskConical,
  Settings,
  HelpCircle,
  BarChart3,
  Lightbulb,
  Plus,
  ChevronRight,
  LayoutDashboard,
  List,
  Wrench,
  Bell,
  Sparkles,
} from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { useState } from 'react'

export type RunsSubTab = 'overview' | 'details' | 'manage' | 'events'

interface LeftPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSettingsClick: () => void
  activeTab: 'chat' | 'runs' | 'charts' | 'insights' | 'journey'
  runsSubTab: RunsSubTab
  onTabChange: (tab: 'chat' | 'runs' | 'charts' | 'insights' | 'journey') => void
  onRunsSubTabChange: (subTab: RunsSubTab) => void
}

export function LeftPanel({ 
  open, 
  onOpenChange, 
  onSettingsClick,
  activeTab,
  runsSubTab,
  onTabChange,
  onRunsSubTabChange,
}: LeftPanelProps) {
  const [runsExpanded, setRunsExpanded] = useState(activeTab === 'runs')

  const handleNavClick = (tab: 'chat' | 'runs' | 'charts' | 'insights' | 'journey', subTab?: RunsSubTab) => {
    onTabChange(tab)
    if (tab === 'runs' && subTab) {
      onRunsSubTabChange(subTab)
    }
    onOpenChange(false)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-[280px] p-0">
        <SheetHeader className="border-b border-border p-4">
          <SheetTitle className="flex items-center gap-2 text-left">
            <FlaskConical className="h-5 w-5 text-accent" />
            Research Lab
          </SheetTitle>
        </SheetHeader>

        <div className="flex flex-col h-[calc(100%-65px)]">
          <div className="p-4">
            <Button className="w-full gap-2 bg-accent text-accent-foreground hover:bg-accent/90">
              <Plus className="h-4 w-4" />
              New Chat
            </Button>
          </div>

          <nav className="flex-1 overflow-y-auto px-2">
            <div className="space-y-1">
              {/* Chat */}
              <button
                type="button"
                onClick={() => handleNavClick('chat')}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                  activeTab === 'chat'
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                }`}
              >
                <MessageSquare className="h-4 w-4" />
                Chat
              </button>

              {/* Runs with sub-navigation */}
              <Collapsible open={runsExpanded} onOpenChange={setRunsExpanded}>
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                      activeTab === 'runs'
                        ? 'bg-secondary text-foreground'
                        : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                    }`}
                  >
                    <FlaskConical className="h-4 w-4" />
                    <span className="flex-1 text-left">Runs</span>
                    <ChevronRight 
                      className={`h-4 w-4 transition-transform ${runsExpanded ? 'rotate-90' : ''}`} 
                    />
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="ml-4 mt-1 space-y-1 border-l border-border pl-3">
                    <button
                      type="button"
                      onClick={() => handleNavClick('runs', 'overview')}
                      className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                        activeTab === 'runs' && runsSubTab === 'overview'
                          ? 'bg-secondary/70 text-foreground'
                          : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                      }`}
                    >
                      <LayoutDashboard className="h-3.5 w-3.5" />
                      Overview
                    </button>
                    <button
                      type="button"
                      onClick={() => handleNavClick('runs', 'details')}
                      className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                        activeTab === 'runs' && runsSubTab === 'details'
                          ? 'bg-secondary/70 text-foreground'
                          : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                      }`}
                    >
                      <List className="h-3.5 w-3.5" />
                      Details
                    </button>
                    <button
                      type="button"
                      onClick={() => handleNavClick('runs', 'manage')}
                      className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                        activeTab === 'runs' && runsSubTab === 'manage'
                          ? 'bg-secondary/70 text-foreground'
                          : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                      }`}
                    >
                      <Wrench className="h-3.5 w-3.5" />
                      Manage
                    </button>
                    <button
                      type="button"
                      onClick={() => handleNavClick('runs', 'events')}
                      className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                        activeTab === 'runs' && runsSubTab === 'events'
                          ? 'bg-secondary/70 text-foreground'
                          : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                      }`}
                    >
                      <Bell className="h-3.5 w-3.5" />
                      Events
                    </button>
                  </div>
                </CollapsibleContent>
              </Collapsible>

              {/* Charts */}
              <button
                type="button"
                onClick={() => handleNavClick('charts')}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                  activeTab === 'charts'
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                }`}
              >
                <BarChart3 className="h-4 w-4" />
                Charts
              </button>

              {/* Insights */}
              <button
                type="button"
                onClick={() => handleNavClick('insights')}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                  activeTab === 'insights'
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                }`}
              >
                <Lightbulb className="h-4 w-4" />
                Insights
              </button>
            </div>
          </nav>

          <Separator />

          <div className="p-2">
            <button
              type="button"
              onClick={() => {
                onOpenChange(false)
                onSettingsClick()
              }}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <Settings className="h-4 w-4" />
              Settings
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <HelpCircle className="h-4 w-4" />
              Help & Support
            </button>
            <button
              type="button"
              onClick={() => handleNavClick('journey')}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                activeTab === 'journey'
                  ? 'bg-secondary text-foreground'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
              }`}
            >
              <Sparkles className="h-4 w-4" />
              Our Journey
            </button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
