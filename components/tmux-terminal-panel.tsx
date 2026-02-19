'use client'

import { useState } from 'react'
import {
    Terminal,
    Copy,
    Check,
    Monitor
} from 'lucide-react'
import { Button } from '@/components/ui/button'

interface TmuxTerminalPanelProps {
    runId: string
    tmuxWindow?: string
    tmuxPane?: string
    sessionName?: string
    showHeader?: boolean
    className?: string
}

export function TmuxTerminalPanel({
    runId,
    tmuxWindow,
    tmuxPane,
    sessionName = 'research-agent',
    showHeader = true,
    className = '',
}: TmuxTerminalPanelProps) {
    const [copied, setCopied] = useState<'window' | 'command' | null>(null)

    const attachCommand = tmuxWindow
        ? `tmux attach -t ${sessionName}:${tmuxWindow}`
        : `tmux attach -t ${sessionName}`

    const copyToClipboard = async (text: string, type: 'window' | 'command') => {
        try {
            await navigator.clipboard.writeText(text)
            setCopied(type)
            setTimeout(() => setCopied(null), 2000)
        } catch (e) {
            console.error('Failed to copy:', e)
        }
    }

    if (!tmuxWindow) {
        return (
            <div className={`rounded-lg border border-border bg-card overflow-hidden ${className}`}>
                {showHeader && (
                    <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-secondary/30">
                        <Terminal className="h-4 w-4 text-muted-foreground" />
                        <span className="text-xs font-medium">Terminal</span>
                    </div>
                )}
                <div className="p-4 text-center">
                    <Monitor className="h-8 w-8 mx-auto mb-2 text-muted-foreground/50" />
                    <p className="text-xs text-muted-foreground">
                        Terminal will be available after the run starts
                    </p>
                </div>
            </div>
        )
    }

    return (
        <div className={`rounded-lg border border-border bg-card overflow-hidden ${className}`}>
            {showHeader && (
                <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-secondary/30">
                    <div className="flex items-center gap-2">
                        <Terminal className="h-4 w-4 text-muted-foreground" />
                        <span className="text-xs font-medium">Terminal</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">
                            {tmuxWindow}
                        </span>
                    </div>
                </div>
            )}

            {/* Terminal Placeholder */}
            <div className="bg-muted/50 p-1">
                {/* Placeholder for future embedded terminal */}
                <div className="rounded border border-dashed border-border bg-secondary/50 p-6 text-center">
                    <Monitor className="h-10 w-10 mx-auto mb-3 text-muted-foreground/50" />
                    <p className="text-sm text-muted-foreground mb-1">
                        Embedded Terminal
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                        Coming soon - Interactive terminal access
                    </p>
                </div>

                {/* Manual attach instructions */}
                <div className="mt-1 rounded bg-secondary/50 p-2 min-w-0">
                    <p className="text-[10px] text-muted-foreground mb-1 min-w-0">To attach manually:</p>
                    <div className="flex items-center gap-1 min-w-0">
                        <code className="text-[11px] font-mono text-foreground bg-muted/50 rounded overflow-hidden text-ellipsis ">
                            {attachCommand}
                        </code>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 shrink-0"
                            onClick={() => copyToClipboard(attachCommand, 'command')}
                        >
                            {copied === 'command' ? (
                                <Check className="h-3 w-3 text-green-500" />
                            ) : (
                                <Copy className="h-3 w-3" />
                            )}
                        </Button>
                    </div>
                </div>

                {/* Pane info */}
                {tmuxPane && (
                    <p className="ml-1 mt-2 text-[10px] text-muted-foreground">
                        Pane ID: {tmuxPane}
                    </p>
                )}
            </div>

            {/* Actions */}
            {/* <div className="flex items-center gap-2 px-3 py-2 border-t border-border bg-secondary/20">
                <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs flex-1"
                    onClick={() => copyToClipboard(tmuxWindow, 'window')}
                >
                    {copied === 'window' ? (
                        <Check className="h-3 w-3 mr-1.5 text-green-500" />
                    ) : (
                        <Copy className="h-3 w-3 mr-1.5" />
                    )}
                    Copy Window Name
                </Button>

                <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs flex-1"
                    disabled
                    title="Coming soon"
                >
                    <ExternalLink className="h-3 w-3 mr-1.5" />
                    Attach
                </Button>
            </div> */}
        </div>
    )
}
