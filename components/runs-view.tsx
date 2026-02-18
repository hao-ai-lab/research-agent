'use client'

import React from "react"

import { useState, useMemo, useRef, useCallback, useEffect } from 'react'
import {
  Play,
  AlertCircle,
  CheckCircle2,
  CheckSquare,
  Square,
  Clock,
  XCircle,
  Layers,
  Archive,
  Undo2,
  Palette,
  Star,
  ArrowLeft,
  ChevronRight,
  ChevronDown,
  AlertTriangle,
  Settings2,
  PlugZap,
  Filter,
  Plus,
  Sparkles,
  Loader2,
  RefreshCw,
  Server,
  Bell,
  Terminal,
  Pencil,
  Check,
  PanelLeftOpen,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { AllRunsChart } from './all-runs-chart'
import { RunDetailView } from './run-detail-view'
import { VisibilityManageView } from './visibility-manage-view'
import { RunName } from './run-name'
import type { ExperimentRun, TagDefinition, VisibilityGroup, Sweep, SweepConfig } from '@/lib/types'
import { createRun, startRun } from '@/lib/api'
import type {
  Alert,
  ClusterState,
  ClusterStatusResponse,
  ClusterType,
  ClusterUpdateRequest,
  CreateRunRequest,
  GpuwrapConfig,
  Run,
} from '@/lib/api'
import { startSweep as apiStartSweep, updateSweep as apiUpdateSweep } from '@/lib/api-client'
import { DEFAULT_RUN_COLORS, getRunsOverview } from '@/lib/mock-data'
import { getStatusText, getStatusBadgeClass as getStatusBadgeClassUtil, getStatusDotColor } from '@/lib/status-utils'
import { Progress } from '@/components/ui/progress'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SweepArtifact } from '@/components/sweep-artifact'
import { SweepStatus } from '@/components/sweep-status'
import { useAppSettings } from '@/lib/app-settings'


type DetailsView = 'time' | 'priority'
type GroupByMode = 'none' | 'sweep'
const STORAGE_KEY_RUNS_VIEW_PREFERENCES = 'runsViewPreferences'
const CHARTS_PAGE_SIZE = 12
const SWEEPS_PAGE_SIZE = 8
const RUNS_PAGE_SIZE = 24

const RUN_STATUS_OPTIONS: ExperimentRun['status'][] = [
  'ready',
  'queued',
  'running',
  'completed',
  'failed',
  'canceled',
]

const CLUSTER_TYPE_OPTIONS: Array<{ value: ClusterType; label: string }> = [
  { value: 'unknown', label: 'Unknown' },
  { value: 'slurm', label: 'Slurm Cluster' },
  { value: 'local_gpu', label: 'Local GPU Cluster' },
  { value: 'kubernetes', label: 'Kubernetes Cluster' },
  { value: 'ray', label: 'Ray Cluster' },
  { value: 'shared_head_node', label: 'Shared GPU Head Node' },
]

// Rich sweep form
import { SweepForm } from '@/components/sweep-form'

interface RunsViewProps {
  runs: ExperimentRun[]
  sweeps?: Sweep[]
  onRunClick?: (run: ExperimentRun) => void
  onUpdateRun?: (run: ExperimentRun) => void
  pendingAlertsByRun?: Record<string, number>
  alerts?: Alert[]
  allTags: TagDefinition[]
  onCreateTag?: (tag: TagDefinition) => void
  onSelectedRunChange?: (run: ExperimentRun | null) => void
  onShowVisibilityManageChange?: (show: boolean) => void
  onRefresh?: () => Promise<void>
  onStartRun?: (runId: string) => Promise<void>
  onStopRun?: (runId: string) => Promise<void>
  onSaveSweep?: (config: SweepConfig) => Promise<void> | void
  onCreateSweep?: (config: SweepConfig) => Promise<void> | void
  onLaunchSweep?: (config: SweepConfig) => Promise<void> | void
  onCreateRun?: (request: CreateRunRequest) => Promise<void> | void
  cluster?: ClusterState | null
  clusterRunSummary?: ClusterStatusResponse['run_summary'] | null
  clusterLoading?: boolean
  clusterError?: string | null
  onDetectCluster?: (preferredType?: ClusterType) => Promise<void>
  onUpdateCluster?: (request: ClusterUpdateRequest) => Promise<void>
  onNavigateToCharts?: () => void
  onRespondToAlert?: (alertId: string, choice: string) => Promise<void>
  showDesktopSidebarToggle?: boolean
  onDesktopSidebarToggle?: () => void
}

export function RunsView({
  runs,
  sweeps = [],
  onRunClick,
  onUpdateRun,
  pendingAlertsByRun = {},
  alerts = [],
  allTags,
  onCreateTag,
  onSelectedRunChange,
  onShowVisibilityManageChange,
  onRefresh,
  onStartRun,
  onStopRun,
  onSaveSweep,
  onCreateSweep,
  onLaunchSweep,
  onCreateRun,
  cluster = null,
  clusterRunSummary = null,
  clusterLoading = false,
  clusterError = null,
  onDetectCluster,
  onUpdateCluster,
  onNavigateToCharts,
  onRespondToAlert,
  showDesktopSidebarToggle = false,
  onDesktopSidebarToggle,
}: RunsViewProps) {
  const { settings } = useAppSettings()
  const interactionMode = settings.appearance.runItemInteractionMode || 'detail-page'
  const useInlineDetails = interactionMode === 'inline-expand'
  const showRunItemMetadata = settings.appearance.showRunItemMetadata !== false

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [selectedSweepId, setSelectedSweepId] = useState<string | null>(null)
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(new Set())
  const [expandedSweepIds, setExpandedSweepIds] = useState<Set<string>>(new Set())
  const [collapsedRunSections, setCollapsedRunSections] = useState<Set<string>>(new Set())
  const [collapsedTopSections, setCollapsedTopSections] = useState<Set<string>>(new Set())
  const [runActionBusy, setRunActionBusy] = useState<Record<string, 'starting' | 'stopping' | undefined>>({})
  const [sweepActionBusy, setSweepActionBusy] = useState<string | null>(null)
  const [clusterDraftType, setClusterDraftType] = useState<ClusterType>(cluster?.type || 'unknown')
  const [clusterActionBusy, setClusterActionBusy] = useState<'detecting' | 'saving' | null>(null)
  const [detailsView, setDetailsView] = useState<DetailsView>('time')
  const [manageMode, setManageMode] = useState(false)
  const [selectedManageRunIds, setSelectedManageRunIds] = useState<Set<string>>(new Set())
  const [groupByMode, setGroupByMode] = useState<GroupByMode>('sweep')
  const [sweepFilter, setSweepFilter] = useState<string>('all')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [statusFilter, setStatusFilter] = useState<Set<ExperimentRun['status']>>(
    () => new Set(RUN_STATUS_OPTIONS)
  )
  const [visibleRunIds, setVisibleRunIds] = useState<Set<string>>(
    new Set(runs.filter((r) => !r.isArchived).map((r) => r.id))
  )
  const [visibilityGroups, setVisibilityGroups] = useState<VisibilityGroup[]>([])
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null)
  const [showVisibilityManage, setShowVisibilityManage] = useState(false)
  const [sweepDialogOpen, setSweepDialogOpen] = useState(false)
  const [runDialogOpen, setRunDialogOpen] = useState(false)
  const [runCreateName, setRunCreateName] = useState('')
  const [runCreateCommand, setRunCreateCommand] = useState('')
  const [runCreateWorkdir, setRunCreateWorkdir] = useState('')
  const [runCreateSweepId, setRunCreateSweepId] = useState<string>('none')
  const [runCreateAutoStart, setRunCreateAutoStart] = useState(true)
  const [runCreateGpuwrapEnabled, setRunCreateGpuwrapEnabled] = useState(true)
  const [runCreateGpuwrapGpusNeeded, setRunCreateGpuwrapGpusNeeded] = useState('1')
  const [runCreateGpuwrapRetries, setRunCreateGpuwrapRetries] = useState('2')
  const [runCreateGpuwrapRetryDelaySeconds, setRunCreateGpuwrapRetryDelaySeconds] = useState('8')
  const [runCreateGpuwrapMaxMemoryUsedMb, setRunCreateGpuwrapMaxMemoryUsedMb] = useState('1500')
  const [runCreateGpuwrapMaxUtilization, setRunCreateGpuwrapMaxUtilization] = useState('40')
  const [runCreateError, setRunCreateError] = useState<string | null>(null)
  const [runCreateSubmitting, setRunCreateSubmitting] = useState(false)
  const [isSelectedRunRefreshing, setIsSelectedRunRefreshing] = useState(false)
  const [isEditingSweepCommand, setIsEditingSweepCommand] = useState(false)
  const [sweepCommandDraft, setSweepCommandDraft] = useState('')
  const [isSavingSweepCommand, setIsSavingSweepCommand] = useState(false)
  const [chartsPage, setChartsPage] = useState(1)
  const [sweepsPage, setSweepsPage] = useState(1)
  const [runsPage, setRunsPage] = useState(1)
  const scrollPositionRef = useRef<number>(0)
  const scrollAreaRef = useRef<HTMLDivElement>(null)

  const allActiveRuns = runs.filter((r) => !r.isArchived)
  const overview = getRunsOverview(allActiveRuns)
  const selectedRun = selectedRunId ? runs.find(r => r.id === selectedRunId) : null
  const selectedSweep = selectedSweepId ? sweeps.find((sweep) => sweep.id === selectedSweepId) : null
  const selectedRunAlerts = selectedRun ? alerts.filter(alert => alert.run_id === selectedRun.id) : []
  const sweepById = useMemo(
    () => new Map(sweeps.map((sweep) => [sweep.id, sweep])),
    [sweeps]
  )
  const sortedSweeps = useMemo(
    () =>
      [...sweeps].sort(
        (a, b) =>
          (b.startedAt?.getTime() || b.createdAt.getTime()) -
          (a.startedAt?.getTime() || a.createdAt.getTime())
      ),
    [sweeps]
  )
  const sweepOptions = useMemo(
    () =>
      Array.from(
        new Set([
          ...runs.map((run) => run.sweepId).filter(Boolean) as string[],
          ...sweeps.map((sweep) => sweep.id),
        ])
      ).sort((a, b) => a.localeCompare(b)),
    [runs, sweeps]
  )

  useEffect(() => {
    if (!selectedSweep) {
      setSweepCommandDraft('')
      setIsEditingSweepCommand(false)
      return
    }

    setSweepCommandDraft(
      selectedSweep.config.command
      || selectedSweep.creationContext.command
      || ''
    )
    setIsEditingSweepCommand(false)
  }, [selectedSweep?.id, selectedSweep?.config.command, selectedSweep?.creationContext.command])

  useEffect(() => {
    if (!useInlineDetails) return
    setSelectedRunId(null)
    setSelectedSweepId(null)
  }, [useInlineDetails])

  const applyHashSelection = useCallback(() => {
    if (typeof window === 'undefined' || useInlineDetails) return

    const rawHash = window.location.hash.startsWith('#')
      ? window.location.hash.slice(1)
      : ''
    if (!rawHash) return

    let target = rawHash
    try {
      target = decodeURIComponent(rawHash)
    } catch {
      target = rawHash
    }
    target = target.trim()
    if (!target) return

    if (target.startsWith('sweep:')) {
      const sweepId = target.slice('sweep:'.length)
      if (sweepId && sweeps.some((sweep) => sweep.id === sweepId)) {
        setSelectedSweepId(sweepId)
        setSelectedRunId(null)
      }
      return
    }

    if (runs.some((run) => run.id === target)) {
      setSelectedRunId(target)
      setSelectedSweepId(null)
    }
  }, [runs, sweeps, useInlineDetails])

  useEffect(() => {
    if (typeof window === 'undefined') return

    applyHashSelection()
    window.addEventListener('hashchange', applyHashSelection)
    return () => window.removeEventListener('hashchange', applyHashSelection)
  }, [applyHashSelection])

  useEffect(() => {
    setClusterDraftType(cluster?.type || 'unknown')
  }, [cluster?.type])

  useEffect(() => {
    const raw = window.localStorage.getItem(STORAGE_KEY_RUNS_VIEW_PREFERENCES)
    if (!raw) return

    try {
      const parsed = JSON.parse(raw) as {
        detailsView?: DetailsView
        groupByMode?: GroupByMode
        sweepFilter?: string
        statusFilter?: ExperimentRun['status'][]
      }

      if (parsed.detailsView === 'time' || parsed.detailsView === 'priority') {
        setDetailsView(parsed.detailsView)
      }
      if (parsed.groupByMode === 'none' || parsed.groupByMode === 'sweep') {
        setGroupByMode(parsed.groupByMode)
      }
      if (typeof parsed.sweepFilter === 'string') {
        setSweepFilter(parsed.sweepFilter)
      }
      if (Array.isArray(parsed.statusFilter)) {
        const validStatuses = parsed.statusFilter.filter((status): status is ExperimentRun['status'] =>
          RUN_STATUS_OPTIONS.includes(status as ExperimentRun['status'])
        )
        if (validStatuses.length > 0) {
          setStatusFilter(new Set(validStatuses))
        }
      }
    } catch (error) {
      console.warn('Failed to parse runs view preferences:', error)
    }
  }, [])

  useEffect(() => {
    if (sweepFilter === 'all' || sweepFilter === 'none') return
    if (sweepOptions.includes(sweepFilter)) return
    setSweepFilter('all')
  }, [sweepFilter, sweepOptions])

  useEffect(() => {
    const preferences = {
      detailsView,
      groupByMode,
      sweepFilter,
      statusFilter: Array.from(statusFilter),
    }
    window.localStorage.setItem(STORAGE_KEY_RUNS_VIEW_PREFERENCES, JSON.stringify(preferences))
  }, [detailsView, groupByMode, sweepFilter, statusFilter])


  const filteredRuns = useMemo(() => {
    return runs.filter((run) => {
      if (!includeArchived && run.isArchived) return false
      if (!statusFilter.has(run.status)) return false
      if (sweepFilter === 'all') return true
      if (sweepFilter === 'none') return !run.sweepId
      return run.sweepId === sweepFilter
    })
  }, [runs, includeArchived, statusFilter, sweepFilter])

  const totalRunsPages = Math.max(1, Math.ceil(filteredRuns.length / RUNS_PAGE_SIZE))
  const pagedFilteredRuns = useMemo(() => {
    const start = (runsPage - 1) * RUNS_PAGE_SIZE
    return filteredRuns.slice(start, start + RUNS_PAGE_SIZE)
  }, [filteredRuns, runsPage])

  const chartRunsWithHistory = useMemo(
    () => allActiveRuns.filter((run) => run.lossHistory && run.lossHistory.length > 0),
    [allActiveRuns]
  )
  const totalChartsPages = Math.max(1, Math.ceil(chartRunsWithHistory.length / CHARTS_PAGE_SIZE))
  const pagedChartRuns = useMemo(() => {
    const start = (chartsPage - 1) * CHARTS_PAGE_SIZE
    return chartRunsWithHistory.slice(start, start + CHARTS_PAGE_SIZE)
  }, [chartRunsWithHistory, chartsPage])

  const totalSweepsPages = Math.max(1, Math.ceil(sortedSweeps.length / SWEEPS_PAGE_SIZE))
  const pagedSweeps = useMemo(() => {
    const start = (sweepsPage - 1) * SWEEPS_PAGE_SIZE
    return sortedSweeps.slice(start, start + SWEEPS_PAGE_SIZE)
  }, [sortedSweeps, sweepsPage])

  useEffect(() => {
    setRunsPage(1)
  }, [detailsView, groupByMode, sweepFilter, includeArchived, statusFilter])

  useEffect(() => {
    setRunsPage((prev) => Math.min(prev, totalRunsPages))
  }, [totalRunsPages])

  useEffect(() => {
    setChartsPage((prev) => Math.min(prev, totalChartsPages))
  }, [totalChartsPages])

  useEffect(() => {
    setSweepsPage((prev) => Math.min(prev, totalSweepsPages))
  }, [totalSweepsPages])

  const selectedManageRuns = useMemo(
    () => filteredRuns.filter((run) => selectedManageRunIds.has(run.id)),
    [filteredRuns, selectedManageRunIds]
  )

  // Sort runs for details view
  const sortedRuns = useMemo(() => {
    if (detailsView === 'time') {
      return [...pagedFilteredRuns].sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
    }
    // Priority view - group by category
    return pagedFilteredRuns
  }, [pagedFilteredRuns, detailsView])

  const groupedRunsBySweep = useMemo(() => {
    const groups = new Map<string, ExperimentRun[]>()
    sortedRuns.forEach((run) => {
      const key = run.sweepId || 'no-sweep'
      if (!groups.has(key)) {
        groups.set(key, [])
      }
      groups.get(key)!.push(run)
    })
    return Array.from(groups.entries())
      .sort(([a], [b]) => {
        if (a === 'no-sweep') return 1
        if (b === 'no-sweep') return -1
        return a.localeCompare(b)
      })
      .map(([sweepId, sweepRuns]) => ({ sweepId, runs: sweepRuns }))
  }, [sortedRuns])

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'running':
        return <Play className="h-3 w-3" />
      case 'failed':
        return <AlertCircle className="h-3 w-3" />
      case 'completed':
        return <CheckCircle2 className="h-3 w-3" />
      case 'canceled':
        return <XCircle className="h-3 w-3" />
      default:
        return <Clock className="h-3 w-3" />
    }
  }

  const getStatusBadgeClass = (status: string) => getStatusBadgeClassUtil(status as any)

  const getSweepStatusBadgeClass = (status: Sweep['status']) => {
    switch (status) {
      case 'draft':
        return 'border-violet-500/35 bg-violet-500/12 text-violet-600 dark:border-violet-400/45 dark:bg-violet-500/20 dark:text-violet-300'
      case 'running':
        return 'border-blue-500/35 bg-blue-500/12 text-blue-600 dark:border-blue-400/45 dark:bg-blue-500/20 dark:text-blue-300'
      case 'completed':
        return 'border-emerald-500/35 bg-emerald-500/12 text-emerald-600 dark:border-emerald-400/45 dark:bg-emerald-500/20 dark:text-emerald-300'
      case 'failed':
        return 'border-destructive/35 bg-destructive/12 text-destructive'
      case 'pending':
        return 'border-amber-500/35 bg-amber-500/12 text-amber-600 dark:border-amber-400/45 dark:bg-amber-500/20 dark:text-amber-300'
      case 'canceled':
        return 'border-muted-foreground/30 bg-muted/40 text-muted-foreground'
      default:
        return 'border-border bg-secondary text-muted-foreground'
    }
  }

  const toggleRunVisibility = (runId: string) => {
    setVisibleRunIds((prev) => {
      const next = new Set(prev)
      if (next.has(runId)) {
        next.delete(runId)
      } else {
        next.add(runId)
      }
      return next
    })
    setActiveGroupId(null)
  }

  const handleSelectGroup = (groupId: string | null) => {
    setActiveGroupId(groupId)
    if (groupId) {
      const group = visibilityGroups.find(g => g.id === groupId)
      if (group) {
        setVisibleRunIds(new Set(group.runIds))
      }
    } else {
      setVisibleRunIds(new Set(allActiveRuns.map(r => r.id)))
    }
  }

  const handleCreateGroup = (group: VisibilityGroup) => {
    setVisibilityGroups(prev => [...prev, group])
  }

  const handleDeleteGroup = (groupId: string) => {
    setVisibilityGroups(prev => prev.filter(g => g.id !== groupId))
    if (activeGroupId === groupId) {
      setActiveGroupId(null)
      setVisibleRunIds(new Set(allActiveRuns.map(r => r.id)))
    }
  }

  const toggleStatusFilter = (status: ExperimentRun['status']) => {
    setStatusFilter((prev) => {
      const next = new Set(prev)
      if (next.has(status)) {
        next.delete(status)
      } else {
        next.add(status)
      }
      return next
    })
  }

  const resetStatusFilter = () => {
    setStatusFilter(new Set(RUN_STATUS_OPTIONS))
  }

  const toggleManageRunSelection = (runId: string) => {
    setSelectedManageRunIds((prev) => {
      const next = new Set(prev)
      if (next.has(runId)) {
        next.delete(runId)
      } else {
        next.add(runId)
      }
      return next
    })
  }

  const clearManageSelection = () => {
    setSelectedManageRunIds(new Set())
  }

  const selectAllFilteredRuns = () => {
    setSelectedManageRunIds(new Set(filteredRuns.map((run) => run.id)))
  }

  const archiveSelectedRuns = () => {
    selectedManageRuns.forEach((run) => {
      if (!run.isArchived) {
        onUpdateRun?.({ ...run, isArchived: true })
      }
    })
    clearManageSelection()
  }

  const unarchiveSelectedRuns = () => {
    selectedManageRuns.forEach((run) => {
      if (run.isArchived) {
        onUpdateRun?.({ ...run, isArchived: false })
      }
    })
    clearManageSelection()
  }

  const setColorForSelectedRuns = (color: string) => {
    selectedManageRuns.forEach((run) => {
      onUpdateRun?.({ ...run, color })
    })
  }

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement
    scrollPositionRef.current = target.scrollTop
  }, [])

  const formatTimestamp = (date?: Date) => {
    if (!date) return '--'
    return new Date(date).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  const formatRunningDuration = (run: ExperimentRun) => {
    const canUseFallbackStart = run.status === 'running' || run.status === 'completed' || run.status === 'failed' || run.status === 'canceled'
    const start = run.startedAt || (canUseFallbackStart ? run.startTime : undefined)
    if (!start) return '--'
    const end = run.endTime || new Date()
    const diffMs = Math.max(0, end.getTime() - start.getTime())
    const hours = Math.floor(diffMs / (1000 * 60 * 60))
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60))
    const seconds = Math.floor((diffMs % (1000 * 60)) / 1000)
    if (hours > 0) return `${hours}h ${minutes}m`
    if (minutes > 0) return `${minutes}m ${seconds}s`
    return `${seconds}s`
  }

  const getTerminalOutcome = (run: ExperimentRun): {
    state: 'finished' | 'failed' | 'canceled' | null
    summary: string
    detail: string | null
    className: string
  } => {
    const exitCode = typeof run.exit_code === 'number' ? run.exit_code : null
    const errorText = run.error?.trim()

    if (run.status === 'failed') {
      return {
        state: 'failed',
        summary: 'Failed',
        detail: errorText || (exitCode !== null ? `Exit code ${exitCode}` : null),
        className: 'text-destructive',
      }
    }

    if (run.status === 'completed') {
      return {
        state: 'finished',
        summary: 'Finished',
        detail: exitCode !== null ? `Exit code ${exitCode}` : null,
        className: 'text-green-600 dark:text-green-400',
      }
    }

    if (run.status === 'canceled') {
      return {
        state: 'canceled',
        summary: 'Stopped',
        detail: errorText || null,
        className: 'text-amber-600 dark:text-amber-400',
      }
    }

    return {
      state: null,
      summary: '',
      detail: null,
      className: 'text-muted-foreground',
    }
  }

  const toggleRunExpansion = (runId: string) => {
    setExpandedRunIds((prev) => {
      const next = new Set(prev)
      if (next.has(runId)) {
        next.delete(runId)
      } else {
        next.add(runId)
      }
      return next
    })
  }

  const toggleSweepExpansion = (sweepId: string) => {
    setExpandedSweepIds((prev) => {
      const next = new Set(prev)
      if (next.has(sweepId)) {
        next.delete(sweepId)
      } else {
        next.add(sweepId)
      }
      return next
    })
  }

  const handleStartRunFromCard = async (run: ExperimentRun, event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (!onStartRun) return
    setRunActionBusy((prev) => ({ ...prev, [run.id]: 'starting' }))
    try {
      await onStartRun(run.id)
      await onRefresh?.()
    } finally {
      setRunActionBusy((prev) => ({ ...prev, [run.id]: undefined }))
    }
  }

  const handleStopRunFromCard = async (run: ExperimentRun, event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (!onStopRun) return
    setRunActionBusy((prev) => ({ ...prev, [run.id]: 'stopping' }))
    try {
      await onStopRun(run.id)
      await onRefresh?.()
    } finally {
      setRunActionBusy((prev) => ({ ...prev, [run.id]: undefined }))
    }
  }

  const handleRetryRun = async (run: ExperimentRun) => {
    if (!onCreateRun) return
    setRunActionBusy((prev) => ({ ...prev, [run.id]: 'starting' }))
    try {
      const request: CreateRunRequest = {
        name: run.name,
        command: run.command,
        sweep_id: run.sweepId,
        auto_start: true,
      }
      await onCreateRun(request)
      await onRefresh?.()
    } catch (e) {
      console.error('Failed to retry run:', e)
    } finally {
      setRunActionBusy((prev) => ({ ...prev, [run.id]: undefined }))
    }
  }

  const handleRunClick = (run: ExperimentRun) => {
    if (useInlineDetails) {
      toggleRunExpansion(run.id)
      return
    }
    setSelectedRunId(run.id)
    setSelectedSweepId(null)
    onSelectedRunChange?.(run)
    onRunClick?.(run)
  }

  const handleSweepClick = (sweep: Sweep) => {
    if (useInlineDetails) {
      toggleSweepExpansion(sweep.id)
      return
    }
    setSelectedSweepId(sweep.id)
    setSelectedRunId(null)
    onSelectedRunChange?.(null)
  }

  const handleBack = () => {
    setSelectedRunId(null)
    setSelectedSweepId(null)
    onSelectedRunChange?.(null)
    // Restore scroll position after state update
    requestAnimationFrame(() => {
      if (scrollAreaRef.current) {
        const viewport = scrollAreaRef.current.querySelector('[data-radix-scroll-area-viewport]')
        if (viewport) {
          viewport.scrollTop = scrollPositionRef.current
        }
      }
    })
  }

  const resetCreateRunForm = useCallback(() => {
    setRunCreateName('')
    setRunCreateCommand('')
    setRunCreateWorkdir('')
    setRunCreateSweepId('none')
    setRunCreateAutoStart(true)
    setRunCreateGpuwrapEnabled(true)
    setRunCreateGpuwrapGpusNeeded('1')
    setRunCreateGpuwrapRetries('2')
    setRunCreateGpuwrapRetryDelaySeconds('8')
    setRunCreateGpuwrapMaxMemoryUsedMb('1500')
    setRunCreateGpuwrapMaxUtilization('40')
    setRunCreateError(null)
    setRunCreateSubmitting(false)
  }, [])

  const handleSubmitCreateRun = useCallback(async () => {
    if (!onCreateRun || runCreateSubmitting) return

    const name = runCreateName.trim()
    const command = runCreateCommand.trim()
    const workdir = runCreateWorkdir.trim()

    if (!name) {
      setRunCreateError('Run name is required.')
      return
    }
    if (!command) {
      setRunCreateError('Command is required.')
      return
    }

    const parseIntField = (raw: string, label: string, min: number, max?: number): number | null => {
      const trimmed = raw.trim()
      if (!trimmed) {
        setRunCreateError(`${label} is required.`)
        return null
      }
      const value = Number.parseInt(trimmed, 10)
      if (!Number.isFinite(value) || Number.isNaN(value)) {
        setRunCreateError(`${label} must be an integer.`)
        return null
      }
      if (value < min || (typeof max === 'number' && value > max)) {
        if (typeof max === 'number') {
          setRunCreateError(`${label} must be between ${min} and ${max}.`)
        } else {
          setRunCreateError(`${label} must be at least ${min}.`)
        }
        return null
      }
      return value
    }

    const parseFloatField = (raw: string, label: string, minExclusive: number): number | null => {
      const trimmed = raw.trim()
      if (!trimmed) {
        setRunCreateError(`${label} is required.`)
        return null
      }
      const value = Number.parseFloat(trimmed)
      if (!Number.isFinite(value) || Number.isNaN(value)) {
        setRunCreateError(`${label} must be a number.`)
        return null
      }
      if (value <= minExclusive) {
        setRunCreateError(`${label} must be greater than ${minExclusive}.`)
        return null
      }
      return value
    }

    const gpuwrapConfig: GpuwrapConfig = {
      enabled: runCreateGpuwrapEnabled,
    }
    if (runCreateGpuwrapEnabled) {
      const gpusNeeded = parseIntField(runCreateGpuwrapGpusNeeded, 'GPUs Needed', 1, 64)
      if (gpusNeeded == null) return
      const retries = parseIntField(runCreateGpuwrapRetries, 'GPU Retries', 0, 20)
      if (retries == null) return
      const retryDelaySeconds = parseFloatField(runCreateGpuwrapRetryDelaySeconds, 'Retry Delay', 0)
      if (retryDelaySeconds == null) return
      const maxMemoryUsedMb = parseIntField(runCreateGpuwrapMaxMemoryUsedMb, 'Max Memory Used', 0)
      if (maxMemoryUsedMb == null) return
      const maxUtilization = parseIntField(runCreateGpuwrapMaxUtilization, 'Max Utilization', 0, 100)
      if (maxUtilization == null) return

      gpuwrapConfig.gpus_needed = gpusNeeded
      gpuwrapConfig.retries = retries
      gpuwrapConfig.retry_delay_seconds = retryDelaySeconds
      gpuwrapConfig.max_memory_used_mb = maxMemoryUsedMb
      gpuwrapConfig.max_utilization = maxUtilization
    }

    const request: CreateRunRequest = {
      name,
      command,
      auto_start: runCreateAutoStart,
      sweep_id: runCreateSweepId !== 'none' ? runCreateSweepId : undefined,
      workdir: workdir || undefined,
      gpuwrap_config: gpuwrapConfig,
    }

    setRunCreateSubmitting(true)
    setRunCreateError(null)
    try {
      await onCreateRun(request)
      setRunDialogOpen(false)
      resetCreateRunForm()
      await onRefresh?.()
    } catch (error) {
      setRunCreateError(error instanceof Error ? error.message : 'Failed to create run.')
    } finally {
      setRunCreateSubmitting(false)
    }
  }, [
    onCreateRun,
    onRefresh,
    resetCreateRunForm,
    runCreateAutoStart,
    runCreateGpuwrapEnabled,
    runCreateGpuwrapGpusNeeded,
    runCreateGpuwrapRetries,
    runCreateGpuwrapRetryDelaySeconds,
    runCreateGpuwrapMaxMemoryUsedMb,
    runCreateGpuwrapMaxUtilization,
    runCreateCommand,
    runCreateName,
    runCreateSubmitting,
    runCreateSweepId,
    runCreateWorkdir,
  ])

  const handleShowVisibilityManage = (show: boolean) => {
    setShowVisibilityManage(show)
    onShowVisibilityManageChange?.(show)
  }

  const toggleRunSection = (sectionKey: string) => {
    setCollapsedRunSections((prev) => {
      const next = new Set(prev)
      if (next.has(sectionKey)) {
        next.delete(sectionKey)
      } else {
        next.add(sectionKey)
      }
      return next
    })
  }

  const isRunSectionExpanded = (sectionKey: string) => !collapsedRunSections.has(sectionKey)

  const toggleTopSection = (sectionKey: string) => {
    setCollapsedTopSections((prev) => {
      const next = new Set(prev)
      if (next.has(sectionKey)) {
        next.delete(sectionKey)
      } else {
        next.add(sectionKey)
      }
      return next
    })
  }

  const isTopSectionExpanded = (sectionKey: string) => !collapsedTopSections.has(sectionKey)

  const getClusterHealthBadgeClass = (status?: ClusterState['status']) => {
    switch (status) {
      case 'healthy':
        return 'border-green-500/40 bg-green-500/10 text-green-600 dark:text-green-400'
      case 'degraded':
        return 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
      case 'offline':
        return 'border-destructive/40 bg-destructive/10 text-destructive'
      default:
        return 'border-border bg-secondary text-muted-foreground'
    }
  }

  const handleDetectClusterSetup = async () => {
    if (!onDetectCluster) return
    setClusterActionBusy('detecting')
    try {
      await onDetectCluster()
    } finally {
      setClusterActionBusy(null)
    }
  }

  const handleSaveClusterType = async () => {
    if (!onUpdateCluster) return
    setClusterActionBusy('saving')
    try {
      await onUpdateCluster({
        type: clusterDraftType,
        source: 'manual',
      })
    } finally {
      setClusterActionBusy(null)
    }
  }

  const renderRunSubsection = (
    sectionKey: string,
    title: string,
    icon: React.ReactNode,
    sectionRuns: ExperimentRun[],
    options?: { dimmed?: boolean }
  ) => {
    if (sectionRuns.length === 0) return null
    const isExpanded = isRunSectionExpanded(sectionKey)

    return (
      <div key={sectionKey}>
        <button
          type="button"
          onClick={() => toggleRunSection(sectionKey)}
          className="mb-2 flex w-full items-center justify-between rounded-md px-1 py-1 text-left hover:bg-secondary/40"
        >
          <div className="flex items-center gap-2">
            {icon}
            <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</h4>
            <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
              {sectionRuns.length}
            </Badge>
          </div>
          {isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </button>

        {isExpanded && (
          <div className={`space-y-2 ${options?.dimmed ? 'opacity-60' : ''}`}>
            {sectionRuns.map((run) => <RunItem key={run.id} run={run} />)}
          </div>
        )}
      </div>
    )
  }

  const RunItem = ({ run, showChevron = true }: { run: ExperimentRun; showChevron?: boolean }) => {
    const pendingAlertCount = pendingAlertsByRun[run.id] || 0
    const hasPendingAlerts = pendingAlertCount > 0
    const runAlerts = alerts.filter((alert) => alert.run_id === run.id)
    const isManageSelectionEnabled = manageMode
    const isSelectedForManage = selectedManageRunIds.has(run.id)
    const isExpanded = expandedRunIds.has(run.id)
    const busyState = runActionBusy[run.id]
    const hasStarted = Boolean(
      run.startedAt
      || run.status === 'running'
      || run.status === 'completed'
      || run.status === 'failed'
      || run.status === 'canceled'
    )
    const terminalOutcome = getTerminalOutcome(run)

    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => {
          if (isManageSelectionEnabled) {
            toggleManageRunSelection(run.id)
            return
          }
          handleRunClick(run)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            if (isManageSelectionEnabled) {
              toggleManageRunSelection(run.id)
              return
            }
            handleRunClick(run)
          }
        }}
        className={`w-full rounded-xl border bg-card p-3 text-left transition-colors active:scale-[0.99] ${isSelectedForManage
          ? 'border-accent bg-accent/10'
          : 'border-border hover:border-muted-foreground/50'
          }`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {isManageSelectionEnabled && (
              <span className="shrink-0 text-muted-foreground">
                {isSelectedForManage ? (
                  <CheckSquare className="h-4 w-4 text-accent" />
                ) : (
                  <Square className="h-4 w-4" />
                )}
              </span>
            )}
            <div
              className="h-3 w-3 rounded-full shrink-0"
              style={{ backgroundColor: run.color || '#4ade80' }}
            />
            {hasPendingAlerts && (
              <div className="relative shrink-0" title={`${pendingAlertCount} pending alert${pendingAlertCount > 1 ? 's' : ''}`}>
                <AlertTriangle className="h-4 w-4 text-warning alert-triangle-shake" />
                {pendingAlertCount > 1 && (
                  <span className="absolute -top-1.5 -right-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-medium leading-none text-destructive-foreground">
                    {pendingAlertCount}
                  </span>
                )}
              </div>
            )}
            <h4 className="font-medium text-sm text-foreground truncate">
              <RunName run={run} />
            </h4>
            {run.isFavorite && <Star className="h-3 w-3 text-yellow-500 fill-yellow-500 shrink-0" />}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!isManageSelectionEnabled && (
              <div className="flex items-center gap-1">
                {(run.status === 'ready' || run.status === 'queued') && onStartRun && (
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-7 w-7"
                    onClick={(event) => { void handleStartRunFromCard(run, event) }}
                    disabled={busyState === 'starting'}
                    title="Start Run"
                  >
                    {busyState === 'starting' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                  </Button>
                )}
                {run.status === 'running' && onStopRun && (
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    onClick={(event) => { void handleStopRunFromCard(run, event) }}
                    disabled={busyState === 'stopping'}
                    title="Stop Run"
                  >
                    {busyState === 'stopping' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
                  </Button>
                )}
                <Button
                  variant={hasPendingAlerts ? 'default' : 'outline'}
                  size="icon"
                  className="relative h-7 w-7"
                  onClick={(event) => {
                    event.stopPropagation()
                    handleRunClick(run)
                  }}
                  title={hasPendingAlerts ? `Alerts (${pendingAlertCount})` : 'Alerts'}
                >
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {hasPendingAlerts && (
                    <span className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-medium leading-none text-destructive-foreground">
                      {pendingAlertCount}
                    </span>
                  )}
                </Button>
                {run.status === 'failed' && (
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    onClick={(event) => {
                      event.stopPropagation()
                      void handleRetryRun(run)
                    }}
                    disabled={busyState === 'starting'}
                    title="Retry Run"
                  >
                    {busyState === 'starting' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  </Button>
                )}
              </div>
            )}
            <Badge variant="outline" className={`${getStatusBadgeClass(run.status)}`}>
              {getStatusIcon(run.status)}
              <span className="ml-1 text-[10px]">{getStatusText(run.status)}</span>
            </Badge>
            {showChevron && !isManageSelectionEnabled && !useInlineDetails && (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
            {showChevron && !isManageSelectionEnabled && useInlineDetails && (
              isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground truncate">
          Run: {run.id}
          {run.sweepId ? ` • Sweep: ${run.sweepId}` : ' • No sweep'}
        </p>
        {showRunItemMetadata && (
          <p className="mt-1 text-[10px] text-muted-foreground">
            Start: {hasStarted ? formatTimestamp(run.startedAt || run.startTime) : '--'} • Created: {formatTimestamp(run.createdAt)} • Runtime: {formatRunningDuration(run)}
          </p>
        )}
        {terminalOutcome.state && (
          <p className={`mt-1 truncate text-[10px] ${terminalOutcome.className}`}>
            {terminalOutcome.summary}
            {run.endTime ? ` • Ended: ${formatTimestamp(run.endTime)}` : ''}
            {terminalOutcome.detail ? ` • ${terminalOutcome.detail}` : ''}
          </p>
        )}
        {run.tags && run.tags.length > 0 && (
          <div className="flex gap-1 mt-2 flex-wrap">
            {run.tags.slice(0, 3).map((tagName) => {
              const tag = allTags.find(t => t.name === tagName)
              return (
                <span
                  key={tagName}
                  className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                  style={{
                    backgroundColor: tag ? `${tag.color}20` : '#4ade8020',
                    color: tag?.color || '#4ade80',
                  }}
                >
                  {tagName}
                </span>
              )
            })}
            {run.tags.length > 3 && (
              <span className="px-1.5 py-0.5 rounded text-[10px] text-muted-foreground">
                +{run.tags.length - 3}
              </span>
            )}
          </div>
        )}

        {useInlineDetails && isExpanded && !isManageSelectionEnabled && (
          <div className="mt-3 border-t border-border/60 pt-3 space-y-2">
            <div className="rounded-lg bg-secondary/35 px-2 py-1.5 text-[11px]">
              <p className="font-medium text-foreground">Command</p>
              <p className="font-mono text-muted-foreground break-all">{run.command}</p>
            </div>
            {run.status === 'running' && (
              <div>
                <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>Progress</span>
                  <span>{run.progress}%</span>
                </div>
                <Progress value={run.progress} className="h-1.5" />
              </div>
            )}
            {run.notes && (
              <div className="rounded-lg bg-secondary/35 px-2 py-1.5 text-[11px] text-muted-foreground">
                {run.notes}
              </div>
            )}
            <div className="rounded-lg bg-secondary/35 px-2 py-1.5 text-[11px]">
              <p className="font-medium text-foreground">Alerts</p>
              {runAlerts.length > 0 ? (
                <div className="mt-1 space-y-1">
                  {runAlerts.slice(0, 2).map((alert) => (
                    <p key={alert.id} className="line-clamp-2 text-muted-foreground">
                      [{alert.severity}] {alert.message}
                    </p>
                  ))}
                  {runAlerts.length > 2 && (
                    <p className="text-muted-foreground">+{runAlerts.length - 2} more alerts</p>
                  )}
                </div>
              ) : (
                <p className="mt-1 text-muted-foreground">No alerts</p>
              )}
            </div>
          </div>
        )}
      </div>
    )
  }

  const SweepItem = ({ sweep }: { sweep: Sweep }) => {
    const isDraft = sweep.status === 'draft'
    const isExpanded = expandedSweepIds.has(sweep.id)
    const canStart = sweep.status === 'draft' || sweep.status === 'pending'
    const canStop = sweep.status === 'running'
    const isBusy = sweepActionBusy === sweep.id
    const sweepRunningRuns = canStop ? runs.filter(r => sweep.runIds.includes(r.id) && r.status === 'running') : []

    const handleStartSweepItem = async (e: React.MouseEvent) => {
      e.stopPropagation()
      setSweepActionBusy(sweep.id)
      try {
        const parallel = Math.max(1, sweep.config.parallelRuns || 1)
        await apiStartSweep(sweep.id, parallel)
        await onRefresh?.()
      } catch (err) {
        console.error('Failed to start sweep:', err)
      } finally {
        setSweepActionBusy(null)
      }
    }

    const handleStopSweepItem = async (e: React.MouseEvent) => {
      e.stopPropagation()
      if (!onStopRun) return
      setSweepActionBusy(sweep.id)
      try {
        await Promise.allSettled(sweepRunningRuns.map(r => onStopRun(r.id)))
        await onRefresh?.()
      } catch (err) {
        console.error('Failed to stop sweep runs:', err)
      } finally {
        setSweepActionBusy(null)
      }
    }

    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => handleSweepClick(sweep)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            handleSweepClick(sweep)
          }
        }}
        className={`rounded-lg border p-2.5 text-left transition-colors ${isDraft
          ? 'border-violet-500/35 bg-violet-500/8 hover:bg-violet-500/12'
          : 'border-border bg-secondary/35 hover:bg-secondary/55'
          }`}
      >
        <div className="flex items-center gap-2">
          <Sparkles className={`h-3.5 w-3.5 shrink-0 ${isDraft ? 'text-violet-500' : 'text-violet-400'}`} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-foreground">
              {sweep.config.name || sweep.id}
            </p>
            <p className="truncate text-[10px] text-muted-foreground">{sweep.id}</p>
          </div>
          {canStart && (
            <Button
              variant="outline"
              size="icon"
              className="h-6 w-6 shrink-0 text-green-600 border-green-500/40 hover:bg-green-500/10 dark:text-green-400"
              onClick={(e) => { void handleStartSweepItem(e) }}
              disabled={isBusy}
            >
              {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            </Button>
          )}
          {canStop && (
            <Button
              variant="outline"
              size="icon"
              className="h-6 w-6 shrink-0 text-destructive border-destructive/40 hover:bg-destructive/10"
              onClick={(e) => { void handleStopSweepItem(e) }}
              disabled={isBusy}
            >
              {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
            </Button>
          )}
          <Badge variant="outline" className={`h-5 text-[9px] capitalize ${getSweepStatusBadgeClass(sweep.status)}`}>
            {sweep.status}
          </Badge>
          {useInlineDetails ? (
            isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
          <span className="truncate">
            {isDraft
              ? 'Draft sweep ready for AI refinement'
              : `${sweep.progress.completed}/${sweep.progress.total} runs`}
          </span>
          {sweep.progress.failed > 0 && (
            <span className="shrink-0 text-destructive">{sweep.progress.failed} failed</span>
          )}
        </div>

        {useInlineDetails && isExpanded && (
          <div
            className="mt-3 border-t border-border/60 pt-3"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {sweep.status === 'draft' ? (
              <SweepArtifact config={sweep.config} sweep={sweep} isCollapsed={false} />
            ) : (
              <SweepStatus
                sweep={sweep}
                runs={runs}
                onRunClick={(run) => handleRunClick(run)}
                isCollapsed={false}
              />
            )}
          </div>
        )}
      </div>
    )
  }

  // Show visibility manage view
  if (showVisibilityManage) {
    return (
      <VisibilityManageView
        runs={runs}
        visibleRunIds={visibleRunIds}
        onToggleVisibility={toggleRunVisibility}
        onSetVisibleRuns={setVisibleRunIds}
        visibilityGroups={visibilityGroups}
        onCreateGroup={handleCreateGroup}
        onDeleteGroup={handleDeleteGroup}
        onUpdateRun={onUpdateRun}
        onBack={() => handleShowVisibilityManage(false)}
      />
    )
  }

  // If a run is selected, show the detail view with slide animation
  if (!useInlineDetails && selectedRun) {
    const selectedRunBusyState = runActionBusy[selectedRun.id]
    const selectedRunPendingAlerts = selectedRunAlerts.filter((alert) => alert.status === 'pending').length

    const handleStartSelectedRun = async () => {
      if (!onStartRun) return
      setRunActionBusy((prev) => ({ ...prev, [selectedRun.id]: 'starting' }))
      try {
        await onStartRun(selectedRun.id)
        await onRefresh?.()
      } finally {
        setRunActionBusy((prev) => ({ ...prev, [selectedRun.id]: undefined }))
      }
    }

    const handleStopSelectedRun = async () => {
      if (!onStopRun) return
      setRunActionBusy((prev) => ({ ...prev, [selectedRun.id]: 'stopping' }))
      try {
        await onStopRun(selectedRun.id)
        await onRefresh?.()
      } finally {
        setRunActionBusy((prev) => ({ ...prev, [selectedRun.id]: undefined }))
      }
    }

    const handleRefreshSelectedRun = async () => {
      if (!onRefresh) return
      setIsSelectedRunRefreshing(true)
      try {
        await onRefresh()
      } finally {
        setIsSelectedRunRefreshing(false)
      }
    }

    const handleScrollToRunAlerts = () => {
      const alertsNode = document.getElementById(`run-alerts-${selectedRun.id}`)
      alertsNode?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }

    return (
      <div className="flex flex-col h-full overflow-hidden animate-in slide-in-from-right-5 duration-200">
        <div className="shrink-0 flex items-center gap-2 px-3 py-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleBack}
            className="h-8 w-8 shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex-1 min-w-0">
            <Select
              value={selectedRun.id}
              onValueChange={(id) => {
                const newRun = runs.find(r => r.id === id)
                if (newRun) handleRunClick(newRun)
              }}
            >
              <SelectTrigger className="h-auto p-0 border-0 bg-transparent hover:bg-secondary/50 rounded-lg px-2 py-1 -ml-2 focus:ring-0 focus:ring-offset-0">
                <div className="flex items-center gap-2 min-w-0">
                  <div
                    className="h-3 w-3 rounded-full shrink-0"
                    style={{ backgroundColor: selectedRun.color || '#4ade80' }}
                  />
                  <div className="text-left min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-foreground truncate"><RunName run={selectedRun} /></span>
                      {selectedRun.isFavorite && <Star className="h-3.5 w-3.5 text-yellow-500 fill-yellow-500 shrink-0" />}
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      {selectedRun.config?.model}
                      {selectedRun.sweepId ? ` • ${selectedRun.sweepId}` : ''}
                    </p>
                  </div>
                </div>
              </SelectTrigger>
              <SelectContent align="start" className="max-h-[300px]">
                {runs.map((r) => (
                  <SelectItem key={r.id} value={r.id} className="py-2">
                    <div className="flex items-center gap-2">
                      <div
                        className="h-2.5 w-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: r.color || '#4ade80' }}
                      />
                      <span className="truncate max-w-[180px]"><RunName run={r} /></span>
                      {r.isFavorite && <Star className="h-3 w-3 text-yellow-500 fill-yellow-500 shrink-0" />}
                      <span className={`ml-auto text-[10px] ${getStatusDotColor(r.status).replace('bg-', 'text-')}`}>
                        {getStatusText(r.status)}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {(selectedRun.status === 'ready' || selectedRun.status === 'queued') && onStartRun && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => { void handleStartSelectedRun() }}
                disabled={selectedRunBusyState === 'starting'}
                className="h-7 w-7 text-green-500 hover:text-green-400"
                title="Start Run"
              >
                {selectedRunBusyState === 'starting'
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <Play className="h-4 w-4" />}
              </Button>
            )}
            {selectedRun.status === 'running' && onStopRun && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => { void handleStopSelectedRun() }}
                disabled={selectedRunBusyState === 'stopping'}
                className="h-7 w-7 text-destructive hover:text-destructive/80"
                title="Stop Run"
              >
                {selectedRunBusyState === 'stopping'
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <Square className="h-4 w-4" />}
              </Button>
            )}
            {selectedRun.status === 'failed' && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => { void handleRetryRun(selectedRun) }}
                disabled={selectedRunBusyState === 'starting'}
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                title="Retry Run"
              >
                {selectedRunBusyState === 'starting'
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <RefreshCw className="h-4 w-4" />}
              </Button>
            )}
            {onRefresh && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => { void handleRefreshSelectedRun() }}
                disabled={isSelectedRunRefreshing}
                className="h-7 w-7 text-muted-foreground"
                title="Refresh"
              >
                <RefreshCw className={`h-4 w-4 ${isSelectedRunRefreshing ? 'animate-spin' : ''}`} />
              </Button>
            )}
            <Button
              variant={selectedRunPendingAlerts > 0 ? 'default' : 'ghost'}
              size="icon"
              onClick={handleScrollToRunAlerts}
              className={`h-7 w-7 ${selectedRunPendingAlerts > 0 ? '' : 'text-muted-foreground'}`}
              title={selectedRunPendingAlerts > 0 ? `Check alerts (${selectedRunPendingAlerts} pending)` : 'Check alerts'}
            >
              <Bell className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onUpdateRun?.({ ...selectedRun, isFavorite: !selectedRun.isFavorite })}
              className={`h-7 w-7 ${selectedRun.isFavorite ? 'text-yellow-500' : 'text-muted-foreground'}`}
            >
              <Star className={`h-4 w-4 ${selectedRun.isFavorite ? 'fill-yellow-500' : ''}`} />
            </Button>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7">
                  <div
                    className="h-4 w-4 rounded-full border border-border"
                    style={{ backgroundColor: selectedRun.color || '#4ade80' }}
                  />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-40 p-2" align="end">
                <div className="grid grid-cols-5 gap-1.5">
                  {DEFAULT_RUN_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => onUpdateRun?.({ ...selectedRun, color })}
                      className={`h-6 w-6 rounded-full border-2 transition-transform hover:scale-110 ${selectedRun.color === color ? 'border-foreground' : 'border-transparent'
                        }`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </PopoverContent>
            </Popover>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onUpdateRun?.({ ...selectedRun, isArchived: !selectedRun.isArchived })}
              className={`h-7 w-7 ${selectedRun.isArchived ? 'text-muted-foreground' : ''}`}
            >
              <Archive className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          <RunDetailView
            run={selectedRun}
            alerts={selectedRunAlerts}
            onSweepSelect={(sweep) => handleSweepClick(sweep)}
            onUpdateRun={onUpdateRun}
            allTags={allTags}
            onCreateTag={onCreateTag}
            sweeps={sweeps}
          />
        </div>
      </div>
    )
  }

  if (!useInlineDetails && selectedSweep) {
    const sweepRuns = runs.filter((run) => selectedSweep.runIds.includes(run.id))
    const sweepAlerts = alerts.filter((alert) => selectedSweep.runIds.includes(alert.run_id))
    const pendingSweepAlerts = sweepAlerts.filter((alert) => alert.status === 'pending')
    const canStartSweep = selectedSweep.status === 'draft' || selectedSweep.status === 'pending'
    const canStopSweep = selectedSweep.status === 'running'
    const canEditSweepCommand = selectedSweep.status !== 'running'
    const runningInSweep = sweepRuns.filter((r) => r.status === 'running')
    const isSweepBusy = sweepActionBusy === selectedSweep.id

    const handleStartSweep = async () => {
      setSweepActionBusy(selectedSweep.id)
      try {
        const parallel = Math.max(1, selectedSweep.config.parallelRuns || 1)
        await apiStartSweep(selectedSweep.id, parallel)
        await onRefresh?.()
      } catch (e) {
        console.error('Failed to start sweep:', e)
      } finally {
        setSweepActionBusy(null)
      }
    }

    const handleStopSweep = async () => {
      if (!onStopRun) return
      setSweepActionBusy(selectedSweep.id)
      try {
        await Promise.allSettled(runningInSweep.map(r => onStopRun(r.id)))
        await onRefresh?.()
      } catch (e) {
        console.error('Failed to stop sweep runs:', e)
      } finally {
        setSweepActionBusy(null)
      }
    }

    const handleSaveSweepCommand = async () => {
      const nextCommand = sweepCommandDraft.trim()
      if (!nextCommand || !canEditSweepCommand) return

      setIsSavingSweepCommand(true)
      try {
        await apiUpdateSweep(selectedSweep.id, {
          base_command: nextCommand,
          ui_config: {
            ...selectedSweep.config,
            command: nextCommand,
            updatedAt: new Date().toISOString(),
          },
        })
        setIsEditingSweepCommand(false)
        await onRefresh?.()
      } catch (e) {
        console.error('Failed to update sweep command:', e)
      } finally {
        setIsSavingSweepCommand(false)
      }
    }

    return (
      <div className="flex flex-col h-full overflow-hidden animate-in slide-in-from-right-5 duration-200">
        <div className="shrink-0 flex items-center gap-2 px-3 py-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleBack}
            className="h-8 w-8 shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-foreground">{selectedSweep.config.name || selectedSweep.id}</p>
            <p className="truncate text-xs text-muted-foreground">
              {selectedSweep.id}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {canStartSweep && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-green-600 border-green-500/40 hover:bg-green-500/10 dark:text-green-400"
                onClick={() => { void handleStartSweep() }}
                disabled={isSweepBusy}
              >
                {isSweepBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                <span className="text-xs">Start</span>
              </Button>
            )}
            {canStopSweep && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-destructive border-destructive/40 hover:bg-destructive/10"
                onClick={() => { void handleStopSweep() }}
                disabled={isSweepBusy}
              >
                {isSweepBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
                <span className="text-xs">Stop</span>
              </Button>
            )}
            <Badge variant="outline" className={`capitalize ${getSweepStatusBadgeClass(selectedSweep.status)}`}>
              {selectedSweep.status}
            </Badge>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="p-4 space-y-3">
              <div className="rounded-xl border border-border bg-card p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <Terminal className="h-4 w-4 text-muted-foreground" />
                    <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Sweep Command
                    </h4>
                  </div>
                  {!isEditingSweepCommand ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5 text-xs"
                      onClick={() => setIsEditingSweepCommand(true)}
                      disabled={!canEditSweepCommand}
                    >
                      <Pencil className="h-3 w-3" />
                      Edit
                    </Button>
                  ) : null}
                </div>

                {isEditingSweepCommand ? (
                  <div className="space-y-2">
                    <Textarea
                      value={sweepCommandDraft}
                      onChange={(e) => setSweepCommandDraft(e.target.value)}
                      className="min-h-[92px] resize-y font-mono text-xs"
                      placeholder="python train.py ..."
                    />
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => {
                          setSweepCommandDraft(selectedSweep.config.command || selectedSweep.creationContext.command || '')
                          setIsEditingSweepCommand(false)
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        className="h-7 gap-1.5 text-xs"
                        onClick={() => { void handleSaveSweepCommand() }}
                        disabled={!sweepCommandDraft.trim() || isSavingSweepCommand}
                      >
                        {isSavingSweepCommand ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                        Save
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="rounded-md bg-secondary/30 px-2 py-1.5 font-mono text-xs text-foreground break-all whitespace-pre-wrap">
                      {selectedSweep.config.command || selectedSweep.creationContext.command || 'No command provided'}
                    </p>
                    {!canEditSweepCommand && (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Stop the sweep before editing its command.
                      </p>
                    )}
                  </>
                )}
              </div>

              {/* Aggregated Alerts */}
              {sweepAlerts.length > 0 && (
                <div className="rounded-xl border border-border bg-card p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Bell className="h-4 w-4 text-muted-foreground" />
                    <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Sweep Alerts</h4>
                    {pendingSweepAlerts.length > 0 && (
                      <Badge variant="outline" className="border-destructive/50 bg-destructive/10 text-destructive text-[9px] px-1.5 py-0 h-4">
                        {pendingSweepAlerts.length} pending
                      </Badge>
                    )}
                  </div>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {sweepAlerts.slice(0, 10).map((alert) => {
                      const alertRun = runs.find(r => r.id === alert.run_id)
                      return (
                        <div
                          key={alert.id}
                          className={`rounded-lg px-2.5 py-2 text-[11px] ${alert.status === 'pending'
                            ? 'bg-secondary/50 border border-border'
                            : 'bg-secondary/25 opacity-60'
                            }`}
                        >
                          <div className="flex items-start gap-2">
                            {alert.severity === 'critical' ? (
                              <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
                            ) : alert.severity === 'warning' ? (
                              <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
                            ) : (
                              <Bell className="h-3.5 w-3.5 text-blue-400 shrink-0 mt-0.5" />
                            )}
                            <div className="min-w-0 flex-1">
                              <p className="text-foreground line-clamp-2">{alert.message}</p>
                              <p className="text-[10px] text-muted-foreground mt-0.5">
                                {alertRun?.alias || alertRun?.name || alert.run_id}
                                {alert.status === 'resolved' && alert.response && ` • Response: ${alert.response}`}
                              </p>
                              {alert.status === 'pending' && alert.choices.length > 0 && onRespondToAlert && (
                                <div className="flex gap-1 mt-1.5 flex-wrap">
                                  {alert.choices.map((choice) => (
                                    <Button
                                      key={choice}
                                      variant="outline"
                                      size="sm"
                                      className="h-5 px-2 text-[10px]"
                                      onClick={() => { void onRespondToAlert(alert.id, choice) }}
                                    >
                                      {choice}
                                    </Button>
                                  ))}
                                </div>
                              )}
                            </div>
                            <Badge
                              variant="outline"
                              className={`shrink-0 text-[8px] h-4 px-1 ${alert.severity === 'critical' ? 'border-destructive/50 text-destructive' :
                                alert.severity === 'warning' ? 'border-amber-500/50 text-amber-500' :
                                  'border-blue-400/50 text-blue-400'
                                }`}
                            >
                              {alert.severity}
                            </Badge>
                          </div>
                        </div>
                      )
                    })}
                    {sweepAlerts.length > 10 && (
                      <p className="text-center text-[10px] text-muted-foreground py-1">
                        +{sweepAlerts.length - 10} more alerts
                      </p>
                    )}
                  </div>
                </div>
              )}

              {selectedSweep.status === 'draft' ? (
                <SweepArtifact config={selectedSweep.config} sweep={selectedSweep} isCollapsed={false} />
              ) : (
                <SweepStatus
                  sweep={selectedSweep}
                  runs={runs}
                  onRunClick={(run) => handleRunClick(run)}
                  isCollapsed={false}
                />
              )}

              <div className="rounded-xl border border-border bg-card p-3">
                <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">Runs In Sweep</h4>
                <div className="space-y-2">
                  {sweepRuns.length > 0 ? (
                    sweepRuns.map((run) => (
                      <RunItem key={run.id} run={run} showChevron />
                    ))
                  ) : (
                    <div className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">
                      No runs are attached to this sweep yet.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </ScrollArea>
        </div>
      </div>
    )
  }

  const favoriteRuns = pagedFilteredRuns.filter(r => r.isFavorite)
  const alertRuns = pagedFilteredRuns.filter(r => (pendingAlertsByRun[r.id] || 0) > 0 && !r.isFavorite)
  const runningRuns = pagedFilteredRuns.filter(r => r.status === 'running' && !r.isFavorite && (pendingAlertsByRun[r.id] || 0) === 0)
  const readyRuns = pagedFilteredRuns.filter(r => r.status === 'ready' && !r.isFavorite && (pendingAlertsByRun[r.id] || 0) === 0)
  const queuedRuns = pagedFilteredRuns.filter(r => r.status === 'queued' && !r.isFavorite && (pendingAlertsByRun[r.id] || 0) === 0)
  const failedRuns = pagedFilteredRuns.filter(r => r.status === 'failed' && !r.isFavorite && (pendingAlertsByRun[r.id] || 0) === 0)
  const completedRuns = pagedFilteredRuns.filter(r => r.status === 'completed' && !r.isFavorite)
  const canceledRuns = pagedFilteredRuns.filter(r => r.status === 'canceled' && !r.isFavorite)
  const isAllStatusSelected = statusFilter.size === RUN_STATUS_OPTIONS.length
  const canArchiveSelection = selectedManageRuns.some((run) => !run.isArchived)
  const canUnarchiveSelection = selectedManageRuns.some((run) => run.isArchived)
  const effectiveClusterRunSummary = clusterRunSummary || {
    total: overview.total,
    running: overview.running,
    launching: 0,
    queued: overview.queued,
    ready: runs.filter((run) => run.status === 'ready' && !run.isArchived).length,
    failed: overview.failed,
    finished: overview.completed,
  }

  // Overview view (default)
  return (
    <>
      <div className="flex flex-col h-full overflow-hidden">
        {/* Top Nav Bar */}
        <div className="flex items-center justify-between border-b border-border bg-card/80 px-4 py-3 backdrop-blur-sm shrink-0">
          <div className="flex items-center gap-2">
            {showDesktopSidebarToggle && onDesktopSidebarToggle && (
              <Button
                variant="outline"
                size="icon-sm"
                onClick={onDesktopSidebarToggle}
                className="hidden h-9 w-9 shrink-0 border-border/70 bg-card text-muted-foreground hover:bg-secondary lg:inline-flex"
                title="Show sidebar"
              >
                <PanelLeftOpen className="h-4 w-4" />
                <span className="sr-only">Show sidebar</span>
              </Button>
            )}
            <div>
              <h2 className="text-lg font-semibold text-foreground">Runs</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {overview.total} run{overview.total !== 1 ? 's' : ''} total
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[11px] gap-1"
                  onClick={() => {
                    setRunDialogOpen(true)
                    setRunCreateError(null)
                  }}
                >
                  <Play className="h-3 w-3" />
                  Create Run
                </Button>
              </TooltipTrigger>
              <TooltipContent>Create a new run</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[11px] gap-1"
                  onClick={() => setSweepDialogOpen(true)}
                >
                  <Plus className="h-3 w-3" />
                  Create Sweep
                </Button>
              </TooltipTrigger>
              <TooltipContent>Create a new sweep</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-hidden">
          <ScrollArea className="h-full" ref={scrollAreaRef} onScrollCapture={handleScroll}>
            <div className="p-3 space-y-4">
              <div className="grid gap-3 lg:grid-cols-2">
                {/* Overview Stats */}
                <div className="rounded-xl border border-border bg-card">
                  <button
                    type="button"
                    onClick={() => toggleTopSection('overview')}
                    className="flex w-full items-center justify-between gap-3 p-4 text-left"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary">
                        <Layers className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <div>
                        <h3 className="text-sm font-medium text-foreground">
                          Experiments Overview
                        </h3>
                        <p className="text-xs text-muted-foreground">
                          {overview.total} total runs
                        </p>
                      </div>
                    </div>
                    {isTopSectionExpanded('overview') ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
                  </button>
                  {isTopSectionExpanded('overview') && (
                    <div className="px-4 pb-4">
                      <div className="grid grid-cols-5 gap-2">
                        <div className="text-center p-2 rounded-lg bg-blue-500/10 border border-blue-500/30">
                          <p className="text-lg font-semibold text-blue-400">
                            {overview.running}
                          </p>
                          <p className="text-[10px] text-muted-foreground">Running</p>
                        </div>
                        <div className="text-center p-2 rounded-lg bg-green-500/10 border border-green-500/30">
                          <p className="text-lg font-semibold text-green-400">
                            {overview.completed}
                          </p>
                          <p className="text-[10px] text-muted-foreground">Finished</p>
                        </div>
                        <div className="text-center p-2 rounded-lg bg-destructive/10 border border-destructive/30">
                          <p className="text-lg font-semibold text-destructive">
                            {overview.failed}
                          </p>
                          <p className="text-[10px] text-muted-foreground">Failed</p>
                        </div>
                        <div className="text-center p-2 rounded-lg bg-foreground/5 border border-foreground/20">
                          <p className="text-lg font-semibold text-foreground">
                            {overview.queued}
                          </p>
                          <p className="text-[10px] text-muted-foreground">Queued</p>
                        </div>
                        <div className="text-center p-2 rounded-lg bg-muted/50 border border-muted-foreground/20">
                          <p className="text-lg font-semibold text-muted-foreground">
                            {overview.canceled}
                          </p>
                          <p className="text-[10px] text-muted-foreground">Canceled</p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Cluster Section */}
                <div className="rounded-xl border border-border bg-card">
                  <button
                    type="button"
                    onClick={() => toggleTopSection('cluster')}
                    className="flex w-full items-start justify-between gap-3 p-4 text-left"
                  >
                    <div className="flex min-w-0 items-start gap-2">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-secondary">
                        <Server className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-sm font-medium text-foreground">Cluster Status</h3>
                        <p className="line-clamp-2 text-xs text-muted-foreground">
                          {cluster?.description || 'Detect your cluster and keep run scheduling context-aware.'}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge variant="outline" className={`text-[10px] ${getClusterHealthBadgeClass(cluster?.status)}`}>
                        {cluster?.status || 'unknown'}
                      </Badge>
                      <Badge variant="secondary" className="text-[10px]">
                        {cluster?.label || 'Unknown'}
                      </Badge>
                      {isTopSectionExpanded('cluster') ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                  </button>

                  {isTopSectionExpanded('cluster') && (
                    <div className="space-y-3 px-4 pb-4">
                      <div className="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-5">
                        <div className="rounded-md border border-border/70 bg-secondary/30 px-2 py-1.5">
                          <p className="text-muted-foreground">Source</p>
                          <p className="font-medium text-foreground capitalize">{cluster?.source || 'unset'}</p>
                        </div>
                        <div className="rounded-md border border-border/70 bg-secondary/30 px-2 py-1.5">
                          <p className="text-muted-foreground">Nodes</p>
                          <p className="font-medium text-foreground">{cluster?.node_count ?? '--'}</p>
                        </div>
                        <div className="rounded-md border border-border/70 bg-secondary/30 px-2 py-1.5">
                          <p className="text-muted-foreground">GPUs</p>
                          <p className="font-medium text-foreground">{cluster?.gpu_count ?? '--'}</p>
                        </div>
                        <div className="rounded-md border border-border/70 bg-secondary/30 px-2 py-1.5">
                          <p className="text-muted-foreground">Head Node</p>
                          <p className="truncate font-medium text-foreground">{cluster?.head_node || '--'}</p>
                        </div>
                        <div className="rounded-md border border-border/70 bg-secondary/30 px-2 py-1.5">
                          <p className="text-muted-foreground">Active Runs</p>
                          <p className="font-medium text-foreground">
                            {(effectiveClusterRunSummary.running || 0) + (effectiveClusterRunSummary.launching || 0)} running
                          </p>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Select value={clusterDraftType} onValueChange={(value) => setClusterDraftType(value as ClusterType)}>
                          <SelectTrigger className="h-8 w-[220px] text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {CLUSTER_TYPE_OPTIONS.map((option) => (
                              <SelectItem key={option.value} value={option.value} className="text-xs">
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        <Button
                          size="sm"
                          className="h-8 px-3 text-xs"
                          onClick={() => { void handleSaveClusterType() }}
                          disabled={!onUpdateCluster || clusterActionBusy !== null || clusterDraftType === (cluster?.type || 'unknown')}
                        >
                          {clusterActionBusy === 'saving' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                          Set Cluster Type
                        </Button>

                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 px-3 text-xs"
                          onClick={() => { void handleDetectClusterSetup() }}
                          disabled={!onDetectCluster || clusterActionBusy !== null}
                        >
                          {clusterActionBusy === 'detecting' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
                          Auto-detect
                        </Button>
                      </div>

                      {clusterError && (
                        <p className="text-xs text-destructive">{clusterError}</p>
                      )}
                      {clusterLoading && (
                        <p className="text-xs text-muted-foreground">Refreshing cluster status...</p>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Charts Section */}
              <div>
                <button
                  type="button"
                  onClick={() => toggleTopSection('charts')}
                  className="mb-2 flex w-full items-center justify-between rounded-md px-1 py-1 text-left hover:bg-secondary/40"
                >
                  <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Charts</h3>
                  {isTopSectionExpanded('charts') ? (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  )}
                </button>
                {isTopSectionExpanded('charts') && (
                  <div className="rounded-xl border border-border bg-card p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-[11px]"
                          onClick={() => setChartsPage((p) => Math.max(1, p - 1))}
                          disabled={chartsPage === 1}
                        >
                          Prev
                        </Button>
                        <span className="text-[11px] text-muted-foreground">
                          Page {chartsPage} / {totalChartsPages}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-[11px]"
                          onClick={() => setChartsPage((p) => Math.min(totalChartsPages, p + 1))}
                          disabled={chartsPage >= totalChartsPages}
                        >
                          Next
                        </Button>
                      </div>
                      <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => onNavigateToCharts?.()}>
                        &gt;
                      </Button>
                    </div>
                    <AllRunsChart
                      runs={pagedChartRuns}
                      visibleRunIds={visibleRunIds}
                      onToggleVisibility={toggleRunVisibility}
                      visibilityGroups={visibilityGroups}
                      activeGroupId={activeGroupId}
                      onSelectGroup={handleSelectGroup}
                      onOpenManage={() => handleShowVisibilityManage(true)}
                    />
                  </div>
                )}
              </div>

              {/* Sweeps Section */}
              <div>
                <button
                  type="button"
                  onClick={() => toggleTopSection('sweeps')}
                  className="mb-2 flex w-full items-center justify-between rounded-md px-1 py-1 text-left hover:bg-secondary/40"
                >
                  <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Sweeps</h3>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="text-[10px]">{sortedSweeps.length}</Badge>
                    {isTopSectionExpanded('sweeps') ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>
                </button>
                {isTopSectionExpanded('sweeps') && (
                  <div className="rounded-xl border border-border bg-card p-3">
                    <div className="mb-2 flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => setSweepsPage((p) => Math.max(1, p - 1))}
                        disabled={sweepsPage === 1}
                      >
                        Prev
                      </Button>
                      <span className="text-[11px] text-muted-foreground">
                        Page {sweepsPage} / {totalSweepsPages}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => setSweepsPage((p) => Math.min(totalSweepsPages, p + 1))}
                        disabled={sweepsPage >= totalSweepsPages}
                      >
                        Next
                      </Button>
                    </div>
                    {sortedSweeps.length > 0 ? (
                      <div className="space-y-2">
                        {pagedSweeps.map((sweep) => (
                          <SweepItem key={sweep.id} sweep={sweep} />
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">
                        No sweep objects yet. Save a draft to create one.
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Runs Section */}
              <div>
                <button
                  type="button"
                  onClick={() => toggleTopSection('runs')}
                  className="mb-2 flex w-full items-center justify-between rounded-md px-1 py-1 text-left hover:bg-secondary/40"
                >
                  <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Runs</h3>
                  {isTopSectionExpanded('runs') ? (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  )}
                </button>
                {isTopSectionExpanded('runs') && (
                  <div className="rounded-xl border border-border bg-card">
                    <div className="border-b border-border px-4 py-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <div className="hidden min-w-0 flex-1 sm:block">
                          <p className="truncate text-[11px] text-muted-foreground">
                            Time: {detailsView === 'time' ? 'Time' : 'Priority'} · Group: {groupByMode === 'sweep' ? 'Sweep' : 'None'} · Sweep: {sweepFilter === 'all' ? 'All' : sweepFilter === 'none' ? 'No Sweep' : sweepFilter} · Status: {isAllStatusSelected ? 'All' : `${statusFilter.size} selected`} · Archived: {includeArchived ? 'Show' : 'Hide'}
                          </p>
                        </div>

                        <div className="ml-auto flex shrink-0 items-center gap-2">
                          <Popover>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <PopoverTrigger asChild>
                                  <Button variant="outline" size="icon" className="h-8 w-8" aria-label="Open Filters">
                                    <Filter className="h-4 w-4" />
                                  </Button>
                                </PopoverTrigger>
                              </TooltipTrigger>
                              <TooltipContent>Filters</TooltipContent>
                            </Tooltip>
                            <PopoverContent align="end" className="w-[min(92vw,360px)] p-3">
                              <div className="space-y-3">
                                <div className="grid gap-1.5">
                                  <p className="text-[11px] font-medium text-muted-foreground">Time</p>
                                  <Select value={detailsView} onValueChange={(v) => setDetailsView(v as DetailsView)}>
                                    <SelectTrigger className="h-8 w-full text-xs">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="time">Time</SelectItem>
                                      <SelectItem value="priority">Priority</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>

                                <div className="grid gap-1.5">
                                  <p className="text-[11px] font-medium text-muted-foreground">Group By</p>
                                  <Select value={groupByMode} onValueChange={(v) => setGroupByMode(v as GroupByMode)}>
                                    <SelectTrigger className="h-8 w-full text-xs">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="none">None</SelectItem>
                                      <SelectItem value="sweep">Sweep</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>

                                <div className="grid gap-1.5">
                                  <p className="text-[11px] font-medium text-muted-foreground">Sweep</p>
                                  <Select value={sweepFilter} onValueChange={setSweepFilter}>
                                    <SelectTrigger className="h-8 w-full text-xs">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="all">All</SelectItem>
                                      <SelectItem value="none">No Sweep</SelectItem>
                                      {sweepOptions.map((sweepId) => (
                                        <SelectItem key={sweepId} value={sweepId}>
                                          {sweepId}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>

                                <div className="grid gap-1.5">
                                  <p className="text-[11px] font-medium text-muted-foreground">Archived</p>
                                  <Button
                                    type="button"
                                    variant={includeArchived ? 'default' : 'outline'}
                                    size="sm"
                                    className="h-8 justify-start text-xs"
                                    onClick={() => setIncludeArchived((prev) => !prev)}
                                  >
                                    {includeArchived ? 'Showing archived runs' : 'Hiding archived runs'}
                                  </Button>
                                </div>

                                <div className="border-t border-border pt-3">
                                  <div className="mb-2 flex items-center justify-between">
                                    <p className="text-[11px] font-medium text-muted-foreground">Status</p>
                                    <Button variant="ghost" size="sm" onClick={resetStatusFilter} className="h-6 px-2 text-[10px]">
                                      Reset
                                    </Button>
                                  </div>
                                  <div className="grid grid-cols-2 gap-1.5">
                                    {RUN_STATUS_OPTIONS.map((status) => {
                                      const selected = statusFilter.has(status)
                                      return (
                                        <button
                                          key={status}
                                          type="button"
                                          onClick={() => toggleStatusFilter(status)}
                                          className={`flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-[11px] transition-colors ${selected
                                            ? 'border-primary/40 bg-primary/10 text-primary'
                                            : 'border-border bg-card text-muted-foreground hover:bg-secondary/40'
                                            }`}
                                        >
                                          {selected ? <CheckSquare className="h-3.5 w-3.5" /> : <span className="h-3.5 w-3.5 rounded-sm border border-current/50" />}
                                          {getStatusText(status)}
                                        </button>
                                      )
                                    })}
                                  </div>
                                </div>
                              </div>
                            </PopoverContent>
                          </Popover>

                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant={manageMode ? 'default' : 'outline'}
                                size="icon"
                                onClick={() => {
                                  setManageMode((prev) => {
                                    const next = !prev
                                    if (!next) {
                                      clearManageSelection()
                                    }
                                    return next
                                  })
                                }}
                                aria-label={manageMode ? 'Exit Manage' : 'Manage'}
                                className="h-8 w-8"
                              >
                                <Settings2 className="h-3.5 w-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{manageMode ? 'Exit Manage' : 'Manage Runs'}</TooltipContent>
                          </Tooltip>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-[11px]"
                          onClick={() => setRunsPage((p) => Math.max(1, p - 1))}
                          disabled={runsPage === 1}
                        >
                          Prev
                        </Button>
                        <span className="text-[11px] text-muted-foreground">
                          Page {runsPage} / {totalRunsPages}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-[11px]"
                          onClick={() => setRunsPage((p) => Math.min(totalRunsPages, p + 1))}
                          disabled={runsPage >= totalRunsPages}
                        >
                          Next
                        </Button>
                      </div>

                      {manageMode && (
                        <div className="rounded-lg border border-border bg-card px-2 py-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs text-muted-foreground">
                              {selectedManageRuns.length} selected
                            </span>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={selectedManageRuns.length === filteredRuns.length ? clearManageSelection : selectAllFilteredRuns}
                              className="h-7 px-2 text-[11px]"
                            >
                              {selectedManageRuns.length === filteredRuns.length ? 'Clear' : 'Select All'}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={archiveSelectedRuns}
                              disabled={selectedManageRuns.length === 0 || !canArchiveSelection}
                              className="h-7 px-2 text-[11px]"
                            >
                              <Archive className="mr-1 h-3 w-3" />
                              Archive
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={unarchiveSelectedRuns}
                              disabled={selectedManageRuns.length === 0 || !canUnarchiveSelection}
                              className="h-7 px-2 text-[11px]"
                            >
                              <Undo2 className="mr-1 h-3 w-3" />
                              Unarchive
                            </Button>
                            <Popover>
                              <PopoverTrigger asChild>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={selectedManageRuns.length === 0}
                                  className="h-7 px-2 text-[11px]"
                                >
                                  <Palette className="mr-1 h-3 w-3" />
                                  Color
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent className="w-44 p-3" align="start">
                                <p className="mb-2 text-xs font-medium text-muted-foreground">
                                  Color for selected
                                </p>
                                <div className="grid grid-cols-5 gap-2">
                                  {DEFAULT_RUN_COLORS.map((color) => (
                                    <button
                                      key={color}
                                      type="button"
                                      onClick={() => setColorForSelectedRuns(color)}
                                      className="h-7 w-7 rounded-full border-2 border-transparent transition-transform hover:scale-110 hover:border-foreground"
                                      style={{ backgroundColor: color }}
                                    />
                                  ))}
                                </div>
                              </PopoverContent>
                            </Popover>
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="p-4 space-y-5">
                      {detailsView === 'priority' ? (
                        <>
                          {renderRunSubsection('priority:favorites', 'Favorites', <Star className="h-4 w-4 text-yellow-500" />, favoriteRuns)}
                          {renderRunSubsection('priority:alerts', 'Has Alerts', <AlertTriangle className="h-4 w-4 text-warning" />, alertRuns)}
                          {renderRunSubsection('priority:running', 'Running', <Play className="h-4 w-4 text-accent" />, runningRuns)}
                          {renderRunSubsection('priority:ready', 'Ready', <Clock className="h-4 w-4 text-amber-400" />, readyRuns)}
                          {renderRunSubsection('priority:queued', 'Queued', <Clock className="h-4 w-4 text-foreground" />, queuedRuns)}
                          {renderRunSubsection('priority:failed', 'Failed', <AlertCircle className="h-4 w-4 text-destructive" />, failedRuns)}
                          {renderRunSubsection('priority:finished', 'Finished', <CheckCircle2 className="h-4 w-4 text-green-400" />, completedRuns)}
                          {renderRunSubsection('priority:canceled', 'Canceled', <XCircle className="h-4 w-4 text-muted-foreground" />, canceledRuns)}
                          {filteredRuns.length === 0 && (
                            <div className="py-10 text-center text-sm text-muted-foreground">
                              No runs match the current filters.
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          {groupByMode === 'sweep' ? (
                            <div className="space-y-5">
                              {groupedRunsBySweep.length > 0 ? (
                                groupedRunsBySweep.map((group) => renderRunSubsection(
                                  `time:group:${group.sweepId}`,
                                  group.sweepId === 'no-sweep'
                                    ? 'No Sweep'
                                    : sweepById.get(group.sweepId)?.config.name || `Sweep ${group.sweepId}`,
                                  <PlugZap className="h-4 w-4 text-muted-foreground" />,
                                  group.runs
                                ))
                              ) : (
                                <div className="py-10 text-center text-sm text-muted-foreground">
                                  No runs match the current filters.
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="space-y-4">
                              {renderRunSubsection(
                                'time:all-active',
                                includeArchived ? 'All Runs' : 'All Active Runs',
                                <Layers className="h-4 w-4 text-muted-foreground" />,
                                sortedRuns
                              )}
                              {sortedRuns.length === 0 && (
                                <div className="py-10 text-center text-sm text-muted-foreground">
                                  No runs match the current filters.
                                </div>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </ScrollArea>
        </div>
      </div>

      <Dialog open={sweepDialogOpen} onOpenChange={setSweepDialogOpen}>
        <DialogContent showCloseButton={false} className="w-[95vw] h-[90vh] max-w-[900px] max-h-[800px] flex flex-col p-0 gap-0">
          <DialogTitle className="sr-only">Sweep Configuration</DialogTitle>
          <SweepForm
            previousSweeps={sweeps}
            onSave={async (config) => { await onSaveSweep?.(config); setSweepDialogOpen(false); await onRefresh?.() }}
            onCreate={async (config) => { await onCreateSweep?.(config); setSweepDialogOpen(false); await onRefresh?.() }}
            onCancel={() => setSweepDialogOpen(false)}
            onLaunch={async (config) => { await onLaunchSweep?.(config); setSweepDialogOpen(false); await onRefresh?.() }}
          />
        </DialogContent>
      </Dialog>
      <Dialog
        open={runDialogOpen}
        onOpenChange={(open) => {
          setRunDialogOpen(open)
          if (!open) resetCreateRunForm()
        }}
      >
        <DialogContent className="max-w-xl p-0 overflow-hidden">
          <div className="border-b border-border px-5 py-4">
            <DialogTitle className="text-sm font-semibold text-foreground">Create Run</DialogTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Create a single run and optionally attach it to an existing sweep.
            </p>
          </div>
          <div className="space-y-4 px-5 py-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">Run Name</label>
              <Input
                value={runCreateName}
                onChange={(event) => setRunCreateName(event.target.value)}
                placeholder="mnist-baseline-run"
                className="h-9 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">Command</label>
              <Textarea
                value={runCreateCommand}
                onChange={(event) => setRunCreateCommand(event.target.value)}
                placeholder="python train.py --model ... --lr ..."
                className="min-h-24 text-xs font-mono"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">Working Directory (Optional)</label>
                <Input
                  value={runCreateWorkdir}
                  onChange={(event) => setRunCreateWorkdir(event.target.value)}
                  placeholder="/workspace/project"
                  className="h-9 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">Attach To Sweep</label>
                <Select value={runCreateSweepId} onValueChange={setRunCreateSweepId}>
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No Sweep</SelectItem>
                    {sortedSweeps.map((sweep) => (
                      <SelectItem key={sweep.id} value={sweep.id}>
                        {sweep.config.name || sweep.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border/70 bg-secondary/20 px-3 py-2">
              <div>
                <p className="text-xs font-medium text-foreground">Auto Start</p>
                <p className="text-[11px] text-muted-foreground">
                  Start in queue immediately after creation
                </p>
              </div>
              <Switch checked={runCreateAutoStart} onCheckedChange={setRunCreateAutoStart} />
            </div>
            <div className="space-y-3 rounded-lg border border-border/70 bg-secondary/20 px-3 py-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-foreground">Use GPU Wrap</p>
                  <p className="text-[11px] text-muted-foreground">
                    Sidecar auto-picks GPUs and retries on contention.
                  </p>
                </div>
                <Switch checked={runCreateGpuwrapEnabled} onCheckedChange={setRunCreateGpuwrapEnabled} />
              </div>
              {runCreateGpuwrapEnabled && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-muted-foreground">GPUs Needed</label>
                    <Input
                      type="number"
                      min={1}
                      max={64}
                      value={runCreateGpuwrapGpusNeeded}
                      onChange={(event) => setRunCreateGpuwrapGpusNeeded(event.target.value)}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-muted-foreground">GPU Retries</label>
                    <Input
                      type="number"
                      min={0}
                      max={20}
                      value={runCreateGpuwrapRetries}
                      onChange={(event) => setRunCreateGpuwrapRetries(event.target.value)}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-muted-foreground">Retry Delay (sec)</label>
                    <Input
                      type="number"
                      step="0.1"
                      min={0.1}
                      value={runCreateGpuwrapRetryDelaySeconds}
                      onChange={(event) => setRunCreateGpuwrapRetryDelaySeconds(event.target.value)}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-muted-foreground">Max Memory Used (MB)</label>
                    <Input
                      type="number"
                      min={0}
                      value={runCreateGpuwrapMaxMemoryUsedMb}
                      onChange={(event) => setRunCreateGpuwrapMaxMemoryUsedMb(event.target.value)}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <label className="text-[11px] font-medium text-muted-foreground">Max Utilization (%)</label>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      value={runCreateGpuwrapMaxUtilization}
                      onChange={(event) => setRunCreateGpuwrapMaxUtilization(event.target.value)}
                      className="h-8 text-xs"
                    />
                  </div>
                </div>
              )}
            </div>
            {runCreateError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {runCreateError}
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
            <Button variant="outline" size="sm" onClick={() => setRunDialogOpen(false)} disabled={runCreateSubmitting}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => { void handleSubmitCreateRun() }} disabled={runCreateSubmitting}>
              {runCreateSubmitting ? 'Creating...' : 'Create Run'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
