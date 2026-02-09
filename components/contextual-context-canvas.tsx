'use client'

import { Link2, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { ContextReference } from '@/lib/contextual-chat'

interface ContextualContextCanvasProps {
  references: ContextReference[]
  onInsertPrompt: (prompt: string) => void
}

function kindPrompt(kind: ContextReference['kind'], id: string) {
  if (kind === 'alert') {
    return `@alert:${id} diagnose the alert, evaluate options, and recommend next action.`
  }
  if (kind === 'sweep') {
    return `@sweep:${id} summarize current status and propose next experiments.`
  }
  if (kind === 'run') {
    return `@run:${id} summarize current health and what to try next.`
  }
  if (kind === 'artifact') {
    return `@artifact:${id} explain this artifact and how it affects current decisions.`
  }
  return `@chart:${id} explain what this chart implies and what action to take.`
}

export function ContextualContextCanvas({ references, onInsertPrompt }: ContextualContextCanvasProps) {
  return (
    <div className="h-full overflow-y-auto px-2 py-2">
      <div className="space-y-2">
        <Card className="border-border/80 bg-card/95">
          <CardHeader className="px-3 py-2 pb-1.5">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <Link2 className="h-4 w-4 text-primary" />
              Context Canvas
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 px-3 pb-3 pt-0">
            <p className="text-[11px] text-muted-foreground">
              Referenced or created artifacts stay visible while the conversation evolves.
            </p>

            {references.length === 0 ? (
              <div className="rounded-md border border-dashed border-border/80 bg-background/70 p-2.5 text-center text-[11px] text-muted-foreground">
                Context appears here as you mention `@run`, `@sweep`, `@alert`, and other artifacts.
              </div>
            ) : (
              <div className="space-y-1.5">
                {references.slice(0, 12).map((reference) => (
                  <div
                    key={reference.key}
                    className="rounded-md border border-border/70 bg-background/70 px-2 py-1.5"
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <p className="truncate text-xs font-medium text-foreground">{reference.label}</p>
                      <Badge variant="outline" className="h-4 px-1.5 text-[9px] uppercase">
                        {reference.kind}
                      </Badge>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <Badge
                        variant={reference.source === 'created' ? 'default' : 'secondary'}
                        className="h-5 px-1.5 text-[9px]"
                      >
                        {reference.source}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5.5 px-1.5 text-[10px]"
                        onClick={() => onInsertPrompt(kindPrompt(reference.kind, reference.id))}
                      >
                        Analyze
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-border/80 bg-card/95">
          <CardHeader className="px-3 py-2 pb-1.5">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <Sparkles className="h-4 w-4 text-indigo-500" />
              Suggested Agent Moves
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 px-3 pb-3 pt-0">
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-full justify-start text-xs"
              onClick={() =>
                onInsertPrompt('Give me a 3-step plan for the next 30 minutes based on current context and risks.')
              }
            >
              Build a 30-min action plan
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-full justify-start text-xs"
              onClick={() =>
                onInsertPrompt('Summarize what changed since the previous run and what hypothesis to test next.')
              }
            >
              Compare against previous state
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-full justify-start text-xs"
              onClick={() =>
                onInsertPrompt('Identify one risky job to stop and one promising job to prioritize, with reasons.')
              }
            >
              Prioritize and de-risk queue
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
