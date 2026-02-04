'use client'

import { useRef, useEffect } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { AlertBar } from './alert-bar'
import { LossChart } from './loss-chart'
import { ChatMessage } from './chat-message'
import { ChatInput, type ChatMode } from './chat-input'
import type {
  ChatMessage as ChatMessageType,
  ExperimentRun,
  LossDataPoint,
  RunEvent,
} from '@/lib/types'

interface ChatViewProps {
  messages: ChatMessageType[]
  runs: ExperimentRun[]
  events: RunEvent[]
  lossData: LossDataPoint[]
  onSendMessage: (message: string, attachments?: File[], mode?: ChatMode) => void
  onRunClick: (run: ExperimentRun) => void
  onNavigateToRun: (runId: string) => void
  onNavigateToEvents: () => void
  onDismissEvent: (eventId: string) => void
  showChart?: boolean
  mode: ChatMode
  onModeChange: (mode: ChatMode) => void
}

export function ChatView({
  messages,
  runs,
  events,
  lossData,
  onSendMessage,
  onRunClick,
  onNavigateToRun,
  onNavigateToEvents,
  onDismissEvent,
  showChart = true,
  mode,
  onModeChange,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Alert Bar - Fixed at top */}
      <AlertBar 
        events={events} 
        onNavigateToEvents={onNavigateToEvents}
        onNavigateToRun={onNavigateToRun}
        onDismissEvent={onDismissEvent}
      />

      {/* Scrollable Chat Area */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <ScrollArea className="h-full" ref={scrollRef}>
          <div className="pb-4">
            {showChart && messages.length > 0 && (
              <div className="px-4 pt-4">
                <LossChart data={lossData} title="GPT-4 Fine-tune Training Loss" />
              </div>
            )}

            <div className="mt-4 space-y-1">
              {messages.map((message) => (
                <ChatMessage key={message.id} message={message} />
              ))}
            </div>

            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-secondary">
                  <span className="text-2xl">🔬</span>
                </div>
                <h3 className="text-lg font-semibold text-foreground">
                  Research Assistant
                </h3>
                <p className="mt-2 max-w-sm text-sm text-muted-foreground">
                  Ask me anything about your experiments, training runs, or ML
                  research. I can help analyze loss curves, debug issues, and
                  suggest improvements.
                </p>
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                  {[
                    'Analyze my latest run',
                    'Why did training fail?',
                    'Compare model configs',
                  ].map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => onSendMessage(suggestion)}
                      className="rounded-full border border-border bg-secondary px-4 py-2 text-sm text-foreground transition-colors hover:bg-secondary/80 active:scale-95"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Chat Input - Fixed at bottom */}
      <div className="shrink-0">
        <ChatInput 
          onSend={onSendMessage} 
          mode={mode}
          onModeChange={onModeChange}
        />
      </div>
    </div>
  )
}
