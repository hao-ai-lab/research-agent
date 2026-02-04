'use client'

import { Menu, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { RunsSubTab } from './left-panel'

interface BreadcrumbItem {
  label: string
  onClick?: () => void
}

interface FloatingNavProps {
  activeTab: 'chat' | 'runs' | 'charts' | 'insights'
  runsSubTab: RunsSubTab
  onMenuClick: () => void
  breadcrumbs?: BreadcrumbItem[]
}

const tabLabels: Record<string, string> = {
  chat: 'Chat',
  runs: 'Runs',
  charts: 'Charts',
  insights: 'Insights',
}

const runsSubTabLabels: Record<RunsSubTab, string> = {
  overview: 'Overview',
  details: 'Details',
  manage: 'Manage',
}

export function FloatingNav({ activeTab, runsSubTab, onMenuClick, breadcrumbs }: FloatingNavProps) {
  // Build default breadcrumbs if not provided
  const defaultBreadcrumbs: BreadcrumbItem[] = [
    { label: tabLabels[activeTab] }
  ]
  
  if (activeTab === 'runs') {
    defaultBreadcrumbs.push({ label: runsSubTabLabels[runsSubTab] })
  }

  const items = breadcrumbs || defaultBreadcrumbs

  return (
    <header className="shrink-0 h-12 flex items-center gap-3 px-3 border-b border-border bg-background">
      <Button
        variant="ghost"
        size="icon"
        onClick={onMenuClick}
        className="h-9 w-9 shrink-0"
      >
        <Menu className="h-5 w-5" />
        <span className="sr-only">Open menu</span>
      </Button>

      <nav className="flex items-center gap-1.5 text-sm min-w-0 overflow-hidden">
        {items.map((item, index) => {
          const isLast = index === items.length - 1
          const isClickable = !!item.onClick
          
          return (
            <div key={index} className="flex items-center gap-1.5 min-w-0">
              {index > 0 && (
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              )}
              {isClickable ? (
                <button
                  type="button"
                  onClick={item.onClick}
                  className="text-muted-foreground hover:text-foreground transition-colors truncate"
                >
                  {item.label}
                </button>
              ) : (
                <span className={`truncate ${isLast ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>
                  {item.label}
                </span>
              )}
            </div>
          )
        })}
      </nav>
    </header>
  )
}
