'use client'

import { useState, useEffect } from 'react'
import { Monitor, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function TerminalView() {
  const [tmuxWindow, setTmuxWindow] = useState<string>('research-agent')
  const [copied, setCopied] = useState(false)
  const attachCommand = `tmux attach -t ${tmuxWindow}`

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(attachCommand)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (e) {
      console.error('Failed to copy', e)
    }
  }

  return (
    <div className="flex flex-col h-full w-full bg-black/90 p-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-primary/10 rounded-lg">
          <Terminal className="h-6 w-6 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-white">System Terminal</h1>
          <p className="text-sm text-gray-400">
            Direct access to the underlying system shell
          </p>
        </div>
      </div>

      <div className="flex-1 rounded-xl border border-white/10 bg-black/50 p-8 flex flex-col items-center justify-center text-center">
        <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4">
          <Monitor className="h-8 w-8 text-gray-400" />
        </div>
        <h2 className="text-lg font-medium text-white mb-2">
          Terminal Access
        </h2>
        <p className="text-gray-400 max-w-md mb-6">
          The integrated web terminal is currently under development. 
          For now, please use your local terminal to attach to the session.
        </p>

        <div className="bg-gray-900 rounded-lg p-3 flex items-center gap-3 border border-white/10">
          <code className="text-sm font-mono text-green-400">
            {attachCommand}
          </code>
          <Button 
            variant="secondary" 
            size="sm" 
            onClick={copyToClipboard}
            className="h-7 text-xs"
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </div>
    </div>
  )
}
