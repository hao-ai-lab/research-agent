'use client'

import { ScrollArea } from '@/components/ui/scroll-area'
import type { ChatMessage } from '@/lib/types'

interface HistoryPanelProps {
  messagePairs: { user: ChatMessage; assistant?: ChatMessage }[]
}

export function HistoryPanel({ messagePairs }: HistoryPanelProps) {
  return (
    <div className="w-64 shrink-0 border-l border-border bg-secondary/20 flex flex-col h-full">
      <div className="px-3 py-2 border-b border-border">
        <h3 className="text-sm font-medium text-foreground">Chat History</h3>
        <p className="text-xs text-muted-foreground">{messagePairs.length} conversations</p>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {messagePairs.length === 0 ? (
            <p className="text-xs text-muted-foreground px-2 py-4 text-center">
              No conversations yet
            </p>
          ) : (
            messagePairs.map((pair, index) => {
              if (!pair.user.content) return null
              const preview = pair.user.content.slice(0, 40) + (pair.user.content.length > 40 ? '...' : '')
              
              return (
                <button
                  key={pair.user.id || index}
                  type="button"
                  className="w-full text-left px-2 py-2 rounded-md hover:bg-secondary/80 transition-colors group"
                >
                  <p className="text-xs font-medium text-foreground truncate group-hover:text-primary">
                    {preview}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {new Date(pair.user.timestamp).toLocaleString([], {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                </button>
              )
            })
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
