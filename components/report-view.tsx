'use client'

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import {
  Play,
  Plus,
  Trash2,
  Copy,
  ChevronUp,
  ChevronDown,
  MessageSquare,
  AtSign,
  X,
  Send,
  Sparkles,
  MoreHorizontal,
  Code,
  Type,
  BarChart3,
  FileText,
  FlaskConical,
  TerminalSquare,
  Loader2,
  Square,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@/components/ui/dropdown-menu'
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable'
import type { ExperimentRun } from '@/lib/types'
import {
  createNotebook,
  executeNotebookCell,
  stopNotebook,
} from '@/lib/api-client'

export type ReportCellType = 'markdown' | 'code' | 'chart' | 'insight'

interface ReportCell {
  id: string
  type: ReportCellType
  content: string
  output?: string
  isExecuting?: boolean
  executionCount?: number
}

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  referencedCells?: string[]
  timestamp: Date
}

interface NotebookRuntime {
  sessionId: string | null
  status: 'stopped' | 'starting' | 'running' | 'error'
  tmuxWindow: string | null
  tmuxPane: string | null
  pythonCommand: string
  venvPath: string
  workdir: string
  lastExecutionCount: number
  error: string | null
}

interface ReportDocument {
  id: string
  title: string
  summary: string
  updatedAt: number
  cells: ReportCell[]
  chatMessages: ChatMessage[]
  notebook: NotebookRuntime
}

export interface ReportToolbarState {
  isPreviewMode: boolean
  setPreviewMode: (isPreviewMode: boolean) => void
  addCell: (type: ReportCellType) => void
}

interface ReportViewProps {
  runs: ExperimentRun[]
  onToolbarChange?: (toolbar: ReportToolbarState | null) => void
}

const initialCells: ReportCell[] = [
  {
    id: 'cell-1',
    type: 'markdown',
    content: '# GPT-4 Fine-tuning Analysis Report\n\nThis report summarizes the training progress and key insights from our latest fine-tuning experiments.',
  },
  {
    id: 'cell-2',
    type: 'chart',
    content: 'Training Loss Over Time',
    output: 'chart-placeholder',
  },
  {
    id: 'cell-3',
    type: 'insight',
    content: 'Key Observations',
    output: '**Training Progress**: Loss decreased from 2.5 to 0.23 over 15 epochs\n\n**Learning Rate**: Optimal at 1e-4\n\n**Recommendation**: Consider early stopping at epoch 20 if no improvement',
  },
  {
    id: 'cell-4',
    type: 'code',
    content: '# Calculate average loss per epoch\nimport numpy as np\n\nlosses = [2.5, 1.8, 1.2, 0.8, 0.5, 0.35, 0.28, 0.25, 0.24, 0.23]\navg_loss = np.mean(losses)\nprint(f"Average Loss: {avg_loss:.3f}")',
    output: 'Out[1]: Average Loss: 0.813',
    executionCount: 1,
  },
  {
    id: 'cell-5',
    type: 'markdown',
    content: '## Next Steps\n\n1. Continue training to epoch 25\n2. Evaluate on validation set\n3. Compare with baseline model',
  },
]

function buildNotebookRuntime(): NotebookRuntime {
  return {
    sessionId: null,
    status: 'stopped',
    tmuxWindow: null,
    tmuxPane: null,
    pythonCommand: 'python',
    venvPath: '',
    workdir: '',
    lastExecutionCount: 0,
    error: null,
  }
}

function buildInitialReports(runs: ExperimentRun[]): ReportDocument[] {
  const now = Date.now()
  return [
    {
      id: 'report-main',
      title: 'Main Analysis Notebook',
      summary: `Notebook covering current experiment trends (${runs.length} tracked runs).`,
      updatedAt: now,
      cells: initialCells,
      chatMessages: [],
      notebook: buildNotebookRuntime(),
    },
    {
      id: 'report-review',
      title: 'Failure Review Notebook',
      summary: 'Space for debugging failed runs and mitigation experiments.',
      updatedAt: now - 60_000,
      cells: [
        {
          id: 'review-1',
          type: 'markdown',
          content: '# Failure Investigation\n\nTrack failure modes, suspicious metrics, and remediation notes here.',
        },
        {
          id: 'review-2',
          type: 'code',
          content: '# Start with quick checks\nprint("Ready to inspect failed runs")',
        },
      ],
      chatMessages: [],
      notebook: buildNotebookRuntime(),
    },
  ]
}

export function ReportView({ runs, onToolbarChange }: ReportViewProps) {
  const [reports, setReports] = useState<ReportDocument[]>(() => buildInitialReports(runs))
  const [activeReportId, setActiveReportId] = useState<string>('report-main')

  const [selectedCellId, setSelectedCellId] = useState<string | null>(null)
  const [editingCellId, setEditingCellId] = useState<string | null>(null)
  const [isPreviewMode, setIsPreviewMode] = useState(true)
  const [showChat, setShowChat] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [referencedCells, setReferencedCells] = useState<string[]>([])
  const chatInputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (reports.length === 0) return
    if (!reports.some(report => report.id === activeReportId)) {
      setActiveReportId(reports[0].id)
    }
  }, [activeReportId, reports])

  const activeReport = useMemo(() => {
    return reports.find(report => report.id === activeReportId) ?? reports[0] ?? null
  }, [reports, activeReportId])

  const cells = activeReport?.cells ?? []
  const chatMessages = activeReport?.chatMessages ?? []
  const activeNotebook = activeReport?.notebook ?? buildNotebookRuntime()

  const generateId = () => `cell-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

  const patchReport = useCallback((reportId: string, updater: (report: ReportDocument) => ReportDocument) => {
    setReports(prev => prev.map(report => (report.id === reportId ? updater(report) : report)))
  }, [])

  const getCellTypeIcon = (type: ReportCellType) => {
    switch (type) {
      case 'markdown': return <Type className="h-3.5 w-3.5" />
      case 'code': return <Code className="h-3.5 w-3.5" />
      case 'chart': return <BarChart3 className="h-3.5 w-3.5" />
      case 'insight': return <Sparkles className="h-3.5 w-3.5" />
      default: return <Type className="h-3.5 w-3.5" />
    }
  }

  useEffect(() => {
    onToolbarChange?.({
      isPreviewMode,
      setPreviewMode: setIsPreviewMode,
      addCell: (type) => addCell(type),
    })
  }, [onToolbarChange, isPreviewMode, activeReportId])

  useEffect(() => {
    return () => {
      onToolbarChange?.(null)
    }
  }, [onToolbarChange])

  useEffect(() => {
    setSelectedCellId(null)
    setEditingCellId(null)
    setReferencedCells([])
    setChatInput('')
  }, [activeReportId])

  const addCell = useCallback((type: ReportCellType, afterId?: string) => {
    if (!activeReport) return

    const newCell: ReportCell = {
      id: generateId(),
      type,
      content: type === 'markdown' ? '# New Section' : type === 'code' ? '# Enter code here' : 'New content',
    }

    patchReport(activeReport.id, report => {
      const nextCells = (() => {
        if (!afterId) return [...report.cells, newCell]
        const index = report.cells.findIndex(c => c.id === afterId)
        if (index === -1) return [...report.cells, newCell]
        return [...report.cells.slice(0, index + 1), newCell, ...report.cells.slice(index + 1)]
      })()

      return {
        ...report,
        cells: nextCells,
        updatedAt: Date.now(),
      }
    })

    setEditingCellId(newCell.id)
    setSelectedCellId(newCell.id)
  }, [activeReport, patchReport])

  const deleteCell = useCallback((id: string) => {
    if (!activeReport) return

    patchReport(activeReport.id, report => ({
      ...report,
      cells: report.cells.filter(c => c.id !== id),
      updatedAt: Date.now(),
    }))

    if (selectedCellId === id) setSelectedCellId(null)
    if (editingCellId === id) setEditingCellId(null)
  }, [activeReport, patchReport, selectedCellId, editingCellId])

  const duplicateCell = useCallback((id: string) => {
    if (!activeReport) return

    patchReport(activeReport.id, report => {
      const index = report.cells.findIndex(c => c.id === id)
      if (index === -1) return report
      const cell = report.cells[index]
      const newCell = { ...cell, id: generateId(), executionCount: undefined, output: undefined, isExecuting: false }
      return {
        ...report,
        cells: [...report.cells.slice(0, index + 1), newCell, ...report.cells.slice(index + 1)],
        updatedAt: Date.now(),
      }
    })
  }, [activeReport, patchReport])

  const moveCell = useCallback((id: string, direction: 'up' | 'down') => {
    if (!activeReport) return

    patchReport(activeReport.id, report => {
      const index = report.cells.findIndex(c => c.id === id)
      if (index === -1) return report
      if ((direction === 'up' && index === 0) || (direction === 'down' && index === report.cells.length - 1)) {
        return report
      }

      const newIndex = direction === 'up' ? index - 1 : index + 1
      const nextCells = [...report.cells]
      const [removed] = nextCells.splice(index, 1)
      nextCells.splice(newIndex, 0, removed)
      return {
        ...report,
        cells: nextCells,
        updatedAt: Date.now(),
      }
    })
  }, [activeReport, patchReport])

  const updateCellContent = useCallback((id: string, content: string) => {
    if (!activeReport) return

    patchReport(activeReport.id, report => ({
      ...report,
      cells: report.cells.map(c => (c.id === id ? { ...c, content } : c)),
      updatedAt: Date.now(),
    }))
  }, [activeReport, patchReport])

  const changeCellType = useCallback((id: string, newType: ReportCellType) => {
    if (!activeReport) return

    patchReport(activeReport.id, report => ({
      ...report,
      cells: report.cells.map(c => (
        c.id === id
          ? { ...c, type: newType, output: undefined, executionCount: undefined }
          : c
      )),
      updatedAt: Date.now(),
    }))
  }, [activeReport, patchReport])

  const setNotebookConfig = useCallback((field: 'workdir' | 'pythonCommand' | 'venvPath', value: string) => {
    if (!activeReport) return

    patchReport(activeReport.id, report => ({
      ...report,
      notebook: {
        ...report.notebook,
        [field]: value,
      },
      updatedAt: Date.now(),
    }))
  }, [activeReport, patchReport])

  const startNotebookKernel = useCallback(async () => {
    if (!activeReport) return

    const reportId = activeReport.id
    const previousSessionId = activeReport.notebook.sessionId
    const wasRunning = activeReport.notebook.status === 'running'

    patchReport(reportId, report => ({
      ...report,
      notebook: {
        ...report.notebook,
        status: 'starting',
        error: null,
      },
      updatedAt: Date.now(),
    }))

    try {
      if (previousSessionId && wasRunning) {
        await stopNotebook(previousSessionId)
      }

      const notebook = await createNotebook({
        name: activeReport.title,
        workdir: activeReport.notebook.workdir || undefined,
        python_command: activeReport.notebook.pythonCommand || undefined,
        venv_path: activeReport.notebook.venvPath || undefined,
      })

      patchReport(reportId, report => ({
        ...report,
        notebook: {
          ...report.notebook,
          sessionId: notebook.id,
          status: notebook.status,
          tmuxWindow: notebook.tmux_window ?? null,
          tmuxPane: notebook.tmux_pane ?? null,
          workdir: notebook.workdir || report.notebook.workdir,
          pythonCommand: notebook.python_command || report.notebook.pythonCommand,
          venvPath: notebook.venv_path || report.notebook.venvPath,
          lastExecutionCount: notebook.last_execution_count || 0,
          error: notebook.error ?? null,
        },
        updatedAt: Date.now(),
      }))
    } catch (error) {
      patchReport(reportId, report => ({
        ...report,
        notebook: {
          ...report.notebook,
          status: 'error',
          error: error instanceof Error ? error.message : 'Failed to start kernel',
        },
        updatedAt: Date.now(),
      }))
    }
  }, [activeReport, patchReport])

  const stopNotebookKernel = useCallback(async () => {
    if (!activeReport?.notebook.sessionId) return

    const reportId = activeReport.id
    const notebookId = activeReport.notebook.sessionId

    try {
      await stopNotebook(notebookId)
    } catch (error) {
      console.error('Failed to stop notebook:', error)
    }

    patchReport(reportId, report => ({
      ...report,
      notebook: {
        ...report.notebook,
        status: 'stopped',
        sessionId: null,
      },
      updatedAt: Date.now(),
    }))
  }, [activeReport, patchReport])

  const executeCell = useCallback(async (id: string) => {
    if (!activeReport) return

    const reportId = activeReport.id
    const cell = activeReport.cells.find(c => c.id === id)
    if (!cell || cell.type !== 'code') return

    if (!activeReport.notebook.sessionId || activeReport.notebook.status !== 'running') {
      patchReport(reportId, report => ({
        ...report,
        cells: report.cells.map(c => c.id === id
          ? {
              ...c,
              output: 'Kernel not running. Start the Python kernel first to execute notebook cells.',
              isExecuting: false,
            }
          : c),
        updatedAt: Date.now(),
      }))
      return
    }

    patchReport(reportId, report => ({
      ...report,
      cells: report.cells.map(c => c.id === id ? { ...c, isExecuting: true } : c),
      updatedAt: Date.now(),
    }))

    try {
      const result = await executeNotebookCell(activeReport.notebook.sessionId, cell.content, 60)
      const chunks: string[] = []
      if (result.stdout?.trim()) chunks.push(result.stdout.trimEnd())
      if (result.stderr?.trim()) chunks.push(`stderr:\n${result.stderr.trimEnd()}`)
      if (result.result) chunks.push(`Out[${result.execution_count}]: ${result.result}`)
      if (result.error) chunks.push(`Traceback:\n${result.error.trimEnd()}`)
      if (chunks.length === 0) chunks.push(`Execution ${result.execution_count} completed with no output.`)

      patchReport(reportId, report => ({
        ...report,
        notebook: {
          ...report.notebook,
          lastExecutionCount: result.execution_count,
          error: result.error,
        },
        cells: report.cells.map(c => c.id === id
          ? {
              ...c,
              isExecuting: false,
              executionCount: result.execution_count,
              output: chunks.join('\n\n'),
            }
          : c),
        updatedAt: Date.now(),
      }))
    } catch (error) {
      patchReport(reportId, report => ({
        ...report,
        cells: report.cells.map(c => c.id === id
          ? {
              ...c,
              isExecuting: false,
              output: `Execution failed:\n${error instanceof Error ? error.message : 'Unknown error'}`,
            }
          : c),
        updatedAt: Date.now(),
      }))
    }
  }, [activeReport, patchReport])

  const addCellReference = useCallback((cellId: string) => {
    if (!referencedCells.includes(cellId)) {
      setReferencedCells(prev => [...prev, cellId])
    }
    setShowChat(true)
    chatInputRef.current?.focus()
  }, [referencedCells])

  const removeCellReference = useCallback((cellId: string) => {
    setReferencedCells(prev => prev.filter(id => id !== cellId))
  }, [])

  const sendChatMessage = useCallback(() => {
    if (!activeReport) return
    if (!chatInput.trim() && referencedCells.length === 0) return

    const reportId = activeReport.id

    const userMessage: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: chatInput,
      referencedCells: [...referencedCells],
      timestamp: new Date(),
    }

    patchReport(reportId, report => ({
      ...report,
      chatMessages: [...report.chatMessages, userMessage],
      updatedAt: Date.now(),
    }))
    setChatInput('')
    setReferencedCells([])

    setTimeout(() => {
      const aiMessage: ChatMessage = {
        id: `msg-${Date.now() + 1}`,
        role: 'assistant',
        content: userMessage.referencedCells && userMessage.referencedCells.length > 0
          ? `I reviewed the referenced cells. Suggested notebook follow-up:\n\n1. Convert repeated analysis into a reusable code cell\n2. Add a chart cell for key metric drift\n3. Save final conclusions in a markdown summary section`
          : 'I can help draft markdown, generate code cells, or propose follow-up experiments from this notebook.',
        timestamp: new Date(),
      }

      patchReport(reportId, report => ({
        ...report,
        chatMessages: [...report.chatMessages, aiMessage],
        updatedAt: Date.now(),
      }))
    }, 800)
  }, [activeReport, chatInput, referencedCells, patchReport])

  const createReport = useCallback(() => {
    const reportId = `report-${Date.now()}`
    const newReport: ReportDocument = {
      id: reportId,
      title: `Notebook ${reports.length + 1}`,
      summary: 'New notebook for experiment exploration.',
      updatedAt: Date.now(),
      cells: [{ id: generateId(), type: 'markdown', content: '# New Notebook\n\nStart writing your analysis.' }],
      chatMessages: [],
      notebook: buildNotebookRuntime(),
    }

    setReports(prev => [newReport, ...prev])
    setActiveReportId(reportId)
  }, [reports.length])

  const deleteActiveReport = useCallback(() => {
    if (!activeReport || reports.length <= 1) return

    const remaining = reports.filter(report => report.id !== activeReport.id)
    setReports(remaining)
    setActiveReportId(remaining[0].id)
  }, [activeReport, reports])

  const getCellById = (id: string) => cells.find(c => c.id === id)

  const renderCellContent = (cell: ReportCell) => {
    const isEditing = editingCellId === cell.id && !isPreviewMode

    if (isEditing) {
      return (
        <Textarea
          value={cell.content}
          onChange={(e) => updateCellContent(cell.id, e.target.value)}
          className="min-h-[110px] font-mono text-sm bg-background border-none focus-visible:ring-0 resize-none"
          autoFocus
        />
      )
    }

    switch (cell.type) {
      case 'markdown':
        return (
          <div className="prose prose-sm prose-invert max-w-none">
            {cell.content.split('\n').map((line, i) => {
              if (line.startsWith('# ')) return <h1 key={i} className="text-xl font-bold mt-0 mb-2">{line.slice(2)}</h1>
              if (line.startsWith('## ')) return <h2 key={i} className="text-lg font-semibold mt-4 mb-2">{line.slice(3)}</h2>
              if (line.startsWith('### ')) return <h3 key={i} className="text-base font-medium mt-3 mb-1">{line.slice(4)}</h3>
              if (line.startsWith('- ')) return <li key={i} className="ml-4">{line.slice(2)}</li>
              if (line.match(/^\d+\. /)) return <li key={i} className="ml-4 list-decimal">{line.replace(/^\d+\. /, '')}</li>
              if (line.trim() === '') return <br key={i} />
              return <p key={i} className="my-1">{line}</p>
            })}
          </div>
        )

      case 'code':
        return (
          <div>
            <pre className="bg-secondary/50 rounded-lg p-3 text-sm font-mono overflow-x-auto">
              <code>{cell.content}</code>
            </pre>
            {cell.output && (
              <div className="mt-2 p-2 bg-muted/20 rounded text-sm font-mono text-muted-foreground border-l-2 border-primary/50 whitespace-pre-wrap">
                {cell.output}
              </div>
            )}
          </div>
        )

      case 'chart':
        return (
          <div className="bg-secondary/30 rounded-lg p-4">
            <div className="text-sm font-medium mb-3">{cell.content}</div>
            <div className="h-[180px] bg-background/50 rounded flex items-center justify-center border border-border/50">
              <div className="text-muted-foreground text-sm flex items-center gap-2">
                <BarChart3 className="h-5 w-5" />
                Chart output placeholder
              </div>
            </div>
          </div>
        )

      case 'insight':
        return (
          <div className="bg-primary/5 border border-primary/20 rounded-lg p-4">
            <div className="flex items-center gap-2 text-primary text-sm font-medium mb-2">
              <Sparkles className="h-4 w-4" />
              {cell.content}
            </div>
            {cell.output && (
              <div className="text-sm text-foreground/80">
                {cell.output.split('\n').map((line, i) => {
                  if (line.startsWith('**') && line.includes('**:')) {
                    const [label, ...rest] = line.split(':')
                    return (
                      <p key={i} className="my-1">
                        <strong className="text-foreground">{label.replace(/\*\*/g, '')}:</strong>
                        {rest.join(':')}
                      </p>
                    )
                  }
                  if (line.trim() === '') return <br key={i} />
                  return <p key={i} className="my-1">{line}</p>
                })}
              </div>
            )}
          </div>
        )

      default:
        return <div>{cell.content}</div>
    }
  }

  const renderNotebookCells = () => (
    <ScrollArea className="h-full">
      <div className="p-4 space-y-3">
        {cells.map((cell, index) => {
          const isSelected = selectedCellId === cell.id

          return (
            <div key={cell.id} className="relative group">
              <div
                onClick={() => {
                  setSelectedCellId(cell.id)
                  if (!isPreviewMode) setEditingCellId(cell.id)
                }}
                className={`relative rounded-lg border transition-all ${
                  isSelected
                    ? 'border-primary/50 bg-primary/5'
                    : 'border-border/50 bg-card hover:border-border'
                } ${cell.isExecuting ? 'animate-pulse' : ''}`}
              >
                <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/50 bg-secondary/30 rounded-t-lg">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    {getCellTypeIcon(cell.type)}
                    <span className="capitalize">{cell.type}</span>
                    {cell.executionCount && (
                      <span className="text-primary/70">In [{cell.executionCount}]</span>
                    )}
                  </div>

                  <div className="ml-auto flex items-center gap-0.5">
                    {cell.type === 'code' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation()
                          executeCell(cell.id)
                        }}
                        className="h-6 px-2 text-xs gap-1"
                        title="Run cell"
                        disabled={cell.isExecuting}
                      >
                        {cell.isExecuting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                        Run
                      </Button>
                    )}

                    {!isPreviewMode && isSelected && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation()
                            moveCell(cell.id, 'up')
                          }}
                          className="h-6 w-6 p-0"
                          disabled={index === 0}
                          title="Move up"
                        >
                          <ChevronUp className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation()
                            moveCell(cell.id, 'down')
                          }}
                          className="h-6 w-6 p-0"
                          disabled={index === cells.length - 1}
                          title="Move down"
                        >
                          <ChevronDown className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation()
                            duplicateCell(cell.id)
                          }}
                          className="h-6 w-6 p-0"
                          title="Duplicate"
                        >
                          <Copy className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation()
                            deleteCell(cell.id)
                          }}
                          className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                          title="Delete"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </>
                    )}

                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation()
                        addCellReference(cell.id)
                      }}
                      className="h-6 w-6 p-0 text-primary"
                      title="Reference in assistant"
                    >
                      <AtSign className="h-3 w-3" />
                    </Button>

                    {!isPreviewMode && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                              {getCellTypeIcon(cell.type)}
                              <span className="ml-2">Cell Type</span>
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                              <DropdownMenuItem
                                onClick={() => changeCellType(cell.id, 'markdown')}
                                className={cell.type === 'markdown' ? 'bg-secondary' : ''}
                              >
                                <Type className="h-4 w-4 mr-2" />
                                Markdown
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => changeCellType(cell.id, 'code')}
                                className={cell.type === 'code' ? 'bg-secondary' : ''}
                              >
                                <Code className="h-4 w-4 mr-2" />
                                Code
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => changeCellType(cell.id, 'chart')}
                                className={cell.type === 'chart' ? 'bg-secondary' : ''}
                              >
                                <BarChart3 className="h-4 w-4 mr-2" />
                                Chart
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => changeCellType(cell.id, 'insight')}
                                className={cell.type === 'insight' ? 'bg-secondary' : ''}
                              >
                                <Sparkles className="h-4 w-4 mr-2" />
                                Insight
                              </DropdownMenuItem>
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => addCell('markdown', cell.id)}>
                            <Plus className="h-4 w-4 mr-2" />
                            Add cell below
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => duplicateCell(cell.id)}>
                            <Copy className="h-4 w-4 mr-2" />
                            Duplicate
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => deleteCell(cell.id)}
                            className="text-destructive focus:text-destructive"
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </div>

                <div className="p-3">
                  {renderCellContent(cell)}
                </div>
              </div>
            </div>
          )
        })}

        {!isPreviewMode && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="w-full mt-2 mb-4 p-4 border-2 border-dashed border-border/50 rounded-lg hover:border-primary/50 hover:bg-secondary/20 transition-colors group cursor-pointer"
              >
                <div className="flex items-center justify-center gap-2 text-muted-foreground group-hover:text-foreground transition-colors">
                  <Plus className="h-4 w-4" />
                  <span className="text-sm">Add cell</span>
                </div>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center">
              <DropdownMenuItem onClick={() => addCell('markdown')}>
                <Type className="h-4 w-4 mr-2" />
                Markdown
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => addCell('code')}>
                <Code className="h-4 w-4 mr-2" />
                Code
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => addCell('chart')}>
                <BarChart3 className="h-4 w-4 mr-2" />
                Chart
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => addCell('insight')}>
                <Sparkles className="h-4 w-4 mr-2" />
                Insight
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </ScrollArea>
  )

  const renderChatPanel = () => (
    <div className="h-full flex flex-col bg-background">
      <div className="shrink-0 px-3 py-2 border-b border-border flex items-center justify-between bg-secondary/30">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium">AI Assistant</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowChat(false)}
          className="h-6 w-6 p-0"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3 space-y-3">
          {chatMessages.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>Ask the AI to help with this notebook</p>
              <p className="text-xs mt-1">Use @ on any cell to reference it</p>
            </div>
          ) : (
            chatMessages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-lg p-3 text-sm ${
                    msg.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-secondary'
                  }`}
                >
                  {msg.referencedCells && msg.referencedCells.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-2">
                      {msg.referencedCells.map(cellId => {
                        const cell = getCellById(cellId)
                        return (
                          <Badge key={cellId} variant="outline" className="text-[10px] gap-1">
                            {cell && getCellTypeIcon(cell.type)}
                            @{cell?.type || 'cell'}
                          </Badge>
                        )
                      })}
                    </div>
                  )}
                  <div className="whitespace-pre-wrap">{msg.content}</div>
                </div>
              </div>
            ))
          )}
        </div>
      </ScrollArea>

      {referencedCells.length > 0 && (
        <div className="shrink-0 px-3 py-2 border-t border-border/50 bg-secondary/20">
          <div className="flex flex-wrap gap-1">
            {referencedCells.map(cellId => {
              const cell = getCellById(cellId)
              return (
                <Badge
                  key={cellId}
                  variant="secondary"
                  className="gap-1 pr-1"
                >
                  {cell && getCellTypeIcon(cell.type)}
                  @{cell?.type || 'cell'}
                  <button
                    onClick={() => removeCellReference(cellId)}
                    className="ml-1 hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              )
            })}
          </div>
        </div>
      )}

      <div className="shrink-0 px-3 py-2 border-t border-border">
        <div className="flex gap-1.5 items-end">
          <Textarea
            ref={chatInputRef}
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            placeholder="Ask AI about this notebook..."
            className="min-h-[36px] max-h-[80px] resize-none text-sm py-2 px-3"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                sendChatMessage()
              }
            }}
          />
          <Button
            onClick={sendChatMessage}
            size="icon"
            className="shrink-0 h-7 w-7 rounded-md"
            disabled={!chatInput.trim() && referencedCells.length === 0}
          >
            <Send className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )

  const kernelStatusTone = activeNotebook.status === 'running'
    ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
    : activeNotebook.status === 'starting'
      ? 'bg-amber-500/15 text-amber-400 border-amber-500/30'
      : activeNotebook.status === 'error'
        ? 'bg-destructive/15 text-destructive border-destructive/30'
        : 'bg-muted text-muted-foreground border-border'

  return (
    <div className="h-full overflow-hidden bg-background">
      <ResizablePanelGroup direction="horizontal" className="h-full">
        <ResizablePanel defaultSize={24} minSize={18} maxSize={40}>
          <div className="h-full border-r border-border/70 bg-secondary/15 flex flex-col">
            <div className="p-3 border-b border-border/60 flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold tracking-wide">Reports</p>
                <p className="text-xs text-muted-foreground">Notebook list</p>
              </div>
              <Button size="sm" variant="outline" className="h-7 px-2" onClick={createReport}>
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>

            <ScrollArea className="flex-1">
              <div className="p-2 space-y-1.5">
                {reports.map(report => {
                  const isActive = activeReport?.id === report.id
                  const kernel = report.notebook
                  return (
                    <button
                      type="button"
                      key={report.id}
                      onClick={() => setActiveReportId(report.id)}
                      className={`w-full text-left rounded-lg border p-2.5 transition-colors ${
                        isActive
                          ? 'border-primary/50 bg-primary/10'
                          : 'border-border/40 bg-card hover:border-border/80'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium truncate">{report.title}</p>
                        <span className={`h-2 w-2 mt-1 rounded-full ${
                          kernel.status === 'running' ? 'bg-emerald-400' :
                          kernel.status === 'starting' ? 'bg-amber-400' :
                          kernel.status === 'error' ? 'bg-destructive' :
                          'bg-muted-foreground/40'
                        }`} />
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{report.summary}</p>
                      <p className="mt-2 text-[10px] text-muted-foreground">
                        Updated {new Date(report.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </button>
                  )
                })}
              </div>
            </ScrollArea>

            <div className="p-3 border-t border-border/60 text-xs text-muted-foreground">
              {runs.length} runs available for notebook analysis.
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize={76} minSize={52}>
          <div className="h-full flex flex-col overflow-hidden">
            {activeReport && (
              <>
                <div className="border-b border-border/70 p-3 bg-card/30 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <FileText className="h-4 w-4 text-primary shrink-0" />
                        <h2 className="text-sm font-semibold truncate">{activeReport.title}</h2>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 truncate">{activeReport.summary}</p>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <Badge variant="outline" className={`capitalize ${kernelStatusTone}`}>
                        {activeNotebook.status}
                      </Badge>

                      {activeNotebook.status === 'running' || activeNotebook.status === 'starting' ? (
                        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={stopNotebookKernel}>
                          <Square className="h-3 w-3 mr-1.5" />
                          Stop Kernel
                        </Button>
                      ) : (
                        <Button variant="default" size="sm" className="h-7 text-xs" onClick={startNotebookKernel}>
                          <FlaskConical className="h-3 w-3 mr-1.5" />
                          {activeNotebook.sessionId ? 'Restart Kernel' : 'Start Python Kernel'}
                        </Button>
                      )}

                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={deleteActiveReport}
                        disabled={reports.length <= 1}
                        title="Delete notebook"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                    <Input
                      value={activeNotebook.workdir}
                      onChange={(e) => setNotebookConfig('workdir', e.target.value)}
                      placeholder="Working directory (optional)"
                      className="h-8 text-xs"
                    />
                    <Input
                      value={activeNotebook.pythonCommand}
                      onChange={(e) => setNotebookConfig('pythonCommand', e.target.value)}
                      placeholder="Python command (default: python)"
                      className="h-8 text-xs"
                    />
                    <Input
                      value={activeNotebook.venvPath}
                      onChange={(e) => setNotebookConfig('venvPath', e.target.value)}
                      placeholder="Venv path (optional)"
                      className="h-8 text-xs"
                    />
                  </div>

                  {activeNotebook.tmuxWindow && (
                    <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="inline-flex items-center gap-1">
                        <TerminalSquare className="h-3.5 w-3.5" />
                        tmux window: <code>{activeNotebook.tmuxWindow}</code>
                      </span>
                      {activeNotebook.tmuxPane && <span>pane: <code>{activeNotebook.tmuxPane}</code></span>}
                      <span>attach: <code>{`tmux attach -t research-agent:${activeNotebook.tmuxWindow}`}</code></span>
                    </div>
                  )}

                  {activeNotebook.error && (
                    <p className="text-xs text-destructive">{activeNotebook.error}</p>
                  )}
                </div>

                <div className="flex-1 min-h-0 overflow-hidden relative">
                  {showChat ? (
                    <ResizablePanelGroup direction="vertical" className="h-full">
                      <ResizablePanel defaultSize={68} minSize={40}>
                        {renderNotebookCells()}
                      </ResizablePanel>
                      <ResizableHandle withHandle />
                      <ResizablePanel defaultSize={32} minSize={18}>
                        {renderChatPanel()}
                      </ResizablePanel>
                    </ResizablePanelGroup>
                  ) : (
                    <>
                      {renderNotebookCells()}
                      <div className="absolute bottom-4 right-4">
                        <Button
                          onClick={() => setShowChat(true)}
                          size="lg"
                          className="rounded-full h-12 w-12 shadow-lg"
                        >
                          <MessageSquare className="h-5 w-5" />
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
