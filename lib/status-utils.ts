import type { RunStatus } from './types'

export function getStatusText(status: RunStatus): string {
  switch (status) {
    case 'running':
      return 'Running'
    case 'completed':
      return 'Finished'
    case 'failed':
      return 'Failed'
    case 'queued':
      return 'Queued'
    case 'canceled':
      return 'Canceled'
    default:
      return status
  }
}

export function getStatusBadgeClass(status: RunStatus): string {
  switch (status) {
    case 'running':
      return 'border-blue-500/50 bg-blue-500/10 text-blue-400'
    case 'failed':
      return 'border-destructive/50 bg-destructive/10 text-destructive'
    case 'completed':
      return 'border-green-500/50 bg-green-500/10 text-green-400'
    case 'canceled':
      return 'border-muted-foreground/30 bg-muted/50 text-muted-foreground'
    case 'queued':
      return 'border-foreground/30 bg-foreground/5 text-foreground'
    default:
      return 'border-muted-foreground/50 bg-muted text-muted-foreground'
  }
}

export function getStatusDotColor(status: RunStatus): string {
  switch (status) {
    case 'running':
      return 'bg-blue-400'
    case 'failed':
      return 'bg-destructive'
    case 'completed':
      return 'bg-green-400'
    case 'canceled':
      return 'bg-muted-foreground'
    case 'queued':
      return 'bg-foreground'
    default:
      return 'bg-muted-foreground'
  }
}
