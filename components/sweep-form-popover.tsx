'use client'

import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { createSweep } from '@/lib/api'

interface SweepFormPopoverProps {
  onClose: () => void
  onRefresh?: () => void
}

export function SweepFormPopover({ onClose, onRefresh }: SweepFormPopoverProps) {
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [params, setParams] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    if (!name.trim() || !command.trim() || !params.trim()) {
      setError('All fields required')
      return
    }

    const paramObj: Record<string, unknown[]> = {}
    try {
      params.split(';').forEach((p) => {
        const [key, vals] = p.split('=')
        if (key && vals) {
          paramObj[key.trim()] = vals.split(',').map((v) => {
            const num = Number(v.trim())
            return Number.isNaN(num) ? v.trim() : num
          })
        }
      })
    } catch {
      setError('Invalid param format')
      return
    }

    if (Object.keys(paramObj).length === 0) {
      setError('At least one parameter required')
      return
    }

    setIsSubmitting(true)
    setError(null)
    try {
      await createSweep({
        name: name.trim(),
        base_command: command.trim(),
        parameters: paramObj,
        max_runs: 10,
        auto_start: false,
      })
      onRefresh?.()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="font-medium text-sm">Create Sweep</div>
      <div className="space-y-2">
        <Input
          placeholder="Sweep name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-8 text-xs"
        />
        <Textarea
          placeholder="python train.py"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          className="h-16 text-xs font-mono"
        />
        <Input
          placeholder="lr=0.001,0.01;batch=32,64"
          value={params}
          onChange={(e) => setParams(e.target.value)}
          className="h-8 text-xs font-mono"
        />
        <p className="text-[10px] text-muted-foreground">
          Format: key=val1,val2;key2=val3,val4
        </p>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={onClose} className="flex-1">
          Cancel
        </Button>
        <Button size="sm" onClick={handleSubmit} disabled={isSubmitting} className="flex-1">
          {isSubmitting ? 'Creating...' : 'Create'}
        </Button>
      </div>
    </div>
  )
}
