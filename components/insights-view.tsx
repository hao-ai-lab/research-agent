'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Lightbulb,
  ToggleLeft,
  ToggleRight,
  Plus,
  PanelLeftOpen,
  Trash2,
  Loader2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { listMemories, createMemory, updateMemory, deleteMemory, type Memory } from '@/lib/api'

interface InsightsViewProps {
  // Legacy prop — no longer required (component self-fetches)
  rules?: never[]
  onToggleRule?: (ruleId: string) => void
  onAddRule?: () => void
  showDesktopSidebarToggle?: boolean
  onDesktopSidebarToggle?: () => void
}

export function InsightsView({
  showDesktopSidebarToggle = false,
  onDesktopSidebarToggle,
}: InsightsViewProps) {
  const [memories, setMemories] = useState<Memory[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [addingNew, setAddingNew] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newContent, setNewContent] = useState('')

  // Fetch memories from backend
  const fetchMemories = useCallback(async () => {
    try {
      const data = await listMemories()
      setMemories(data)
      setError(null)
    } catch (e) {
      setError('Could not load memories')
      console.error('[InsightsView] fetch error:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchMemories()
    // Refresh every 30s
    const interval = setInterval(fetchMemories, 30_000)
    return () => clearInterval(interval)
  }, [fetchMemories])

  const handleToggle = async (memoryId: string, currentActive: boolean) => {
    try {
      await updateMemory(memoryId, { is_active: !currentActive })
      setMemories(prev =>
        prev.map(m => m.id === memoryId ? { ...m, is_active: !currentActive } : m)
      )
    } catch (e) {
      console.error('[InsightsView] toggle error:', e)
    }
  }

  const handleDelete = async (memoryId: string) => {
    try {
      await deleteMemory(memoryId)
      setMemories(prev => prev.filter(m => m.id !== memoryId))
    } catch (e) {
      console.error('[InsightsView] delete error:', e)
    }
  }

  const handleAdd = async () => {
    if (!newTitle.trim()) return
    try {
      const memory = await createMemory({
        title: newTitle.trim(),
        content: newContent.trim() || newTitle.trim(),
        source: 'user',
        tags: ['preference'],
      })
      setMemories(prev => [memory, ...prev])
      setNewTitle('')
      setNewContent('')
      setAddingNew(false)
    } catch (e) {
      console.error('[InsightsView] add error:', e)
    }
  }

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp * 1000)
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    const days = Math.floor(diff / (1000 * 60 * 60 * 24))

    if (days === 0) return 'Today'
    if (days === 1) return 'Yesterday'
    if (days < 7) return `${days} days ago`
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }

  const sourceColors: Record<string, string> = {
    user: 'border-accent/50 bg-accent/10 text-accent',
    agent: 'border-blue-500/50 bg-blue-500/10 text-blue-400',
    reflection: 'border-purple-500/50 bg-purple-500/10 text-purple-400',
  }

  const sourceLabel: Record<string, string> = {
    user: 'User',
    agent: 'Agent',
    reflection: 'Reflection',
  }

  const activeCount = memories.filter(m => m.is_active).length

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 min-h-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="p-4 space-y-4">
            {/* Header with Add button */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {showDesktopSidebarToggle && onDesktopSidebarToggle && (
                  <Button
                    variant="outline"
                    size="icon-sm"
                    onClick={onDesktopSidebarToggle}
                    className="hidden h-9 w-9 shrink-0 border-border/70 bg-card text-muted-foreground hover:bg-secondary lg:inline-flex"
                    title="Show sidebar"
                  >
                    <PanelLeftOpen className="h-4 w-4" />
                    <span className="sr-only">Show sidebar</span>
                  </Button>
                )}
                <Lightbulb className="h-4 w-4 text-accent" />
                <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {loading ? 'Loading...' : `Active Rules (${activeCount})`}
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAddingNew(true)}
                className="h-8 bg-transparent"
              >
                <Plus className="h-4 w-4 mr-1" />
                Add
              </Button>
            </div>

            {/* Error */}
            {error && (
              <p className="text-xs text-destructive">{error}</p>
            )}

            {/* Add form */}
            {addingNew && (
              <div className="rounded-xl border border-accent/30 p-4 space-y-3 bg-card">
                <input
                  type="text"
                  placeholder="Title — e.g. 'Always run tests first'"
                  value={newTitle}
                  onChange={e => setNewTitle(e.target.value)}
                  className="w-full bg-transparent border-b border-border/50 pb-1 text-sm text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-accent"
                  autoFocus
                  onKeyDown={e => e.key === 'Enter' && handleAdd()}
                />
                <textarea
                  placeholder="Details (optional)"
                  value={newContent}
                  onChange={e => setNewContent(e.target.value)}
                  rows={2}
                  className="w-full bg-transparent border-b border-border/50 pb-1 text-xs text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-accent resize-none"
                />
                <div className="flex gap-2 justify-end">
                  <Button variant="ghost" size="sm" onClick={() => { setAddingNew(false); setNewTitle(''); setNewContent('') }}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={handleAdd} disabled={!newTitle.trim()}>
                    Save
                  </Button>
                </div>
              </div>
            )}

            {/* Loading */}
            {loading && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}

            {/* Empty state */}
            {!loading && memories.length === 0 && (
              <div className="text-center py-8 text-muted-foreground text-xs">
                <Lightbulb className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p>No memories yet</p>
                <p className="mt-1 opacity-70">
                  Memories are auto-captured from Wild Loop reflections, or you can add your own.
                </p>
              </div>
            )}

            {/* Memories List */}
            <div className="space-y-3">
              {memories.map((memory) => (
                <div
                  key={memory.id}
                  className={`rounded-xl border p-4 transition-colors ${
                    memory.is_active
                      ? 'border-border bg-card'
                      : 'border-border/50 bg-card/50 opacity-60'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h4 className="font-medium text-sm text-foreground truncate">
                          {memory.title}
                        </h4>
                        <Badge
                          variant="outline"
                          className={`${sourceColors[memory.source] || sourceColors.agent} text-[10px]`}
                        >
                          {sourceLabel[memory.source] || memory.source}
                        </Badge>
                        {memory.tags.length > 0 && (
                          <Badge variant="outline" className="text-[10px] border-border/50 text-muted-foreground">
                            {memory.tags[0]}
                          </Badge>
                        )}
                      </div>
                      {memory.content && memory.content !== memory.title && (
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          {memory.content}
                        </p>
                      )}
                      <p className="text-[10px] text-muted-foreground/70 mt-2">
                        Created {formatDate(memory.created_at)}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleDelete(memory.id)}
                        className="p-1 rounded-md hover:bg-destructive/20 transition-colors opacity-0 group-hover:opacity-100 hover:opacity-100"
                        title="Delete memory"
                      >
                        <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggle(memory.id, memory.is_active)}
                        className="p-1 rounded-md hover:bg-secondary transition-colors"
                      >
                        {memory.is_active ? (
                          <ToggleRight className="h-6 w-6 text-accent" />
                        ) : (
                          <ToggleLeft className="h-6 w-6 text-muted-foreground" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
