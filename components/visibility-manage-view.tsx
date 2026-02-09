'use client'

import { useState, useMemo } from 'react'
import {
  ArrowLeft,
  Search,
  Eye,
  EyeOff,
  Check,
  Plus,
  Trash2,
  Palette,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import type { ExperimentRun, VisibilityGroup } from '@/lib/types'
import { DEFAULT_RUN_COLORS } from '@/lib/mock-data'
import { RunName } from './run-name'

interface VisibilityManageViewProps {
  runs: ExperimentRun[]
  visibleRunIds: Set<string>
  onToggleVisibility: (runId: string) => void
  onSetVisibleRuns: (runIds: Set<string>) => void
  visibilityGroups: VisibilityGroup[]
  onCreateGroup: (group: VisibilityGroup) => void
  onDeleteGroup: (groupId: string) => void
  onUpdateRun?: (run: ExperimentRun) => void
  onBack: () => void
}

export function VisibilityManageView({
  runs,
  visibleRunIds,
  onToggleVisibility,
  onSetVisibleRuns,
  visibilityGroups,
  onCreateGroup,
  onDeleteGroup,
  onUpdateRun,
  onBack,
}: VisibilityManageViewProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(new Set())
  const [showNewGroupDialog, setShowNewGroupDialog] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [newGroupColor, setNewGroupColor] = useState(DEFAULT_RUN_COLORS[0])

  const hasChartData = (run: ExperimentRun) => {
    const hasLossHistory = !!(run.lossHistory && run.lossHistory.length > 0)
    const hasMetricSeries = !!(
      run.metricSeries &&
      Object.values(run.metricSeries).some((points) => points && points.length > 0)
    )
    return hasLossHistory || hasMetricSeries
  }

  const activeRuns = runs.filter((r) => !r.isArchived && hasChartData(r))

  const filteredRuns = useMemo(() => {
    if (!searchQuery.trim()) return activeRuns
    const query = searchQuery.toLowerCase()
    return activeRuns.filter(
      (run) =>
        (run.alias?.toLowerCase().includes(query) || run.name.toLowerCase().includes(query)) ||
        run.tags?.some((tag) => tag.toLowerCase().includes(query))
    )
  }, [activeRuns, searchQuery])

  const allFilteredSelected = filteredRuns.every((run) => selectedRunIds.has(run.id))
  const someFilteredSelected = filteredRuns.some((run) => selectedRunIds.has(run.id))

  const toggleSelectRun = (runId: string) => {
    setSelectedRunIds((prev) => {
      const next = new Set(prev)
      if (next.has(runId)) {
        next.delete(runId)
      } else {
        next.add(runId)
      }
      return next
    })
  }

  const toggleSelectAllFiltered = () => {
    if (allFilteredSelected) {
      setSelectedRunIds((prev) => {
        const next = new Set(prev)
        filteredRuns.forEach((run) => next.delete(run.id))
        return next
      })
    } else {
      setSelectedRunIds((prev) => {
        const next = new Set(prev)
        filteredRuns.forEach((run) => next.add(run.id))
        return next
      })
    }
  }

  const showSelectedOnly = () => {
    onSetVisibleRuns(selectedRunIds)
  }

  const hideSelected = () => {
    const newVisible = new Set(visibleRunIds)
    selectedRunIds.forEach((id) => newVisible.delete(id))
    onSetVisibleRuns(newVisible)
  }

  const showAll = () => {
    onSetVisibleRuns(new Set(activeRuns.map((r) => r.id)))
  }

  const handleColorChange = (run: ExperimentRun, color: string) => {
    onUpdateRun?.({ ...run, color })
  }

  const handleCreateGroup = () => {
    if (newGroupName.trim() && selectedRunIds.size > 0) {
      onCreateGroup({
        id: `group-${Date.now()}`,
        name: newGroupName.trim(),
        color: newGroupColor,
        runIds: Array.from(selectedRunIds),
      })
      setNewGroupName('')
      setNewGroupColor(DEFAULT_RUN_COLORS[0])
      setShowNewGroupDialog(false)
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-background animate-in slide-in-from-right-5 duration-200">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-3 border-b border-border px-4 py-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          className="h-9 w-9 shrink-0"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold text-foreground">Manage Visibility</h2>
          <p className="text-xs text-muted-foreground">
            {activeRuns.length} runs available
          </p>
        </div>
      </div>

      {/* Search and Actions Bar */}
      <div className="shrink-0 border-b border-border p-3 space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search runs..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 h-9 text-sm"
          />
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Checkbox
              id="select-all"
              checked={someFilteredSelected && !allFilteredSelected ? 'indeterminate' : allFilteredSelected}
              onCheckedChange={toggleSelectAllFiltered}
            />
            <label
              htmlFor="select-all"
              className="text-xs text-muted-foreground cursor-pointer"
            >
              {searchQuery ? `All (${filteredRuns.length})` : 'Select all'}
            </label>
          </div>

          {selectedRunIds.size > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">
                {selectedRunIds.size} selected
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={showSelectedOnly}
                className="h-7 px-2 text-xs bg-transparent"
              >
                <Eye className="h-3 w-3 mr-1" />
                Show only
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={hideSelected}
                className="h-7 px-2 text-xs bg-transparent"
              >
                <EyeOff className="h-3 w-3 mr-1" />
                Hide
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowNewGroupDialog(true)}
                className="h-7 px-2 text-xs"
              >
                <Plus className="h-3 w-3 mr-1" />
                Group
              </Button>
            </div>
          )}

          {selectedRunIds.size === 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={showAll}
              className="h-7 px-2 text-xs text-muted-foreground"
            >
              Show all
            </Button>
          )}
        </div>
      </div>

      {/* Visibility Groups */}
      {visibilityGroups.length > 0 && (
        <div className="shrink-0 border-b border-border p-3">
          <h4 className="text-xs font-medium text-muted-foreground mb-2">
            Visibility Groups
          </h4>
          <div className="flex flex-wrap gap-2">
            {visibilityGroups.map((group) => (
              <div
                key={group.id}
                className="flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5"
              >
                <div
                  className="h-3 w-3 rounded-full"
                  style={{ backgroundColor: group.color }}
                />
                <span className="text-xs font-medium">{group.name}</span>
                <span className="text-[10px] text-muted-foreground">
                  ({group.runIds.length})
                </span>
                <button
                  type="button"
                  onClick={() => onDeleteGroup(group.id)}
                  className="ml-1 p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Runs List */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="p-3 space-y-2">
            {filteredRuns.map((run) => {
              const isSelected = selectedRunIds.has(run.id)
              const isVisible = visibleRunIds.has(run.id)
              return (
                <div
                  key={run.id}
                  className={`flex items-center gap-3 rounded-lg border p-3 transition-colors ${
                    isSelected
                      ? 'border-accent/50 bg-accent/5'
                      : 'border-border bg-card'
                  }`}
                >
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => toggleSelectRun(run.id)}
                  />

                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        className="h-6 w-6 rounded-full border-2 border-border hover:border-muted-foreground transition-colors"
                        style={{ backgroundColor: run.color || '#4ade80' }}
                      />
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-2" align="start">
                      <div className="grid grid-cols-5 gap-1.5">
                        {DEFAULT_RUN_COLORS.map((color) => (
                          <button
                            key={color}
                            type="button"
                            onClick={() => handleColorChange(run, color)}
                            className={`h-6 w-6 rounded-full border-2 transition-transform hover:scale-110 ${
                              run.color === color
                                ? 'border-foreground'
                                : 'border-transparent'
                            }`}
                            style={{ backgroundColor: color }}
                          >
                            {run.color === color && (
                              <Check className="h-3 w-3 text-foreground mx-auto" />
                            )}
                          </button>
                        ))}
                      </div>
                    </PopoverContent>
                  </Popover>

                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">
                      <RunName run={run} />
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {run.config?.model}
                    </p>
                  </div>

                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onToggleVisibility(run.id)}
                    className={`h-8 w-8 shrink-0 ${
                      isVisible ? 'text-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    {isVisible ? (
                      <Eye className="h-4 w-4" />
                    ) : (
                      <EyeOff className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              )
            })}
          </div>
        </ScrollArea>
      </div>

      {/* New Group Dialog */}
      <Dialog open={showNewGroupDialog} onOpenChange={setShowNewGroupDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create Visibility Group</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Group Name</label>
              <Input
                placeholder="e.g., Best Performers"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Color</label>
              <div className="flex gap-2">
                {DEFAULT_RUN_COLORS.slice(0, 6).map((color) => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setNewGroupColor(color)}
                    className={`h-8 w-8 rounded-full border-2 transition-transform hover:scale-110 ${
                      newGroupColor === color
                        ? 'border-foreground'
                        : 'border-transparent'
                    }`}
                    style={{ backgroundColor: color }}
                  >
                    {newGroupColor === color && (
                      <Check className="h-4 w-4 text-foreground mx-auto" />
                    )}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {selectedRunIds.size} runs will be included in this group
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewGroupDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateGroup} disabled={!newGroupName.trim()}>
              Create Group
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
