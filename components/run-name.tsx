'use client'

import type { ExperimentRun } from '@/lib/types'
import { cn } from '@/lib/utils'

interface RunNameProps {
  run: ExperimentRun
  className?: string
  truncate?: boolean
}

export function RunName({ run, className, truncate = true }: RunNameProps) {
  if (run.alias) {
    return (
      <span className={cn('inline-flex items-baseline gap-1.5', truncate && 'min-w-0', className)}>
        <span className={cn('font-semibold', truncate && 'truncate')}>
          {run.alias}
        </span>
        <span className={cn('text-muted-foreground/70 font-normal text-[0.85em]', truncate && 'truncate')}>
          {run.name}
        </span>
      </span>
    )
  }

  return (
    <span className={cn(truncate && 'truncate', className)}>
      {run.name}
    </span>
  )
}
