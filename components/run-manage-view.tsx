'use client'

import { useState } from 'react'
import { Archive, Undo2, Palette, CheckSquare, Square, MinusSquare } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import type { ExperimentRun, TagDefinition } from '@/lib/types'
import { DEFAULT_RUN_COLORS } from '@/lib/mock-data'
import { getStatusText } from '@/lib/status-utils'
import { RunName } from './run-name'

interface RunManageViewProps {
  runs: ExperimentRun[]
  onUpdateRun?: (run: ExperimentRun) => void
  allTags: TagDefinition[]
  onCreateTag?: (tag: TagDefinition) => void
}

export function RunManageView({ runs, onUpdateRun }: RunManageViewProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const activeRuns = runs.filter((r) => !r.isArchived)
  const archivedRuns = runs.filter((r) => r.isArchived)

  const toggleSelect = (runId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(runId)) {
        next.delete(runId)
      } else {
        next.add(runId)
      }
      return next
    })
  }

  const selectAll = () => {
    setSelectedIds(new Set(runs.map((r) => r.id)))
  }

  const deselectAll = () => {
    setSelectedIds(new Set())
  }

  const selectSection = (sectionRuns: ExperimentRun[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      sectionRuns.forEach((r) => next.add(r.id))
      return next
    })
  }

  const deselectSection = (sectionRuns: ExperimentRun[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      sectionRuns.forEach((r) => next.delete(r.id))
      return next
    })
  }

  const isSectionFullySelected = (sectionRuns: ExperimentRun[]) => {
    return sectionRuns.every((r) => selectedIds.has(r.id))
  }

  const isSectionPartiallySelected = (sectionRuns: ExperimentRun[]) => {
    const selected = sectionRuns.filter((r) => selectedIds.has(r.id))
    return selected.length > 0 && selected.length < sectionRuns.length
  }

  const toggleSectionSelect = (sectionRuns: ExperimentRun[]) => {
    if (isSectionFullySelected(sectionRuns)) {
      deselectSection(sectionRuns)
    } else {
      selectSection(sectionRuns)
    }
  }

  const archiveSelected = () => {
    selectedIds.forEach((id) => {
      const run = runs.find((r) => r.id === id)
      if (run && !run.isArchived) {
        onUpdateRun?.({ ...run, isArchived: true })
      }
    })
    setSelectedIds(new Set())
  }

  const unarchiveSelected = () => {
    selectedIds.forEach((id) => {
      const run = runs.find((r) => r.id === id)
      if (run && run.isArchived) {
        onUpdateRun?.({ ...run, isArchived: false })
      }
    })
    setSelectedIds(new Set())
  }

  const setColorForSelected = (color: string) => {
    selectedIds.forEach((id) => {
      const run = runs.find((r) => r.id === id)
      if (run) {
        onUpdateRun?.({ ...run, color })
      }
    })
  }

  const SectionSelectButton = ({ sectionRuns }: { sectionRuns: ExperimentRun[] }) => {
    const isFullySelected = isSectionFullySelected(sectionRuns)
    const isPartiallySelected = isSectionPartiallySelected(sectionRuns)
    
    return (
      <button
        type="button"
        onClick={() => toggleSectionSelect(sectionRuns)}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        {isFullySelected ? (
          <CheckSquare className="h-4 w-4 text-accent" />
        ) : isPartiallySelected ? (
          <MinusSquare className="h-4 w-4 text-accent" />
        ) : (
          <Square className="h-4 w-4" />
        )}
      </button>
    )
  }

  const RunManageItem = ({ run }: { run: ExperimentRun }) => {
    const isSelected = selectedIds.has(run.id)

    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => toggleSelect(run.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggleSelect(run.id)
          }
        }}
        className={`flex items-center gap-3 p-3 rounded-xl border transition-colors cursor-pointer ${
          isSelected
            ? 'border-accent bg-accent/10'
            : 'border-border bg-card hover:border-muted-foreground/50 hover:bg-secondary/30'
        }`}
      >
        <div className="shrink-0">
          {isSelected ? (
            <CheckSquare className="h-5 w-5 text-accent" />
          ) : (
            <Square className="h-5 w-5 text-muted-foreground" />
          )}
        </div>

        <div
          className="h-4 w-4 rounded-full shrink-0 border border-border"
          style={{ backgroundColor: run.color || '#4ade80' }}
        />

        <div className="flex-1 min-w-0">
          <h4 className="font-medium text-sm text-foreground truncate">
            <RunName run={run} />
          </h4>
          <p className="text-xs text-muted-foreground truncate">
            {run.config?.model} - {getStatusText(run.status)}
          </p>
        </div>

        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          {run.isArchived && (
            <Badge
              variant="outline"
              className="text-[10px] border-muted-foreground/30 text-muted-foreground"
            >
              <Archive className="h-3 w-3 mr-1" />
              Archived
            </Badge>
          )}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <Palette className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-44 p-3" align="end">
              <p className="text-xs font-medium text-muted-foreground mb-2">
                Color
              </p>
              <div className="grid grid-cols-5 gap-2">
                {DEFAULT_RUN_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => onUpdateRun?.({ ...run, color })}
                    className={`h-7 w-7 rounded-full border-2 transition-transform hover:scale-110 ${
                      run.color === color
                        ? 'border-foreground'
                        : 'border-transparent'
                    }`}
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header with title, selection count, actions, and select all */}
      <div className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <h3 className="text-sm font-medium text-foreground shrink-0">Manage Runs</h3>
            {selectedIds.size > 0 && (
              <>
                <span className="text-xs text-muted-foreground shrink-0">
                  {selectedIds.size} selected
                </span>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={archiveSelected}
                    className="h-7 text-xs px-2 bg-transparent"
                  >
                    <Archive className="h-3 w-3 mr-1" />
                    Archive
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={unarchiveSelected}
                    className="h-7 text-xs px-2 bg-transparent"
                  >
                    <Undo2 className="h-3 w-3 mr-1" />
                    Unarchive
                  </Button>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs px-2 bg-transparent"
                      >
                        <Palette className="h-3 w-3 mr-1" />
                        Color
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-44 p-3" align="start">
                      <p className="text-xs font-medium text-muted-foreground mb-2">
                        Color for selected
                      </p>
                      <div className="grid grid-cols-5 gap-2">
                        {DEFAULT_RUN_COLORS.map((color) => (
                          <button
                            key={color}
                            type="button"
                            onClick={() => setColorForSelected(color)}
                            className="h-7 w-7 rounded-full border-2 border-transparent transition-transform hover:scale-110 hover:border-foreground"
                            style={{ backgroundColor: color }}
                          />
                        ))}
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>
              </>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={selectedIds.size === runs.length ? deselectAll : selectAll}
            className="h-7 text-xs shrink-0"
          >
            {selectedIds.size === runs.length ? 'Deselect All' : 'Select All'}
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="p-4 space-y-5">
            {/* Active Runs */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Active Runs ({activeRuns.length})
                </h4>
                <SectionSelectButton sectionRuns={activeRuns} />
              </div>
              <div className="space-y-2">
                {activeRuns.map((run) => (
                  <RunManageItem key={run.id} run={run} />
                ))}
              </div>
            </div>

            {/* Archived Runs */}
            {archivedRuns.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Archived ({archivedRuns.length})
                  </h4>
                  <SectionSelectButton sectionRuns={archivedRuns} />
                </div>
                <div className="space-y-2 opacity-70">
                  {archivedRuns.map((run) => (
                    <RunManageItem key={run.id} run={run} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
