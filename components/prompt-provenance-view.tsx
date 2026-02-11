'use client'

import { useState } from 'react'
import type { PromptProvenance } from '@/lib/types'
import { ChevronDown, ChevronRight, Eye, Sparkles } from 'lucide-react'

interface PromptProvenanceViewProps {
  /** The raw content that was actually sent to the LLM */
  content: string
  /** Provenance metadata from the backend prompt builder */
  provenance: PromptProvenance
}

type ViewMode = 'user_input' | 'constructed'

/**
 * Two-mode view for wild loop auto-generated prompts.
 *
 * - "Your Input" mode shows the user's original goal/input
 * - "Constructed Prompt" mode shows the full rendered prompt with an
 *   explanation of the skill template + variables applied
 */
export function PromptProvenanceView({ content, provenance }: PromptProvenanceViewProps) {
  const [mode, setMode] = useState<ViewMode>('user_input')
  const [showTemplate, setShowTemplate] = useState(false)

  const skillLabel = provenance.skill_name || provenance.skill_id || 'hardcoded fallback'
  const varEntries = Object.entries(provenance.variables)

  return (
    <div className="space-y-1.5">
      {/* Mode toggle tabs */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setMode('user_input')}
          className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium transition-colors ${
            mode === 'user_input'
              ? 'bg-primary/15 text-primary'
              : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60'
          }`}
        >
          <Eye className="h-3 w-3" />
          Your Input
        </button>
        <button
          type="button"
          onClick={() => setMode('constructed')}
          className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium transition-colors ${
            mode === 'constructed'
              ? 'bg-violet-500/15 text-violet-400'
              : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60'
          }`}
        >
          <Sparkles className="h-3 w-3" />
          Constructed Prompt
        </button>
      </div>

      {/* Content area */}
      {mode === 'user_input' ? (
        <div className="border-l-4 border-primary px-3 py-1">
          <p className="text-base leading-relaxed text-foreground break-words">
            {provenance.user_input || '(no user input)'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {/* Skill badge + type */}
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-violet-400">
              <Sparkles className="h-2.5 w-2.5" />
              {skillLabel}
            </span>
            <span className="text-muted-foreground/60">·</span>
            <span>{provenance.prompt_type}</span>
          </div>

          {/* Variables applied */}
          {varEntries.length > 0 && (
            <div className="rounded-lg border border-border/50 bg-secondary/20 px-3 py-2">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                Template Variables
              </p>
              <div className="space-y-1">
                {varEntries.map(([key, value]) => {
                  const displayValue = value.length > 120 ? value.slice(0, 117) + '...' : value
                  return (
                    <div key={key} className="flex gap-2 text-xs">
                      <code className="shrink-0 rounded border border-orange-300/40 bg-orange-100/50 px-1 py-0.5 font-mono text-[11px] text-orange-600 dark:border-[#39ff14]/25 dark:bg-[#0b1a0f] dark:text-[#39ff14]">
                        {`{{${key}}}`}
                      </code>
                      <span className="min-w-0 break-words text-foreground/80">{displayValue}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Template toggle */}
          {provenance.template && (
            <button
              type="button"
              onClick={() => setShowTemplate(!showTemplate)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {showTemplate ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {showTemplate ? 'Hide' : 'Show'} raw template
            </button>
          )}
          {showTemplate && provenance.template && (
            <pre className="max-h-[200px] overflow-auto rounded-lg border border-border/50 bg-secondary/30 p-2 text-[11px] leading-relaxed text-muted-foreground font-mono whitespace-pre-wrap break-words">
              {provenance.template}
            </pre>
          )}

          {/* Rendered prompt (collapsible since it can be long) */}
          <RenderedPromptSection content={content} />
        </div>
      )}
    </div>
  )
}

function RenderedPromptSection({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false)
  const isLong = content.length > 300
  const preview = isLong ? content.slice(0, 280) + '...' : content

  return (
    <div className="rounded-lg border border-violet-500/20 bg-violet-500/5 px-3 py-2">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-violet-400/70">
        Final Prompt Sent
      </p>
      <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/80 font-mono">
        {expanded || !isLong ? content : preview}
      </pre>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-[11px] text-violet-400 hover:text-violet-300 transition-colors"
        >
          {expanded ? 'Show less' : 'Show full prompt'}
        </button>
      )}
    </div>
  )
}
