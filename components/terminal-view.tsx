'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { RefreshCw, Terminal as TerminalIcon, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'

type XTerminal = import('@xterm/xterm').Terminal
type XFitAddon = import('@xterm/addon-fit').FitAddon

const WS_URL = typeof window !== 'undefined'
  ? `ws://${window.location.hostname}:${process.env.NEXT_PUBLIC_TERMINAL_WS_PORT || '3001'}`
  : ''

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

export function TerminalView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerminal | null>(null)
  const fitAddonRef = useRef<XFitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')

  const connect = useCallback(async () => {
    if (!containerRef.current) return

    setStatus('connecting')

    // Dynamically import xterm (client-side only)
    const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-web-links'),
    ])

    // Clean up previous instance
    if (termRef.current) {
      termRef.current.dispose()
    }
    if (wsRef.current) {
      wsRef.current.close()
    }

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#0a0a0a',
        foreground: '#e4e4e7',
        cursor: '#a1a1aa',
        selectionBackground: '#27272a',
        black: '#09090b',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#eab308',
        blue: '#3b82f6',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#e4e4e7',
        brightBlack: '#52525b',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#facc15',
        brightBlue: '#60a5fa',
        brightMagenta: '#c084fc',
        brightCyan: '#22d3ee',
        brightWhite: '#fafafa',
      },
      allowProposedApi: true,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon())

    term.open(containerRef.current)
    fitAddon.fit()

    termRef.current = term
    fitAddonRef.current = fitAddon

    // Connect to WebSocket terminal server
    const ws = new WebSocket(WS_URL)
    wsRef.current = ws

    ws.onopen = () => {
      setStatus('connected')
      // Send initial size
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }

    ws.onmessage = (event) => {
      term.write(typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer))
    }

    ws.onclose = () => {
      setStatus('disconnected')
      term.write('\r\n\x1b[90m[Connection closed]\x1b[0m\r\n')
    }

    ws.onerror = () => {
      setStatus('error')
      term.write('\r\n\x1b[31m[Connection error — is the terminal server running?]\x1b[0m\r\n')
      term.write('\x1b[90mStart it with: npx tsx scripts/terminal-server.ts\x1b[0m\r\n')
    }

    // User input → WebSocket
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data)
      }
    })

    // Resize handling
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }))
      }
    })
  }, [])

  useEffect(() => {
    // Load xterm CSS from public directory
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = '/xterm.css'
    document.head.appendChild(link)

    connect()

    return () => {
      wsRef.current?.close()
      termRef.current?.dispose()
      link.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Handle container resize
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (fitAddonRef.current && termRef.current) {
        try {
          fitAddonRef.current.fit()
        } catch {
          // ignore fit errors during transitions
        }
      }
    })

    if (containerRef.current) {
      observer.observe(containerRef.current)
    }

    return () => observer.disconnect()
  }, [])

  const statusConfig = {
    connecting: { color: 'text-yellow-400', label: 'Connecting…', dot: 'bg-yellow-400 animate-pulse' },
    connected: { color: 'text-emerald-400', label: 'Connected', dot: 'bg-emerald-400' },
    disconnected: { color: 'text-zinc-400', label: 'Disconnected', dot: 'bg-zinc-400' },
    error: { color: 'text-red-400', label: 'Error', dot: 'bg-red-400' },
  }

  const s = statusConfig[status]

  return (
    <div className="flex flex-col h-full w-full bg-[#0a0a0a]">
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-zinc-800 bg-zinc-900/80">
        <div className="flex items-center gap-2">
          <TerminalIcon className="h-3.5 w-3.5 text-zinc-400" />
          <span className="text-xs font-medium text-zinc-300">Terminal</span>
          <span className={`inline-flex items-center gap-1 text-[10px] ${s.color}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
            {s.label}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {(status === 'disconnected' || status === 'error') && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-zinc-400 hover:text-zinc-200"
              onClick={connect}
            >
              <RefreshCw className="h-3 w-3 mr-1" />
              Reconnect
            </Button>
          )}
        </div>
      </div>

      {/* Terminal container */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 p-1"
        style={{ backgroundColor: '#0a0a0a' }}
      />
    </div>
  )
}
