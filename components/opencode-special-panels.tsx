'use client'

import React, { useMemo } from 'react'
import { CheckCircle2, Circle, Loader2, ListChecks, ShieldAlert } from 'lucide-react'

type TodoLineStatus = 'done' | 'doing' | 'todo'
type TodoLine =
    | { id: string; kind: 'task'; status: TodoLineStatus; text: string; indentLevel: number }
    | { id: string; kind: 'heading'; text: string; indentLevel: number }
    | { id: string; kind: 'text'; text: string; indentLevel: number }
    | { id: string; kind: 'spacer' }

const TODO_TASK_PATTERN = /(^|\n)\s*(?:[-*+]|\d+[.)])\s+\[( |x|X|\/)\]\s+/

function extractTodoTextFromValue(value: unknown): string | null {
    if (typeof value === 'string') {
        if (TODO_TASK_PATTERN.test(value)) return value
        try {
            const parsed = JSON.parse(value) as unknown
            return extractTodoTextFromValue(parsed)
        } catch {
            return null
        }
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            const extracted = extractTodoTextFromValue(item)
            if (extracted) return extracted
        }
        return null
    }

    if (value && typeof value === 'object') {
        for (const nestedValue of Object.values(value as Record<string, unknown>)) {
            const extracted = extractTodoTextFromValue(nestedValue)
            if (extracted) return extracted
        }
    }

    return null
}

function parseTodoLines(markdown: string): TodoLine[] {
    return markdown.split('\n').map((rawLine, index) => {
        if (rawLine.trim().length === 0) {
            return { id: `spacer-${index}`, kind: 'spacer' }
        }

        const headingMatch = rawLine.match(/^(\s*)(#{1,6})\s+(.*)$/)
        if (headingMatch) {
            return {
                id: `heading-${index}`,
                kind: 'heading',
                text: headingMatch[3],
                indentLevel: Math.floor(headingMatch[1].length / 2),
            }
        }

        const taskMatch = rawLine.match(/^(\s*)(?:[-*+]|\d+[.)])\s+\[( |x|X|\/)\]\s+(.*)$/)
        if (taskMatch) {
            const marker = taskMatch[2]
            const status: TodoLineStatus = marker === '/' ? 'doing' : (marker.toLowerCase() === 'x' ? 'done' : 'todo')
            return {
                id: `task-${index}`,
                kind: 'task',
                status,
                text: taskMatch[3],
                indentLevel: Math.floor(taskMatch[1].length / 2),
            }
        }

        const textIndent = rawLine.match(/^(\s*)/)?.[1].length ?? 0
        return {
            id: `text-${index}`,
            kind: 'text',
            text: rawLine.trim(),
            indentLevel: Math.floor(textIndent / 2),
        }
    })
}

function statusPillClass(status: TodoLineStatus): string {
    if (status === 'done') return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    if (status === 'doing') return 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
    return 'border-border/60 bg-background/50 text-muted-foreground'
}

export function TodoChecklistPanel({
    toolName,
    toolInput,
    toolOutput,
}: {
    toolName?: string
    toolInput?: string
    toolOutput?: string
}) {
    const isTodoTool = (toolName || '').toLowerCase().includes('todo')
    const todoMarkdown = useMemo(() => (
        extractTodoTextFromValue(toolOutput)
        || extractTodoTextFromValue(toolInput)
    ), [toolInput, toolOutput])

    if (!isTodoTool && !todoMarkdown) return null

    const lines = parseTodoLines(todoMarkdown || '')
    const counts = lines.reduce(
        (acc, line) => {
            if (line.kind !== 'task') return acc
            if (line.status === 'done') acc.done += 1
            if (line.status === 'doing') acc.doing += 1
            if (line.status === 'todo') acc.todo += 1
            return acc
        },
        { done: 0, doing: 0, todo: 0 }
    )

    if (!todoMarkdown || lines.length === 0) return null

    return (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className="inline-flex items-center gap-1 font-medium text-foreground">
                    <ListChecks className="h-3.5 w-3.5 text-amber-500" />
                    Task Checklist
                </span>
                <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 ${statusPillClass('done')}`}>
                    {counts.done} done
                </span>
                <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 ${statusPillClass('doing')}`}>
                    {counts.doing} doing
                </span>
                <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 ${statusPillClass('todo')}`}>
                    {counts.todo} todo
                </span>
            </div>
            <div className="mt-2 space-y-1.5">
                {lines.map((line) => {
                    if (line.kind === 'spacer') return <div key={line.id} className="h-1" />
                    if (line.kind === 'heading') {
                        return (
                            <div
                                key={line.id}
                                style={{ paddingLeft: `${line.indentLevel * 12}px` }}
                                className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                            >
                                {line.text}
                            </div>
                        )
                    }
                    if (line.kind === 'text') {
                        return (
                            <p
                                key={line.id}
                                style={{ paddingLeft: `${line.indentLevel * 12}px` }}
                                className="text-[11px] text-muted-foreground"
                            >
                                {line.text}
                            </p>
                        )
                    }
                    return (
                        <div
                            key={line.id}
                            style={{ paddingLeft: `${line.indentLevel * 12}px` }}
                            className="flex items-start gap-2 text-xs"
                        >
                            {line.status === 'done' && <CheckCircle2 className="mt-[1px] h-4 w-4 shrink-0 text-emerald-500" />}
                            {line.status === 'doing' && <Loader2 className="mt-[1px] h-4 w-4 shrink-0 animate-spin text-amber-500" />}
                            {line.status === 'todo' && <Circle className="mt-[1px] h-4 w-4 shrink-0 text-muted-foreground/70" />}
                            <span className={line.status === 'done' ? 'line-through text-muted-foreground' : 'text-foreground/90'}>
                                {line.text}
                            </span>
                        </div>
                    )
                })}
            </div>
        </div>
    )
}

export function PermissionRequestPanel({
    title,
    description,
    action,
    resource,
    status,
}: {
    title?: string
    description?: string
    action?: string
    resource?: string
    status?: string
}) {
    const normalizedStatus = (status || 'pending').toLowerCase()
    const statusClass = normalizedStatus.includes('deny') || normalizedStatus.includes('error')
        ? 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300'
        : normalizedStatus.includes('allow') || normalizedStatus.includes('grant') || normalizedStatus.includes('approved')
        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
        : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'

    return (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-relaxed text-muted-foreground">
            <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                    <ShieldAlert className="h-3.5 w-3.5 text-amber-500" />
                    {title || 'Permission request'}
                </span>
                <span className={`inline-flex rounded-md border px-1.5 py-0.5 text-[11px] ${statusClass}`}>
                    {normalizedStatus}
                </span>
            </div>
            {description && <p className="mt-1 text-muted-foreground">{description}</p>}
            {action && (
                <div className="mt-2">
                    <span className="font-medium text-foreground/80">Action:</span>{' '}
                    <code className="rounded border border-border/60 bg-background/60 px-1 py-0.5">{action}</code>
                </div>
            )}
            {resource && (
                <div className="mt-1">
                    <span className="font-medium text-foreground/80">Resource:</span>{' '}
                    <code className="rounded border border-border/60 bg-background/60 px-1 py-0.5">{resource}</code>
                </div>
            )}
        </div>
    )
}
