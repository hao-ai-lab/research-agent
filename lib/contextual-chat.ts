import type { Alert, ChatMessageData } from '@/lib/api-client'
import type { ExperimentRun, Sweep } from '@/lib/types'

export type ContextReferenceKind = 'run' | 'sweep' | 'alert' | 'chart' | 'artifact'

export interface ContextReference {
  key: string
  kind: ContextReferenceKind
  id: string
  label: string
  source: 'mentioned' | 'created'
  lastSeenTimestamp: number
}

const REFERENCE_REGEX = /@(run|sweep|alert|chart|artifact):([A-Za-z0-9._-]+)/g
const CREATED_SWEEP_REGEX = /Created and started\s+\*\*([^*]+)\*\*\s+\(([^)]+)\)/i

function buildLabel(
  kind: ContextReferenceKind,
  id: string,
  runs: ExperimentRun[],
  sweeps: Sweep[],
  alerts: Alert[]
) {
  if (kind === 'run') {
    const run = runs.find((item) => item.id === id)
    return run ? run.alias || run.name : `Run ${id}`
  }

  if (kind === 'sweep') {
    const sweep = sweeps.find((item) => item.id === id)
    return sweep ? sweep.config.name || `Sweep ${id}` : `Sweep ${id}`
  }

  if (kind === 'alert') {
    const alert = alerts.find((item) => item.id === id)
    return alert ? alert.message : `Alert ${id}`
  }

  if (kind === 'artifact') {
    return `Artifact ${id}`
  }

  return `Chart ${id}`
}

export function extractContextReferences(
  messages: ChatMessageData[],
  runs: ExperimentRun[],
  sweeps: Sweep[],
  alerts: Alert[]
): ContextReference[] {
  const references = new Map<string, ContextReference>()

  messages.forEach((message, index) => {
    const messageTimestamp = Number.isFinite(message.timestamp)
      ? message.timestamp
      : Date.now() / 1000 + index

    let refMatch: RegExpExecArray | null
    REFERENCE_REGEX.lastIndex = 0
    while ((refMatch = REFERENCE_REGEX.exec(message.content)) !== null) {
      const kind = refMatch[1] as ContextReferenceKind
      const id = refMatch[2]
      const key = `${kind}:${id}`
      const label = buildLabel(kind, id, runs, sweeps, alerts)

      const previous = references.get(key)
      if (!previous || messageTimestamp >= previous.lastSeenTimestamp) {
        references.set(key, {
          key,
          kind,
          id,
          label,
          source: 'mentioned',
          lastSeenTimestamp: messageTimestamp,
        })
      }
    }

    const createdSweepMatch = message.content.match(CREATED_SWEEP_REGEX)
    if (createdSweepMatch?.[2]) {
      const id = createdSweepMatch[2]
      const label = createdSweepMatch[1] || `Sweep ${id}`
      const key = `sweep:${id}`
      const previous = references.get(key)
      if (!previous || messageTimestamp >= previous.lastSeenTimestamp) {
        references.set(key, {
          key,
          kind: 'sweep',
          id,
          label,
          source: 'created',
          lastSeenTimestamp: messageTimestamp,
        })
      }
    }
  })

  return Array.from(references.values()).sort(
    (a, b) => b.lastSeenTimestamp - a.lastSeenTimestamp
  )
}
