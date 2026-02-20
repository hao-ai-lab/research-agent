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
  Terminal,
} from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { useAppSettings } from '@/lib/app-settings'
import type { LeftPanelItemId } from '@/lib/types'

interface LeftPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSettingsClick: () => void
  activeTab: 'chat' | 'runs' | 'charts' | 'insights' | 'journey'
  onTabChange: (tab: 'chat' | 'runs' | 'charts' | 'insights' | 'journey') => void
}

const NAV_ITEM_CONFIG = {
  chat: {
    icon: MessageSquare,
    label: 'Chat',
  },
  runs: {
    icon: LayoutDashboard,
    label: 'Runs',
  },
  charts: {
    icon: BarChart3,
    label: 'Charts',
  },
  insights: {
    icon: Lightbulb,
    label: 'Insights',
  },
  terminal: {
    icon: Terminal,
    label: 'Terminal',
  },
} as const

export function LeftPanel({
  open,
  onOpenChange,
  onSettingsClick,
  activeTab,
  onTabChange,
}: LeftPanelProps) {
  const { settings } = useAppSettings()

  const handleNavClick = (tab: 'chat' | 'runs' | 'charts' | 'insights' | 'journey') => {
    onTabChange(tab)
    onOpenChange(false)
  }

  // Get ordered and visible nav items from settings
  const navItems = (settings.leftPanel?.items || [])
    .filter((item) => item.visible)
    .sort((a, b) => a.order - b.order)

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
              {navItems.map((item) => {
                const config = NAV_ITEM_CONFIG[item.id as LeftPanelItemId]
                if (!config) return null

                const Icon = config.icon

                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleNavClick(item.id as 'chat' | 'runs' | 'charts' | 'insights')}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${activeTab === item.id
                        ? 'bg-secondary text-foreground'
                        : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                      }`}
                  >
                    <Icon className="h-4 w-4" />
                    {config.label}
                  </button>
                )
              })}
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
            {settings.developer?.showJourneyPanel && (
              <button
                type="button"
                onClick={() => handleNavClick('journey')}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${activeTab === 'journey'
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                  }`}
              >
                <Sparkles className="h-4 w-4" />
                Our Journey
              </button>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
