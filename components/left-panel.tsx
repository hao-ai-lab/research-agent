'use client'

import {
  MessageSquare,
  FlaskConical,
  Settings,
  HelpCircle,
  BarChart3,
  Lightbulb,
  Plus,
  LayoutDashboard,
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

interface LeftPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSettingsClick: () => void
  activeTab: 'chat' | 'runs' | 'charts' | 'insights' | 'journey'
  onTabChange: (tab: 'chat' | 'runs' | 'charts' | 'insights' | 'journey') => void
}

export function LeftPanel({ 
  open, 
  onOpenChange, 
  onSettingsClick,
  activeTab,
  onTabChange,
}: LeftPanelProps) {
  const handleNavClick = (tab: 'chat' | 'runs' | 'charts' | 'insights' | 'journey') => {
    onTabChange(tab)
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

              {/* Runs */}
              <button
                type="button"
                onClick={() => handleNavClick('runs')}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                  activeTab === 'runs'
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                }`}
              >
                <LayoutDashboard className="h-4 w-4" />
                Runs
              </button>

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
