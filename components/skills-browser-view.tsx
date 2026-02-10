'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import Prism from 'prismjs'
import 'prismjs/components/prism-markdown'
import {
  ChevronDown,
  ChevronRight,
  File,
  FileText,
  FolderOpen,
  RefreshCcw,
  RotateCcw,
  Save,
  Search,
  Wand2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  listPromptSkills,
  listSkillFiles,
  readSkillFile,
  writeSkillFile,
  updatePromptSkill,
  reloadPromptSkills,
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

export function SkillsBrowserView() {
  const [skills, setSkills] = useState<PromptSkill[]>([])
  const [filesBySkill, setFilesBySkill] = useState<Record<string, SkillFileEntry[]>>({})
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<SelectedItem | null>(null)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Editor state
  const [editorContent, setEditorContent] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [selectedSkill, setSelectedSkill] = useState<PromptSkill | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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
  // Tree building
  // --------------------------------------------------------------------------

  const treeNodes = useMemo<TreeNode[]>(() => {
    const query = search.toLowerCase()
    return skills
      .filter((skill) => {
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
  }, [skills, filesBySkill, search])

  // --------------------------------------------------------------------------
  // Selection handlers
  // --------------------------------------------------------------------------

  const handleSelectSkill = useCallback(
    (skill: PromptSkill) => {
      setSelected({ type: 'skill', skillId: skill.id })
      setSelectedSkill(skill)
      setEditorContent(skill.template)
      setOriginalContent(skill.template)
    },
    []
  )

  const handleSelectFile = useCallback(
    async (skillId: string, filePath: string) => {
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
  const highlightedMarkdown = useMemo(() => {
    const grammar = Prism.languages.markdown
    if (!grammar) return editorContent
    return Prism.highlight(editorContent, grammar, 'markdown')
  }, [editorContent])

  const renderEditorWithPreview = (placeholder?: string) => (
    <div className="flex h-full min-h-0 flex-col gap-3 lg:flex-row">
      <textarea
        ref={textareaRef}
        value={editorContent}
        onChange={(e) => setEditorContent(e.target.value)}
        className="h-1/2 w-full rounded-lg border border-border/50 bg-background/50 p-4 text-[13px] font-mono text-foreground resize-none focus:outline-none focus:ring-1 focus:ring-accent/50 focus:border-accent/30 leading-relaxed lg:h-full lg:w-1/2"
        spellCheck={false}
        placeholder={placeholder}
      />
      <div className="code-output-box h-1/2 w-full overflow-auto rounded-lg border border-border/50 bg-background/30 lg:h-full lg:w-1/2">
        <div className="border-b border-border/40 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Markdown Preview
        </div>
        <pre className="m-0 p-4 text-[13px] leading-relaxed font-mono whitespace-pre-wrap break-words">
          <code
            className="language-markdown"
            dangerouslySetInnerHTML={{ __html: highlightedMarkdown }}
          />
        </pre>
      </div>
    </div>
  )

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
        <button
          type="button"
          className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-base transition-colors ${
            isSelected
              ? 'bg-violet-500/20 text-foreground ring-1 ring-violet-400/40'
              : 'text-foreground/80 hover:bg-secondary/60'
          }`}
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

          {/* Icon */}
          {node.type === 'skill' ? (
            <Wand2 className="h-3.5 w-3.5 shrink-0 text-violet-400" />
          ) : node.type === 'directory' ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-400" />
          ) : node.label === 'SKILL.md' ? (
            <FileText className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
          ) : (
            <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}

          <span className={`truncate ${isSelected ? 'font-medium' : ''}`}>{node.label}</span>

          {node.type === 'file' && node.fileEntry?.size != null && (
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {node.fileEntry.size < 1024
                ? `${node.fileEntry.size}B`
                : `${(node.fileEntry.size / 1024).toFixed(1)}KB`}
            </span>
          )}
        </button>

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
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-500/10">
              <Wand2 className="h-4.5 w-4.5 text-violet-400" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold text-foreground truncate">{selectedSkill.name}</h2>
              <p className="text-xs text-muted-foreground font-mono">{selectedSkill.id}</p>
            </div>
          </div>
          {selectedSkill.description && (
            <p className="text-sm text-muted-foreground leading-relaxed">{selectedSkill.description}</p>
          )}

          {/* Variable chips */}
          {selectedSkill.variables.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {selectedSkill.variables.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => {
                    const insertion = `{{${v}}}`
                    const ta = textareaRef.current
                    if (ta) {
                      const pos = ta.selectionStart
                      const before = editorContent.slice(0, pos)
                      const after = editorContent.slice(pos)
                      setEditorContent(before + insertion + after)
                      setTimeout(() => {
                        ta.focus()
                        ta.setSelectionRange(pos + insertion.length, pos + insertion.length)
                      }, 0)
                    } else {
                      setEditorContent((prev) => prev + insertion)
                    }
                  }}
                  className="rounded-full bg-accent/8 border border-accent/20 px-2.5 py-0.5 text-[11px] font-mono text-accent hover:bg-accent/15 transition-colors cursor-pointer"
                  title={`Insert {{${v}}}`}
                >
                  {`{{${v}}}`}
                </button>
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
            {renderEditorWithPreview('Template content...')}
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
          {renderEditorWithPreview()}
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
  // Main render
  // --------------------------------------------------------------------------

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel — file tree */}
      <div className="flex w-64 shrink-0 flex-col border-r border-border/40 bg-background">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/40 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-violet-400" />
            <span className="text-base font-semibold text-foreground">Skills</span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {skills.length}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleReload}
            title="Reload skills from disk"
            className="h-7 w-7 p-0"
          >
            <RefreshCcw className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Search */}
        <div className="px-3 py-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search skills…"
              className="h-9 w-full rounded-md border border-border/50 bg-secondary/30 pl-8 pr-8 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent/50"
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

      {/* Right panel — editor / detail */}
      <div className="flex-1 min-w-0 bg-background/50 overflow-hidden">
        {!selected ? (
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
    </div>
  )
}
