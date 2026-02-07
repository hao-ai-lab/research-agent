'use client'

import { useMemo, useState } from 'react'
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
  WandSparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
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

import type { SweepConfig, SweepHyperparameter, SweepMetric, SweepInsight } from '@/lib/types'
import { createDefaultSweepConfig } from '@/lib/mock-data'
import { buildSweepDraftFromPrompt } from '@/lib/sweep-nl'

interface SweepFormProps {
  initialConfig?: SweepConfig
  onSave: (config: SweepConfig) => void
  onCancel: () => void
  onLaunch?: (config: SweepConfig) => void
  isGenerating?: boolean
}

interface DraftMeta {
  extracted: string[]
  confidence: number
}

const PRESET_PROMPTS = [
  {
    label: 'Learning Rate Sweep',
    prompt: 'Create a sweep for learning rate from 1e-5 to 3e-3 with 20 runs, optimize validation loss, and run 4 in parallel.',
  },
  {
    label: 'LR + Batch Matrix',
    prompt: 'Grid search learning rate values 1e-4, 3e-4, 1e-3 and batch size 16, 32, 64. Maximize accuracy with up to 18 runs.',
  },
  {
    label: 'Regularization Tuning',
    prompt: 'Sweep dropout from 0.0 to 0.4 and weight decay values 0, 1e-4, 5e-4. Minimize val loss, 12 runs, 3 concurrent.',
  },
]

function parseCommaValues(raw: string): Array<string | number> {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const numeric = Number(value)
      return Number.isFinite(numeric) ? numeric : value
    })
}

function normalizeConfig(config: SweepConfig): SweepConfig {
  const normalizedMetrics = config.metrics.map((metric, index) => ({
    ...metric,
    isPrimary: index === 0 ? true : metric.isPrimary,
  }))

  if (!normalizedMetrics.some((metric) => metric.isPrimary) && normalizedMetrics[0]) {
    normalizedMetrics[0].isPrimary = true
  }

  return {
    ...config,
    metrics: normalizedMetrics,
    updatedAt: new Date(),
  }
}

function isMetricValid(metric: SweepMetric): boolean {
  return metric.name.trim().length > 0 && metric.path.trim().length > 0
}

function isHyperparameterValid(param: SweepHyperparameter): boolean {
  if (!param.name.trim()) return false

  if (param.type === 'choice') {
    return Boolean(param.values && param.values.length > 1)
  }

  if (param.type === 'range') {
    return Number.isFinite(param.min) && Number.isFinite(param.max)
  }

  return param.fixedValue !== undefined && `${param.fixedValue}`.trim().length > 0
}

export function SweepForm({
  initialConfig,
  onSave,
  onCancel,
  onLaunch,
  isGenerating = false,
}: SweepFormProps) {
  const [config, setConfig] = useState<SweepConfig>(
    initialConfig || createDefaultSweepConfig()
  )
  const [nlPrompt, setNlPrompt] = useState('')
  const [draftMeta, setDraftMeta] = useState<DraftMeta | null>(null)
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    goal: true,
    command: true,
    hyperparameters: true,
    metrics: true,
    insights: false,
    settings: false,
  })

  const configuredHyperparameters = useMemo(
    () => config.hyperparameters.filter(isHyperparameterValid).length,
    [config.hyperparameters]
  )

  const configuredMetrics = useMemo(
    () => config.metrics.filter(isMetricValid).length,
    [config.metrics]
  )

  const isValid =
    config.name.trim().length > 0 &&
    config.command.trim().length > 0 &&
    configuredHyperparameters > 0 &&
    configuredMetrics > 0

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }))
  }

  const updateConfig = (updates: Partial<SweepConfig>) => {
    setConfig((prev) => ({ ...prev, ...updates, updatedAt: new Date() }))
  }

  const applyPromptDraft = (prompt: string) => {
    if (!prompt.trim()) return

    const drafted = buildSweepDraftFromPrompt(prompt, config)
    setConfig((prev) => ({
      ...drafted.config,
      id: prev.id,
      createdAt: prev.createdAt,
      updatedAt: new Date(),
    }))
    setDraftMeta({ extracted: drafted.extracted, confidence: drafted.confidence })
  }

  const addHyperparameter = () => {
    updateConfig({
      hyperparameters: [
        ...config.hyperparameters,
        {
          name: '',
          type: 'choice',
          values: [],
        },
      ],
    })
  }

  const updateHyperparameter = (index: number, updates: Partial<SweepHyperparameter>) => {
    const next = [...config.hyperparameters]
    next[index] = { ...next[index], ...updates }
    updateConfig({ hyperparameters: next })
  }

  const removeHyperparameter = (index: number) => {
    updateConfig({
      hyperparameters: config.hyperparameters.filter((_, i) => i !== index),
    })
  }

  const addMetric = () => {
    updateConfig({
      metrics: [
        ...config.metrics,
        {
          name: '',
          path: '',
          goal: 'minimize',
          isPrimary: config.metrics.length === 0,
        },
      ],
    })
  }

  const updateMetric = (index: number, updates: Partial<SweepMetric>) => {
    const next = [...config.metrics]
    if (updates.isPrimary) {
      next.forEach((metric, idx) => {
        if (idx !== index) metric.isPrimary = false
      })
    }
    next[index] = { ...next[index], ...updates }
    updateConfig({ metrics: next })
  }

  const removeMetric = (index: number) => {
    updateConfig({ metrics: config.metrics.filter((_, i) => i !== index) })
  }

  const addInsight = () => {
    updateConfig({
      insights: [
        ...config.insights,
        {
          id: `insight-${Date.now()}`,
          type: 'review',
          condition: '',
          description: '',
        },
      ],
    })
  }

  const updateInsight = (index: number, updates: Partial<SweepInsight>) => {
    const next = [...config.insights]
    next[index] = { ...next[index], ...updates }
    updateConfig({ insights: next })
  }

  const removeInsight = (index: number) => {
    updateConfig({ insights: config.insights.filter((_, i) => i !== index) })
  }

  const confidenceLabel = draftMeta
    ? draftMeta.confidence >= 0.75
      ? 'High confidence draft'
      : draftMeta.confidence >= 0.45
      ? 'Medium confidence draft'
      : 'Low confidence draft'
    : null

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-accent" />
            <h2 className="text-sm font-semibold text-foreground">
              {initialConfig ? 'Edit Sweep' : 'Create Sweep'}
            </h2>
            {isGenerating && (
              <Badge variant="secondary" className="text-[10px]">
                AI Generating...
              </Badge>
            )}
          </div>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onCancel}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-4 p-4">
          <div className="rounded-xl border border-accent/25 bg-gradient-to-br from-accent/12 via-accent/6 to-transparent p-3">
            <div className="mb-2 flex items-center gap-2">
              <WandSparkles className="h-3.5 w-3.5 text-accent" />
              <p className="text-xs font-medium text-foreground">Natural language draft</p>
            </div>
            <Textarea
              value={nlPrompt}
              onChange={(event) => setNlPrompt(event.target.value)}
              placeholder="Describe the sweep in plain language. Example: sweep lr from 1e-4 to 1e-2 and batch size 16,32,64, maximize accuracy, 24 runs, 4 parallel."
              className="min-h-[84px] border-border/70 bg-background/85 text-xs"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {PRESET_PROMPTS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => {
                    setNlPrompt(preset.prompt)
                    applyPromptDraft(preset.prompt)
                  }}
                  className="rounded-full border border-border bg-background px-2.5 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <div className="flex min-h-5 flex-wrap items-center gap-1.5">
                {confidenceLabel && (
                  <Badge variant="secondary" className="text-[10px]">
                    {confidenceLabel}
                  </Badge>
                )}
                {draftMeta?.extracted.map((item) => (
                  <Badge key={item} variant="outline" className="text-[10px]">
                    {item}
                  </Badge>
                ))}
              </div>
              <Button
                size="sm"
                className="h-7 text-[11px]"
                onClick={() => applyPromptDraft(nlPrompt)}
                disabled={!nlPrompt.trim()}
              >
                <WandSparkles className="mr-1.5 h-3 w-3" />
                Generate Draft
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-lg border border-border/70 bg-card px-2.5 py-2">
              <p className="text-[10px] text-muted-foreground">Hyperparameters</p>
              <p className="text-sm font-semibold text-foreground">{configuredHyperparameters}</p>
            </div>
            <div className="rounded-lg border border-border/70 bg-card px-2.5 py-2">
              <p className="text-[10px] text-muted-foreground">Metrics</p>
              <p className="text-sm font-semibold text-foreground">{configuredMetrics}</p>
            </div>
            <div className="rounded-lg border border-border/70 bg-card px-2.5 py-2">
              <p className="text-[10px] text-muted-foreground">Max Runs</p>
              <p className="text-sm font-semibold text-foreground">{config.maxRuns || '-'}</p>
            </div>
            <div className="rounded-lg border border-border/70 bg-card px-2.5 py-2">
              <p className="text-[10px] text-muted-foreground">Parallel</p>
              <p className="text-sm font-semibold text-foreground">{config.parallelRuns || '-'}</p>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Sweep Name</label>
            <Input
              value={config.name}
              onChange={(event) => updateConfig({ name: event.target.value })}
              placeholder="e.g., Learning Rate Sweep"
              className="h-9 text-sm"
            />
          </div>

          <Collapsible open={expandedSections.goal} onOpenChange={() => toggleSection('goal')}>
            <CollapsibleTrigger className="flex w-full items-center gap-2 py-2 text-left">
              {expandedSections.goal ? (
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
              )}
              <Target className="h-3.5 w-3.5 text-accent" />
              <span className="text-xs font-medium">Goal & Description</span>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-2 pt-2">
              <Textarea
                value={config.goal}
                onChange={(event) => updateConfig({ goal: event.target.value })}
                placeholder="What should this sweep optimize?"
                className="min-h-[60px] text-sm"
              />
              <Textarea
                value={config.description}
                onChange={(event) => updateConfig({ description: event.target.value })}
                placeholder="Context, constraints, or notes for the agent"
                className="min-h-[46px] text-sm"
              />
            </CollapsibleContent>
          </Collapsible>

          <Collapsible open={expandedSections.command} onOpenChange={() => toggleSection('command')}>
            <CollapsibleTrigger className="flex w-full items-center gap-2 py-2 text-left">
              {expandedSections.command ? (
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
              )}
              <Terminal className="h-3.5 w-3.5 text-sky-400" />
              <span className="text-xs font-medium">Command / Script</span>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <Textarea
                value={config.command}
                onChange={(event) => updateConfig({ command: event.target.value })}
                placeholder="python train.py --lr {learning_rate} --batch-size {batch_size}"
                className="min-h-[72px] font-mono text-xs"
              />
              <p className="mt-1 text-[10px] text-muted-foreground">
                Use {'{param_name}'} placeholders for each sweep variable.
              </p>
            </CollapsibleContent>
          </Collapsible>

          <Collapsible open={expandedSections.hyperparameters} onOpenChange={() => toggleSection('hyperparameters')}>
            <CollapsibleTrigger className="flex w-full items-center gap-2 py-2 text-left">
              {expandedSections.hyperparameters ? (
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
              )}
              <Sliders className="h-3.5 w-3.5 text-violet-400" />
              <span className="text-xs font-medium">Hyperparameters</span>
              <Badge variant="secondary" className="ml-auto text-[10px]">
                {config.hyperparameters.length}
              </Badge>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-2 pt-2">
              {config.hyperparameters.map((param, index) => (
                <div key={index} className="space-y-2 rounded-lg border border-border/60 bg-secondary/20 p-2">
                  <div className="flex items-center gap-2">
                    <Input
                      value={param.name}
                      onChange={(event) => updateHyperparameter(index, { name: event.target.value })}
                      placeholder="Parameter name"
                      className="h-7 flex-1 text-xs"
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
                      onChange={(event) =>
                        updateHyperparameter(index, {
                          values: parseCommaValues(event.target.value),
                        })
                      }
                      placeholder="Comma separated values (e.g. 16, 32, 64)"
                      className="h-7 text-xs"
                    />
                  )}

                  {param.type === 'range' && (
                    <div className="grid grid-cols-3 gap-2">
                      <Input
                        type="number"
                        value={param.min ?? ''}
                        onChange={(event) =>
                          updateHyperparameter(index, {
                            min: event.target.value === '' ? undefined : Number(event.target.value),
                          })
                        }
                        placeholder="Min"
                        className="h-7 text-xs"
                      />
                      <Input
                        type="number"
                        value={param.max ?? ''}
                        onChange={(event) =>
                          updateHyperparameter(index, {
                            max: event.target.value === '' ? undefined : Number(event.target.value),
                          })
                        }
                        placeholder="Max"
                        className="h-7 text-xs"
                      />
                      <Input
                        type="number"
                        value={param.step ?? ''}
                        onChange={(event) =>
                          updateHyperparameter(index, {
                            step: event.target.value === '' ? undefined : Number(event.target.value),
                          })
                        }
                        placeholder="Step"
                        className="h-7 text-xs"
                      />
                    </div>
                  )}

                  {param.type === 'fixed' && (
                    <Input
                      value={param.fixedValue?.toString() || ''}
                      onChange={(event) => {
                        const value = event.target.value
                        const numeric = Number(value)
                        updateHyperparameter(index, {
                          fixedValue: Number.isFinite(numeric) ? numeric : value,
                        })
                      }}
                      placeholder="Fixed value"
                      className="h-7 text-xs"
                    />
                  )}
                </div>
              ))}

              <Button variant="outline" size="sm" className="h-8 w-full text-xs" onClick={addHyperparameter}>
                <Plus className="mr-1 h-3 w-3" />
                Add Hyperparameter
              </Button>
            </CollapsibleContent>
          </Collapsible>

          <Collapsible open={expandedSections.metrics} onOpenChange={() => toggleSection('metrics')}>
            <CollapsibleTrigger className="flex w-full items-center gap-2 py-2 text-left">
              {expandedSections.metrics ? (
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
              )}
              <BarChart3 className="h-3.5 w-3.5 text-emerald-400" />
              <span className="text-xs font-medium">Metrics</span>
              <Badge variant="secondary" className="ml-auto text-[10px]">
                {config.metrics.length}
              </Badge>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-2 pt-2">
              {config.metrics.map((metric, index) => (
                <div key={index} className="space-y-2 rounded-lg border border-border/60 bg-secondary/20 p-2">
                  <div className="flex items-center gap-2">
                    <Input
                      value={metric.name}
                      onChange={(event) => updateMetric(index, { name: event.target.value })}
                      placeholder="Metric name"
                      className="h-7 flex-1 text-xs"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => removeMetric(index)}
                    >
                      <Trash2 className="h-3 w-3 text-destructive" />
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      value={metric.path}
                      onChange={(event) => updateMetric(index, { path: event.target.value })}
                      placeholder="Metric path (e.g. val/loss)"
                      className="h-7 flex-1 text-xs"
                    />
                    <Select
                      value={metric.goal}
                      onValueChange={(value: 'minimize' | 'maximize') =>
                        updateMetric(index, { goal: value })
                      }
                    >
                      <SelectTrigger className="h-7 w-24 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="minimize">Min</SelectItem>
                        <SelectItem value="maximize">Max</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={metric.isPrimary}
                      onCheckedChange={(checked) => updateMetric(index, { isPrimary: checked })}
                      className="scale-75"
                    />
                    <span className="text-[10px] text-muted-foreground">Primary metric</span>
                  </div>
                </div>
              ))}

              <Button variant="outline" size="sm" className="h-8 w-full text-xs" onClick={addMetric}>
                <Plus className="mr-1 h-3 w-3" />
                Add Metric
              </Button>
            </CollapsibleContent>
          </Collapsible>

          <Collapsible open={expandedSections.insights} onOpenChange={() => toggleSection('insights')}>
            <CollapsibleTrigger className="flex w-full items-center gap-2 py-2 text-left">
              {expandedSections.insights ? (
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
              )}
              <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
              <span className="text-xs font-medium">Insights & Alerts</span>
              <Badge variant="secondary" className="ml-auto text-[10px]">
                {config.insights.length}
              </Badge>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-2 pt-2">
              <p className="text-[10px] text-muted-foreground">
                Add safety checks for divergence, suspicious metrics, or conditions requiring human review.
              </p>
              {config.insights.map((insight, index) => (
                <div key={insight.id} className="space-y-2 rounded-lg border border-border/60 bg-secondary/20 p-2">
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
                      onChange={(event) => updateInsight(index, { condition: event.target.value })}
                      placeholder="Condition (e.g. loss > 10)"
                      className="h-7 flex-1 text-xs"
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
                    onChange={(event) => updateInsight(index, { description: event.target.value })}
                    placeholder="Description"
                    className="h-7 text-xs"
                  />
                  <Input
                    value={insight.action || ''}
                    onChange={(event) => updateInsight(index, { action: event.target.value })}
                    placeholder="Suggested action (optional)"
                    className="h-7 text-xs"
                  />
                </div>
              ))}

              <Button variant="outline" size="sm" className="h-8 w-full text-xs" onClick={addInsight}>
                <Plus className="mr-1 h-3 w-3" />
                Add Insight Rule
              </Button>
            </CollapsibleContent>
          </Collapsible>

          <Collapsible open={expandedSections.settings} onOpenChange={() => toggleSection('settings')}>
            <CollapsibleTrigger className="flex w-full items-center gap-2 py-2 text-left">
              {expandedSections.settings ? (
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
              )}
              <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-medium">Sweep Settings</span>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-muted-foreground">Max Runs</label>
                  <Input
                    type="number"
                    value={config.maxRuns || ''}
                    onChange={(event) =>
                      updateConfig({
                        maxRuns: event.target.value === '' ? undefined : Number.parseInt(event.target.value, 10),
                      })
                    }
                    className="h-7 text-xs"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground">Parallel Runs</label>
                  <Input
                    type="number"
                    value={config.parallelRuns || ''}
                    onChange={(event) =>
                      updateConfig({
                        parallelRuns: event.target.value === '' ? undefined : Number.parseInt(event.target.value, 10),
                      })
                    }
                    className="h-7 text-xs"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Switch
                    checked={Boolean(config.earlyStoppingEnabled)}
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
                      onChange={(event) =>
                        updateConfig({
                          earlyStoppingPatience:
                            event.target.value === '' ? undefined : Number.parseInt(event.target.value, 10),
                        })
                      }
                      className="h-6 w-12 text-xs"
                    />
                  </div>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </div>

      <div className="space-y-2 border-t border-border p-3">
        {!isValid && (
          <p className="text-[11px] text-amber-600 dark:text-amber-400">
            Add a name, command, at least one configured hyperparameter, and one valid metric.
          </p>
        )}
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="h-8 flex-1 text-xs" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="h-8 flex-1 text-xs"
            onClick={() => onSave(normalizeConfig(config))}
            disabled={!isValid}
          >
            <Check className="mr-1 h-3 w-3" />
            Save Draft
          </Button>
        </div>
        {onLaunch && (
          <Button
            size="sm"
            className="h-9 w-full text-xs bg-accent hover:bg-accent/90"
            onClick={() => onLaunch(normalizeConfig(config))}
            disabled={!isValid}
          >
            <RotateCcw className="mr-1 h-3 w-3" />
            Launch Sweep
          </Button>
        )}
      </div>
    </div>
  )
}
