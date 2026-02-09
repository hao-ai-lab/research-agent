import type {
  CreateSweepRequest,
  Sweep as ApiSweep,
  UpdateSweepRequest,
} from '@/lib/api-client'
import type {
  Sweep as UiSweep,
  SweepConfig,
  SweepHyperparameter,
  SweepStatus,
} from '@/lib/types'

const MAX_RANGE_VALUES_PER_PARAM = 128

function toChoiceValues(values: unknown[]): Array<string | number> {
  return values.filter((value): value is string | number => (
    typeof value === 'string' || typeof value === 'number'
  ))
}

function toDate(value: unknown, fallback: Date): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return fallback
}

function buildFallbackConfig(sweep: ApiSweep, createdAt: Date): SweepConfig {
  return {
    id: sweep.id,
    name: sweep.name || sweep.id,
    description: sweep.goal || '',
    goal: sweep.goal || '',
    command: sweep.base_command || '',
    hyperparameters: Object.entries(sweep.parameters || {}).map(([name, values]) => ({
      name,
      type: 'choice',
      values: Array.isArray(values) ? toChoiceValues(values) : [],
    })),
    metrics: [],
    insights: [],
    maxRuns: sweep.max_runs ?? sweep.progress.total,
    parallelRuns: Math.max(1, (sweep.progress.running || 0) + (sweep.progress.launching || 0) || 1),
    earlyStoppingEnabled: false,
    earlyStoppingPatience: 3,
    createdAt,
    updatedAt: createdAt,
  }
}

function hydrateConfigFromApi(sweep: ApiSweep, createdAt: Date): SweepConfig {
  const fallback = buildFallbackConfig(sweep, createdAt)
  const rawConfig = sweep.ui_config
  if (!rawConfig || typeof rawConfig !== 'object') {
    return fallback
  }

  const uiConfig = rawConfig as Partial<SweepConfig>
  return {
    ...fallback,
    ...uiConfig,
    id: typeof uiConfig.id === 'string' ? uiConfig.id : fallback.id,
    name: typeof uiConfig.name === 'string' ? uiConfig.name : fallback.name,
    description: typeof uiConfig.description === 'string' ? uiConfig.description : fallback.description,
    goal: typeof uiConfig.goal === 'string' ? uiConfig.goal : fallback.goal,
    command: typeof uiConfig.command === 'string' ? uiConfig.command : fallback.command,
    hyperparameters: Array.isArray(uiConfig.hyperparameters)
      ? (uiConfig.hyperparameters as SweepHyperparameter[])
      : fallback.hyperparameters,
    metrics: Array.isArray(uiConfig.metrics) ? uiConfig.metrics : fallback.metrics,
    insights: Array.isArray(uiConfig.insights) ? uiConfig.insights : fallback.insights,
    createdAt: toDate(uiConfig.createdAt, fallback.createdAt),
    updatedAt: toDate(uiConfig.updatedAt, fallback.updatedAt),
  }
}

function expandRangeValues(param: SweepHyperparameter): Array<string | number> {
  if (param.min === undefined || param.max === undefined) return []
  if (param.max < param.min) return []

  const step = typeof param.step === 'number' && param.step > 0 ? param.step : 1
  const values: Array<string | number> = []
  let current = param.min
  let guard = 0

  while (current <= param.max + Number.EPSILON && guard < MAX_RANGE_VALUES_PER_PARAM) {
    const rounded = Number.isInteger(current) ? current : Number(current.toFixed(12))
    values.push(rounded)
    current += step
    guard += 1
  }

  return values
}

function hyperparametersToParameterGrid(hyperparameters: SweepHyperparameter[]): Record<string, unknown[]> {
  const parameters: Record<string, unknown[]> = {}

  hyperparameters.forEach((param) => {
    const name = param.name?.trim()
    if (!name) return

    if (param.type === 'choice') {
      const values = toChoiceValues(param.values || [])
      if (values.length > 0) parameters[name] = values
      return
    }

    if (param.type === 'fixed') {
      if (param.fixedValue !== undefined) parameters[name] = [param.fixedValue]
      return
    }

    if (param.type === 'range') {
      const values = expandRangeValues(param)
      if (values.length > 0) parameters[name] = values
    }
  })

  return parameters
}

function serializeConfig(config: SweepConfig): Record<string, unknown> {
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>
}

export function mapApiSweepStatusToUi(status: ApiSweep['status']): SweepStatus {
  if (status === 'ready' || status === 'pending') return 'pending'
  if (status === 'draft') return 'draft'
  if (status === 'running') return 'running'
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'canceled') return 'canceled'
  return 'pending'
}

export function mapApiSweepToUiSweep(sweep: ApiSweep): UiSweep {
  const createdAt = new Date(sweep.created_at * 1000)
  return {
    id: sweep.id,
    config: hydrateConfigFromApi(sweep, createdAt),
    status: mapApiSweepStatusToUi(sweep.status),
    runIds: sweep.run_ids,
    createdAt,
    startedAt: sweep.started_at
      ? new Date(sweep.started_at * 1000)
      : (sweep.status === 'running' ? createdAt : undefined),
    completedAt: sweep.completed_at ? new Date(sweep.completed_at * 1000) : undefined,
    progress: {
      completed: sweep.progress.completed,
      total: sweep.progress.total,
      failed: sweep.progress.failed,
      running: (sweep.progress.running || 0) + (sweep.progress.launching || 0),
    },
  }
}

export function sweepConfigToCreateRequest(
  config: SweepConfig,
  status: CreateSweepRequest['status'],
): CreateSweepRequest {
  return {
    name: config.name || `sweep-${Date.now()}`,
    base_command: config.command || '',
    parameters: hyperparametersToParameterGrid(config.hyperparameters),
    max_runs: config.maxRuns || 10,
    auto_start: false,
    goal: config.goal,
    status,
    ui_config: serializeConfig(config),
  }
}

export function sweepConfigToUpdateRequest(
  config: SweepConfig,
  status?: UpdateSweepRequest['status'],
): UpdateSweepRequest {
  const request: UpdateSweepRequest = {
    name: config.name || `sweep-${Date.now()}`,
    base_command: config.command || '',
    parameters: hyperparametersToParameterGrid(config.hyperparameters),
    max_runs: config.maxRuns || 10,
    goal: config.goal,
    ui_config: serializeConfig(config),
  }
  if (status) request.status = status
  return request
}
