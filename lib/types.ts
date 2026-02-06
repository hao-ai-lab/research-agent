export type RunStatus = 'ready' | 'running' | 'completed' | 'failed' | 'queued' | 'canceled'

export interface Artifact {
  id: string
  name: string
  type: 'text' | 'image' | 'model' | 'log'
  url?: string
  content?: string
  timestamp: Date
}

export interface ExperimentRun {
  id: string
  name: string
  alias?: string
  status: RunStatus
  progress: number
  startTime: Date
  endTime?: Date
  command: string
  metrics?: {
    loss: number
    accuracy: number
    epoch: number
  }
  config?: {
    model: string
    learningRate: number
    batchSize: number
    hiddenLayers?: number
    dropout?: number
    optimizer?: string
    scheduler?: string
    warmupSteps?: number
    maxEpochs?: number
  }
  alerts?: {
    type: 'error' | 'warning' | 'info'
    message: string
    runId?: string
    timestamp?: Date
  }[]
  artifacts?: Artifact[]
  lossHistory?: { step: number; trainLoss: number; valLoss?: number }[]
  isFavorite?: boolean
  tags?: string[]
  notes?: string
  color?: string
  isArchived?: boolean
}

export interface AppSettings {
  appearance: {
    theme: 'dark' | 'light' | 'system'
    fontSize: 'small' | 'medium' | 'large'
    buttonSize: 'compact' | 'default' | 'large'
  }
  integrations: {
    slack?: {
      enabled: boolean
      apiKey?: string
      channel?: string
    }
  }
  notifications: {
    alertsEnabled: boolean
    alertTypes: ('error' | 'warning' | 'info')[]
  }
}

export interface RunAlert {
  id: string
  runId: string
  runName: string
  type: 'error' | 'warning' | 'info'
  message: string
  timestamp: Date
}

export type EventPriority = 'critical' | 'high' | 'medium' | 'low'
export type EventStatus = 'new' | 'acknowledged' | 'resolved' | 'dismissed'

export interface RunEvent {
  id: string
  runId: string
  runName: string
  runAlias?: string
  type: 'error' | 'warning' | 'info'
  priority: EventPriority
  status: EventStatus
  title: string
  summary: string
  description: string
  timestamp: Date
  logs?: string[]
  suggestedActions?: string[]
  relatedMetrics?: { name: string; value: string }[]
}

// Message parts for ordered rendering of thinking, tools, and text
export type MessagePartType = 'thinking' | 'tool' | 'text'

export type ToolState = 'pending' | 'running' | 'completed' | 'error'

export interface MessagePart {
  id: string
  type: MessagePartType
  content: string
  // For tool parts
  toolName?: string
  toolState?: ToolState
  toolInput?: string   // Tool arguments/input
  toolOutput?: string  // Tool result/output
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking?: string  // Legacy: combined thinking (backward compat)
  parts?: MessagePart[]  // NEW: ordered array of parts
  timestamp: Date
  attachments?: {
    name: string
    type: string
    url: string
  }[]
  chart?: {
    title: string
    data: LossDataPoint[]
  }
  sweepConfig?: SweepConfig
  sweepId?: string
}

export interface LossDataPoint {
  step: number
  trainLoss: number
  valLoss?: number
}

export interface RunsOverview {
  total: number
  running: number
  completed: number
  failed: number
  queued: number
  canceled: number
}

export interface MemoryRule {
  id: string
  title: string
  description: string
  createdAt: Date
  source: 'user' | 'agent'
  isActive: boolean
}

export interface InsightChart {
  id: string
  title: string
  description?: string
  type: 'line' | 'bar' | 'scatter' | 'area'
  data: { label: string; value: number; secondary?: number }[]
  createdAt: Date
  source: 'coding' | 'chat'
  metric?: string
  isPinned?: boolean
  isInOverview?: boolean
}

export interface TagDefinition {
  name: string
  color: string
}

export interface MetricVisualization {
  id: string
  name: string
  path: string
  category: 'primary' | 'secondary'
  type: 'line' | 'bar' | 'area'
  isPinned?: boolean
  isInOverview?: boolean
  layerSelector?: boolean
}

export interface VisibilityGroup {
  id: string
  name: string
  color: string
  runIds: string[]
}

// Sweep types
export type SweepStatus = 'draft' | 'pending' | 'running' | 'completed' | 'failed' | 'canceled'

export interface SweepHyperparameter {
  name: string
  type: 'range' | 'choice' | 'fixed'
  values?: (string | number)[] // For choice type
  min?: number // For range type
  max?: number // For range type
  step?: number // For range type
  fixedValue?: string | number // For fixed type
}

export interface SweepMetric {
  name: string
  path: string
  goal: 'minimize' | 'maximize'
  isPrimary: boolean
}

export interface SweepInsight {
  id: string
  type: 'failure' | 'suspicious' | 'review'
  condition: string
  description: string
  action?: string
}

export interface SweepConfig {
  id: string
  name: string
  description: string
  goal: string
  command: string
  script?: string
  hyperparameters: SweepHyperparameter[]
  metrics: SweepMetric[]
  insights: SweepInsight[]
  maxRuns?: number
  parallelRuns?: number
  earlyStoppingEnabled?: boolean
  earlyStoppingPatience?: number
  createdAt: Date
  updatedAt: Date
}

export interface Sweep {
  id: string
  config: SweepConfig
  status: SweepStatus
  runIds: string[]
  bestRunId?: string
  bestMetricValue?: number
  startedAt?: Date
  completedAt?: Date
  createdAt: Date
  progress: {
    completed: number
    total: number
    failed: number
    running: number
  }
}

export interface SweepArtifact {
  id: string
  type: 'sweep-config'
  sweepId: string
  config: SweepConfig
  timestamp: Date
}
