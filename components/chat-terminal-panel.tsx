'use client'

import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  CornerDownLeft,
  Eraser,
  Loader2,
  RefreshCw,
  Terminal,
  XCircle,
} from 'lucide-react'

import {
  closeTerminalSession,
  createTerminalSession,
  resizeTerminalSession,
  sendTerminalInput,
  streamTerminalSession,
} from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const MAX_OUTPUT_CHARS = 250_000

export function ChatTerminalPanel() {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [workdir, setWorkdir] = useState('')
  const [shell, setShell] = useState('')
  const [output, setOutput] = useState('')
  const [command, setCommand] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isConnecting, setIsConnecting] = useState(true)
  const [isConnected, setIsConnected] = useState(false)

  const mountedRef = useRef(false)
  const sessionIdRef = useRef<string | null>(null)
  const streamAbortRef = useRef<AbortController | null>(null)
  const terminalViewportRef = useRef<HTMLDivElement>(null)
  const terminalSurfaceRef = useRef<HTMLDivElement>(null)
  const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null)

  const appendOutput = useCallback((chunk: string) => {
    if (!chunk) return
    setOutput((prev) => {
      const next = prev + chunk
      if (next.length <= MAX_OUTPUT_CHARS) return next
      return next.slice(next.length - MAX_OUTPUT_CHARS)
    })
  }, [])

  const stopStreaming = useCallback(() => {
    const controller = streamAbortRef.current
    if (controller) {
      controller.abort()
      streamAbortRef.current = null
    }
  }, [])

  const closeSession = useCallback(async (id: string | null) => {
    if (!id) return
    try {
      await closeTerminalSession(id)
    } catch {
      // No-op: backend may already have closed the session.
    }
  }, [])

  const startSession = useCallback(async () => {
    setError(null)
    setIsConnecting(true)
    setIsConnected(false)
    setOutput('')

    stopStreaming()
    await closeSession(sessionIdRef.current)

    try {
      const created = await createTerminalSession()
      if (!mountedRef.current) return

      setSessionId(created.session_id)
      sessionIdRef.current = created.session_id
      setWorkdir(created.workdir)
      setShell(created.shell)
      setIsConnected(true)
      setIsConnecting(false)

      const controller = new AbortController()
      streamAbortRef.current = controller

      void (async () => {
        try {
          for await (const event of streamTerminalSession(created.session_id, controller.signal)) {
            if (!mountedRef.current) break
            if (event.type === 'ready') {
              if (event.workdir) setWorkdir(event.workdir)
              if (event.shell) setShell(event.shell)
              continue
            }
            if (event.type === 'output') {
              appendOutput(event.data || '')
              continue
            }
            if (event.type === 'closed') {
              setIsConnected(false)
              break
            }
            if (event.type === 'error') {
              setError(event.message || 'Terminal stream error')
            }
          }
        } catch (streamErr) {
          if (!mountedRef.current) return
          if (controller.signal.aborted) return
          const message = streamErr instanceof Error ? streamErr.message : 'Failed to stream terminal output'
          setError(message)
          setIsConnected(false)
        } finally {
          if (streamAbortRef.current === controller) {
            streamAbortRef.current = null
          }
        }
      })()
    } catch (sessionErr) {
      if (!mountedRef.current) return
      const message = sessionErr instanceof Error ? sessionErr.message : 'Failed to start terminal session'
      setError(message)
      setIsConnecting(false)
      setIsConnected(false)
      setSessionId(null)
      sessionIdRef.current = null
    }
  }, [appendOutput, closeSession, stopStreaming])

  useEffect(() => {
    mountedRef.current = true
    void startSession()

    return () => {
      mountedRef.current = false
      stopStreaming()
      const existingSessionId = sessionIdRef.current
      sessionIdRef.current = null
      if (existingSessionId) {
        void closeSession(existingSessionId)
      }
    }
  }, [closeSession, startSession, stopStreaming])

  useEffect(() => {
    const viewport = terminalViewportRef.current
    if (!viewport) return
    viewport.scrollTop = viewport.scrollHeight
  }, [output])

  useEffect(() => {
    if (!sessionId || !terminalSurfaceRef.current) return

    const surface = terminalSurfaceRef.current
    let resizeTimer: ReturnType<typeof setTimeout> | null = null

    const sendResize = () => {
      const width = surface.clientWidth
      const height = surface.clientHeight
      const cols = Math.max(40, Math.min(320, Math.floor(width / 8)))
      const rows = Math.max(8, Math.min(180, Math.floor(height / 18)))
      const last = lastResizeRef.current
      if (last && last.cols === cols && last.rows === rows) {
        return
      }
      lastResizeRef.current = { cols, rows }
      void resizeTerminalSession(sessionId, cols, rows).catch(() => {
        // Ignore resize errors while reconnecting/closing.
      })
    }

    const scheduleResize = () => {
      if (resizeTimer) {
        clearTimeout(resizeTimer)
      }
      resizeTimer = setTimeout(sendResize, 120)
    }

    const observer = new ResizeObserver(scheduleResize)
    observer.observe(surface)
    scheduleResize()

    return () => {
      observer.disconnect()
      if (resizeTimer) {
        clearTimeout(resizeTimer)
      }
    }
  }, [sessionId])

  const handleSubmit = useCallback(async (event: FormEvent) => {
    event.preventDefault()

    const trimmed = command.trim()
    if (!trimmed || !sessionId) return

    setCommand('')

    try {
      await sendTerminalInput(sessionId, `${command}\n`)
    } catch (inputErr) {
      const message = inputErr instanceof Error ? inputErr.message : 'Failed to send terminal input'
      setError(message)
    }
  }, [command, sessionId])

  const handleCtrlC = useCallback(async () => {
    if (!sessionId) return
    try {
      await sendTerminalInput(sessionId, '\u0003')
    } catch (inputErr) {
      const message = inputErr instanceof Error ? inputErr.message : 'Failed to send interrupt'
      setError(message)
    }
  }, [sessionId])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden border-t border-border/70 bg-card/30">
      <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium text-foreground">Terminal</span>
          <span className={`h-1.5 w-1.5 rounded-full ${isConnected ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />
          <code className="min-w-0 max-w-[42vw] truncate rounded bg-secondary/70 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {workdir || 'starting...'}
          </code>
        </div>

        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setOutput('')}
            title="Clear output"
          >
            <Eraser className="h-3.5 w-3.5" />
            <span className="sr-only">Clear output</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => { void handleCtrlC() }}
            title="Send Ctrl+C"
            disabled={!isConnected || !sessionId}
          >
            <XCircle className="h-3.5 w-3.5" />
            <span className="sr-only">Send Ctrl+C</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => { void startSession() }}
            title="Restart terminal"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span className="sr-only">Restart terminal</span>
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-1.5 border-b border-destructive/25 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          <AlertCircle className="h-3.5 w-3.5" />
          <span className="truncate">{error}</span>
        </div>
      )}

      <div ref={terminalSurfaceRef} className="min-h-0 flex-1 overflow-hidden bg-black/95">
        <div ref={terminalViewportRef} className="h-full overflow-auto px-3 py-2">
          <pre className="min-h-full whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-green-200">
            {output || (isConnecting ? '' : '$ ')}
          </pre>
          {isConnecting && (
            <div className="flex items-center gap-1.5 text-xs text-green-300/90">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Starting terminal...
            </div>
          )}
        </div>
      </div>

      <form onSubmit={handleSubmit} className="flex items-center gap-2 border-t border-border/70 bg-background px-3 py-2">
        <span className="font-mono text-xs text-muted-foreground">$</span>
        <Input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder={shell ? `Command (${shell})` : 'Run a command'}
          className="h-8 font-mono text-xs"
          autoComplete="off"
          spellCheck={false}
          disabled={!sessionId || !isConnected}
        />
        <Button type="submit" size="sm" className="h-8 gap-1.5" disabled={!sessionId || !isConnected || command.trim().length === 0}>
          <CornerDownLeft className="h-3.5 w-3.5" />
          Run
        </Button>
      </form>
    </div>
  )
}
