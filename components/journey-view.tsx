'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  CalendarClock,
  Check,
  CircleDollarSign,
  Clock3,
  GitBranch,
  ListTree,
  Loader2,
  Minus,
  Plus,
  RotateCcw,
  Target,
  TriangleAlert,
  Upload,
} from 'lucide-react'
import { getJourneyNextActions, getSession, type ChatMessageData, type ChatSession } from '@/lib/api-client'
import type { ExperimentRun, InsightChart } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { DevNotes } from './dev-notes'
import type { JourneySubTab } from './nav-page'

type JourneyNodeType = 'question' | 'hypothesis' | 'experiment' | 'result' | 'decision' | 'artifact'
type JourneyStatus = 'active' | 'completed' | 'failed' | 'blocked' | 'archived'
type JourneyActor = 'human' | 'agent' | 'system'

interface JourneyNode {
  id: string
  type: JourneyNodeType
  title: string
  status: JourneyStatus
  created_at: string
  effort_minutes: number
  cost_usd: number
  confidence: number
  information_gain_score: number
  why_stopped?: string
  parent_ids: string[]
  tags: string[]
}

interface JourneyEdge {
  from: string
  to: string
  relation: 'derived_from' | 'tests' | 'contradicts' | 'supersedes' | 'blocked_by' | 'informs' | 'depends_on'
}

interface JourneyEvent {
  id: string
  ts: string
  node_id: string
  actor: JourneyActor
  kind: string
  note: string
}

interface JourneyReflections {
  wins: string[]
  failures: string[]
  costly_paths: string[]
  next_best_actions: string[]
}

interface JourneyData {
  journey_id: string
  title: string
  started_at: string
  updated_at: string
  nodes: JourneyNode[]
  edges: JourneyEdge[]
  events: JourneyEvent[]
  reflections: JourneyReflections
}

interface JourneyViewProps {
  onBack: () => void
  subTab: JourneySubTab
  sessions: ChatSession[]
  runs: ExperimentRun[]
  charts: InsightChart[]
  currentSessionId: string | null
  currentMessages: ChatMessageData[]
}

function toIso(value: Date | number | undefined | null): string | null {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number') return new Date(value * 1000).toISOString()
  return null
}

function firstAvailableIso(...values: Array<Date | number | undefined | null>): string {
  for (const v of values) {
    const iso = toIso(v)
    if (iso) return iso
  }
  return new Date().toISOString()
}

function statusFromRun(run: ExperimentRun): JourneyStatus {
  if (run.status === 'completed') return 'completed'
  if (run.status === 'failed') return 'failed'
  if (run.status === 'running') return 'active'
  if (run.status === 'queued' || run.status === 'ready') return 'blocked'
  if (run.status === 'canceled') return 'archived'
  return 'active'
}

function computeEffortMinutes(run: ExperimentRun): number {
  const start = run.startedAt || run.startTime || run.createdAt || run.queuedAt
  const end = run.endTime || run.stoppedAt
  if (!start) return 0
  const startMs = start.getTime()
  const endMs = end ? end.getTime() : Date.now()
  return Math.max(0, Math.round((endMs - startMs) / 60000))
}

function computeDepths(nodes: JourneyNode[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const memo = new Map<string, number>()

  const depthOf = (id: string): number => {
    if (memo.has(id)) return memo.get(id) || 0
    const node = byId.get(id)
    if (!node || node.parent_ids.length === 0) {
      memo.set(id, 0)
      return 0
    }
    const depth = 1 + Math.max(...node.parent_ids.map((pid) => depthOf(pid)))
    memo.set(id, depth)
    return depth
  }

  for (const n of nodes) depthOf(n.id)
  return memo
}

function buildJourneyData(
  sessions: ChatSession[],
  runs: ExperimentRun[],
  charts: InsightChart[],
  sessionMessages: Record<string, ChatMessageData[]>,
  currentSessionId: string | null,
): JourneyData {
  const nowIso = new Date().toISOString()
  if (sessions.length === 0 && runs.length === 0 && charts.length === 0) {
    return {
      journey_id: 'journey-empty',
      title: 'User Journey',
      started_at: nowIso,
      updated_at: nowIso,
      nodes: [],
      edges: [],
      events: [],
      reflections: {
        wins: ['No data yet. Start chatting or running experiments to build your journey.'],
        failures: [],
        costly_paths: [],
        next_best_actions: [
          'Start a chat session and run at least one experiment.',
          'Create or pin one chart to capture an insight.',
        ],
      },
    }
  }

  const sortedSessions = [...sessions].sort((a, b) => a.created_at - b.created_at)
  const chatNodeIds = new Set(sortedSessions.map((s) => `chat:${s.id}`))

  const runById = new Map(runs.map((r) => [r.id, r]))

  const chartParentRun = (chart: InsightChart) => {
    const chartTs = chart.createdAt.getTime()
    const candidates = runs
      .filter((run) => {
        const runTs = (run.endTime || run.stoppedAt || run.startedAt || run.startTime || run.createdAt || run.queuedAt)?.getTime()
        return typeof runTs === 'number' && runTs <= chartTs
      })
      .sort((a, b) => {
        const aTs = (a.endTime || a.stoppedAt || a.startedAt || a.startTime || a.createdAt || a.queuedAt)?.getTime() || 0
        const bTs = (b.endTime || b.stoppedAt || b.startedAt || b.startTime || b.createdAt || b.queuedAt)?.getTime() || 0
        return bTs - aTs
      })
    return candidates[0]?.id || null
  }

  const nodes: JourneyNode[] = []
  const edges: JourneyEdge[] = []
  const events: JourneyEvent[] = []

  for (const session of sortedSessions) {
    const id = `chat:${session.id}`
    const messages = sessionMessages[session.id] || []
    const messageCount = messages.length || session.message_count
    const sessionCreatedIso = firstAvailableIso(session.created_at)
    nodes.push({
      id,
      type: 'question',
      title: session.title || `Chat ${session.id.slice(0, 8)}`,
      status: messageCount > 0 ? 'completed' : 'active',
      created_at: sessionCreatedIso,
      effort_minutes: Math.max(2, messageCount * 2),
      cost_usd: 0,
      confidence: Math.min(0.85, 0.35 + messageCount * 0.02),
      information_gain_score: Math.min(1, messageCount / 20),
      parent_ids: [],
      tags: ['chat', 'history'],
    })

    events.push({
      id: `evt:${id}:created`,
      ts: sessionCreatedIso,
      node_id: id,
      actor: 'system',
      kind: 'chat_started',
      note: `Session created with ${messageCount} message${messageCount === 1 ? '' : 's'}.`,
    })

    const cappedMessages = messages.slice(-40)
    cappedMessages.forEach((msg, idx) => {
      events.push({
        id: `evt:${id}:msg:${idx}`,
        ts: firstAvailableIso(msg.timestamp),
        node_id: id,
        actor: msg.role === 'user' ? 'human' : 'agent',
        kind: msg.role === 'user' ? 'user_message' : 'assistant_reply',
        note: (msg.content || '').slice(0, 180) || '(empty message)',
      })
    })
  }

  for (const run of runs) {
    const id = `run:${run.id}`
    const parentIds: string[] = []
    const chatParentId = run.chatSessionId ? `chat:${run.chatSessionId}` : null
    if (chatParentId && chatNodeIds.has(chatParentId)) {
      parentIds.push(chatParentId)
      edges.push({ from: chatParentId, to: id, relation: 'tests' })
    }
    if (run.parentRunId && runById.has(run.parentRunId)) {
      const parentRunNodeId = `run:${run.parentRunId}`
      parentIds.push(parentRunNodeId)
      edges.push({ from: parentRunNodeId, to: id, relation: 'derived_from' })
    }

    const createdIso = firstAvailableIso(run.createdAt, run.queuedAt, run.launchedAt, run.startedAt, run.startTime)
    const endedIso = toIso(run.endTime || run.stoppedAt)
    const effortMinutes = computeEffortMinutes(run)

    nodes.push({
      id,
      type: 'experiment',
      title: run.alias || run.name || run.id,
      status: statusFromRun(run),
      created_at: createdIso,
      effort_minutes: effortMinutes,
      cost_usd: 0,
      confidence: run.status === 'completed' ? 0.75 : run.status === 'failed' ? 0.35 : 0.5,
      information_gain_score: run.status === 'completed' ? 0.8 : run.status === 'failed' ? 0.25 : 0.45,
      why_stopped: run.status === 'failed' ? (run.error || 'Run failed') : undefined,
      parent_ids: parentIds,
      tags: ['run', run.status],
    })

    events.push({
      id: `evt:${id}:created`,
      ts: createdIso,
      node_id: id,
      actor: 'system',
      kind: 'run_created',
      note: run.command || 'Run created',
    })

    if (endedIso) {
      events.push({
        id: `evt:${id}:ended`,
        ts: endedIso,
        node_id: id,
        actor: 'system',
        kind: `run_${run.status}`,
        note: run.error || `${run.status} after ${effortMinutes}m`,
      })
    }
  }

  for (const chart of charts) {
    const id = `chart:${chart.id}`
    const parentIds: string[] = []

    if (chart.source === 'chat' && currentSessionId && chatNodeIds.has(`chat:${currentSessionId}`)) {
      parentIds.push(`chat:${currentSessionId}`)
      edges.push({ from: `chat:${currentSessionId}`, to: id, relation: 'informs' })
    } else {
      const nearestRunId = chartParentRun(chart)
      if (nearestRunId) {
        parentIds.push(`run:${nearestRunId}`)
        edges.push({ from: `run:${nearestRunId}`, to: id, relation: 'informs' })
      }
    }

    nodes.push({
      id,
      type: 'result',
      title: chart.title,
      status: 'completed',
      created_at: chart.createdAt.toISOString(),
      effort_minutes: 5,
      cost_usd: 0,
      confidence: 0.6,
      information_gain_score: 0.55,
      parent_ids: parentIds,
      tags: ['chart', chart.source, chart.type],
    })

    events.push({
      id: `evt:${id}:created`,
      ts: chart.createdAt.toISOString(),
      node_id: id,
      actor: 'system',
      kind: 'chart_created',
      note: chart.description || `${chart.type} chart`,
    })
  }

  const failures = runs
    .filter((r) => r.status === 'failed')
    .sort((a, b) => computeEffortMinutes(b) - computeEffortMinutes(a))

  const completed = runs
    .filter((r) => r.status === 'completed')
    .sort((a, b) => computeEffortMinutes(b) - computeEffortMinutes(a))

  const costly = runs
    .slice()
    .sort((a, b) => computeEffortMinutes(b) - computeEffortMinutes(a))
    .slice(0, 3)

  const allTimestamps = [
    ...sortedSessions.map((s) => firstAvailableIso(s.created_at)),
    ...runs.map((r) => firstAvailableIso(r.createdAt, r.queuedAt, r.launchedAt, r.startedAt, r.startTime)),
    ...charts.map((c) => c.createdAt.toISOString()),
  ].sort()

  return {
    journey_id: `journey-${sortedSessions.length}-${runs.length}-${charts.length}`,
    title: 'User Research Journey (Real Data)',
    started_at: allTimestamps[0] || nowIso,
    updated_at: allTimestamps[allTimestamps.length - 1] || nowIso,
    nodes,
    edges,
    events: events.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()),
    reflections: {
      wins: [
        ...(completed.slice(0, 2).map((run) => `Completed run: ${run.alias || run.name || run.id}`)),
        ...(charts.slice(0, 1).map((chart) => `Chart created: ${chart.title}`)),
      ],
      failures: failures.slice(0, 3).map((run) => `${run.alias || run.name || run.id}: ${run.error || 'failed'}`),
      costly_paths: costly.map((run) => `${run.alias || run.name || run.id}: ${computeEffortMinutes(run)}m`),
      next_best_actions: [
        failures.length > 0
          ? 'Review top failed runs and cluster by failure type before launching new sweeps.'
          : 'No failed runs detected recently; preserve current run strategy and broaden search space.',
        charts.length === 0
          ? 'Create at least one chart per completed run to retain evidence in the journey.'
          : 'Link charts to decision notes so each result explains what changed next.',
        sessions.length > 0
          ? 'Summarize recent chat threads into hypotheses before executing additional experiments.'
          : 'Start a focused chat thread that defines one testable hypothesis.',
      ],
    },
  }
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value)
}

function statusClasses(status: JourneyStatus) {
  if (status === 'completed') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
  if (status === 'failed') return 'border-destructive/30 bg-destructive/10 text-destructive'
  if (status === 'blocked') return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400'
  if (status === 'archived') return 'border-muted-foreground/20 bg-muted text-muted-foreground'
  return 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400'
}

function stageLabel(depth: number): string {
  if (depth === 0) return 'Stage 1: Started'
  if (depth === 1) return 'Stage 2: First attempts'
  return `Stage ${depth + 1}: Next iteration`
}

function relationLabel(relation: JourneyEdge['relation']): string {
  switch (relation) {
    case 'derived_from':
      return 'came from'
    case 'tests':
      return 'tested by'
    case 'contradicts':
      return 'conflicts with'
    case 'supersedes':
      return 'replaced by'
    case 'blocked_by':
      return 'blocked by'
    case 'informs':
      return 'informed'
    case 'depends_on':
      return 'depends on'
    default:
      return relation
  }
}

function relationStroke(relation: JourneyEdge['relation']): string {
  if (relation === 'tests') return '#f59e0b'
  if (relation === 'informs') return '#22c55e'
  if (relation === 'blocked_by') return '#ef4444'
  if (relation === 'contradicts') return '#f97316'
  return '#94a3b8'
}

function nodeTypeAccent(type: JourneyNodeType): { border: string; chip: string } {
  if (type === 'question') return { border: '#60a5fa', chip: '#1d4ed8' }
  if (type === 'experiment') return { border: '#f59e0b', chip: '#b45309' }
  if (type === 'result') return { border: '#22c55e', chip: '#15803d' }
  if (type === 'decision') return { border: '#a78bfa', chip: '#6d28d9' }
  if (type === 'hypothesis') return { border: '#38bdf8', chip: '#0e7490' }
  return { border: '#94a3b8', chip: '#334155' }
}

function nodeTypeLabel(type: JourneyNodeType): string {
  if (type === 'question') return 'Chat'
  if (type === 'experiment') return 'Run'
  if (type === 'result') return 'Chart'
  if (type === 'decision') return 'Decision'
  if (type === 'hypothesis') return 'Idea'
  return 'Step'
}

function statusDot(status: JourneyStatus): string {
  if (status === 'completed') return '#22c55e'
  if (status === 'failed') return '#ef4444'
  if (status === 'blocked') return '#f59e0b'
  if (status === 'archived') return '#64748b'
  return '#60a5fa'
}

function buildGraphLayout(nodes: JourneyNode[], edges: JourneyEdge[], depths: Map<string, number>) {
  const visibleNodes = nodes.slice(0, 36)
  const visibleIds = new Set(visibleNodes.map((n) => n.id))
  const columns = new Map<number, JourneyNode[]>()
  let maxDepth = 0

  visibleNodes.forEach((node) => {
    const depth = depths.get(node.id) || 0
    maxDepth = Math.max(maxDepth, depth)
    if (!columns.has(depth)) columns.set(depth, [])
    columns.get(depth)!.push(node)
  })

  const colCount = Math.max(1, maxDepth + 1)
  const colWidth = 260
  const rowHeight = 84
  const nodeW = 190
  const nodeH = 42
  const paddingX = 22
  const paddingY = 26

  const positions = new Map<string, { x: number; y: number }>()
  let maxRows = 1

  for (let depth = 0; depth < colCount; depth += 1) {
    const col = columns.get(depth) || []
    maxRows = Math.max(maxRows, col.length)
    col.forEach((node, idx) => {
      const x = paddingX + depth * colWidth
      const y = paddingY + idx * rowHeight
      positions.set(node.id, { x, y })
    })
  }

  const width = paddingX * 2 + colCount * colWidth
  const height = paddingY * 2 + maxRows * rowHeight

  const visibleEdges = edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to))

  return { visibleNodes, visibleEdges, positions, width, height, nodeW, nodeH }
}

export function JourneyView({
  onBack,
  subTab,
  sessions,
  runs,
  charts,
  currentSessionId,
  currentMessages,
}: JourneyViewProps) {
  const [sessionMessages, setSessionMessages] = useState<Record<string, ChatMessageData[]>>({})
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [uploadedJourney, setUploadedJourney] = useState<JourneyData | null>(null)
  const [graphZoom, setGraphZoom] = useState(1)
  const [visibleActors, setVisibleActors] = useState<JourneyActor[]>(['human', 'agent', 'system'])
  const [llmNextActions, setLlmNextActions] = useState<string[] | null>(null)
  const [llmReasoning, setLlmReasoning] = useState<string | null>(null)
  const [llmLoading, setLlmLoading] = useState(false)
  const [llmError, setLlmError] = useState<string | null>(null)
  const fetchedSessionIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false

    const loadSessionHistory = async () => {
      setHistoryError(null)
      setHistoryLoading(true)
      const next: Record<string, ChatMessageData[]> = {}
      if (currentSessionId) {
        next[currentSessionId] = currentMessages
      }

      const targets = [...sessions]
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 20)

      const missing = targets.filter((s) => !fetchedSessionIdsRef.current.has(s.id) && s.id !== currentSessionId)

      const results = await Promise.allSettled(
        missing.map(async (session) => {
          const full = await getSession(session.id)
          return { id: session.id, messages: full.messages || [] }
        })
      )

      results.forEach((result) => {
        if (result.status === 'fulfilled') {
          fetchedSessionIdsRef.current.add(result.value.id)
          next[result.value.id] = result.value.messages
        }
      })

      const failedCount = results.filter((r) => r.status === 'rejected').length
      if (!cancelled) {
        setSessionMessages((prev) => ({ ...prev, ...next }))
        setHistoryLoading(false)
        if (failedCount > 0) {
          setHistoryError(`Could not load ${failedCount} session histories; showing partial journey.`)
        }
      }
    }

    void loadSessionHistory()

    return () => {
      cancelled = true
    }
  }, [sessions, currentSessionId, currentMessages])

  const liveJourney = useMemo(
    () => buildJourneyData(sessions, runs, charts, sessionMessages, currentSessionId),
    [sessions, runs, charts, sessionMessages, currentSessionId]
  )

  const data = uploadedJourney || liveJourney
  const nodeById = useMemo(() => new Map(data.nodes.map((n) => [n.id, n])), [data.nodes])
  const depths = useMemo(() => computeDepths(data.nodes), [data.nodes])

  const summary = useMemo(() => {
    const totalEffort = data.nodes.reduce((sum, n) => sum + n.effort_minutes, 0)
    const totalCost = data.nodes.reduce((sum, n) => sum + n.cost_usd, 0)
    const failed = data.nodes.filter((n) => n.status === 'failed').length
    const avgConfidence = data.nodes.reduce((sum, n) => sum + n.confidence, 0) / Math.max(1, data.nodes.length)
    return {
      totalEffort,
      totalCost,
      failed,
      avgConfidence,
      experiments: data.nodes.filter((n) => n.type === 'experiment').length,
    }
  }, [data.nodes])

  const timeline = useMemo(
    () => [...data.events].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()),
    [data.events]
  )
  const filteredTimeline = useMemo(
    () => timeline.filter((event) => visibleActors.includes(event.actor)),
    [timeline, visibleActors]
  )

  const hotspots = useMemo(() => {
    return data.nodes
      .map((n) => {
        const denom = Math.max(1, n.effort_minutes + n.cost_usd * 40)
        const efficiency = n.information_gain_score / denom
        return { node: n, efficiency }
      })
      .sort((a, b) => a.efficiency - b.efficiency)
      .slice(0, 4)
  }, [data.nodes])

  const failedNodes = useMemo(
    () => data.nodes.filter((n) => n.status === 'failed').sort((a, b) => b.cost_usd - a.cost_usd),
    [data.nodes]
  )

  const decisions = useMemo(() => data.nodes.filter((n) => n.type === 'decision'), [data.nodes])

  const maxDepth = useMemo(() => Math.max(...Array.from(depths.values()), 0), [depths])
  const graph = useMemo(() => buildGraphLayout(data.nodes, data.edges, depths), [data.nodes, data.edges, depths])

  const lifecycle = useMemo(() => {
    const searching = data.nodes.filter((n) => n.type === 'question').length
    const experimenting = data.nodes.filter((n) => n.type === 'experiment').length
    const resolving = data.nodes.filter((n) => n.type === 'result' || n.type === 'decision').length
    const latestEvent = timeline[timeline.length - 1]
    const currentPhase =
      resolving > 0 ? 'resolved' :
      experimenting > 0 ? 'curating' :
      searching > 0 ? 'searching' :
      'searching'

    return {
      counts: { searching, experimenting, resolving },
      currentPhase,
      latestEvent,
    }
  }, [data.nodes, timeline])
  const llmContext = useMemo(() => {
    const sortedByTime = [...data.nodes].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    )
    return {
      title: data.title,
      summary: {
        nodes: data.nodes.length,
        events: data.events.length,
        failures: data.nodes.filter((n) => n.status === 'failed').length,
        experiments: data.nodes.filter((n) => n.type === 'experiment').length,
      },
      reflections: data.reflections,
      steps: sortedByTime.slice(-30).map((node) => ({
        id: node.id,
        title: node.title,
        type: node.type,
        status: node.status,
        effort_minutes: node.effort_minutes,
        confidence: node.confidence,
      })),
      events: timeline.slice(-40).map((event) => ({
        time: event.ts,
        actor: event.actor,
        event: event.kind,
        note: event.note,
      })),
    }
  }, [data, timeline])

  const handleLoadJson: React.ChangeEventHandler<HTMLInputElement> = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    const text = await file.text()
    const parsed = JSON.parse(text) as JourneyData
    setUploadedJourney(parsed)
  }

  const handleZoomIn = () => setGraphZoom((z) => Math.min(1.8, Number((z + 0.1).toFixed(2))))
  const handleZoomOut = () => setGraphZoom((z) => Math.max(0.7, Number((z - 0.1).toFixed(2))))
  const handleZoomReset = () => setGraphZoom(1)
  const toggleActor = (actor: JourneyActor) => {
    setVisibleActors((prev) => {
      if (prev.includes(actor)) {
        if (prev.length === 1) return prev
        return prev.filter((value) => value !== actor)
      }
      return [...prev, actor]
    })
  }

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        setLlmLoading(true)
        setLlmError(null)
        const response = await getJourneyNextActions({
          journey: llmContext as Record<string, unknown>,
          max_actions: 3,
        })
        if (cancelled) return
        if (Array.isArray(response.next_best_actions) && response.next_best_actions.length > 0) {
          setLlmNextActions(response.next_best_actions)
          setLlmReasoning(typeof response.reasoning === 'string' ? response.reasoning : null)
        } else {
          setLlmNextActions(null)
          setLlmReasoning(null)
        }
      } catch (error) {
        if (cancelled) return
        setLlmNextActions(null)
        setLlmReasoning(null)
        setLlmError(error instanceof Error ? error.message : 'Failed to generate LLM next actions')
      } finally {
        if (!cancelled) setLlmLoading(false)
      }
    }, 350)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [llmContext])

  if (subTab === 'devnotes') {
    return <DevNotes onBack={onBack} />
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={onBack} className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-foreground">User Journey</h2>
            <p className="truncate text-xs text-muted-foreground">
              Real chats + runs + charts merged into a research timeline
            </p>
          </div>
          {historyLoading && (
            <Badge variant="secondary" className="gap-1 text-[10px]">
              <Loader2 className="h-3 w-3 animate-spin" />
              Syncing history
            </Badge>
          )}
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-secondary">
            <Upload className="h-3.5 w-3.5" />
            Load JSON
            <input type="file" accept="application/json" onChange={handleLoadJson} className="hidden" />
          </label>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-4">
          {historyError && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              {historyError}
            </div>
          )}

          <div className="rounded-xl border border-border bg-gradient-to-br from-teal-500/10 via-amber-500/5 to-transparent p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-foreground">{data.title}</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {data.journey_id} | {new Date(data.started_at).toLocaleString()} to {new Date(data.updated_at).toLocaleString()}
                </p>
              </div>
              <Badge variant="outline" className="text-xs">{data.nodes.length} nodes</Badge>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Experiments</div>
              <div className="mt-1 text-xl font-semibold text-foreground">{summary.experiments}</div>
            </div>
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Total Effort</div>
              <div className="mt-1 text-xl font-semibold text-foreground">{Math.round(summary.totalEffort)}m</div>
            </div>
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Total Cost</div>
              <div className="mt-1 text-xl font-semibold text-foreground">{formatCurrency(summary.totalCost)}</div>
            </div>
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Failure Rate</div>
              <div className="mt-1 text-xl font-semibold text-foreground">{Math.round((summary.failed / Math.max(1, data.nodes.length)) * 100)}%</div>
            </div>
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Avg Confidence</div>
              <div className="mt-1 text-xl font-semibold text-foreground">{Math.round(summary.avgConfidence * 100)}%</div>
            </div>
          </div>

          <section className="rounded-xl border border-amber-500/30 bg-[#0f1115] p-4 text-slate-100 shadow-[0_0_0_1px_rgba(245,158,11,0.12),0_16px_50px_rgba(2,6,23,0.55)]">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div>
                <h4 className="text-sm font-semibold tracking-wide text-amber-300">Journey Dependency Map</h4>
                <p className="mt-1 text-xs text-slate-400">
                  Left to right: Chat {'->'} Run {'->'} Chart/Decision.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-200">
                  live from user data
                </Badge>
                <div className="flex items-center gap-1 rounded-md border border-slate-600/80 bg-slate-900/80 p-1">
                  <Button type="button" size="icon" variant="ghost" onClick={handleZoomOut} className="h-6 w-6 text-slate-200 hover:bg-slate-800">
                    <Minus className="h-3.5 w-3.5" />
                  </Button>
                  <span className="min-w-10 text-center font-mono text-[10px] text-slate-300">{Math.round(graphZoom * 100)}%</span>
                  <Button type="button" size="icon" variant="ghost" onClick={handleZoomIn} className="h-6 w-6 text-slate-200 hover:bg-slate-800">
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                  <Button type="button" size="icon" variant="ghost" onClick={handleZoomReset} className="h-6 w-6 text-slate-200 hover:bg-slate-800">
                    <RotateCcw className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>

            <div className="mb-3 rounded-md border border-slate-700 bg-[#141922] p-2.5 text-[11px] text-slate-300">
              <span className="font-semibold text-amber-300">Read this in 20s:</span> follow arrows from any Chat node.
              If a line reaches a Run, that chat started an experiment. If it reaches a Chart, that run produced a result.
            </div>

            <div className="mb-3 flex flex-wrap items-center gap-2 text-[10px] text-slate-300">
              <span className="inline-flex items-center gap-1 rounded-full border border-slate-600 px-2 py-0.5"><span className="h-2 w-2 rounded-full bg-[#60a5fa]" />Chat</span>
              <span className="inline-flex items-center gap-1 rounded-full border border-slate-600 px-2 py-0.5"><span className="h-2 w-2 rounded-full bg-[#f59e0b]" />Run</span>
              <span className="inline-flex items-center gap-1 rounded-full border border-slate-600 px-2 py-0.5"><span className="h-2 w-2 rounded-full bg-[#22c55e]" />Chart</span>
              <span className="inline-flex items-center gap-1 rounded-full border border-slate-600 px-2 py-0.5"><span className="h-2 w-2 rounded-full bg-[#a78bfa]" />decision</span>
            </div>

            <div className="overflow-auto rounded-lg border border-slate-700/70 bg-[#0b0d10] p-2">
              <svg width={graph.width} height={graph.height} role="img" aria-label="Journey dependency graph">
                <defs>
                  <pattern id="journey-grid" width="24" height="24" patternUnits="userSpaceOnUse">
                    <path d="M 24 0 L 0 0 0 24" fill="none" stroke="#111827" strokeWidth="1" />
                  </pattern>
                  <marker id="journey-arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
                    <path d="M0,0 L8,4 L0,8 Z" fill="#94a3b8" />
                  </marker>
                </defs>

                <g transform={`scale(${graphZoom})`}>
                  <rect x={0} y={0} width={graph.width} height={graph.height} fill="url(#journey-grid)" />

                  {graph.visibleEdges.map((edge, index) => {
                    const from = graph.positions.get(edge.from)
                    const to = graph.positions.get(edge.to)
                    if (!from || !to) return null
                    const sx = from.x + graph.nodeW
                    const sy = from.y + graph.nodeH / 2
                    const tx = to.x
                    const ty = to.y + graph.nodeH / 2
                    const cx1 = sx + 60
                    const cx2 = tx - 60
                    return (
                      <g key={`${edge.from}-${edge.to}-${edge.relation}`}>
                        <path
                          d={`M ${sx} ${sy} C ${cx1} ${sy}, ${cx2} ${ty}, ${tx} ${ty}`}
                          stroke={relationStroke(edge.relation)}
                          strokeWidth={1.6}
                          fill="none"
                          opacity={0.92}
                          markerEnd="url(#journey-arrow)"
                        />
                        {index < 10 && (
                          <circle cx={sx + (tx - sx) * 0.5} cy={sy + (ty - sy) * 0.5} r={1.6} fill={relationStroke(edge.relation)} opacity={0.85} />
                        )}
                      </g>
                    )
                  })}

                  {graph.visibleNodes.map((node) => {
                    const pos = graph.positions.get(node.id)
                    if (!pos) return null
                    const isFresh = Date.now() - new Date(node.created_at).getTime() < 1000 * 60 * 60 * 24
                    const accent = nodeTypeAccent(node.type)
                    const dot = statusDot(node.status)
                    return (
                      <g key={node.id} transform={`translate(${pos.x}, ${pos.y})`}>
                        <rect
                          width={graph.nodeW}
                          height={graph.nodeH}
                          rx={10}
                          fill="#111827"
                          stroke={isFresh ? '#f59e0b' : accent.border}
                          strokeWidth={isFresh ? 2 : 1.4}
                          opacity={0.98}
                        />
                        <rect x={8} y={8} width={56} height={12} rx={6} fill={accent.chip} opacity={0.95} />
                        <circle cx={graph.nodeW - 10} cy={14} r={3.3} fill={dot} />
                        <text x={14} y={17} fontSize={9} fill="#f8fafc" style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}>
                          {nodeTypeLabel(node.type)}
                        </text>
                        <text x={10} y={31} fontSize={11} fill="#e2e8f0" style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
                          {node.title.slice(0, 22)}
                        </text>
                      </g>
                    )
                  })}
                </g>
              </svg>
            </div>
          </section>

          <section className="rounded-xl border border-amber-500/20 bg-[#111318] p-4 text-slate-100">
            <h4 className="mb-2 text-sm font-semibold tracking-wide text-amber-300">Curate Lifecycle</h4>
            <p className="mb-3 text-xs text-slate-400">
              The lifecycle tracks three phases. Each transition has one trigger and updates automatically from user activity.
            </p>

            <div className="mb-3 grid gap-2 md:grid-cols-3">
              <div className="rounded-md border border-slate-700 bg-[#161b23] p-2.5">
                <p className="text-[11px] uppercase tracking-wide text-slate-400">searching</p>
                <p className="mt-1 text-lg font-semibold text-slate-100">{lifecycle.counts.searching}</p>
              </div>
              <div className="rounded-md border border-slate-700 bg-[#161b23] p-2.5">
                <p className="text-[11px] uppercase tracking-wide text-slate-400">curating</p>
                <p className="mt-1 text-lg font-semibold text-slate-100">{lifecycle.counts.experimenting}</p>
              </div>
              <div className="rounded-md border border-slate-700 bg-[#161b23] p-2.5">
                <p className="text-[11px] uppercase tracking-wide text-slate-400">resolved</p>
                <p className="mt-1 text-lg font-semibold text-slate-100">{lifecycle.counts.resolving}</p>
              </div>
            </div>

            <div className="rounded-md border border-slate-700 bg-[#0b0d10] p-3">
              <p className="text-xs text-slate-300">
                Current phase: <span className="font-semibold text-amber-300">{lifecycle.currentPhase}</span>
              </p>
              {lifecycle.latestEvent && (
                <p className="mt-1 text-xs text-slate-400">
                  Latest trigger: {lifecycle.latestEvent.kind} at {new Date(lifecycle.latestEvent.ts).toLocaleString()}
                </p>
              )}
            </div>
          </section>

          <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
            <section className="rounded-xl border border-border bg-card p-4">
              <div className="mb-3 flex items-center gap-2">
                <ListTree className="h-4 w-4 text-teal-500" />
                <h4 className="text-sm font-semibold text-foreground">Journey Stages</h4>
              </div>
              <p className="mb-3 text-xs text-muted-foreground">
                Read top to bottom. Each stage is what you tried after the previous stage.
              </p>
              <div className="space-y-2">
                {Array.from({ length: maxDepth + 1 }).map((_, depth) => {
                  const items = data.nodes
                    .filter((n) => (depths.get(n.id) || 0) === depth)
                    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
                  if (!items.length) return null
                  return (
                    <div key={depth} className="rounded-md border border-border bg-background/60 p-2.5">
                      <p className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">{stageLabel(depth)}</p>
                      <div className="space-y-2">
                        {items.map((node) => (
                          <div key={node.id} className="rounded-md border border-border/70 bg-card p-2.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="outline" className="text-[10px]">{nodeTypeLabel(node.type)}</Badge>
                              <Badge variant="outline" className={`text-[10px] ${statusClasses(node.status)}`}>{node.status}</Badge>
                            </div>
                            <p className="mt-1 text-sm text-foreground">{node.title}</p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              started from: {node.parent_ids.length ? 'an earlier step' : 'this is a starting point'}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="mt-3 rounded-md border border-border bg-background/60 p-2.5">
                <p className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">How steps are connected</p>
                <div className="grid gap-1">
                  {data.edges.slice(0, 12).map((edge) => (
                    <div key={`${edge.from}-${edge.to}-${edge.relation}`} className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{edge.to.slice(0, 18)}</span> {relationLabel(edge.relation)} <span className="font-medium text-foreground">{edge.from.slice(0, 18)}</span>
                    </div>
                  ))}
                  {data.edges.length > 12 && (
                    <div className="text-[11px] text-muted-foreground">+{data.edges.length - 12} more connections</div>
                  )}
                </div>
              </div>
            </section>

            <section className="space-y-4">
              <div className="rounded-xl border border-border bg-card p-4">
                <div className="mb-3 flex items-center gap-2">
                  <CircleDollarSign className="h-4 w-4 text-amber-500" />
                  <h4 className="text-sm font-semibold text-foreground">Cost Hotspots</h4>
                </div>
                <div className="space-y-2">
                  {hotspots.map(({ node, efficiency }) => (
                    <div key={node.id} className="rounded-md border border-border bg-background/60 p-2.5">
                      <p className="text-sm font-medium text-foreground">{node.title}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        efficiency {efficiency.toFixed(4)} | effort {Math.round(node.effort_minutes)}m | cost {formatCurrency(node.cost_usd)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-border bg-card p-4">
                <div className="mb-3 flex items-center gap-2">
                  <TriangleAlert className="h-4 w-4 text-destructive" />
                  <h4 className="text-sm font-semibold text-foreground">Failure Paths</h4>
                </div>
                <div className="space-y-2">
                  {failedNodes.map((node) => (
                    <div key={node.id} className="rounded-md border border-destructive/20 bg-destructive/5 p-2.5">
                      <p className="text-sm font-medium text-foreground">{node.title}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{node.why_stopped || 'No reason logged.'}</p>
                    </div>
                  ))}
                  {failedNodes.length === 0 && (
                    <div className="text-xs text-muted-foreground">No failed nodes found from current data.</div>
                  )}
                </div>
              </div>
            </section>
          </div>

          <section className="rounded-xl border border-border bg-card p-4">
            <div className="mb-3 flex items-center gap-2">
              <CalendarClock className="h-4 w-4 text-blue-500" />
              <h4 className="text-sm font-semibold text-foreground">Timeline (what happened and when)</h4>
            </div>
            <div className="mb-3 text-xs text-muted-foreground">
              Click the <span className="font-medium text-foreground">Actor</span> column title to filter rows.
            </div>
            <div className="overflow-auto rounded-md border border-border">
              <table className="w-full min-w-[760px] border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-border bg-secondary/40">
                    <th className="p-2">Time</th>
                    <th className="p-2">Node</th>
                    <th className="p-2">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded px-1 py-0.5 font-semibold text-foreground hover:bg-secondary"
                          >
                            Actor
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-56">
                          <DropdownMenuItem onSelect={() => setVisibleActors(['human'])}>
                            Show only human
                            {visibleActors.length === 1 && visibleActors[0] === 'human' && <Check className="ml-auto h-3.5 w-3.5" />}
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setVisibleActors(['agent'])}>
                            Show only agent
                            {visibleActors.length === 1 && visibleActors[0] === 'agent' && <Check className="ml-auto h-3.5 w-3.5" />}
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setVisibleActors(['system'])}>
                            Show only system
                            {visibleActors.length === 1 && visibleActors[0] === 'system' && <Check className="ml-auto h-3.5 w-3.5" />}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={() => setVisibleActors(['human', 'agent'])}>
                            Show human + agent
                            {visibleActors.length === 2 && visibleActors.includes('human') && visibleActors.includes('agent') && (
                              <Check className="ml-auto h-3.5 w-3.5" />
                            )}
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setVisibleActors(['human', 'agent', 'system'])}>
                            Show all actors
                            {visibleActors.length === 3 && <Check className="ml-auto h-3.5 w-3.5" />}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </th>
                    <th className="p-2">Event</th>
                    <th className="p-2">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTimeline.map((event) => (
                    <tr key={event.id} className="border-b border-border/70 align-top transition-colors">
                      <td className="p-2 text-muted-foreground">{new Date(event.ts).toLocaleString()}</td>
                      <td className="p-2 text-foreground">{nodeById.get(event.node_id)?.title || event.node_id}</td>
                      <td className="p-2">
                        <Badge variant="outline" className="text-[10px]">
                          {event.actor}
                        </Badge>
                      </td>
                      <td className="p-2 text-foreground">{event.kind}</td>
                      <td className="p-2 text-muted-foreground">{event.note}</td>
                    </tr>
                  ))}
                  {filteredTimeline.length === 0 && (
                    <tr>
                      <td className="p-2 text-muted-foreground" colSpan={5}>
                        No timeline rows match this actor filter.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="grid gap-4 lg:grid-cols-3">
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="mb-2 flex items-center gap-2">
                <GitBranch className="h-4 w-4 text-teal-500" />
                <h4 className="text-sm font-semibold text-foreground">Next Directions</h4>
              </div>
              {llmLoading && (
                <p className="mb-2 text-xs text-muted-foreground">Analyzing journey with LLM...</p>
              )}
              {llmReasoning && (
                <p className="mb-2 text-xs text-muted-foreground">{llmReasoning}</p>
              )}
              {llmError && (
                <p className="mb-2 text-xs text-amber-600 dark:text-amber-400">Using heuristic fallback: {llmError}</p>
              )}
              <ol className="space-y-2 pl-5 text-sm text-muted-foreground">
                {(llmNextActions && llmNextActions.length > 0 ? llmNextActions : data.reflections.next_best_actions).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ol>
            </div>

            <div className="rounded-xl border border-border bg-card p-4">
              <div className="mb-2 flex items-center gap-2">
                <Target className="h-4 w-4 text-emerald-500" />
                <h4 className="text-sm font-semibold text-foreground">What Worked</h4>
              </div>
              <ul className="space-y-2 text-sm text-muted-foreground">
                {data.reflections.wins.map((item) => (
                  <li key={item}>{item}</li>
                ))}
                {data.reflections.wins.length === 0 && <li>No wins captured yet.</li>}
              </ul>
            </div>

            <div className="rounded-xl border border-border bg-card p-4">
              <div className="mb-2 flex items-center gap-2">
                <Clock3 className="h-4 w-4 text-amber-500" />
                <h4 className="text-sm font-semibold text-foreground">Costly Paths</h4>
              </div>
              <ul className="space-y-2 text-sm text-muted-foreground">
                {data.reflections.costly_paths.map((item) => (
                  <li key={item}>{item}</li>
                ))}
                {data.reflections.costly_paths.length === 0 && <li>No costly paths captured yet.</li>}
              </ul>
            </div>
          </section>

          {decisions.length > 0 && (
            <section className="rounded-xl border border-border bg-card p-4">
              <h4 className="mb-2 text-sm font-semibold text-foreground">Decision Ledger</h4>
              <div className="grid gap-2">
                {decisions.map((node) => (
                  <div key={node.id} className="rounded-md border border-border bg-background/60 p-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className={`text-[10px] ${statusClasses(node.status)}`}>{node.status}</Badge>
                      <span className="text-xs text-muted-foreground">confidence {Math.round(node.confidence * 100)}%</span>
                    </div>
                    <p className="mt-1 text-sm text-foreground">{node.title}</p>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
