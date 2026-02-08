'use client'

import { Menu, Bell, Settings, PlugZap, Eye, Edit3, Plus, ChevronDown, Type, Code, BarChart3, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { useApiConfig } from '@/lib/api-config'
import type { ReportCellType } from './report-view'

interface FloatingNavProps {
  activeTab: 'chat' | 'runs' | 'charts' | 'memory' | 'events' | 'journey' | 'report' | 'settings'
  onMenuClick: () => void
  // Chat-specific props
  eventCount?: number
  onAlertClick?: () => void
  onCreateSweepClick?: () => void
  showArtifacts?: boolean
  onToggleArtifacts?: () => void
  collapseChats?: boolean
  onToggleCollapseChats?: () => void
  collapseArtifactsInChat?: boolean
  onToggleCollapseArtifactsInChat?: () => void
  // Report-specific props
  reportIsPreviewMode?: boolean
  onReportPreviewModeChange?: (isPreviewMode: boolean) => void
  onReportAddCell?: (type: ReportCellType) => void
}

export function FloatingNav({
  activeTab,
  onMenuClick,
  eventCount = 0,
  onAlertClick,
  onCreateSweepClick,
  showArtifacts = false,
  onToggleArtifacts,
  collapseChats = false,
  onToggleCollapseChats,
  collapseArtifactsInChat = false,
  onToggleCollapseArtifactsInChat,
  reportIsPreviewMode = true,
  onReportPreviewModeChange,
  onReportAddCell,
}: FloatingNavProps) {
  const isChat = activeTab === 'chat'
  const isReport = activeTab === 'report'
  const { useMock: isDemoMode } = useApiConfig()

  return (
    <header className="shrink-0 h-14 flex items-center gap-3 px-3 border-b border-border/80 bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/75">
      <div className="relative">
        <Button
          variant="ghost"
          size="icon"
          onClick={onMenuClick}
          className={`h-9 w-9 shrink-0 lg:hidden ${isDemoMode ? 'ring-2 ring-red-500/50 ring-offset-1 ring-offset-background' : ''}`}
        >
          <Menu className={`h-5 w-5 ${isDemoMode ? 'text-red-500' : ''}`} />
          <span className="sr-only">Open menu</span>
        </Button>
        {isDemoMode && (
          <Badge
            variant="destructive"
            className="absolute -top-1.5 -right-2 h-4 px-1 text-[9px] font-bold lg:hidden"
          >
            demo
          </Badge>
        )}
      </div>

      <div className="flex-1" />

      {/* Right side buttons - only show in chat */}
      {isChat && (
        <div className="flex items-center gap-1 shrink-0">
          {/* Alert Button with Badge */}
          <Button
            variant="ghost"
            size="icon"
            onClick={onAlertClick}
            className="h-8 w-8 relative"
          >
            <Bell className="h-4 w-4" />
            {eventCount > 0 && (
              <Badge
                variant="destructive"
                className="absolute -top-1 -right-1 h-4 min-w-4 px-1 text-[10px] flex items-center justify-center"
              >
                {eventCount > 99 ? '99+' : eventCount}
              </Badge>
            )}
            <span className="sr-only">View alerts ({eventCount})</span>
          </Button>

          <Button
            variant="ghost"
            size="icon"
            onClick={onCreateSweepClick}
            className="h-8 w-8"
            title="Create sweep"
          >
            <PlugZap className="h-4 w-4" />
            <span className="sr-only">Create sweep</span>
          </Button>

          {/* Settings Dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
              >
                <Settings className="h-4 w-4" />
                <span className="sr-only">Chat settings</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>Chat Settings</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="flex items-center justify-between cursor-pointer"
                onSelect={(e) => {
                  e.preventDefault()
                  onToggleArtifacts?.()
                }}
              >
                <Label htmlFor="show-artifacts" className="cursor-pointer">Show artifacts</Label>
                <Switch
                  id="show-artifacts"
                  checked={showArtifacts}
                  onCheckedChange={onToggleArtifacts}
                  onClick={(e) => e.stopPropagation()}
                />
              </DropdownMenuItem>
              <DropdownMenuItem
                className="flex items-center justify-between cursor-pointer"
                onSelect={(e) => {
                  e.preventDefault()
                  onToggleCollapseChats?.()
                }}
              >
                <Label htmlFor="collapse-chats" className="cursor-pointer">Collapse all chats</Label>
                <Switch
                  id="collapse-chats"
                  checked={collapseChats}
                  onCheckedChange={onToggleCollapseChats}
                  onClick={(e) => e.stopPropagation()}
                />
              </DropdownMenuItem>
              <DropdownMenuItem
                className="flex items-center justify-between cursor-pointer"
                onSelect={(e) => {
                  e.preventDefault()
                  onToggleCollapseArtifactsInChat?.()
                }}
              >
                <Label htmlFor="collapse-artifacts" className="cursor-pointer">Collapse artifacts in chat</Label>
                <Switch
                  id="collapse-artifacts"
                  checked={collapseArtifactsInChat}
                  onCheckedChange={onToggleCollapseArtifactsInChat}
                  onClick={(e) => e.stopPropagation()}
                />
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {isReport && onReportPreviewModeChange && onReportAddCell && (
        <div className="flex items-center gap-2 shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 gap-1.5">
                {reportIsPreviewMode ? (
                  <>
                    <Eye className="h-3.5 w-3.5" />
                    Preview
                  </>
                ) : (
                  <>
                    <Edit3 className="h-3.5 w-3.5" />
                    Edit
                  </>
                )}
                <ChevronDown className="h-3 w-3 ml-1 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => onReportPreviewModeChange(true)}
                className={reportIsPreviewMode ? 'bg-secondary' : ''}
              >
                <Eye className="h-4 w-4 mr-2" />
                Preview
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => onReportPreviewModeChange(false)}
                className={!reportIsPreviewMode ? 'bg-secondary' : ''}
              >
                <Edit3 className="h-4 w-4 mr-2" />
                Edit
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                Add Cell
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onReportAddCell('markdown')}>
                <Type className="h-4 w-4 mr-2" />
                Markdown
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onReportAddCell('code')}>
                <Code className="h-4 w-4 mr-2" />
                Code
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onReportAddCell('chart')}>
                <BarChart3 className="h-4 w-4 mr-2" />
                Chart
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onReportAddCell('insight')}>
                <Sparkles className="h-4 w-4 mr-2" />
                Insight
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </header>
  )
}
