export type ReferenceTokenType = 'run' | 'sweep' | 'artifact' | 'alert' | 'chart' | 'chat' | 'skill'

export const REFERENCE_TYPE_COLOR_MAP: Record<ReferenceTokenType, string> = {
  run: '#22c55e',
  sweep: '#a855f7',
  artifact: '#0ea5e9',
  alert: '#f97316',
  chart: '#14b8a6',
  chat: '#64748b',
  skill: '#8b5cf6',
}

export const REFERENCE_TYPE_BACKGROUND_MAP: Record<ReferenceTokenType, string> = {
  run: 'rgba(34, 197, 94, 0.18)',
  sweep: 'rgba(168, 85, 247, 0.2)',
  artifact: 'rgba(14, 165, 233, 0.16)',
  alert: 'rgba(249, 115, 22, 0.18)',
  chart: 'rgba(20, 184, 166, 0.16)',
  chat: 'rgba(100, 116, 139, 0.2)',
  skill: 'rgba(139, 92, 246, 0.2)',
}
