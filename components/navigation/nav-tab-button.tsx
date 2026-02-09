'use client'

import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface NavTabButtonProps {
  label: string
  icon: LucideIcon
  active?: boolean
  compact?: boolean
  title?: string
  onClick: () => void
}

export function NavTabButton({
  label,
  icon: Icon,
  active = false,
  compact = false,
  title,
  onClick,
}: NavTabButtonProps) {
  return (
    <Button
      type="button"
      title={title || label}
      variant={active ? 'secondary' : 'ghost'}
      size={compact ? 'icon' : 'sm'}
      onClick={onClick}
      className={cn(
        compact
          ? 'h-[var(--app-btn-icon-sm)] w-[var(--app-btn-icon-sm)]'
          : 'h-[var(--app-btn-h-sm)] w-full justify-start px-2.5',
        active && 'border border-border/80 bg-card text-foreground shadow-xs',
        !active && 'text-muted-foreground hover:text-foreground'
      )}
    >
      <Icon className={cn('h-4 w-4 shrink-0', !compact && 'mr-2')} />
      {!compact && label}
      <span className="sr-only">{label}</span>
    </Button>
  )
}
