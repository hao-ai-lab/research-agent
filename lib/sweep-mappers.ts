import type {
  CreateSweepRequest,
  Sweep as ApiSweep,
  UpdateSweepRequest,
} from '@/lib/api-client'
import type {
  Sweep as UiSweep,
  SweepCreationContext,
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
  if (typeof value === 'number') {
    const normalized = value < 1_000_000_000_000 ? value * 1000 : value
    const parsed = new Date(normalized)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  if (typeof value === 'string') {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) {
      const normalized = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric
      const parsedNumeric = new Date(normalized)
      if (!Number.isNaN(parsedNumeric.getTime())) return parsedNumeric
    }
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return fallback
}

function toNullableString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text.length > 0 ? text : null
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function toNullableBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'y', 'on'].includes(lowered)) return true
    if (['false', '0', 'no', 'n', 'off'].includes(lowered)) return false
  }
  return null
}

function buildFallbackConfig(sweep: ApiSweep, createdAt: Date): SweepConfig {
  return {
    id: sweep.id,
    name: sweep.name || sweep.id,
    description: '',
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

function hydrateCreationContextFromApi(
  sweep: ApiSweep,
  createdAt: Date,
  config: SweepConfig,
): SweepCreationContext {
  const raw = sweep.creation_context && typeof sweep.creation_context === 'object'
    ? (sweep.creation_context as Record<string, unknown>)
    : null

  const fallbackGoal = toNullableString(config.goal) || toNullableString(sweep.goal)
  const fallbackDescription = toNullableString(config.description)
  const fallbackCommand = toNullableString(config.command) || toNullableString(sweep.base_command)
  const fallbackMaxRuns = toNullableNumber(config.maxRuns) ?? toNullableNumber(sweep.max_runs) ?? null

  return {
    name: toNullableString(raw?.name) || toNullableString(config.name) || toNullableString(sweep.name),
    goal: toNullableString(raw?.goal) ?? fallbackGoal,
    description: toNullableString(raw?.description) ?? fallbackDescription,
    command: toNullableString(raw?.command) ?? fallbackCommand,
    notes: toNullableString(raw?.notes) ?? toNullableString(config.notes),
    maxRuns: toNullableNumber(raw?.max_runs) ?? fallbackMaxRuns,
    parallelRuns: toNullableNumber(raw?.parallel_runs) ?? toNullableNumber(config.parallelRuns),
    earlyStoppingEnabled: toNullableBoolean(raw?.early_stopping_enabled) ?? toNullableBoolean(config.earlyStoppingEnabled),
    earlyStoppingPatience: toNullableNumber(raw?.early_stopping_patience) ?? toNullableNumber(config.earlyStoppingPatience),
    hyperparameterCount: toNullableNumber(raw?.hyperparameter_count) ?? config.hyperparameters.length,
    metricCount: toNullableNumber(raw?.metric_count) ?? config.metrics.length,
    insightCount: toNullableNumber(raw?.insight_count) ?? config.insights.length,
    createdAt: toDate(raw?.created_at, config.createdAt || createdAt),
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
  const config = hydrateConfigFromApi(sweep, createdAt)
  return {
    id: sweep.id,
    config,
    creationContext: hydrateCreationContextFromApi(sweep, createdAt, config),
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
