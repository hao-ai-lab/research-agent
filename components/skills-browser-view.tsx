'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  File,
  FileText,
  FolderOpen,
  Plus,
  RefreshCcw,
  RotateCcw,
  Save,
  ScrollText,
  Search,
  Shield,
  Trash2,
  Wand2,
  X,
  PanelLeftOpen,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import {
  listPromptSkills,
  listSkillFiles,
  readSkillFile,
  writeSkillFile,
  updatePromptSkill,
  reloadPromptSkills,
  createSkill,
  deleteSkill,
  type PromptSkill,
  type SkillFileEntry,
} from '@/lib/api'

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

interface TreeNode {
  id: string
  label: string
  type: 'skill' | 'file' | 'directory'
  skillId: string
  filePath?: string
  children?: TreeNode[]
  skill?: PromptSkill
  fileEntry?: SkillFileEntry
}

interface SelectedItem {
  type: 'skill' | 'file'
  skillId: string
  filePath?: string
}

// --------------------------------------------------------------------------
// Component
// --------------------------------------------------------------------------

interface SkillsBrowserViewProps {
  showDesktopSidebarToggle?: boolean
  onDesktopSidebarToggle?: () => void
}

export function SkillsBrowserView({
  showDesktopSidebarToggle = false,
  onDesktopSidebarToggle,
}: SkillsBrowserViewProps) {
  const [skills, setSkills] = useState<PromptSkill[]>([])
  const [filesBySkill, setFilesBySkill] = useState<Record<string, SkillFileEntry[]>>({})
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<SelectedItem | null>(null)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showSystem, setShowSystem] = useState(false)

  // Editor state
  const [editorContent, setEditorContent] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [selectedSkill, setSelectedSkill] = useState<PromptSkill | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Create skill state — shown in right panel
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [newSkillName, setNewSkillName] = useState('')
  const [newSkillDesc, setNewSkillDesc] = useState('')
  const [newSkillCategory, setNewSkillCategory] = useState<'skill' | 'prompt'>('skill')
  const [newSkillTemplate, setNewSkillTemplate] = useState('')
  const [creating, setCreating] = useState(false)

  // Delete confirmation state
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  // --------------------------------------------------------------------------
  // Data loading
  // --------------------------------------------------------------------------

  const loadSkills = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await listPromptSkills()
      setSkills(data)

      // Load files for each skill
      const filesMap: Record<string, SkillFileEntry[]> = {}
      await Promise.all(
        data.map(async (skill) => {
          try {
            const files = await listSkillFiles(skill.id)
            filesMap[skill.id] = files
          } catch {
            filesMap[skill.id] = []
          }
        })
      )
      setFilesBySkill(filesMap)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load skills')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadSkills()
  }, [loadSkills])

  const handleReload = useCallback(async () => {
    try {
      await reloadPromptSkills()
      await loadSkills()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reload')
    }
  }, [loadSkills])

  // --------------------------------------------------------------------------
  // CRUD handlers
  // --------------------------------------------------------------------------

  const handleCreate = useCallback(async () => {
    if (!newSkillName.trim()) return
    setCreating(true)
    setError(null)
    try {
      await createSkill({
        name: newSkillName.trim(),
        description: newSkillDesc.trim(),
        category: newSkillCategory,
        template: newSkillTemplate,
      })
      setShowCreateForm(false)
      setNewSkillName('')
      setNewSkillDesc('')
      setNewSkillCategory('skill')
      setNewSkillTemplate('')
      setSelected(null)
      setSelectedSkill(null)
      await loadSkills()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create skill')
    } finally {
      setCreating(false)
    }
  }, [newSkillName, newSkillDesc, newSkillCategory, newSkillTemplate, loadSkills])

  const handleDelete = useCallback(async (skillId: string) => {
    setDeleting(true)
    setError(null)
    try {
      await deleteSkill(skillId)
      setConfirmDeleteId(null)
      if (selected?.skillId === skillId) {
        setSelected(null)
        setSelectedSkill(null)
        setEditorContent('')
        setOriginalContent('')
      }
      await loadSkills()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete skill')
    } finally {
      setDeleting(false)
    }
  }, [selected, loadSkills])

  // --------------------------------------------------------------------------
  // Tree building
  // --------------------------------------------------------------------------

  const treeNodes = useMemo<TreeNode[]>(() => {
    const query = search.toLowerCase()
    return skills
      .filter((skill) => {
        // Filter system skills
        if (!showSystem && skill.internal) return false
        if (!query) return true
        return (
          skill.id.toLowerCase().includes(query) ||
          skill.name.toLowerCase().includes(query) ||
          skill.description.toLowerCase().includes(query)
        )
      })
      .map((skill): TreeNode => {
        const files = filesBySkill[skill.id] || []
        return {
          id: `skill:${skill.id}`,
          label: skill.name,
          type: 'skill',
          skillId: skill.id,
          skill,
          children: files.map(
            (f): TreeNode => ({
              id: `file:${skill.id}:${f.path}`,
              label: f.name,
              type: f.type === 'directory' ? 'directory' : 'file',
              skillId: skill.id,
              filePath: f.path,
              fileEntry: f,
            })
          ),
        }
      })
  }, [skills, filesBySkill, search, showSystem])

  // Count for header
  const visibleCount = treeNodes.length
  const systemCount = skills.filter((s) => s.internal).length

  // --------------------------------------------------------------------------
  // Selection handlers
  // --------------------------------------------------------------------------

  const handleSelectSkill = useCallback(
    (skill: PromptSkill) => {
      setShowCreateForm(false)
      setSelected({ type: 'skill', skillId: skill.id })
      setSelectedSkill(skill)
      setEditorContent(skill.template)
      setOriginalContent(skill.template)
    },
    []
  )

  const handleSelectFile = useCallback(
    async (skillId: string, filePath: string) => {
      setShowCreateForm(false)
      setSelected({ type: 'file', skillId, filePath })
      setSelectedSkill(skills.find((s) => s.id === skillId) || null)
      try {
        const data = await readSkillFile(skillId, filePath)
        setEditorContent(data.content)
        setOriginalContent(data.content)
      } catch (e) {
        setEditorContent(`// Error loading file: ${e instanceof Error ? e.message : String(e)}`)
        setOriginalContent('')
      }
    },
    [skills]
  )

  const toggleNode = useCallback((nodeId: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev)
      if (next.has(nodeId)) {
        next.delete(nodeId)
      } else {
        next.add(nodeId)
      }
      return next
    })
  }, [])

  // --------------------------------------------------------------------------
  // Save / Discard
  // --------------------------------------------------------------------------

  const isDirty = editorContent !== originalContent

  const handleSave = useCallback(async () => {
    if (!selected || !isDirty) return
    setSaving(true)
    try {
      if (selected.type === 'skill') {
        await updatePromptSkill(selected.skillId, editorContent)
      } else if (selected.filePath) {
        await writeSkillFile(selected.skillId, selected.filePath, editorContent)
      }
      setOriginalContent(editorContent)
      // Reload skill data to reflect changes
      await loadSkills()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [selected, isDirty, editorContent, loadSkills])

  const handleDiscard = useCallback(() => {
    setEditorContent(originalContent)
  }, [originalContent])

  // --------------------------------------------------------------------------
  // Keyboard shortcut
  // --------------------------------------------------------------------------

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleSave])

  // --------------------------------------------------------------------------
  // Render tree node
  // --------------------------------------------------------------------------

  const renderTreeNode = (node: TreeNode, depth: number = 0) => {
    const isExpanded = expandedNodes.has(node.id)
    const isSelected =
      selected &&
      ((node.type === 'skill' && selected.type === 'skill' && selected.skillId === node.skillId && !selected.filePath) ||
        (node.type === 'file' && selected.type === 'file' && selected.skillId === node.skillId && selected.filePath === node.filePath))

    const hasChildren = node.children && node.children.length > 0

    return (
      <div key={node.id}>
        <div
          role="button"
          tabIndex={0}
          className={`group flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${isSelected
            ? 'bg-cyan-500/14 text-cyan-100 ring-1 ring-cyan-400/35'
            : 'text-foreground/80 hover:bg-secondary/60 hover:text-foreground'
            } cursor-pointer`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => {
            if (node.type === 'skill') {
              toggleNode(node.id)
              if (node.skill) handleSelectSkill(node.skill)
            } else if (node.type === 'file' && node.filePath) {
              handleSelectFile(node.skillId, node.filePath)
            } else if (node.type === 'directory') {
              toggleNode(node.id)
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              if (node.type === 'skill') {
                toggleNode(node.id)
                if (node.skill) handleSelectSkill(node.skill)
              } else if (node.type === 'file' && node.filePath) {
                handleSelectFile(node.skillId, node.filePath)
              } else if (node.type === 'directory') {
                toggleNode(node.id)
              }
            }
          }}
        >
          {/* Expand/collapse icon */}
          {hasChildren || node.type === 'skill' ? (
            isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )
          ) : (
            <span className="w-3.5 shrink-0" />
          )}

          {/* Icon — prompt templates get ScrollText/cyan, skills get Wand2/violet */}
          {node.type === 'skill' && node.skill?.category === 'skill' ? (
            <Wand2 className="h-3.5 w-3.5 shrink-0 text-violet-400" />
          ) : node.type === 'skill' ? (
            <ScrollText className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
          ) : node.type === 'directory' ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-400" />
          ) : node.label === 'SKILL.md' ? (
            <FileText className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
          ) : (
            <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <span className="min-w-0 flex-1 truncate" title={node.label}>
                {node.label}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6} className="max-w-xs break-words px-2 py-1 text-[11px]">
              {node.label}
            </TooltipContent>
          </Tooltip>

          {/* Internal badge */}
          {node.type === 'skill' && node.skill?.internal && (
            <span className="ml-1 flex items-center gap-0.5 text-[9px] rounded-full bg-amber-500/10 border border-amber-500/20 px-1.5 py-px text-amber-400 font-medium" title="System skill — cannot be deleted">
              <Shield className="h-2.5 w-2.5" />
              System
            </span>
          )}

          {/* Delete button for non-internal skills */}
          {node.type === 'skill' && node.skill && !node.skill.internal && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setConfirmDeleteId(node.skillId)
              }}
              className="ml-auto opacity-0 group-hover:opacity-100 text-destructive/60 hover:text-destructive transition-all p-0.5 rounded"
              title={`Delete ${node.label}`}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}

          {node.type === 'file' && node.fileEntry?.size != null && (
            <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
              {node.fileEntry.size < 1024
                ? `${node.fileEntry.size}B`
                : `${(node.fileEntry.size / 1024).toFixed(1)}KB`}
            </span>
          )}
        </div>

        {/* Children */}
        {isExpanded && node.children?.map((child) => renderTreeNode(child, depth + 1))}
      </div>
    )
  }

  // --------------------------------------------------------------------------
  // Render skill card (when a skill folder is selected)
  // --------------------------------------------------------------------------

  const renderSkillCard = () => {
    if (!selectedSkill) return null
    return (
      <div className="flex h-full flex-col">
        {/* Header */}
        <div className="border-b border-border/40 px-5 py-4">
          <div className="flex items-center gap-3 mb-2">
            {selectedSkill.category === 'skill' ? (
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-500/10">
                <Wand2 className="h-4.5 w-4.5 text-violet-400" />
              </div>
            ) : (
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-500/10">
                <ScrollText className="h-4.5 w-4.5 text-cyan-400" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold text-foreground truncate" title={selectedSkill.name}>
                  {selectedSkill.name}
                </h2>
                <span className={`text-[10px] rounded-full px-1.5 py-0.5 font-medium ${selectedSkill.category === 'skill'
                  ? 'bg-violet-500/15 text-violet-400'
                  : 'bg-cyan-500/15 text-cyan-400'
                  }`}>
                  {selectedSkill.category === 'skill' ? 'Skill' : 'Prompt'}
                </span>
              </div>
              <p className="text-xs text-muted-foreground font-mono">{selectedSkill.id}</p>
            </div>
          </div>
          {selectedSkill.description && (
            <p className="text-sm text-muted-foreground leading-relaxed">{selectedSkill.description}</p>
          )}

          {/* Variable chips — display only, no click action */}
          {selectedSkill.variables.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {selectedSkill.variables.map((v) => (
                <span
                  key={v}
                  className="rounded-full border border-cyan-400/35 bg-cyan-500/12 px-2.5 py-0.5 text-[11px] font-mono text-cyan-200"
                  title={`Variable: {{${v}}}`}
                >
                  {`{{${v}}}`}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Editor */}
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex items-center justify-between px-5 py-2 border-b border-border/30">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Template
            </span>
            <div className="flex items-center gap-2">
              {isDirty && (
                <span className="text-[10px] bg-amber-500/20 text-amber-500 rounded-full px-2 py-0.5 font-medium">
                  unsaved
                </span>
              )}
            </div>
          </div>
          <div className="flex-1 min-h-0 p-3">
            <textarea
              ref={textareaRef}
              value={editorContent}
              onChange={(e) => setEditorContent(e.target.value)}
              className="h-full w-full rounded-lg border border-border/50 bg-background/50 p-4 text-[13px] font-mono text-foreground resize-none focus:outline-none focus:ring-1 focus:ring-accent/50 focus:border-accent/30 leading-relaxed"
              spellCheck={false}
              placeholder="Template content..."
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between border-t border-border/40 px-5 py-3">
          <span className="text-[11px] text-muted-foreground">
            {isDirty ? '⌘S to save' : 'No changes'}
          </span>
          <div className="flex items-center gap-2">
            {isDirty && (
              <Button variant="ghost" size="sm" onClick={handleDiscard} className="text-xs h-7">
                <RotateCcw className="h-3 w-3 mr-1.5" />
                Discard
              </Button>
            )}
            <Button
              variant="default"
              size="sm"
              disabled={!isDirty || saving}
              onClick={handleSave}
              className="text-xs h-7"
            >
              <Save className="h-3 w-3 mr-1.5" />
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // --------------------------------------------------------------------------
  // Render file editor (when a specific file is selected)
  // --------------------------------------------------------------------------

  const renderFileEditor = () => {
    if (!selected || selected.type !== 'file' || !selected.filePath) return null
    const fileName = selected.filePath.split('/').pop() || selected.filePath

    return (
      <div className="flex h-full flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-border/40 px-5 py-3">
          <FileText className="h-4 w-4 text-cyan-400" />
          <span className="text-sm font-medium text-foreground">{fileName}</span>
          <span className="text-xs text-muted-foreground font-mono">
            {selectedSkill?.id}/{selected.filePath}
          </span>
          {isDirty && (
            <span className="ml-auto text-[10px] bg-amber-500/20 text-amber-500 rounded-full px-2 py-0.5 font-medium">
              unsaved
            </span>
          )}
        </div>

        {/* Editor */}
        <div className="flex-1 min-h-0 p-3">
          <textarea
            ref={textareaRef}
            value={editorContent}
            onChange={(e) => setEditorContent(e.target.value)}
            className="h-full w-full rounded-lg border border-border/50 bg-background/50 p-4 text-[13px] font-mono text-foreground resize-none focus:outline-none focus:ring-1 focus:ring-accent/50 focus:border-accent/30 leading-relaxed"
            spellCheck={false}
          />
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between border-t border-border/40 px-5 py-3">
          <span className="text-[11px] text-muted-foreground">
            {isDirty ? '⌘S to save' : 'No changes'}
          </span>
          <div className="flex items-center gap-2">
            {isDirty && (
              <Button variant="ghost" size="sm" onClick={handleDiscard} className="text-xs h-7">
                <RotateCcw className="h-3 w-3 mr-1.5" />
                Discard
              </Button>
            )}
            <Button
              variant="default"
              size="sm"
              disabled={!isDirty || saving}
              onClick={handleSave}
              className="text-xs h-7"
            >
              <Save className="h-3 w-3 mr-1.5" />
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // --------------------------------------------------------------------------
  // Render create skill form (shown in right panel)
  // --------------------------------------------------------------------------

  const renderCreateForm = () => {
    return (
      <div className="flex h-full flex-col">
        {/* Header */}
        <div className="border-b border-border/40 px-5 py-4">
          <div className="flex items-center gap-3 mb-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/10">
              <Plus className="h-4.5 w-4.5 text-emerald-400" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold text-foreground">Create New Skill</h2>
              <p className="text-xs text-muted-foreground">Define a new prompt skill with a template and variables.</p>
            </div>
          </div>
        </div>

        {/* Form */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          {/* Skill Name */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">
              Skill Name <span className="text-destructive">*</span>
            </label>
            <input
              type="text"
              value={newSkillName}
              onChange={(e) => setNewSkillName(e.target.value)}
              placeholder="e.g. My Research Helper"
              className="h-9 w-full rounded-md border border-border/50 bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent/50"
              autoFocus
            />
            <p className="text-[11px] text-muted-foreground">
              The name will be used to generate the skill ID (e.g. <span className="font-mono">my_research_helper</span>)
            </p>
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">Description</label>
            <input
              type="text"
              value={newSkillDesc}
              onChange={(e) => setNewSkillDesc(e.target.value)}
              placeholder="Brief description of what this skill does"
              className="h-9 w-full rounded-md border border-border/50 bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent/50"
            />
          </div>

          {/* Category */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">Category</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setNewSkillCategory('skill')}
                className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${newSkillCategory === 'skill'
                  ? 'border-violet-400/50 bg-violet-500/15 text-violet-300'
                  : 'border-border/50 bg-background text-muted-foreground hover:bg-secondary/60'
                  }`}
              >
                <Wand2 className="h-3 w-3" />
                Skill
              </button>
              <button
                type="button"
                onClick={() => setNewSkillCategory('prompt')}
                className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${newSkillCategory === 'prompt'
                  ? 'border-cyan-400/50 bg-cyan-500/15 text-cyan-300'
                  : 'border-border/50 bg-background text-muted-foreground hover:bg-secondary/60'
                  }`}
              >
                <ScrollText className="h-3 w-3" />
                Prompt
              </button>
            </div>
          </div>

          {/* Initial Template */}
          <div className="space-y-1.5 flex-1 min-h-0 flex flex-col">
            <label className="text-xs font-medium text-foreground">Initial Template</label>
            <textarea
              value={newSkillTemplate}
              onChange={(e) => setNewSkillTemplate(e.target.value)}
              placeholder={`Write your template here...\nUse {{variable_name}} for dynamic placeholders.`}
              className="flex-1 min-h-[200px] w-full rounded-lg border border-border/50 bg-background/50 p-4 text-[13px] font-mono text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-accent/50 focus:border-accent/30 leading-relaxed"
              spellCheck={false}
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 border-t border-border/40 px-5 py-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setShowCreateForm(false)
              setNewSkillName('')
              setNewSkillDesc('')
              setNewSkillCategory('skill')
              setNewSkillTemplate('')
            }}
            className="text-xs h-7"
          >
            Cancel
          </Button>
          <Button
            variant="default"
            size="sm"
            disabled={!newSkillName.trim() || creating}
            onClick={handleCreate}
            className="text-xs h-7"
          >
            <Plus className="h-3 w-3 mr-1.5" />
            {creating ? 'Creating…' : 'Create Skill'}
          </Button>
        </div>
      </div>
    )
  }

  // --------------------------------------------------------------------------
  // Main render
  // --------------------------------------------------------------------------

  return (
    <div className="h-full overflow-hidden">
      <ResizablePanelGroup direction="horizontal" autoSaveId="skills-browser-layout">
        <ResizablePanel defaultSize={30} minSize={20} maxSize={48}>
          {/* Left panel — file tree */}
          <div className="flex h-full flex-col bg-background">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border/40 px-3 py-2.5">
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
                <Wand2 className="h-4 w-4 text-violet-400" />
                <span className="text-sm font-semibold text-foreground">Prompt Skills Library</span>
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {visibleCount}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setShowCreateForm(true)
                        setSelected(null)
                        setSelectedSkill(null)
                      }}
                      className="h-7 w-7 p-0"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={6} className="text-[11px]">
                    Create new skill
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleReload}
                      className="h-7 w-7 p-0"
                    >
                      <RefreshCcw className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={6} className="text-[11px]">
                    Reload skills from disk
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowSystem((prev) => !prev)}
                      className={`h-7 w-7 p-0 ${showSystem ? 'text-foreground bg-secondary/80' : 'text-muted-foreground'}`}
                    >
                      {showSystem ? (
                        <Eye className="h-3.5 w-3.5" />
                      ) : (
                        <EyeOff className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={6} className="text-[11px]">
                    {showSystem ? 'Hide' : 'Show'} system skills ({systemCount})
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>

            {/* Delete confirmation */}
            {confirmDeleteId && (
              <div className="border-b border-border/40 px-3 py-3 bg-destructive/5">
                <p className="text-xs text-foreground mb-2">
                  Delete <span className="font-mono font-semibold">{confirmDeleteId}</span>? This cannot be undone.
                </p>
                <div className="flex gap-1.5">
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteId(null)} className="flex-1 text-xs h-7">
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={deleting}
                    onClick={() => handleDelete(confirmDeleteId)}
                    className="flex-1 text-xs h-7"
                  >
                    <Trash2 className="h-3 w-3 mr-1" />
                    {deleting ? 'Deleting…' : 'Delete'}
                  </Button>
                </div>
              </div>
            )}

            {/* Search + System filter */}
            <div className="px-3 py-2 space-y-1.5">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search skills…"
                  className="h-8 w-full rounded-md border border-border/50 bg-secondary/30 pl-8 pr-8 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent/50"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>

            {/* Tree */}
            <div className="flex-1 overflow-y-auto px-2 pb-4">
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
                </div>
              ) : error ? (
                <div className="px-2 py-4 text-center">
                  <p className="text-xs text-destructive mb-2">{error}</p>
                  <Button variant="ghost" size="sm" onClick={loadSkills} className="text-xs">
                    Retry
                  </Button>
                </div>
              ) : treeNodes.length === 0 ? (
                <div className="px-2 py-8 text-center text-xs text-muted-foreground">
                  {search ? 'No skills match your search.' : 'No skills found. Start the server to load templates.'}
                </div>
              ) : (
                treeNodes.map((node) => renderTreeNode(node))
              )}
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle className="bg-border/50 hover:bg-cyan-400/30 transition-colors" />
        <ResizablePanel defaultSize={70} minSize={52}>
          {/* Right panel — editor / detail / create form */}
          <div className="h-full min-w-0 bg-background/50 overflow-hidden">
            {showCreateForm ? (
              renderCreateForm()
            ) : !selected ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
                <Wand2 className="h-10 w-10 opacity-20" />
                <div className="text-center">
                  <p className="text-sm font-medium">Select a skill</p>
                  <p className="text-xs mt-1 max-w-xs">
                    Choose a skill from the tree to view and edit its template, variables, and files.
                  </p>
                </div>
              </div>
            ) : selected.type === 'skill' ? (
              renderSkillCard()
            ) : (
              renderFileEditor()
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
