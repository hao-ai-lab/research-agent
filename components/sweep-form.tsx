'use client'

import { useState, useMemo } from 'react'
import {
  X,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  Target,
  Terminal,
  Sliders,
  BarChart3,
  AlertTriangle,
  Settings2,
  Check,
  RotateCcw,
  Sparkles,
  Copy,
  Eye,
  Layers,
  Wand2,
  Play,
  Save,
  Pencil,
  StickyNote,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'

import type { SweepConfig, SweepHyperparameter, SweepMetric, SweepInsight, Sweep } from '@/lib/types'
import { createDefaultSweepConfig } from '@/lib/mock-data'

type SweepFormMode = 'simple' | 'advanced'

interface SweepFormProps {
  initialConfig?: SweepConfig
  previousSweeps?: Sweep[]
  onSave: (config: SweepConfig) => void
  onCreate?: (config: SweepConfig) => void
  onCancel: () => void
  onLaunch?: (config: SweepConfig) => void
  onGenerate?: (prompt: string) => void
  isGenerating?: boolean
  defaultMode?: SweepFormMode
}

// ---------- helpers ----------

function generateAutoName(): string {
  const now = new Date()
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `sweep-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

/** Expand hyper-parameters into a list of run combinations */
function expandRunCombinations(
  hyperparameters: SweepHyperparameter[],
): Record<string, string | number>[] {
  const entries = hyperparameters
    .filter((p) => p.name.trim())
    .map((p) => {
      if (p.type === 'choice' && p.values && p.values.length > 0) {
        return { name: p.name, values: p.values }
      }
      if (p.type === 'range' && p.min !== undefined && p.max !== undefined) {
        const step = p.step || 1
        const vals: number[] = []
        for (let v = p.min; v <= p.max; v += step) vals.push(v)
        return { name: p.name, values: vals }
      }
      if (p.type === 'fixed' && p.fixedValue !== undefined) {
        return { name: p.name, values: [p.fixedValue] }
      }
      return null
    })
    .filter(Boolean) as { name: string; values: (string | number)[] }[]

  if (entries.length === 0) return []

  // cartesian product
  let combos: Record<string, string | number>[] = [{}]
  for (const entry of entries) {
    const next: Record<string, string | number>[] = []
    for (const combo of combos) {
      for (const val of entry.values) {
        next.push({ ...combo, [entry.name]: val })
      }
    }
    combos = next
  }
  return combos
}

// ---------- component ----------

export function SweepForm({
  initialConfig,
  previousSweeps = [],
  onSave,
  onCreate,
  onCancel,
  onLaunch,
  onGenerate,
  isGenerating = false,
  defaultMode = 'simple',
}: SweepFormProps) {
  const [config, setConfig] = useState<SweepConfig>(() => {
    const base = initialConfig || createDefaultSweepConfig()
    return { ...base, name: base.name || generateAutoName() }
  })
  const [mode, setMode] = useState<SweepFormMode>(defaultMode)
  const [editingName, setEditingName] = useState(false)
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    name: false,
    goal: true,
    command: false,
    hyperparameters: false,
    metrics: true,
    insights: false,
    settings: false,
    notes: false,
  })

  // Simple mode parameters (key=values string pairs)
  const [simpleParams, setSimpleParams] = useState<{ key: string; values: string }[]>(() => {
    // Initialize from initial config if available
    if (initialConfig?.hyperparameters?.length) {
      return initialConfig.hyperparameters
        .filter((p) => p.name.trim())
        .map((p) => ({
          key: p.name,
          values:
            p.type === 'choice'
              ? (p.values || []).join(', ')
              : p.type === 'fixed'
              ? String(p.fixedValue ?? '')
              : p.min !== undefined && p.max !== undefined
              ? `${p.min}..${p.max}${p.step ? `:${p.step}` : ''}`
              : '',
        }))
    }
    return [{ key: '', values: '' }]
  })

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }))
  }

  const updateConfig = (updates: Partial<SweepConfig>) => {
    setConfig((prev) => ({ ...prev, ...updates, updatedAt: new Date() }))
  }

  // ---------- sync simple params → config hyperparameters ----------
  const syncSimpleParamsToConfig = () => {
    const hyperparameters: SweepHyperparameter[] = simpleParams
      .filter((p) => p.key.trim() && p.values.trim())
      .map((p) => {
        const vals = p.values.split(',').map((v) => {
          const trimmed = v.trim()
          const num = Number(trimmed)
          return isNaN(num) ? trimmed : num
        })
        return { name: p.key.trim(), type: 'choice' as const, values: vals }
      })
    return hyperparameters
  }

  // ---------- Hyperparameter handlers ----------
  const addHyperparameter = () => {
    const newParam: SweepHyperparameter = { name: '', type: 'choice', values: [] }
    updateConfig({ hyperparameters: [...config.hyperparameters, newParam] })
  }

  const updateHyperparameter = (index: number, updates: Partial<SweepHyperparameter>) => {
    const newParams = [...config.hyperparameters]
    newParams[index] = { ...newParams[index], ...updates }
    updateConfig({ hyperparameters: newParams })
  }

  const removeHyperparameter = (index: number) => {
    updateConfig({ hyperparameters: config.hyperparameters.filter((_, i) => i !== index) })
  }

  // ---------- Metric handlers ----------
  const addMetric = () => {
    const newMetric: SweepMetric = {
      name: '',
      path: '',
      goal: 'minimize',
      isPrimary: config.metrics.length === 0,
    }
    updateConfig({ metrics: [...config.metrics, newMetric] })
  }

  const updateMetric = (index: number, updates: Partial<SweepMetric>) => {
    const newMetrics = [...config.metrics]
    if (updates.isPrimary) {
      newMetrics.forEach((m, i) => {
        if (i !== index) m.isPrimary = false
      })
    }
    newMetrics[index] = { ...newMetrics[index], ...updates }
    updateConfig({ metrics: newMetrics })
  }

  const removeMetric = (index: number) => {
    updateConfig({ metrics: config.metrics.filter((_, i) => i !== index) })
  }

  // ---------- Insight handlers ----------
  const addInsight = () => {
    const newInsight: SweepInsight = {
      id: `insight-${Date.now()}`,
      type: 'review',
      condition: '',
      description: '',
    }
    updateConfig({ insights: [...config.insights, newInsight] })
  }

  const updateInsight = (index: number, updates: Partial<SweepInsight>) => {
    const newInsights = [...config.insights]
    newInsights[index] = { ...newInsights[index], ...updates }
    updateConfig({ insights: newInsights })
  }

  const removeInsight = (index: number) => {
    updateConfig({ insights: config.insights.filter((_, i) => i !== index) })
  }

  // ---------- Duplicate from previous ----------
  const handleDuplicate = (sweepId: string) => {
    const sweep = previousSweeps.find((s) => s.id === sweepId)
    if (!sweep) return
    const cloned = {
      ...sweep.config,
      id: `sweep-${Date.now()}`,
      name: '',
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    setConfig(cloned)
    // Also update simple params
    setSimpleParams(
      cloned.hyperparameters.filter((p) => p.name.trim()).map((p) => ({
        key: p.name,
        values:
          p.type === 'choice'
            ? (p.values || []).join(', ')
            : String(p.fixedValue ?? ''),
      }))
    )
  }

  // ---------- Prepare config for save/launch ----------
  const prepareConfig = (): SweepConfig => {
    let finalConfig = { ...config }

    // Sync simple params if in simple mode
    if (mode === 'simple') {
      finalConfig.hyperparameters = syncSimpleParamsToConfig()
    }

    // Auto-generate name if blank
    if (!finalConfig.name.trim()) {
      finalConfig.name = generateAutoName()
    }

    // Merge description into goal if description has content but goal doesn't reference it
    if (finalConfig.description && !finalConfig.goal.includes(finalConfig.description)) {
      finalConfig.goal = finalConfig.goal
        ? `${finalConfig.goal}\n\n${finalConfig.description}`
        : finalConfig.description
    }

    return finalConfig
  }

  // Validation: in simple mode only goal is required; in advanced, command + at least one param
  const isValid = mode === 'simple'
    ? !!config.goal.trim()
    : config.command.trim() && config.hyperparameters.some(p => p.name.trim())

  // ---------- Run combinations for preview ----------
  const runCombinations = useMemo(() => {
    if (mode === 'simple') {
      const hp = syncSimpleParamsToConfig()
      return expandRunCombinations(hp)
    }
    return expandRunCombinations(config.hyperparameters)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, config.hyperparameters, simpleParams])

  const paramNames = useMemo(() => {
    if (runCombinations.length === 0) return []
    return Object.keys(runCombinations[0])
  }, [runCombinations])

  const [showPreview, setShowPreview] = useState(false)
  const [duplicatedFrom, setDuplicatedFrom] = useState<string | null>(null)

  // ========== RENDER ==========
  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Sparkles className="h-4 w-4 text-accent shrink-0" />
          {editingName ? (
            <Input
              autoFocus
              value={config.name}
              onChange={(e) => updateConfig({ name: e.target.value })}
              onBlur={() => setEditingName(false)}
              onKeyDown={(e) => { if (e.key === 'Enter') setEditingName(false) }}
              className="h-6 text-sm font-semibold px-1.5 py-0"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingName(true)}
              className="flex items-center gap-1.5 min-w-0 group"
            >
              <h2 className="text-sm font-semibold text-foreground truncate">
                {config.name || 'Untitled Sweep'}
              </h2>
              <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
            </button>
          )}
          {isGenerating && (
            <Badge variant="secondary" className="text-[10px] shrink-0">
              AI Generating...
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {/* Mode toggle */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={`h-6 w-6 ${mode === 'advanced' ? 'text-accent' : 'text-muted-foreground'}`}
                  onClick={() => setMode(mode === 'simple' ? 'advanced' : 'simple')}
                >
                  {mode === 'simple' ? <Sparkles className="h-3.5 w-3.5" /> : <Settings2 className="h-3.5 w-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p className="text-xs">{mode === 'simple' ? 'Simple mode — switch to Advanced' : 'Advanced mode — switch to Simple'}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          {/* Create from previous sweep */}
          {previousSweeps.length > 0 && (
            <Select onValueChange={(v) => { setDuplicatedFrom(v); handleDuplicate(v) }}>
              <SelectTrigger className={`h-6 w-auto gap-1 px-2 text-[11px] border-none ${
                duplicatedFrom
                  ? 'bg-accent/20 text-accent hover:bg-accent/30'
                  : 'bg-secondary/60 text-muted-foreground hover:bg-secondary'
              }`}>
                <Copy className="h-3 w-3" />
                <span className="hidden sm:inline"><SelectValue placeholder="Create from..." /></span>
              </SelectTrigger>
              <SelectContent align="end" className="max-w-[320px]">
                <div className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Create from sweep…
                </div>
                {previousSweeps.map((s) => {
                  const createdStr = s.createdAt
                    ? new Date(s.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                    : ''
                  return (
                    <SelectItem key={s.id} value={s.id} className="text-xs">
                      <div className="flex flex-col gap-0.5">
                        <span className="font-medium">{s.config.name || s.id}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {s.id}{createdStr ? ` · ${createdStr}` : ''}
                        </span>
                      </div>
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
          )}

          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onCancel}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Form Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-4 space-y-3">
          {/* ========== SIMPLE MODE ========== */}
          {mode === 'simple' && (
            <>
              {/* Goal & Description (merged) */}
              <Collapsible open={expandedSections.goal} onOpenChange={() => toggleSection('goal')}>
                <CollapsibleTrigger className="flex items-center gap-2 w-full py-2 text-left">
                  {expandedSections.goal ? (
                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  )}
                  <Target className="h-3.5 w-3.5 text-accent" />
                  <span className="text-xs font-medium">Goal & Description<span className="text-destructive"> *</span></span>
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-2">
                  <Textarea
                    value={config.goal}
                    onChange={(e) => updateConfig({ goal: e.target.value })}
                    placeholder="What is the goal of this experiment and any additional context? e.g., Find the optimal learning rate..."
                    className="text-sm min-h-[80px]"
                  />
                </CollapsibleContent>
              </Collapsible>

              {/* Command — optional, collapsible */}
              <Collapsible open={expandedSections.command} onOpenChange={() => toggleSection('command')}>
                <CollapsibleTrigger className="flex items-center gap-2 w-full py-2 text-left">
                  {expandedSections.command ? (
                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  )}
                  <Terminal className="h-3.5 w-3.5 text-blue-400" />
                  <span className="text-xs font-medium">Command / Script</span>
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-1">
                  <Textarea
                    value={config.command}
                    onChange={(e) => updateConfig({ command: e.target.value })}
                    placeholder="python train.py --lr {learning_rate} --batch-size {batch_size}"
                    className="text-sm font-mono min-h-[60px]"
                  />
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Parameters will be appended as --key=value
                  </p>
                </CollapsibleContent>
              </Collapsible>

              {/* Hyperparameters — optional, collapsible */}
              <Collapsible open={expandedSections.hyperparameters} onOpenChange={() => toggleSection('hyperparameters')}>
                <CollapsibleTrigger className="flex items-center gap-2 w-full py-2 text-left">
                  {expandedSections.hyperparameters ? (
                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  )}
                  <Sliders className="h-3.5 w-3.5 text-purple-400" />
                  <span className="text-xs font-medium">Hyperparameters</span>
                  {simpleParams.some(p => p.key.trim()) && (
                    <Badge variant="secondary" className="text-[10px] ml-auto">
                      {simpleParams.filter(p => p.key.trim()).length}
                    </Badge>
                  )}
                  <Button
                    variant="default"
                    size="icon"
                    className={`h-5 w-5 shrink-0 ${simpleParams.some(p => p.key.trim()) ? '' : 'ml-auto'}`}
                    onClick={(e) => { e.stopPropagation(); setSimpleParams([...simpleParams, { key: '', values: '' }]); if (!expandedSections.hyperparameters) toggleSection('hyperparameters') }}
                  >
                    <Plus className="h-3 w-3" />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-1 space-y-2">
                  <div className="space-y-2">
                    {simpleParams.map((param, index) => (
                      <div key={index} className="flex gap-2 items-start">
                        <Input
                          placeholder="key"
                          value={param.key}
                          onChange={(e) => {
                            const next = [...simpleParams]
                            next[index].key = e.target.value
                            setSimpleParams(next)
                          }}
                          className="w-24 h-8 text-xs"
                        />
                        <Input
                          placeholder="values (comma-separated)"
                          value={param.values}
                          onChange={(e) => {
                            const next = [...simpleParams]
                            next[index].values = e.target.value
                            setSimpleParams(next)
                          }}
                          className="flex-1 h-8 text-xs"
                        />
                        {simpleParams.length > 1 && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 shrink-0"
                            onClick={() => setSimpleParams(simpleParams.filter((_, i) => i !== index))}
                          >
                            <Trash2 className="h-3 w-3 text-destructive" />
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Example: lr → 0.001, 0.01, 0.1
                  </p>
                  {simpleParams.some(p => p.key.trim()) && (
                    <div className="flex justify-end pt-1">
                      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setSimpleParams([...simpleParams, { key: '', values: '' }])}>
                        <Plus className="h-3 w-3" />
                      </Button>
                    </div>
                  )}
                </CollapsibleContent>
              </Collapsible>

              {/* Notes — optional, collapsible */}
              <Collapsible open={expandedSections.notes} onOpenChange={() => toggleSection('notes')}>
                <CollapsibleTrigger className="flex items-center gap-2 w-full py-2 text-left">
                  {expandedSections.notes ? (
                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  )}
                  <StickyNote className="h-3.5 w-3.5 text-yellow-400" />
                  <span className="text-xs font-medium">Notes</span>
                  {!expandedSections.notes && config.notes?.trim() && (
                    <span className="text-[10px] text-muted-foreground ml-auto truncate max-w-[180px]">{config.notes}</span>
                  )}
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-1">
                  <Textarea
                    value={config.notes || ''}
                    onChange={(e) => updateConfig({ notes: e.target.value })}
                    placeholder="Add notes about this sweep..."
                    className="text-sm min-h-[60px]"
                  />
                </CollapsibleContent>
              </Collapsible>

              {/* Expected runs summary */}
              {runCombinations.length > 0 && (
                <div className="rounded-lg bg-secondary/50 p-3">
                  <p className="text-xs text-muted-foreground">
                    This will create{' '}
                    <span className="font-medium text-foreground">{runCombinations.length}</span>{' '}
                    runs
                  </p>
                </div>
              )}
            </>
          )}

          {/* ========== ADVANCED MODE ========== */}
          {mode === 'advanced' && (
            <>

              {/* Goal & Description (merged) */}
              <Collapsible open={expandedSections.goal} onOpenChange={() => toggleSection('goal')}>
                <CollapsibleTrigger className="flex items-center gap-2 w-full py-2 text-left">
                  {expandedSections.goal ? (
                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  )}
                  <Target className="h-3.5 w-3.5 text-accent" />
                  <span className="text-xs font-medium">Goal & Description<span className="text-destructive"> *</span></span>
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-2">
                  <Textarea
                    value={config.goal}
                    onChange={(e) => updateConfig({ goal: e.target.value })}
                    placeholder="What is the goal of this experiment and any additional context? e.g., Find the optimal learning rate..."
                    className="text-sm min-h-[80px]"
                  />
                </CollapsibleContent>
              </Collapsible>

              {/* Command Section */}
              <Collapsible open={expandedSections.command} onOpenChange={() => toggleSection('command')}>
                <CollapsibleTrigger className="flex items-center gap-2 w-full py-2 text-left">
                  {expandedSections.command ? (
                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  )}
                  <Terminal className="h-3.5 w-3.5 text-blue-400" />
                  <span className="text-xs font-medium">Command / Script</span>
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-2">
                  <Textarea
                    value={config.command}
                    onChange={(e) => updateConfig({ command: e.target.value })}
                    placeholder="python train.py --lr {learning_rate} --batch-size {batch_size}"
                    className="text-sm font-mono min-h-[60px]"
                  />
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Use {'{param_name}'} for hyperparameter placeholders
                  </p>
                </CollapsibleContent>
              </Collapsible>

              {/* Hyperparameters Section */}
              <Collapsible open={expandedSections.hyperparameters} onOpenChange={() => toggleSection('hyperparameters')}>
                <CollapsibleTrigger className="flex items-center gap-2 w-full py-2 text-left">
                  {expandedSections.hyperparameters ? (
                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  )}
                  <Sliders className="h-3.5 w-3.5 text-purple-400" />
                  <span className="text-xs font-medium">Hyperparameters</span>
                  <Badge variant="secondary" className="text-[10px] ml-auto">
                    {config.hyperparameters.length}
                  </Badge>
                  <Button
                    variant="default"
                    size="icon"
                    className="h-5 w-5 shrink-0"
                    onClick={(e) => { e.stopPropagation(); addHyperparameter(); if (!expandedSections.hyperparameters) toggleSection('hyperparameters') }}
                  >
                    <Plus className="h-3 w-3" />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-2 space-y-2">
                  {config.hyperparameters.map((param, index) => (
                    <div key={index} className="p-2 rounded-lg bg-secondary/30 border border-border/50 space-y-2">
                      <div className="flex items-center gap-2">
                        <Input
                          value={param.name}
                          onChange={(e) => updateHyperparameter(index, { name: e.target.value })}
                          placeholder="Parameter name"
                          className="h-7 text-xs flex-1"
                        />
                        <Select
                          value={param.type}
                          onValueChange={(value: 'range' | 'choice' | 'fixed') =>
                            updateHyperparameter(index, { type: value })
                          }
                        >
                          <SelectTrigger className="h-7 w-24 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="choice">Choice</SelectItem>
                            <SelectItem value="range">Range</SelectItem>
                            <SelectItem value="fixed">Fixed</SelectItem>
                          </SelectContent>
                        </Select>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => removeHyperparameter(index)}
                        >
                          <Trash2 className="h-3 w-3 text-destructive" />
                        </Button>
                      </div>

                      {param.type === 'choice' && (
                        <Input
                          value={param.values?.join(', ') || ''}
                          onChange={(e) =>
                            updateHyperparameter(index, {
                              values: e.target.value.split(',').map((v) => {
                                const trimmed = v.trim()
                                const num = Number(trimmed)
                                return isNaN(num) ? trimmed : num
                              }),
                            })
                          }
                          placeholder="Values (comma separated): 8, 16, 32, 64"
                          className="h-7 text-xs"
                        />
                      )}

                      {param.type === 'range' && (
                        <div className="flex items-center gap-2">
                          <Input
                            type="number"
                            value={param.min || ''}
                            onChange={(e) =>
                              updateHyperparameter(index, { min: parseFloat(e.target.value) })
                            }
                            placeholder="Min"
                            className="h-7 text-xs"
                          />
                          <Input
                            type="number"
                            value={param.max || ''}
                            onChange={(e) =>
                              updateHyperparameter(index, { max: parseFloat(e.target.value) })
                            }
                            placeholder="Max"
                            className="h-7 text-xs"
                          />
                          <Input
                            type="number"
                            value={param.step || ''}
                            onChange={(e) =>
                              updateHyperparameter(index, { step: parseFloat(e.target.value) })
                            }
                            placeholder="Step"
                            className="h-7 text-xs"
                          />
                        </div>
                      )}

                      {param.type === 'fixed' && (
                        <Input
                          value={param.fixedValue?.toString() || ''}
                          onChange={(e) => {
                            const val = e.target.value
                            const num = Number(val)
                            updateHyperparameter(index, {
                              fixedValue: isNaN(num) ? val : num,
                            })
                          }}
                          placeholder="Fixed value"
                          className="h-7 text-xs"
                        />
                      )}
                    </div>
                  ))}
                  {config.hyperparameters.length > 0 && (
                    <div className="flex justify-end pt-1">
                      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={addHyperparameter}>
                        <Plus className="h-3 w-3" />
                      </Button>
                    </div>
                  )}
                </CollapsibleContent>
              </Collapsible>

              {/* Metrics Section */}
              <Collapsible open={expandedSections.metrics} onOpenChange={() => toggleSection('metrics')}>
                <CollapsibleTrigger className="flex items-center gap-2 w-full py-2 text-left">
                  {expandedSections.metrics ? (
                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  )}
                  <BarChart3 className="h-3.5 w-3.5 text-emerald-400" />
                  <span className="text-xs font-medium">Metrics</span>
                  <Badge variant="secondary" className="text-[10px] ml-auto">
                    {config.metrics.length}
                  </Badge>
                  <Button
                    variant="default"
                    size="icon"
                    className="h-5 w-5 shrink-0"
                    onClick={(e) => { e.stopPropagation(); addMetric(); if (!expandedSections.metrics) toggleSection('metrics') }}
                  >
                    <Plus className="h-3 w-3" />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-2 space-y-2">
                  {config.metrics.map((metric, index) => (
                    <div key={index} className="p-2 rounded-lg bg-secondary/30 border border-border/50 space-y-1.5">
                      {/* Row 1: Metric ID (path) + Name (alias) + Goal + Delete */}
                      <div className="flex items-center gap-1.5">
                        <Input
                          value={metric.path}
                          onChange={(e) => updateMetric(index, { path: e.target.value })}
                          placeholder="Metric ID (e.g., val/loss)"
                          className="h-7 text-xs flex-[2] min-w-0"
                        />
                        <Input
                          value={metric.name}
                          onChange={(e) => updateMetric(index, { name: e.target.value })}
                          placeholder="Alias"
                          className="h-7 text-xs flex-1 min-w-0"
                        />
                        <Select
                          value={metric.goal}
                          onValueChange={(value: 'minimize' | 'maximize') =>
                            updateMetric(index, { goal: value })
                          }
                        >
                          <SelectTrigger className="h-7 w-[70px] text-xs shrink-0">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="minimize">Min</SelectItem>
                            <SelectItem value="maximize">Max</SelectItem>
                          </SelectContent>
                        </Select>
                        <div className="flex items-center gap-1 shrink-0">
                          <Switch
                            checked={metric.isPrimary}
                            onCheckedChange={(checked) => updateMetric(index, { isPrimary: checked })}
                            className="scale-[0.6]"
                          />
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0"
                          onClick={() => removeMetric(index)}
                        >
                          <Trash2 className="h-3 w-3 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  ))}
                  {config.metrics.length > 0 && (
                    <div className="flex justify-end pt-1">
                      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={addMetric}>
                        <Plus className="h-3 w-3" />
                      </Button>
                    </div>
                  )}
                </CollapsibleContent>
              </Collapsible>

              {/* Insights Section */}
              <Collapsible open={expandedSections.insights} onOpenChange={() => toggleSection('insights')}>
                <CollapsibleTrigger className="flex items-center gap-2 w-full py-2 text-left">
                  {expandedSections.insights ? (
                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  )}
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                  <span className="text-xs font-medium">Insights & Alerts</span>
                  <Badge variant="secondary" className="text-[10px] ml-auto">
                    {config.insights.length}
                  </Badge>
                  <Button
                    variant="default"
                    size="icon"
                    className="h-5 w-5 shrink-0"
                    onClick={(e) => { e.stopPropagation(); addInsight(); if (!expandedSections.insights) toggleSection('insights') }}
                  >
                    <Plus className="h-3 w-3" />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-2 space-y-2">
                  <p className="text-[10px] text-muted-foreground">
                    Define conditions to detect failures, suspicious behavior, or things needing review.
                  </p>
                  {config.insights.map((insight, index) => (
                    <div key={insight.id} className="p-2 rounded-lg bg-secondary/30 border border-border/50 space-y-2">
                      <div className="flex items-center gap-2">
                        <Select
                          value={insight.type}
                          onValueChange={(value: 'failure' | 'suspicious' | 'review') =>
                            updateInsight(index, { type: value })
                          }
                        >
                          <SelectTrigger className="h-7 w-28 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="failure">Failure</SelectItem>
                            <SelectItem value="suspicious">Suspicious</SelectItem>
                            <SelectItem value="review">Review</SelectItem>
                          </SelectContent>
                        </Select>
                        <Input
                          value={insight.condition}
                          onChange={(e) => updateInsight(index, { condition: e.target.value })}
                          placeholder="Condition (e.g., loss > 10)"
                          className="h-7 text-xs flex-1"
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => removeInsight(index)}
                        >
                          <Trash2 className="h-3 w-3 text-destructive" />
                        </Button>
                      </div>
                      <Input
                        value={insight.description}
                        onChange={(e) => updateInsight(index, { description: e.target.value })}
                        placeholder="Description of what this means"
                        className="h-7 text-xs"
                      />
                      <Input
                        value={insight.action || ''}
                        onChange={(e) => updateInsight(index, { action: e.target.value })}
                        placeholder="Suggested action (optional)"
                        className="h-7 text-xs"
                      />
                    </div>
                  ))}

                  {config.insights.length > 0 && (
                    <div className="flex justify-end pt-1">
                      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={addInsight}>
                        <Plus className="h-3 w-3" />
                      </Button>
                    </div>
                  )}
                </CollapsibleContent>
              </Collapsible>

              {/* Settings Section */}
              <Collapsible open={expandedSections.settings} onOpenChange={() => toggleSection('settings')}>
                <CollapsibleTrigger className="flex items-center gap-2 w-full py-2 text-left">
                  {expandedSections.settings ? (
                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  )}
                  <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium">Sweep Settings</span>
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-2 space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[10px] text-muted-foreground">Max Runs</label>
                      <Input
                        type="number"
                        value={config.maxRuns || ''}
                        onChange={(e) => updateConfig({ maxRuns: parseInt(e.target.value) || undefined })}
                        className="h-7 text-xs"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-muted-foreground">Parallel Runs</label>
                      <Input
                        type="number"
                        value={config.parallelRuns || ''}
                        onChange={(e) => updateConfig({ parallelRuns: parseInt(e.target.value) || undefined })}
                        className="h-7 text-xs"
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={config.earlyStoppingEnabled}
                        onCheckedChange={(checked) => updateConfig({ earlyStoppingEnabled: checked })}
                        className="scale-75"
                      />
                      <span className="text-xs">Early Stopping</span>
                    </div>
                    {config.earlyStoppingEnabled && (
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] text-muted-foreground">Patience:</span>
                        <Input
                          type="number"
                          value={config.earlyStoppingPatience || ''}
                          onChange={(e) =>
                            updateConfig({ earlyStoppingPatience: parseInt(e.target.value) || undefined })
                          }
                          className="h-6 w-12 text-xs"
                        />
                      </div>
                    )}
                  </div>
                </CollapsibleContent>
              </Collapsible>

              {/* Notes */}
              <Collapsible open={expandedSections.notes} onOpenChange={() => toggleSection('notes')}>
                <CollapsibleTrigger className="flex items-center gap-2 w-full py-2 text-left">
                  {expandedSections.notes ? (
                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  )}
                  <StickyNote className="h-3.5 w-3.5 text-yellow-400" />
                  <span className="text-xs font-medium">Notes</span>
                  {!expandedSections.notes && config.notes?.trim() && (
                    <span className="text-[10px] text-muted-foreground ml-auto truncate max-w-[180px]">{config.notes}</span>
                  )}
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-1">
                  <Textarea
                    value={config.notes || ''}
                    onChange={(e) => updateConfig({ notes: e.target.value })}
                    placeholder="Add notes about this sweep..."
                    className="text-sm min-h-[60px]"
                  />
                </CollapsibleContent>
              </Collapsible>
            </>
          )}
        </div>
      </div>

      {/* Preview toggle + preview content */}
      {(runCombinations.length > 0 || mode === 'advanced') && (
        <div className="border-t border-border">
          <button
            type="button"
            onClick={() => setShowPreview((p) => !p)}
            className="flex items-center justify-between w-full px-4 py-2 text-xs hover:bg-secondary/30 transition-colors"
          >
            <span className="flex items-center gap-2 text-muted-foreground">
              <Eye className="h-3 w-3" />
              Preview
              {runCombinations.length > 0 && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                  {runCombinations.length} runs
                </Badge>
              )}
            </span>
            <Switch
              checked={showPreview}
              onCheckedChange={setShowPreview}
              className="scale-75"
              onClick={(e) => e.stopPropagation()}
            />
          </button>

          {showPreview && runCombinations.length > 0 && paramNames.length > 0 && (
            <div className="px-4 pb-3 max-h-[200px] overflow-y-auto">
              <div className="rounded-lg border border-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-secondary/50">
                      <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">#</th>
                      {paramNames.map((name) => (
                        <th key={name} className="px-2 py-1.5 text-left font-medium text-muted-foreground">
                          {name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {runCombinations.slice(0, 20).map((combo, i) => (
                      <tr key={i} className="border-t border-border/50 hover:bg-secondary/20">
                        <td className="px-2 py-1 text-muted-foreground">{i + 1}</td>
                        {paramNames.map((name) => (
                          <td key={name} className="px-2 py-1 font-mono">
                            {String(combo[name])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {runCombinations.length > 20 && (
                  <div className="px-2 py-1.5 text-center text-[10px] text-muted-foreground border-t border-border/50 bg-secondary/30">
                    ... and {runCombinations.length - 20} more runs
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Footer Actions */}
      <div className="px-3 py-2 border-t border-border">
        <div className="flex gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-3 text-[11px] text-muted-foreground"
            onClick={() => onSave(prepareConfig())}
          >
            <Save className="h-3 w-3 mr-1" />
            Save Draft
          </Button>

          {mode === 'simple' && onGenerate ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="flex-1 h-7 text-[11px]"
                    disabled={!config.goal.trim()}
                    onClick={() => {
                      const parts = [`/sweep ${config.goal.trim()}`]
                      if (config.command.trim()) parts.push(`--command "${config.command.trim()}"`)
                      if (config.name.trim()) parts.push(`--name "${config.name.trim()}"`)
                      simpleParams.forEach((p) => {
                        if (p.key && p.values) parts.push(`--param ${p.key}=${p.values}`)
                      })
                      onGenerate(parts.join(' '))
                    }}
                  >
                    <Wand2 className="h-3 w-3 mr-1" />
                    Generate
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p className="text-xs">Generate Sweep from AI</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : onCreate ? (
            <Button
              variant="secondary"
              size="sm"
              className="flex-1 h-7 text-[11px] bg-violet-500 text-white hover:bg-violet-600"
              onClick={() => onCreate(prepareConfig())}
              disabled={!isValid}
            >
              <Wand2 className="h-3 w-3 mr-1" />
              Create (AI)
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              className="flex-1 h-7 text-[11px] bg-green-600 hover:bg-green-700 text-white"
              onClick={() => onSave(prepareConfig())}
              disabled={!isValid}
            >
              <Check className="h-3 w-3 mr-1" />
              Create
            </Button>
          )}

          {onLaunch && (
            <Button
              size="sm"
              className="flex-1 h-7 text-[11px] bg-accent hover:bg-accent/90"
              onClick={() => onLaunch(prepareConfig())}
              disabled={!isValid}
            >
              <Play className="h-3 w-3 mr-1" />
              Launch
            </Button>
          )}

          <div className="border-l border-border mx-1" />

          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-3 text-[11px] text-muted-foreground"
            onClick={onCancel}
          >
            Cancel
          </Button>

          <Button
            size="sm"
            className="h-7 px-4 text-[11px]"
            onClick={() => onSave(prepareConfig())}
          >
            <Save className="h-3 w-3 mr-1" />
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}
