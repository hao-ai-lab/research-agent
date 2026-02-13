'use client'

import React from "react"

import { useState, useMemo, useRef, useEffect } from 'react'
import { ChevronDown, ChevronRight, Brain, Wrench, Check, AlertCircle, Loader2, Pencil, Copy } from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { LossChart } from './loss-chart'
import type { ChatMessage as ChatMessageType, Sweep, SweepConfig, MessagePart } from '@/lib/types'
import { SweepArtifact } from './sweep-artifact'
import { SweepStatus } from './sweep-status'
import { CodeOutputBox } from './code-output-box'
import type { ExperimentRun } from '@/lib/types'
import type { Alert } from '@/lib/api-client'
import {
  REFERENCE_TYPE_BACKGROUND_MAP,
  REFERENCE_TYPE_COLOR_MAP,
  type ReferenceTokenType,
} from '@/lib/reference-token-colors'
import { extractContextReferences } from '@/lib/extract-context-references'
import { ContextReferencesBar } from './context-references-bar'
import { PromptProvenanceView } from './prompt-provenance-view'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface ChatMessageProps {
  message: ChatMessageType
  collapseArtifacts?: boolean
  sweeps?: Sweep[]
  runs?: ExperimentRun[]
  alerts?: Alert[]
  onEditSweep?: (config: SweepConfig) => void
  onLaunchSweep?: (config: SweepConfig) => void
  onRunClick?: (run: ExperimentRun) => void
  onReplyToSelection?: (text: string) => void
  onSubmitEditedUserMessage?: (message: ChatMessageType, editedContent: string) => void
  /** Content of the user message that prompted this assistant response (for context extraction) */
  previousUserContent?: string
}

function extractLeadingQuoteBlock(content: string): { excerpt: string | null; body: string } {
  const lines = content.split('\n')
  const excerptLines: string[] = []
  let cursor = 0

  while (cursor < lines.length && /^>\s?/.test(lines[cursor])) {
    excerptLines.push(lines[cursor].replace(/^>\s?/, ''))
    cursor += 1
  }

  if (excerptLines.length === 0) {
    return { excerpt: null, body: content }
  }

  while (cursor < lines.length && lines[cursor].trim() === '') {
    cursor += 1
  }

  return {
    excerpt: excerptLines.join('\n').trim(),
    body: lines.slice(cursor).join('\n'),
  }
}

function parseTaggedCodeBlock(content: string): { language: string; code: string } | null {
  const trimmed = content.trim()
  const match = trimmed.match(/^<(backend|frontend)(?:\s+lang=["']?([A-Za-z0-9_+-]+)["']?)?>\n?([\s\S]*?)\n?<\/\1>$/i)
  if (!match) return null

  return {
    language: (match[2] || match[1]).toLowerCase(),
    code: match[3],
  }
}

function detectStandaloneCode(content: string): { language: string; code: string } | null {
  const trimmed = content.trim()
  if (!trimmed || trimmed.includes('```')) return null

  const lines = trimmed.split('\n')
  if (lines.length < 2) return null

  const htmlLike = /^<(?:!doctype|html|head|body|main|section|article|div|script|style|template)\b/i.test(trimmed) && /<\/[a-z]/i.test(trimmed)
  if (htmlLike) {
    return { language: 'html', code: trimmed }
  }

  const jsPattern = /^\s*(?:const|let|var|function|import|export|if|for|while|return|class)\b|=>|[{};]/
  const pyPattern = /^\s*(?:def|class|import|from|if|for|while|return|with|try|except)\b|:\s*$/
  const jsonLike = /^[\[{][\s\S]*[\]}]$/.test(trimmed) && /":\s*/.test(trimmed)

  const jsLines = lines.filter((line) => jsPattern.test(line)).length
  const pyLines = lines.filter((line) => pyPattern.test(line)).length
  const threshold = Math.max(2, Math.floor(lines.length * 0.6))

  if (jsonLike) return { language: 'json', code: trimmed }
  if (jsLines >= threshold) return { language: 'javascript', code: trimmed }
  if (pyLines >= threshold) return { language: 'python', code: trimmed }

  return null
}

export function ChatMessage({
  message,
  collapseArtifacts = false,
  sweeps = [],
  runs = [],
  alerts = [],
  onEditSweep,
  onLaunchSweep,
  onRunClick,
  onReplyToSelection,
  onSubmitEditedUserMessage,
  previousUserContent,
}: ChatMessageProps) {
  const [isThinkingOpen, setIsThinkingOpen] = useState(false)
  const [isChartOpen, setIsChartOpen] = useState(true)
  const [selectionReplyUi, setSelectionReplyUi] = useState<{
    text: string
    x: number
    y: number
  } | null>(null)
  const [copiedUserMessage, setCopiedUserMessage] = useState(false)
  const [isEditingUserMessage, setIsEditingUserMessage] = useState(false)
  const [editedUserMessage, setEditedUserMessage] = useState(message.content)
  const isUser = message.role === 'user'
  const assistantContainerRef = useRef<HTMLDivElement>(null)
  const copyResetTimerRef = useRef<number | null>(null)
  const editTextareaRef = useRef<HTMLTextAreaElement>(null)

  // Extract context references from the current round (user question + assistant answer)
  const contextReferences = useMemo(() => {
    if (isUser) return []
    // Gather text from all parts, plus the main content
    const partTexts = (message.parts || []).filter(p => p.type === 'text').map(p => p.content)
    return extractContextReferences(
      previousUserContent,
      message.content,
      ...partTexts,
    )
  }, [isUser, message.content, message.parts, previousUserContent])

  const formatDateTime = (date: Date) => {
    const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' })
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    return `${dateStr}, ${timeStr}`
  }

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!isUser) return
    setIsEditingUserMessage(false)
    setEditedUserMessage(message.content)
  }, [isUser, message.content, message.id])

  useEffect(() => {
    if (!isEditingUserMessage) return
    const textarea = editTextareaRef.current
    if (!textarea) return
    textarea.focus()
    const cursor = textarea.value.length
    textarea.setSelectionRange(cursor, cursor)
  }, [isEditingUserMessage])

  useEffect(() => {
    if (isUser || !onReplyToSelection) return

    const updateSelectionReply = () => {
      const selection = window.getSelection()
      const root = assistantContainerRef.current
      if (!selection || !root || selection.rangeCount === 0 || selection.isCollapsed) {
        setSelectionReplyUi(null)
        return
      }

      const anchorNode = selection.anchorNode
      const focusNode = selection.focusNode
      if (!anchorNode || !focusNode || !root.contains(anchorNode) || !root.contains(focusNode)) {
        setSelectionReplyUi(null)
        return
      }

      const text = selection.toString().trim()
      if (!text) {
        setSelectionReplyUi(null)
        return
      }

      const rect = selection.getRangeAt(0).getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) {
        setSelectionReplyUi(null)
        return
      }

      const x = Math.min(Math.max(rect.left + rect.width / 2, 56), window.innerWidth - 56)
      const y = Math.max(rect.top - 10, 12)
      setSelectionReplyUi({ text, x, y })
    }

    const clearSelectionReply = () => setSelectionReplyUi(null)

    document.addEventListener('selectionchange', updateSelectionReply)
    window.addEventListener('scroll', clearSelectionReply, true)

    return () => {
      document.removeEventListener('selectionchange', updateSelectionReply)
      window.removeEventListener('scroll', clearSelectionReply, true)
    }
  }, [isUser, onReplyToSelection])

  const handleCopyUserMessage = async () => {
    const text = message.content
    if (!text) return

    const fallbackCopy = () => {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.setAttribute('readonly', '')
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        fallbackCopy()
      }
      setCopiedUserMessage(true)
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current)
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopiedUserMessage(false)
      }, 1400)
    } catch {
      fallbackCopy()
      setCopiedUserMessage(true)
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current)
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopiedUserMessage(false)
      }, 1400)
    }
  }

  const handleStartEditingUserMessage = () => {
    if (!onSubmitEditedUserMessage) return
    setEditedUserMessage(message.content)
    setIsEditingUserMessage(true)
  }

  const handleCancelEditingUserMessage = () => {
    setEditedUserMessage(message.content)
    setIsEditingUserMessage(false)
  }

  const handleSubmitEditedUserMessage = () => {
    const nextContent = editedUserMessage.trim()
    if (!nextContent || !onSubmitEditedUserMessage) return
    onSubmitEditedUserMessage(message, nextContent)
    setIsEditingUserMessage(false)
  }

  const renderReferenceToken = (reference: string, key: string) => {
    const [type, ...idParts] = reference.split(':')
    const itemId = idParts.join(':')
    const tokenType = (type in REFERENCE_TYPE_COLOR_MAP ? type : 'chat') as ReferenceTokenType
    const color = REFERENCE_TYPE_COLOR_MAP[tokenType]
    const backgroundColor = REFERENCE_TYPE_BACKGROUND_MAP[tokenType]
    const tokenStyle = {
      color,
      backgroundColor,
      ['--reference-border' as string]: `${color}66`,
    } as React.CSSProperties

    if (type === 'sweep') {
      const sweep = sweeps.find((candidate) => candidate.id === itemId)

      if (sweep) {
        return (
          <Popover key={key}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="mx-0.5 inline-flex items-center align-middle rounded-sm border border-[color:var(--reference-border)] px-2.5 py-1.5 text-base leading-none outline-none transition-colors hover:border-transparent focus:outline-none focus-visible:ring-0 focus-visible:outline-none"
                style={tokenStyle}
              >
                @{reference}
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-[min(94vw,430px)] p-0">
              <div className="p-2">
                {sweep.status === 'draft' ? (
                  <SweepArtifact
                    config={sweep.config}
                    sweep={sweep}
                    onEdit={onEditSweep}
                    onLaunch={onLaunchSweep}
                    isCollapsed={false}
                  />
                ) : (
                  <SweepStatus
                    sweep={sweep}
                    runs={runs}
                    onRunClick={onRunClick}
                    isCollapsed={false}
                  />
                )}
              </div>
            </PopoverContent>
          </Popover>
        )
      }
    }

    return (
      <span
        key={key}
        className="mx-0.5 inline-flex items-center align-middle rounded-sm border border-[color:var(--reference-border)] px-2.5 py-1.5 text-base leading-none"
        style={tokenStyle}
      >
        @{reference}
      </span>
    )
  }

  const renderReferences = (text: string, keyPrefix: string) => {
    const output: React.ReactNode[] = []
    const referenceRegex = /@((?:run|sweep|artifact|alert|chart|chat):[A-Za-z0-9:._-]+)(?=$|[\s,.;!?)\]])/g
    let cursor = 0
    let match: RegExpExecArray | null
    let partIndex = 0

    while ((match = referenceRegex.exec(text)) !== null) {
      const tokenStart = match.index
      const tokenEnd = tokenStart + match[0].length
      if (tokenStart > cursor) {
        output.push(
          <span key={`${keyPrefix}-txt-${partIndex++}`}>
            {text.slice(cursor, tokenStart)}
          </span>
        )
      }

      output.push(renderReferenceToken(match[1], `${keyPrefix}-ref-${tokenStart}`))
      cursor = tokenEnd
    }

    if (cursor < text.length) {
      output.push(
        <span key={`${keyPrefix}-txt-${partIndex++}`}>
          {text.slice(cursor)}
        </span>
      )
    }

    if (output.length === 0) {
      output.push(
        <span key={`${keyPrefix}-txt-empty`}>
          {text}
        </span>
      )
    }

    return output
  }

  const renderMarkdown = (content: string) => {
    const taggedCode = parseTaggedCodeBlock(content)
    if (taggedCode) {
      return [<CodeOutputBox key="tagged-code" language={taggedCode.language} code={taggedCode.code} />]
    }

    const standaloneCode = detectStandaloneCode(content)
    if (standaloneCode) {
      return [<CodeOutputBox key="detected-code" language={standaloneCode.language} code={standaloneCode.code} />]
    }

    // Simple markdown rendering
    const lines = content.split('\n')
    const elements: React.ReactNode[] = []
    let inCodeBlock = false
    let codeContent = ''
    let codeLanguage = ''
    let codeKey = 0

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      if (line.startsWith('```')) {
        if (inCodeBlock) {
          elements.push(
            <CodeOutputBox
              key={`code-${codeKey++}`}
              language={codeLanguage}
              code={codeContent.replace(/\n$/, '')}
            />
          )
          codeContent = ''
          codeLanguage = ''
          inCodeBlock = false
        } else {
          inCodeBlock = true
          codeLanguage = line.slice(3).trim()
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

    if (inCodeBlock && codeContent) {
      elements.push(
        <CodeOutputBox
          key={`code-${codeKey++}`}
          language={codeLanguage}
          code={codeContent.replace(/\n$/, '')}
        />
      )
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
            className="rounded border border-orange-300/70 bg-orange-100/85 px-1.5 py-0.5 font-mono text-sm text-orange-700 dark:border-[#39ff14]/35 dark:bg-[#0b1a0f] dark:text-[#39ff14]"
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
              {renderReferences(bp.slice(2, -2), `bold-${i}-${j}`)}
            </strong>
          )
        }
        return (
          <React.Fragment key={`${i}-${j}`}>
            {renderReferences(bp, `text-${i}-${j}`)}
          </React.Fragment>
        )
      })
    })
  }

  if (isUser) {
    // Wild loop auto-generated messages with provenance get the two-mode view
    if (message.provenance) {
      return (
        <div className="px-0.5 py-2 min-w-0 overflow-hidden">
          <PromptProvenanceView content={message.content} provenance={message.provenance} />
        </div>
      )
    }

    const parsedUserReply = extractLeadingQuoteBlock(message.content)
    const hasExcerptCard = Boolean(parsedUserReply.excerpt)
    const userBody = hasExcerptCard ? parsedUserReply.body : message.content
    const excerptLineCount = parsedUserReply.excerpt ? parsedUserReply.excerpt.split('\n').length : 0
    const canSubmitEditedMessage = Boolean(editedUserMessage.trim() && onSubmitEditedUserMessage)

    return (
      <div className="px-0.5 py-2 min-w-0 overflow-hidden">
        {!isEditingUserMessage && hasExcerptCard && parsedUserReply.excerpt && (
          <div className="mb-2 flex justify-start">
            <div className="w-[220px] rounded-2xl border border-border/80 bg-card/80 p-3 shadow-sm">
              <p className="text-sm font-medium leading-tight text-foreground break-words">
                excerpt_from_previous_message.txt
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {excerptLineCount} line{excerptLineCount === 1 ? '' : 's'}
              </p>
              <span className="mt-2 inline-flex rounded-md border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
                TXT
              </span>
            </div>
          </div>
        )}
        <div className="group/user relative">
          {!isEditingUserMessage && (
            <div className="absolute -top-3 right-1 z-20 flex items-center gap-1 rounded-md border border-border/70 bg-background/95 p-1 opacity-100 shadow-sm transition-opacity md:pointer-events-none md:opacity-0 md:group-hover/user:pointer-events-auto md:group-hover/user:opacity-100 md:group-focus-within/user:pointer-events-auto md:group-focus-within/user:opacity-100">
              {onSubmitEditedUserMessage && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label="Edit message"
                      onClick={handleStartEditingUserMessage}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={6}>Edit</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={copiedUserMessage ? 'Copied message' : 'Copy message'}
                    onClick={handleCopyUserMessage}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                  >
                    {copiedUserMessage ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6}>{copiedUserMessage ? 'Copied' : 'Copy'}</TooltipContent>
              </Tooltip>
            </div>
          )}
          <div className="border-l-4 border-primary px-3 py-1">
            {isEditingUserMessage ? (
              <div className="space-y-2">
                <textarea
                  ref={editTextareaRef}
                  value={editedUserMessage}
                  onChange={(event) => setEditedUserMessage(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                      event.preventDefault()
                      handleSubmitEditedUserMessage()
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      handleCancelEditingUserMessage()
                    }
                  }}
                  rows={4}
                  className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                />
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={handleCancelEditingUserMessage}
                    className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleSubmitEditedUserMessage}
                    disabled={!canSubmitEditedMessage}
                    className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Send
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-base leading-relaxed text-foreground break-words">{renderInlineMarkdown(userBody)}</p>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div ref={assistantContainerRef} className="px-0.5 py-2 min-w-0 overflow-hidden">
      <div className="space-y-2 min-w-0">
        {/* Parts-based rendering (new) vs legacy thinking field */}
        {message.parts && message.parts.length > 0 ? (
          // NEW: Render each part in order for correct interleaving
          message.parts.map((part) => (
            <SavedPartRenderer
              key={part.id}
              part={part}
              renderMarkdown={renderMarkdown}
            />
          ))
        ) : (
          // Legacy: single thinking block
          message.thinking && (
            <Collapsible open={isThinkingOpen} onOpenChange={setIsThinkingOpen}>
              <CollapsibleTrigger className="flex w-full items-center justify-start gap-1.5 rounded-lg bg-secondary/50 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
                {isThinkingOpen ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                <Brain className="h-3 w-3" />
                <span>Thinking process</span>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2">
                <div className="w-full rounded-lg border border-border/50 bg-secondary/30 p-3 text-xs leading-relaxed text-muted-foreground">
                  {message.thinking.split('\n').map((line, i) => (
                    <p key={i} className={line.trim() === '' ? 'h-2' : ''}>
                      {line}
                    </p>
                  ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )
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

        {/* Sweep Config Artifact */}
        {message.sweepConfig && (
          <div className="mb-2">
            {(() => {
              const sweep = message.sweepId
                ? sweeps.find(s => s.id === message.sweepId)
                : undefined

              if (sweep && sweep.status !== 'draft') {
                // Show sweep status if the sweep is running/completed
                return (
                  <SweepStatus
                    sweep={sweep}
                    runs={runs}
                    onRunClick={onRunClick}
                    isCollapsed={collapseArtifacts}
                  />
                )
              }

              // Show sweep artifact (config) if draft or no sweep yet
              return (
                <SweepArtifact
                  config={message.sweepConfig}
                  sweep={sweep}
                  onEdit={onEditSweep}
                  onLaunch={onLaunchSweep}
                  isCollapsed={collapseArtifacts}
                />
              )
            })()}
          </div>
        )}

        {/* Text content — skip when parts are present since text parts already render it */}
        {!(message.parts && message.parts.length > 0) && message.content && (
          <div className="px-1 py-1 text-base leading-relaxed break-words overflow-hidden">
            {renderMarkdown(message.content)}
          </div>
        )}

        {/* Context references bar */}
        {contextReferences.length > 0 && (
          <ContextReferencesBar
            references={contextReferences}
            sweeps={sweeps}
            runs={runs}
            alerts={alerts}
            onEditSweep={onEditSweep}
            onLaunchSweep={onLaunchSweep}
            onRunClick={onRunClick}
          />
        )}

        <span className="text-[10px] text-muted-foreground" suppressHydrationWarning>
          {formatDateTime(message.timestamp)}
        </span>
      </div>
      {selectionReplyUi && (
        <button
          type="button"
          onMouseDown={(event) => {
            event.preventDefault()
          }}
          onClick={() => {
            onReplyToSelection?.(selectionReplyUi.text)
            setSelectionReplyUi(null)
            window.getSelection()?.removeAllRanges()
          }}
          className="fixed z-50 rounded-md border border-black bg-black px-2.5 py-1 text-xs font-medium text-white shadow-md transition-colors hover:bg-black/90"
          style={{
            left: selectionReplyUi.x,
            top: selectionReplyUi.y,
            transform: 'translate(-50%, -100%)',
          }}
        >
          Reply
        </button>
      )}
    </div>
  )
}

/**
 * Renders a saved message part (thinking, tool, or text) with collapsible behavior
 */
function SavedPartRenderer({
  part,
  renderMarkdown
}: {
  part: MessagePart
  renderMarkdown: (content: string) => React.ReactNode
}) {
  const [isOpen, setIsOpen] = useState(false) // Default collapsed per user preference

  if (part.type === 'thinking') {
    return (
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger className="flex w-full items-center justify-start gap-1.5 rounded-lg bg-secondary/50 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
          {isOpen ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          <Brain className="h-3 w-3" />
          <span>Thinking process</span>
          {!isOpen && part.content && (
            <span className="ml-1 truncate text-muted-foreground/50 max-w-[200px]" title={part.content.split('\n')[0]}>
              — {part.content.split('\n')[0].slice(0, 60)}{part.content.split('\n')[0].length > 60 ? '…' : ''}
            </span>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2">
          <div className="w-full rounded-lg border border-border/50 bg-secondary/30 p-3 text-xs leading-relaxed text-muted-foreground max-h-[var(--app-streaming-tool-box-height,7.5rem)] overflow-y-auto">
            {part.content.split('\n').map((line, i) => (
              <p key={i} className={line.trim() === '' ? 'h-2' : ''}>
                {line}
              </p>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    )
  }

  if (part.type === 'tool') {
    const durationLabel = formatToolDuration(part.toolDurationMs, part.toolStartedAt, part.toolEndedAt)

    const getStatusIcon = () => {
      switch (part.toolState) {
        case 'pending':
        case 'running':
          return <Loader2 className="h-3 w-3 animate-spin" />
        case 'completed':
          return <Check className="h-3 w-3 text-green-500" />
        case 'error':
          return <AlertCircle className="h-3 w-3 text-red-500" />
        default:
          return <Wrench className="h-3 w-3" />
      }
    }

    const getStatusText = () => {
      switch (part.toolState) {
        case 'pending': return 'Pending'
        case 'running': return 'Running'
        case 'completed': return 'Done'
        case 'error': return 'Error'
        default: return part.toolState || ''
      }
    }

    return (
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger className="flex w-full items-center justify-start gap-2 rounded-lg bg-secondary/50 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
          {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {getStatusIcon()}
          <Wrench className="h-3 w-3" />
          <span>{part.toolName || 'Tool'}</span>
          <span className="text-muted-foreground/60">•</span>
          <span className={part.toolState === 'completed' ? 'text-green-500' : part.toolState === 'error' ? 'text-red-500' : ''}>
            {getStatusText()}
          </span>
          {durationLabel && <span className="text-muted-foreground/70">({durationLabel})</span>}
          {!isOpen && part.toolInput && (
            <span className="ml-1 truncate text-muted-foreground/50 max-w-[200px]" title={part.toolInput}>
              — {part.toolInput.slice(0, 60)}{part.toolInput.length > 60 ? '…' : ''}
            </span>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2">
          {(part.toolInput || part.toolOutput || part.content) && (
            <div className="w-full rounded-lg border border-border/50 bg-secondary/30 p-3 text-xs leading-relaxed text-muted-foreground space-y-2 max-h-[var(--app-streaming-tool-box-height,7.5rem)] overflow-y-auto">
              {part.toolInput && (
                <div>
                  <span className="font-medium text-foreground/70">Input:</span>
                  <pre className="mt-1 whitespace-pre-wrap break-all overflow-hidden">{part.toolInput}</pre>
                </div>
              )}
              {part.toolOutput && (
                <div>
                  <span className="font-medium text-foreground/70">Output:</span>
                  <pre className="mt-1 whitespace-pre-wrap break-all overflow-hidden">{part.toolOutput}</pre>
                </div>
              )}
              {part.content && !part.toolInput && !part.toolOutput && (
                <pre className="whitespace-pre-wrap break-all overflow-hidden">{part.content}</pre>
              )}
              {(part.toolStartedAt || part.toolEndedAt) && (
                <div className="text-muted-foreground/80">
                  {part.toolStartedAt && <div>Start: {formatToolTimestamp(part.toolStartedAt)}</div>}
                  {part.toolEndedAt && <div>End: {formatToolTimestamp(part.toolEndedAt)}</div>}
                </div>
              )}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    )
  }

  if (part.type === 'text') {
    return (
      <div className="px-1 py-1 text-base leading-relaxed break-words overflow-hidden">
        {renderMarkdown(part.content)}
      </div>
    )
  }

  return null
}

function formatToolTimestamp(value: number): string {
  const ms = value > 1e12 ? value : value * 1000
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatToolDuration(durationMs?: number, startedAt?: number, endedAt?: number): string | null {
  const derived = durationMs ?? (
    startedAt != null && endedAt != null
      ? Math.max(0, Math.round((endedAt > 1e12 ? endedAt : endedAt * 1000) - (startedAt > 1e12 ? startedAt : startedAt * 1000)))
      : undefined
  )
  if (derived == null) return null
  if (derived < 1000) return `${derived}ms`
  return `${(derived / 1000).toFixed(2)}s`
}
