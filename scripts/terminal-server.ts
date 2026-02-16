/**
 * Standalone WebSocket terminal server.
 * Spawns a real PTY shell (zsh/bash) and pipes I/O over WebSocket.
 *
 * Usage: npx tsx scripts/terminal-server.ts
 * Env:   TERMINAL_WS_PORT (default 3001)
 */
import { WebSocketServer, WebSocket } from 'ws'
import * as pty from 'node-pty'
import * as os from 'os'

const PORT = parseInt(process.env.TERMINAL_WS_PORT || '3001', 10)

const wss = new WebSocketServer({ port: PORT })

console.log(`[terminal-server] listening on ws://localhost:${PORT}`)

wss.on('connection', (ws: WebSocket) => {
  const shell = os.platform() === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash')

  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 30,
    cwd: process.env.HOME || process.cwd(),
    env: { ...process.env } as Record<string, string>,
  })

  console.log(`[terminal-server] PTY spawned (pid=${ptyProcess.pid}, shell=${shell})`)

  // PTY stdout → WebSocket
  ptyProcess.onData((data: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data)
    }
  })

  ptyProcess.onExit(({ exitCode }) => {
    console.log(`[terminal-server] PTY exited (code=${exitCode})`)
    if (ws.readyState === WebSocket.OPEN) {
      ws.close()
    }
  })

  // WebSocket → PTY stdin (or resize)
  ws.on('message', (msg: Buffer | string) => {
    const text = typeof msg === 'string' ? msg : msg.toString('utf-8')

    // Check for JSON control messages
    if (text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text)
        if (parsed.type === 'resize' && typeof parsed.cols === 'number' && typeof parsed.rows === 'number') {
          ptyProcess.resize(parsed.cols, parsed.rows)
          return
        }
      } catch {
        // Not JSON, treat as regular input
      }
    }

    ptyProcess.write(text)
  })

  ws.on('close', () => {
    console.log(`[terminal-server] WebSocket closed, killing PTY`)
    ptyProcess.kill()
  })

  ws.on('error', (err) => {
    console.error(`[terminal-server] WebSocket error:`, err.message)
    ptyProcess.kill()
  })
})

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[terminal-server] shutting down...')
  wss.close()
  process.exit(0)
})

process.on('SIGTERM', () => {
  wss.close()
  process.exit(0)
})
