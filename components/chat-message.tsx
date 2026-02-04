'use client'

import React from "react"

import { useState } from 'react'
import { ChevronDown, ChevronRight, Brain } from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { LossChart } from './loss-chart'
import type { ChatMessage as ChatMessageType } from '@/lib/types'

interface ChatMessageProps {
  message: ChatMessageType
  collapseArtifacts?: boolean
}

export function ChatMessage({ message, collapseArtifacts = false }: ChatMessageProps) {
  const [isThinkingOpen, setIsThinkingOpen] = useState(false)
  const [isChartOpen, setIsChartOpen] = useState(true)
  const isUser = message.role === 'user'

  const formatDateTime = (date: Date) => {
    const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' })
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    return `${dateStr}, ${timeStr}`
  }

  const renderMarkdown = (content: string) => {
    // Simple markdown rendering
    const lines = content.split('\n')
    const elements: React.ReactNode[] = []
    let inCodeBlock = false
    let codeContent = ''
    let codeKey = 0

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      if (line.startsWith('```')) {
        if (inCodeBlock) {
          elements.push(
            <pre
              key={`code-${codeKey++}`}
              className="my-2 overflow-x-auto rounded-lg bg-background p-3 text-xs"
            >
              <code>{codeContent.trim()}</code>
            </pre>
          )
          codeContent = ''
          inCodeBlock = false
        } else {
          inCodeBlock = true
        }
        continue
      }

      if (inCodeBlock) {
        codeContent += line + '\n'
        continue
      }

      if (line.startsWith('**') && line.endsWith('**')) {
        elements.push(
          <p key={i} className="mt-3 mb-1 font-semibold text-foreground">
            {line.slice(2, -2)}
          </p>
        )
      } else if (line.startsWith('- ') || line.startsWith('* ')) {
        elements.push(
          <li key={i} className="ml-4 text-foreground/90">
            {renderInlineMarkdown(line.slice(2))}
          </li>
        )
      } else if (line.match(/^\d+\. /)) {
        elements.push(
          <li key={i} className="ml-4 list-decimal text-foreground/90">
            {renderInlineMarkdown(line.replace(/^\d+\. /, ''))}
          </li>
        )
      } else if (line.trim() === '') {
        elements.push(<br key={i} />)
      } else {
        elements.push(
          <p key={i} className="text-foreground/90">
            {renderInlineMarkdown(line)}
          </p>
        )
      }
    }

    return elements
  }

  const renderInlineMarkdown = (text: string) => {
    // Handle inline code
    const parts = text.split(/(`[^`]+`)/)
    return parts.map((part, i) => {
      if (part.startsWith('`') && part.endsWith('`')) {
        return (
          <code
            key={i}
            className="rounded bg-background px-1.5 py-0.5 text-xs text-accent"
          >
            {part.slice(1, -1)}
          </code>
        )
      }
      // Handle bold
      const boldParts = part.split(/(\*\*[^*]+\*\*)/)
      return boldParts.map((bp, j) => {
        if (bp.startsWith('**') && bp.endsWith('**')) {
          return (
            <strong key={`${i}-${j}`} className="font-semibold">
              {bp.slice(2, -2)}
            </strong>
          )
        }
        return <span key={`${i}-${j}`}>{bp}</span>
      })
    })
  }

  if (isUser) {
    return (
      <div className="px-1 py-2">
        <div className="rounded-2xl bg-emerald-600 px-4 py-2.5 text-white">
          <p className="text-sm leading-relaxed">{message.content}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="px-0.5 py-2">
      <div className="space-y-2">
        {message.thinking && (
          <Collapsible open={isThinkingOpen} onOpenChange={setIsThinkingOpen}>
            <CollapsibleTrigger className="flex items-center gap-1.5 rounded-lg bg-secondary/50 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
              {isThinkingOpen ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              <Brain className="h-3 w-3" />
              <span>Thinking process</span>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
              <div className="rounded-lg border border-border/50 bg-secondary/30 p-3 text-xs leading-relaxed text-muted-foreground max-w-2xl">
                {message.thinking.split('\n').map((line, i) => (
                  <p key={i} className={line.trim() === '' ? 'h-2' : ''}>
                    {line}
                  </p>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* Embedded Chart - rendered before text content */}
        {message.chart && (
          <Collapsible open={!collapseArtifacts && isChartOpen} onOpenChange={setIsChartOpen}>
            <CollapsibleTrigger className="flex items-center gap-1.5 rounded-lg bg-secondary/50 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground mb-2">
              {(!collapseArtifacts && isChartOpen) ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              <span>{message.chart.title}</span>
            </CollapsibleTrigger>
            <CollapsibleContent className="mb-3">
              <LossChart data={message.chart.data} title={message.chart.title} />
            </CollapsibleContent>
          </Collapsible>
        )}

        <div className="rounded-2xl bg-secondary px-4 py-3 text-sm leading-relaxed">
          {renderMarkdown(message.content)}
        </div>

        <span className="text-[10px] text-muted-foreground" suppressHydrationWarning>
          {formatDateTime(message.timestamp)}
        </span>
      </div>
    </div>
  )
}
