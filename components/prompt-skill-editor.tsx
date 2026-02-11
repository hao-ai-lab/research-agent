'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { ChevronDown, ChevronRight, Save, RotateCcw, FileText, RefreshCcw, ScrollText, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { listPromptSkills, updatePromptSkill, reloadPromptSkills, type PromptSkill } from '@/lib/api'

export function PromptSkillEditor() {
  const [skills, setSkills] = useState<PromptSkill[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editedTemplates, setEditedTemplates] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadSkills = useCallback(async () => {
    try {
      const data = await listPromptSkills()
      setSkills(data)
      setError(null)
    } catch (err) {
      setError('Failed to load prompt skills. Is the server running?')
      console.error('[prompt-skills] Failed to load:', err)
    }
  }, [])

  useEffect(() => {
    loadSkills()
  }, [loadSkills])

  const handleSave = async (id: string) => {
    const template = editedTemplates[id]
    if (!template) return
    setSaving(id)
    try {
      const updated = await updatePromptSkill(id, template)
      setSkills(prev => prev.map(s => s.id === id ? updated : s))
      setEditedTemplates(prev => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    } catch (err) {
      console.error('[prompt-skills] Save failed:', err)
    } finally {
      setSaving(null)
    }
  }

  const handleReset = (id: string) => {
    setEditedTemplates(prev => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  const handleReload = async () => {
    try {
      await reloadPromptSkills()
      await loadSkills()
      setEditedTemplates({})
    } catch (err) {
      console.error('[prompt-skills] Reload failed:', err)
    }
  }

  const getDisplayTemplate = (skill: PromptSkill) =>
    editedTemplates[skill.id] ?? skill.template

  const isDirty = (id: string) => id in editedTemplates

  if (error) {
    return (
      <div className="rounded-lg bg-secondary/50 p-4">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="ghost" size="sm" onClick={loadSkills} className="mt-2">
          <RefreshCcw className="h-3 w-3 mr-2" />
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {/* Header with reload button */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Prompt Templates</span>
        </div>
        <Button variant="ghost" size="sm" onClick={handleReload} title="Reload from disk">
          <RefreshCcw className="h-3 w-3 mr-1.5" />
          Reload
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Edit the markdown templates used during Wild Loop iterations.
        Use {'{{variable}}'} placeholders for dynamic content.
      </p>

      {/* Skill List */}
      {skills.map(skill => {
        const isExpanded = expandedId === skill.id
        const dirty = isDirty(skill.id)

        return (
          <div key={skill.id} className="rounded-lg border border-border/60 bg-secondary/30 overflow-hidden">
            {/* Header */}
            <button
              type="button"
              onClick={() => setExpandedId(isExpanded ? null : skill.id)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-secondary/60"
            >
              {isExpanded
                ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              }
              {skill.category === 'skill' ? (
                <Wand2 className="h-3.5 w-3.5 shrink-0 text-violet-400" />
              ) : (
                <ScrollText className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
              )}
              <span className="text-sm font-medium flex-1">{skill.name}</span>
              <span className={`text-[10px] rounded-full px-1.5 py-0.5 font-medium ${
                skill.category === 'skill'
                  ? 'bg-violet-500/15 text-violet-400'
                  : 'bg-cyan-500/15 text-cyan-400'
              }`}>
                {skill.category === 'skill' ? 'Skill' : 'Prompt'}
              </span>
              {dirty && (
                <span className="text-[10px] bg-amber-500/20 text-amber-500 rounded-full px-1.5 py-0.5">
                  unsaved
                </span>
              )}
              <span className="text-[10px] text-muted-foreground font-mono">{skill.id}</span>
            </button>

            {/* Expanded editor */}
            {isExpanded && (
              <div className="border-t border-border/40 p-3 space-y-2">
                {/* Variable chips */}
                {skill.variables.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {skill.variables.map(v => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => {
                          const template = getDisplayTemplate(skill)
                          setEditedTemplates(prev => ({
                            ...prev,
                            [skill.id]: template + `{{${v}}}`,
                          }))
                        }}
                        className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-mono text-accent hover:bg-accent/20 transition-colors cursor-pointer"
                        title={`Insert {{${v}}}`}
                      >
                        {`{{${v}}}`}
                      </button>
                    ))}
                  </div>
                )}

                {/* Template editor */}
                <textarea
                  value={getDisplayTemplate(skill)}
                  onChange={e => {
                    setEditedTemplates(prev => ({
                      ...prev,
                      [skill.id]: e.target.value,
                    }))
                  }}
                  className="w-full min-h-[200px] max-h-[400px] rounded-md border border-border bg-background p-3 text-xs font-mono text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-accent"
                  spellCheck={false}
                />

                {/* Action buttons */}
                <div className="flex items-center justify-end gap-2">
                  {dirty && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleReset(skill.id)}
                      className="text-xs"
                    >
                      <RotateCcw className="h-3 w-3 mr-1" />
                      Discard
                    </Button>
                  )}
                  <Button
                    variant="default"
                    size="sm"
                    disabled={!dirty || saving === skill.id}
                    onClick={() => handleSave(skill.id)}
                    className="text-xs"
                  >
                    <Save className="h-3 w-3 mr-1" />
                    {saving === skill.id ? 'Saving...' : 'Save'}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )
      })}

      {skills.length === 0 && !error && (
        <div className="py-8 text-center text-sm text-muted-foreground">
          No prompt skills found. Start the server to load templates.
        </div>
      )}
    </div>
  )
}
