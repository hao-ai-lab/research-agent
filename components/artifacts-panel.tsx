'use client'

import { FileText, Image, Box, FileCode } from 'lucide-react'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import type { Artifact } from '@/lib/types'

interface ArtifactsPanelProps {
  artifacts: Artifact[]
}

const typeIcons = {
  text: FileText,
  image: Image,
  model: Box,
  log: FileCode,
}

const typeColors = {
  text: 'bg-blue-500/10 text-blue-400',
  image: 'bg-green-500/10 text-green-400',
  model: 'bg-purple-500/10 text-purple-400',
  log: 'bg-orange-500/10 text-orange-400',
}

export function ArtifactsPanel({ artifacts }: ArtifactsPanelProps) {
  if (artifacts.length === 0) {
    return (
      <div className="shrink-0 border-b border-border bg-secondary/30 px-4 py-2">
        <p className="text-xs text-muted-foreground">No artifacts yet</p>
      </div>
    )
  }

  return (
    <div className="shrink-0 border-b border-border bg-secondary/30">
      <ScrollArea className="w-full">
        <div className="flex gap-2 px-4 py-2">
          {artifacts.slice(0, 10).map((artifact) => {
            const Icon = typeIcons[artifact.type]
            const colorClass = typeColors[artifact.type]
            
            return (
              <button
                key={artifact.id}
                type="button"
                className="flex items-center gap-2 shrink-0 rounded-md border border-border bg-background px-3 py-1.5 hover:bg-secondary/80 transition-colors"
              >
                <div className={`p-1 rounded ${colorClass}`}>
                  <Icon className="h-3 w-3" />
                </div>
                <div className="text-left">
                  <p className="text-xs font-medium text-foreground truncate max-w-[120px]">
                    {artifact.name}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {new Date(artifact.timestamp).toLocaleDateString()}
                  </p>
                </div>
              </button>
            )
          })}
          {artifacts.length > 10 && (
            <div className="flex items-center px-2 text-xs text-muted-foreground">
              +{artifacts.length - 10} more
            </div>
          )}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  )
}
