import type { SweepConfig, SweepHyperparameter, SweepMetric } from '@/lib/types'

export interface SweepDraftResult {
  config: SweepConfig
  extracted: string[]
  confidence: number
}

const SWEEP_INTENT_PATTERN = /\b(sweep|grid search|hyper\s*parameter|hyperparameter|ablation|tune|search over|parameter search|experiment matrix)\b/i

const PARAM_ALIASES: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /(?:learning\s*rate|\blr\b)/i, name: 'learning_rate' },
  { pattern: /(?:batch\s*size|batch_size|\bbs\b)/i, name: 'batch_size' },
  { pattern: /(?:dropout)/i, name: 'dropout' },
  { pattern: /(?:weight\s*decay|\bwd\b)/i, name: 'weight_decay' },
  { pattern: /(?:epochs?|num\s*epochs?)/i, name: 'epochs' },
  { pattern: /(?:warmup\s*steps?|warmup)/i, name: 'warmup_steps' },
  { pattern: /(?:optimizer)/i, name: 'optimizer' },
  { pattern: /(?:scheduler)/i, name: 'scheduler' },
  { pattern: /(?:temperature|temp)/i, name: 'temperature' },
]

const METRIC_PATHS: Record<string, { path: string; goal: 'minimize' | 'maximize' }> = {
  accuracy: { path: 'val/accuracy', goal: 'maximize' },
  f1: { path: 'val/f1', goal: 'maximize' },
  auc: { path: 'val/auc', goal: 'maximize' },
  bleu: { path: 'val/bleu', goal: 'maximize' },
  reward: { path: 'train/reward', goal: 'maximize' },
  loss: { path: 'val/loss', goal: 'minimize' },
  perplexity: { path: 'val/perplexity', goal: 'minimize' },
  error: { path: 'val/error', goal: 'minimize' },
}

function createBlankSweepConfig(): SweepConfig {
  const now = new Date()
  return {
    id: `sweep-config-${Date.now()}`,
    name: '',
    description: '',
    goal: '',
    command: '',
    hyperparameters: [],
    metrics: [{ name: 'Validation Loss', path: 'val/loss', goal: 'minimize', isPrimary: true }],
    insights: [],
    maxRuns: 10,
    parallelRuns: 2,
    earlyStoppingEnabled: true,
    earlyStoppingPatience: 3,
    createdAt: now,
    updatedAt: now,
  }
}

function parseNumericToken(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed) return null

  const isPercent = trimmed.endsWith('%')
  let token = trimmed.replace(/,/g, '')
  if (isPercent) token = token.slice(0, -1)

  let multiplier = 1
  if (token.endsWith('k')) {
    multiplier = 1_000
    token = token.slice(0, -1)
  } else if (token.endsWith('m')) {
    multiplier = 1_000_000
    token = token.slice(0, -1)
  }

  const value = Number(token)
  if (!Number.isFinite(value)) {
    return null
  }

  const normalized = value * multiplier
  return isPercent ? normalized / 100 : normalized
}

function parseListValues(raw: string): Array<string | number> {
  return raw
    .split(/,|\bor\b|\band\b|\//i)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const cleaned = token.replace(/^['"]|['"]$/g, '')
      const numeric = parseNumericToken(cleaned)
      return numeric ?? cleaned
    })
}

function findParamName(rawName: string): string {
  const match = PARAM_ALIASES.find((entry) => entry.pattern.test(rawName))
  if (match) return match.name

  return rawName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function mergeHyperparameter(params: SweepHyperparameter[], nextParam: SweepHyperparameter): SweepHyperparameter[] {
  const idx = params.findIndex((p) => p.name === nextParam.name)
  if (idx === -1) {
    return [...params, nextParam]
  }

  const current = params[idx]

  // Prefer range over choice/fixed when both are available.
  if (nextParam.type === 'range' && current.type !== 'range') {
    const copy = [...params]
    copy[idx] = nextParam
    return copy
  }

  if (nextParam.type === current.type) {
    if (nextParam.type === 'choice') {
      const mergedValues = Array.from(new Set([...(current.values || []), ...(nextParam.values || [])]))
      const copy = [...params]
      copy[idx] = { ...current, values: mergedValues }
      return copy
    }

    const copy = [...params]
    copy[idx] = { ...current, ...nextParam }
    return copy
  }

  return params
}

function extractCommand(prompt: string): string | null {
  const codeMatch = prompt.match(/`([^`]+)`/)
  if (codeMatch) {
    const command = codeMatch[1].trim()
    if (/(python|torchrun|bash|sh|node|npm|pnpm|uv|poetry|ruby|rails)/i.test(command)) {
      return command
    }
  }

  const lineMatch = prompt
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^(python|torchrun|bash|sh|node|npm|pnpm|uv|poetry|ruby|rails)\b/i.test(line))

  if (lineMatch) {
    return lineMatch
  }

  return null
}

function extractRunLimits(prompt: string): { maxRuns?: number; parallelRuns?: number } {
  const maxRunsPattern = /(?:max(?:imum)?|up\s*to|limit(?:ed)?\s*to)?\s*(\d{1,4})\s*(?:runs|trials|experiments)\b/i
  const parallelPattern = /(?:parallel(?:ism)?|concurrent(?:ly)?|at\s*a\s*time)\s*(?:of|to|=)?\s*(\d{1,3})\b/i

  const maxRunsMatch = prompt.match(maxRunsPattern)
  const parallelMatch = prompt.match(parallelPattern)

  const maxRuns = maxRunsMatch ? parseInt(maxRunsMatch[1], 10) : undefined
  const parallelRuns = parallelMatch ? parseInt(parallelMatch[1], 10) : undefined

  return {
    maxRuns: Number.isFinite(maxRuns) ? maxRuns : undefined,
    parallelRuns: Number.isFinite(parallelRuns) ? parallelRuns : undefined,
  }
}

function extractMetrics(prompt: string): SweepMetric[] {
  const lower = prompt.toLowerCase()

  let selectedKey: string | null = null

  for (const key of Object.keys(METRIC_PATHS)) {
    if (lower.includes(key)) {
      selectedKey = key
      break
    }
  }

  if (!selectedKey) {
    return [{ name: 'Validation Loss', path: 'val/loss', goal: 'minimize', isPrimary: true }]
  }

  const config = METRIC_PATHS[selectedKey]
  const metricName = selectedKey === 'loss'
    ? 'Validation Loss'
    : selectedKey === 'f1'
    ? 'F1 Score'
    : selectedKey.toUpperCase()

  const maximizeHint = /\b(maximize|highest|improve|increase|best)\b/i.test(prompt)
  const minimizeHint = /\b(minimize|lowest|reduce|decrease)\b/i.test(prompt)

  const goal = maximizeHint
    ? 'maximize'
    : minimizeHint
    ? 'minimize'
    : config.goal

  return [{ name: metricName, path: config.path, goal, isPrimary: true }]
}

function extractHyperparameters(prompt: string): SweepHyperparameter[] {
  let params: SweepHyperparameter[] = []

  // Pattern: "lr from 1e-4 to 1e-2 step 1e-4"
  const rangePattern = /((?:learning\s*rate|\blr\b|batch\s*size|batch_size|dropout|weight\s*decay|\bwd\b|epochs?|num\s*epochs?|warmup\s*steps?|warmup|temperature|temp))\s*(?:from|between)\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?%?[kKmM]?)\s*(?:to|and)\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?%?[kKmM]?)(?:\s*(?:step|increment(?:s)?(?:\s*of)?)\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?%?[kKmM]?))?/gi

  for (const match of prompt.matchAll(rangePattern)) {
    const name = findParamName(match[1])
    const min = parseNumericToken(match[2])
    const max = parseNumericToken(match[3])
    const step = match[4] ? parseNumericToken(match[4]) : null

    if (min === null || max === null) continue

    params = mergeHyperparameter(params, {
      name,
      type: 'range',
      min,
      max,
      ...(step !== null ? { step } : {}),
    })
  }

  // Pattern: "batch size: 16, 32, 64"
  const listPattern = /((?:learning\s*rate|\blr\b|batch\s*size|batch_size|dropout|weight\s*decay|\bwd\b|epochs?|num\s*epochs?|warmup\s*steps?|warmup|optimizer|scheduler|temperature|temp))\s*(?:=|:|in|values?|over|across|try)?\s*(?:\[)?\s*([a-zA-Z0-9_.%+\-\s,/'"]{3,})(?:\])?/gi

  for (const match of prompt.matchAll(listPattern)) {
    const rawName = match[1]
    const rawValues = match[2]

    // Avoid re-processing a range phrase as a list phrase.
    if (/\bfrom\b|\bbetween\b/i.test(rawValues)) continue

    const name = findParamName(rawName)
    const values = parseListValues(rawValues)

    if (values.length < 2) continue

    // Guard against sentence captures.
    const hasTooManyWords = values.some((value) =>
      typeof value === 'string' && value.split(/\s+/).length > 3
    )
    if (hasTooManyWords) continue

    params = mergeHyperparameter(params, {
      name,
      type: 'choice',
      values,
    })
  }

  return params
}

function buildFallbackCommand(params: SweepHyperparameter[]): string {
  const placeholders = params
    .slice(0, 5)
    .map((param) => `--${param.name} {${param.name}}`)
    .join(' ')

  return placeholders
    ? `python train.py ${placeholders}`
    : 'python train.py --learning_rate {learning_rate}'
}

function toTitleCase(input: string): string {
  return input
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(' ')
}

function buildName(prompt: string, params: SweepHyperparameter[]): string {
  const explicit = prompt.match(/(?:name|call (?:it|this))\s*[:=]?\s*([\w\s-]{3,40})/i)
  if (explicit?.[1]) {
    return explicit[1].trim()
  }

  if (params.length > 0) {
    const head = params.slice(0, 2).map((param) => toTitleCase(param.name)).join(' + ')
    return `${head} Sweep`
  }

  return 'Experiment Sweep'
}

function buildGoal(prompt: string): string {
  const firstSentence = prompt.split(/[\n.!?]/).map((part) => part.trim()).find(Boolean)
  if (!firstSentence) {
    return 'Optimize experiment performance via parameter exploration.'
  }
  return firstSentence
}

export function isLikelySweepPrompt(prompt: string): boolean {
  if (!prompt.trim()) return false

  if (SWEEP_INTENT_PATTERN.test(prompt)) return true

  const hasRange = /\b(from|between)\b.+\b(to|and)\b/i.test(prompt)
  const hasParameterHint = PARAM_ALIASES.some((entry) => entry.pattern.test(prompt))

  return hasRange && hasParameterHint
}

export function buildSweepDraftFromPrompt(prompt: string, seedConfig?: SweepConfig): SweepDraftResult {
  const config = seedConfig ? { ...seedConfig, updatedAt: new Date() } : createBlankSweepConfig()
  const extracted: string[] = []

  const trimmedPrompt = prompt.trim()
  if (!trimmedPrompt) {
    return { config, extracted, confidence: 0 }
  }

  const command = extractCommand(trimmedPrompt)
  const hyperparameters = extractHyperparameters(trimmedPrompt)
  const metrics = extractMetrics(trimmedPrompt)
  const limits = extractRunLimits(trimmedPrompt)

  config.goal = config.goal || buildGoal(trimmedPrompt)
  config.description = config.description || trimmedPrompt
  config.name = config.name || buildName(trimmedPrompt, hyperparameters)

  if (command) {
    config.command = command
    extracted.push('command')
  }

  if (hyperparameters.length > 0) {
    config.hyperparameters = hyperparameters
    extracted.push(`${hyperparameters.length} hyperparameter${hyperparameters.length > 1 ? 's' : ''}`)
  }

  if (!config.command) {
    config.command = buildFallbackCommand(config.hyperparameters)
  }

  if (metrics.length > 0) {
    config.metrics = metrics
    extracted.push('primary metric')
  }

  if (limits.maxRuns) {
    config.maxRuns = limits.maxRuns
    extracted.push('max runs')
  }

  if (limits.parallelRuns) {
    config.parallelRuns = limits.parallelRuns
    extracted.push('parallelism')
  }

  const confidence = Math.min(
    0.95,
    (isLikelySweepPrompt(trimmedPrompt) ? 0.35 : 0.15) +
      (command ? 0.2 : 0) +
      (hyperparameters.length > 0 ? 0.25 : 0) +
      (limits.maxRuns ? 0.1 : 0) +
      (limits.parallelRuns ? 0.05 : 0) +
      (metrics.length > 0 ? 0.1 : 0)
  )

  return {
    config: {
      ...config,
      updatedAt: new Date(),
    },
    extracted,
    confidence,
  }
}
