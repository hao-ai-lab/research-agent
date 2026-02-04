'use client'

import { useState } from 'react'
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

interface SweepFormProps {
  initialConfig?: SweepConfig
  onSave: (config: SweepConfig) => void
  onCancel: () => void
  onLaunch?: (config: SweepConfig) => void
  isGenerating?: boolean
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
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    goal: true,
    command: true,
    hyperparameters: true,
    metrics: true,
    insights: false,
    settings: false,
  })

  const toggleSection = (section: string) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }))
  }

  const updateConfig = (updates: Partial<SweepConfig>) => {
    setConfig(prev => ({ ...prev, ...updates, updatedAt: new Date() }))
  }

  // Hyperparameter handlers
  const addHyperparameter = () => {
    const newParam: SweepHyperparameter = {
      name: '',
      type: 'choice',
      values: [],
    }
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

  // Metric handlers
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
    // If setting as primary, unset others
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

  // Insight handlers
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

  const isValid = config.name.trim() && config.command.trim() && config.metrics.length > 0

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
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

      {/* Form Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-4 space-y-3">
          {/* Name */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Sweep Name
            </label>
            <Input
              value={config.name}
              onChange={(e) => updateConfig({ name: e.target.value })}
              placeholder="e.g., Learning Rate Sweep"
              className="h-9 text-sm"
            />
          </div>

          {/* Goal Section */}
          <Collapsible open={expandedSections.goal} onOpenChange={() => toggleSection('goal')}>
            <CollapsibleTrigger className="flex items-center gap-2 w-full py-2 text-left">
              {expandedSections.goal ? (
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
              )}
              <Target className="h-3.5 w-3.5 text-accent" />
              <span className="text-xs font-medium">Goal & Description</span>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2 space-y-2">
              <Textarea
                value={config.goal}
                onChange={(e) => updateConfig({ goal: e.target.value })}
                placeholder="What is the goal of this experiment? e.g., Find the optimal learning rate..."
                className="text-sm min-h-[60px]"
              />
              <Textarea
                value={config.description}
                onChange={(e) => updateConfig({ description: e.target.value })}
                placeholder="Additional description or context..."
                className="text-sm min-h-[40px]"
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
                          values: e.target.value.split(',').map(v => {
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
              
              <Button
                variant="outline"
                size="sm"
                className="w-full h-8 text-xs"
                onClick={addHyperparameter}
              >
                <Plus className="h-3 w-3 mr-1" />
                Add Hyperparameter
              </Button>
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
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2 space-y-2">
              {config.metrics.map((metric, index) => (
                <div key={index} className="p-2 rounded-lg bg-secondary/30 border border-border/50 space-y-2">
                  <div className="flex items-center gap-2">
                    <Input
                      value={metric.name}
                      onChange={(e) => updateMetric(index, { name: e.target.value })}
                      placeholder="Metric name"
                      className="h-7 text-xs flex-1"
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
                      onChange={(e) => updateMetric(index, { path: e.target.value })}
                      placeholder="Metric path (e.g., val/loss)"
                      className="h-7 text-xs flex-1"
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
              
              <Button
                variant="outline"
                size="sm"
                className="w-full h-8 text-xs"
                onClick={addMetric}
              >
                <Plus className="h-3 w-3 mr-1" />
                Add Metric
              </Button>
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
              
              <Button
                variant="outline"
                size="sm"
                className="w-full h-8 text-xs"
                onClick={addInsight}
              >
                <Plus className="h-3 w-3 mr-1" />
                Add Insight Rule
              </Button>
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
                      onChange={(e) => updateConfig({ earlyStoppingPatience: parseInt(e.target.value) || undefined })}
                      className="h-6 w-12 text-xs"
                    />
                  </div>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </div>

      {/* Footer Actions */}
      <div className="p-3 border-t border-border space-y-2">
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 h-8 text-xs"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="flex-1 h-8 text-xs"
            onClick={() => onSave(config)}
            disabled={!isValid}
          >
            <Check className="h-3 w-3 mr-1" />
            Save Draft
          </Button>
        </div>
        {onLaunch && (
          <Button
            size="sm"
            className="w-full h-9 text-xs bg-accent hover:bg-accent/90"
            onClick={() => onLaunch(config)}
            disabled={!isValid}
          >
            <RotateCcw className="h-3 w-3 mr-1" />
            Launch Sweep
          </Button>
        )}
      </div>
    </div>
  )
}
