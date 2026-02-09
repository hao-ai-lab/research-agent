'use client'

import { useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Target,
  Terminal,
  Sliders,
  BarChart3,
  AlertTriangle,
  Play,
  Edit2,
  Copy,
  Check,
  FileJson,
  Sparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import type { SweepConfig, Sweep } from '@/lib/types'

interface SweepArtifactProps {
  config: SweepConfig
  sweep?: Sweep
  onEdit?: (config: SweepConfig) => void
  onLaunch?: (config: SweepConfig) => void
  isCollapsed?: boolean
}

export function SweepArtifact({
  config,
  sweep,
  onEdit,
  onLaunch,
  isCollapsed = false,
}: SweepArtifactProps) {
  const [expanded, setExpanded] = useState(!isCollapsed)
  const [copied, setCopied] = useState(false)
  const [showDetails, setShowDetails] = useState(false)

  const copyToClipboard = () => {
    navigator.clipboard.writeText(JSON.stringify(config, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const primaryMetric = config.metrics.find(m => m.isPrimary)
  const statusColor = sweep?.status === 'draft'
    ? 'bg-violet-500'
    : sweep?.status === 'running' 
    ? 'bg-accent' 
    : sweep?.status === 'completed' 
    ? 'bg-emerald-500' 
    : sweep?.status === 'failed' 
    ? 'bg-destructive'
    : 'bg-muted-foreground'

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      {/* Header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-secondary/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
        )}
        <Sparkles className="h-3.5 w-3.5 text-purple-400 shrink-0" />
        <span className="text-sm font-medium text-foreground truncate flex-1">
          {config.name || 'Untitled Sweep'}
        </span>
        {sweep && (
          <div className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${statusColor}`} />
            <span className="text-[10px] text-muted-foreground capitalize">
              {sweep.status}
            </span>
          </div>
        )}
        <Badge variant="secondary" className="text-[10px]">
          <FileJson className="h-2.5 w-2.5 mr-1" />
          sweep
        </Badge>
      </button>

      {/* Expanded Content */}
      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t border-border/50">
          {/* Goal */}
          {config.goal && (
            <div className="pt-2">
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-1">
                <Target className="h-3 w-3" />
                <span>Goal</span>
              </div>
              <p className="text-xs text-foreground/90">{config.goal}</p>
            </div>
          )}

          {/* Quick Summary */}
          <div className="flex flex-wrap gap-1.5 pt-1">
            <Badge variant="outline" className="text-[10px] gap-1">
              <Sliders className="h-2.5 w-2.5" />
              {config.hyperparameters.length} params
            </Badge>
            <Badge variant="outline" className="text-[10px] gap-1">
              <BarChart3 className="h-2.5 w-2.5" />
              {config.metrics.length} metrics
            </Badge>
            {config.insights.length > 0 && (
              <Badge variant="outline" className="text-[10px] gap-1">
                <AlertTriangle className="h-2.5 w-2.5" />
                {config.insights.length} insights
              </Badge>
            )}
            {config.maxRuns && (
              <Badge variant="outline" className="text-[10px]">
                max {config.maxRuns} runs
              </Badge>
            )}
          </div>

          {/* Command Preview */}
          <div className="pt-1">
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-1">
              <Terminal className="h-3 w-3" />
              <span>Command</span>
            </div>
            <div className="bg-background rounded-md px-2 py-1.5 font-mono text-[10px] text-foreground/80 break-all whitespace-pre-wrap">
              {config.command || 'No command specified'}
            </div>
          </div>

          {/* Details Section (Collapsible) */}
          <Collapsible open={showDetails} onOpenChange={setShowDetails}>
            <CollapsibleTrigger className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors pt-1">
              {showDetails ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              <span>View details</span>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2 space-y-2">
              {/* Hyperparameters */}
              {config.hyperparameters.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-1">
                    <Sliders className="h-3 w-3 text-purple-400" />
                    <span>Hyperparameters</span>
                  </div>
                  <div className="space-y-1">
                    {config.hyperparameters.map((param, i) => (
                      <div key={i} className="flex items-center gap-2 text-[10px]">
                        <span className="font-mono text-foreground">{param.name}</span>
                        <span className="text-muted-foreground">:</span>
                        {param.type === 'choice' && (
                          <span className="text-muted-foreground">
                            [{param.values?.join(', ')}]
                          </span>
                        )}
                        {param.type === 'range' && (
                          <span className="text-muted-foreground">
                            {param.min} - {param.max} (step: {param.step})
                          </span>
                        )}
                        {param.type === 'fixed' && (
                          <span className="text-muted-foreground">{param.fixedValue}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Metrics */}
              {config.metrics.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-1">
                    <BarChart3 className="h-3 w-3 text-emerald-400" />
                    <span>Metrics</span>
                  </div>
                  <div className="space-y-1">
                    {config.metrics.map((metric, i) => (
                      <div key={i} className="flex items-center gap-2 text-[10px]">
                        <span className="font-mono text-foreground">{metric.name}</span>
                        {metric.isPrimary && (
                          <Badge className="text-[8px] h-4 bg-emerald-500/20 text-emerald-400 border-0">
                            primary
                          </Badge>
                        )}
                        <span className="text-muted-foreground ml-auto">{metric.goal}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Insights */}
              {config.insights.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-1">
                    <AlertTriangle className="h-3 w-3 text-amber-400" />
                    <span>Insight Rules</span>
                  </div>
                  <div className="space-y-1">
                    {config.insights.map((insight, i) => (
                      <div key={i} className="text-[10px] flex items-start gap-2">
                        <Badge 
                          variant="outline" 
                          className={`text-[8px] shrink-0 ${
                            insight.type === 'failure' 
                              ? 'text-destructive border-destructive/30' 
                              : insight.type === 'suspicious' 
                              ? 'text-amber-400 border-amber-400/30'
                              : 'text-blue-400 border-blue-400/30'
                          }`}
                        >
                          {insight.type}
                        </Badge>
                        <span className="text-muted-foreground">{insight.condition}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Settings */}
              <div>
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-1">
                  Settings
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Max runs:</span>
                    <span className="text-foreground">{config.maxRuns || 'Unlimited'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Parallel:</span>
                    <span className="text-foreground">{config.parallelRuns || 1}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Early stop:</span>
                    <span className="text-foreground">
                      {config.earlyStoppingEnabled ? `Yes (${config.earlyStoppingPatience} epochs)` : 'No'}
                    </span>
                  </div>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Sweep Progress (if running) */}
          {sweep && sweep.status !== 'draft' && (
            <div className="pt-2 border-t border-border/50">
              <div className="flex items-center justify-between text-[10px] mb-1">
                <span className="text-muted-foreground">Progress</span>
                <span className="text-foreground">
                  {sweep.progress.completed}/{sweep.progress.total} runs
                </span>
              </div>
              <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                <div 
                  className="h-full bg-accent transition-all" 
                  style={{ width: `${(sweep.progress.completed / sweep.progress.total) * 100}%` }}
                />
              </div>
              <div className="flex items-center gap-3 mt-1.5 text-[10px]">
                <span className="flex items-center gap-1 text-emerald-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  {sweep.progress.completed} done
                </span>
                <span className="flex items-center gap-1 text-accent">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                  {sweep.progress.running} running
                </span>
                {sweep.progress.failed > 0 && (
                  <span className="flex items-center gap-1 text-destructive">
                    <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
                    {sweep.progress.failed} failed
                  </span>
                )}
              </div>
              {sweep.bestRunId && sweep.bestMetricValue !== undefined && (
                <div className="mt-2 p-2 rounded-md bg-emerald-500/10 border border-emerald-500/20">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-emerald-400 font-medium">Best Result</span>
                    <span className="text-foreground font-mono">
                      {primaryMetric?.name}: {sweep.bestMetricValue.toFixed(4)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 pt-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-[10px] gap-1"
              onClick={copyToClipboard}
            >
              {copied ? (
                <Check className="h-3 w-3 text-emerald-400" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
              {copied ? 'Copied' : 'Copy'}
            </Button>
            {onEdit && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-[10px] gap-1"
                onClick={() => onEdit(config)}
              >
                <Edit2 className="h-3 w-3" />
                Edit
              </Button>
            )}
            {onLaunch && (!sweep || sweep.status === 'draft') && (
              <Button
                size="sm"
                className="h-7 text-[10px] gap-1 ml-auto bg-purple-500 hover:bg-purple-600"
                onClick={() => onLaunch(config)}
              >
                <Play className="h-3 w-3" />
                Launch
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
