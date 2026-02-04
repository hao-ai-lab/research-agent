import type { ExperimentRun, ChatMessage, LossDataPoint, MemoryRule, InsightChart, TagDefinition, MetricVisualization, RunEvent, Sweep, SweepConfig } from './types'

export const DEFAULT_TAG_COLORS = [
  '#4ade80', // green
  '#60a5fa', // blue
  '#f472b6', // pink
  '#facc15', // yellow
  '#a78bfa', // purple
  '#fb923c', // orange
  '#2dd4bf', // teal
  '#f87171', // red
]

export const defaultTags: TagDefinition[] = [
  { name: 'production', color: '#4ade80' },
  { name: 'gpt-4', color: '#60a5fa' },
  { name: 'classification', color: '#f472b6' },
  { name: 'rlhf', color: '#facc15' },
  { name: 'failed', color: '#f87171' },
  { name: 'rag', color: '#a78bfa' },
  { name: 'code', color: '#fb923c' },
  { name: 'queued', color: '#2dd4bf' },
  { name: 'vision', color: '#818cf8' },
  { name: 'clip', color: '#34d399' },
  { name: 'sentiment', color: '#fbbf24' },
]

export const defaultMetricVisualizations: MetricVisualization[] = [
  { id: 'train-loss', name: 'Training Loss', path: 'train/loss', category: 'primary', type: 'line', isPinned: true, isInOverview: true },
  { id: 'val-loss', name: 'Validation Loss', path: 'val/loss', category: 'primary', type: 'line', isPinned: true, isInOverview: true },
  { id: 'reward', name: 'Reward', path: 'train/reward', category: 'primary', type: 'line', isPinned: false, isInOverview: false },
  { id: 'loss-ema', name: 'Loss EMA', path: 'train/loss_ema', category: 'secondary', type: 'line' },
  { id: 'loss-slope', name: 'Loss Slope', path: 'train/loss_slope', category: 'secondary', type: 'area' },
  { id: 'gen-gap', name: 'Generalization Gap', path: 'val/generalization_gap', category: 'secondary', type: 'area' },
  { id: 'grad-norm', name: 'Gradient Norm', path: 'grad/global_norm', category: 'secondary', type: 'line' },
  { id: 'grad-norm-ema', name: 'Gradient Norm EMA', path: 'grad/global_norm_ema', category: 'secondary', type: 'line' },
  { id: 'grad-attn', name: 'Attention Grad Norm', path: 'grad/norm/attn', category: 'secondary', type: 'line', layerSelector: true },
  { id: 'grad-ratio', name: 'Grad/Param Norm Ratio', path: 'grad/norm_ratio', category: 'secondary', type: 'line' },
  { id: 'act-mean', name: 'Activation Mean', path: 'act/mean', category: 'secondary', type: 'line', layerSelector: true },
]

const generateRunLossHistory = (
  epochs: number,
  finalLoss: number,
  variance = 0.05
) => {
  const history: { step: number; trainLoss: number; valLoss: number }[] = []
  for (let i = 0; i <= epochs * 100; i += 100) {
    const progress = i / (epochs * 100)
    const trainLoss =
      2.5 * Math.exp(-progress * 3) +
      finalLoss +
      (Math.random() - 0.5) * variance
    const valLoss =
      2.5 * Math.exp(-progress * 2.8) +
      finalLoss * 1.1 +
      (Math.random() - 0.5) * variance * 1.5
    history.push({
      step: i,
      trainLoss: Math.max(0.01, Number(trainLoss.toFixed(4))),
      valLoss: Math.max(0.01, Number(valLoss.toFixed(4))),
    })
  }
  return history
}

export const DEFAULT_RUN_COLORS = [
  '#4ade80', // green
  '#60a5fa', // blue
  '#f472b6', // pink
  '#facc15', // yellow
  '#a78bfa', // purple
  '#fb923c', // orange
  '#2dd4bf', // teal
  '#f87171', // red
  '#818cf8', // indigo
  '#34d399', // emerald
]

export const mockRuns: ExperimentRun[] = [
  {
    id: '1',
    name: 'Qwen8B-sft50-math30-arxiv20',
    status: 'running',
    progress: 72,
    startTime: new Date(Date.now() - 3 * 60 * 60 * 1000),
    command:
      'python train.py --model qwen-8b --lr 2e-5 --batch-size 32 --data sft:50%,math:30%,arxiv:20%',
    metrics: {
      loss: 0.198,
      accuracy: 93.2,
      epoch: 18,
    },
    config: {
      model: 'qwen-8b',
      learningRate: 0.00002,
      batchSize: 32,
      hiddenLayers: 32,
      dropout: 0.1,
      optimizer: 'AdamW',
      scheduler: 'cosine',
      warmupSteps: 500,
      maxEpochs: 25,
      dataMixture: { sft: 50, math: 30, arxiv: 20 },
    },
    lossHistory: generateRunLossHistory(18, 0.18),
    artifacts: [
      {
        id: 'a1',
        name: 'eval_math.txt',
        type: 'text',
        content:
          'Math benchmark: GSM8K 78.2%, MATH 45.6%\nArXiv comprehension: 82.1%',
        timestamp: new Date(Date.now() - 30 * 60 * 1000),
      },
    ],
    isFavorite: true,
    tags: ['production', 'qwen'],
    notes: 'Balanced mixture with strong math reasoning. Current best candidate.',
    color: '#4ade80',
    isArchived: false,
  },
  {
    id: '2',
    name: 'Qwen8B-code60-math25-wiki15',
    status: 'running',
    progress: 45,
    startTime: new Date(Date.now() - 1.5 * 60 * 60 * 1000),
    command:
      'python train.py --model qwen-8b --lr 2e-5 --batch-size 32 --data code:60%,math:25%,wiki:15%',
    metrics: {
      loss: 0.312,
      accuracy: 87.4,
      epoch: 11,
    },
    config: {
      model: 'qwen-8b',
      learningRate: 0.00002,
      batchSize: 32,
      hiddenLayers: 32,
      dropout: 0.1,
      optimizer: 'AdamW',
      scheduler: 'cosine',
      warmupSteps: 500,
      maxEpochs: 25,
      dataMixture: { code: 60, math: 25, wiki: 15 },
    },
    lossHistory: generateRunLossHistory(11, 0.28),
    artifacts: [],
    isFavorite: false,
    tags: ['code'],
    notes: 'Code-heavy mixture for programming tasks',
    color: '#60a5fa',
    isArchived: false,
  },
  {
    id: '3',
    name: 'Qwen8B-math70-code20-sft10',
    status: 'failed',
    progress: 38,
    startTime: new Date(Date.now() - 6 * 60 * 60 * 1000),
    endTime: new Date(Date.now() - 4 * 60 * 60 * 1000),
    command:
      'python train.py --model qwen-8b --lr 3e-5 --batch-size 64 --data math:70%,code:20%,sft:10%',
    metrics: {
      loss: 0.856,
      accuracy: 62.1,
      epoch: 9,
    },
    config: {
      model: 'qwen-8b',
      learningRate: 0.00003,
      batchSize: 64,
      hiddenLayers: 32,
      dropout: 0.1,
      optimizer: 'AdamW',
      scheduler: 'cosine',
      warmupSteps: 300,
      maxEpochs: 25,
      dataMixture: { math: 70, code: 20, sft: 10 },
    },
    alerts: [
      {
        type: 'error',
        message: 'OOM: CUDA out of memory at epoch 9',
        runId: '3',
        timestamp: new Date(Date.now() - 4 * 60 * 60 * 1000),
      },
    ],
    lossHistory: generateRunLossHistory(9, 0.8, 0.1),
    artifacts: [
      {
        id: 'a3',
        name: 'error_log.txt',
        type: 'log',
        content:
          'RuntimeError: CUDA out of memory. Batch size 64 too large for 8B model.',
        timestamp: new Date(Date.now() - 4 * 60 * 60 * 1000),
      },
    ],
    isFavorite: false,
    tags: ['failed'],
    notes: 'Math-heavy mixture failed due to large batch size. Retry with bs=32.',
    color: '#f472b6',
    isArchived: false,
  },
  {
    id: '4',
    name: 'Qwen8B-wiki40-arxiv40-sft20',
    status: 'completed',
    progress: 100,
    startTime: new Date(Date.now() - 28 * 60 * 60 * 1000),
    endTime: new Date(Date.now() - 22 * 60 * 60 * 1000),
    command:
      'python train.py --model qwen-8b --lr 2e-5 --batch-size 32 --data wiki:40%,arxiv:40%,sft:20%',
    metrics: {
      loss: 0.112,
      accuracy: 94.8,
      epoch: 25,
    },
    config: {
      model: 'qwen-8b',
      learningRate: 0.00002,
      batchSize: 32,
      hiddenLayers: 32,
      dropout: 0.1,
      optimizer: 'AdamW',
      scheduler: 'cosine_with_restarts',
      warmupSteps: 1000,
      maxEpochs: 25,
      dataMixture: { wiki: 40, arxiv: 40, sft: 20 },
    },
    lossHistory: generateRunLossHistory(25, 0.1),
    artifacts: [
      {
        id: 'a4',
        name: 'eval_report.txt',
        type: 'text',
        content:
          'Knowledge benchmarks: TriviaQA 71.2%, NaturalQuestions 58.9%\nReading comprehension excellent.',
        timestamp: new Date(Date.now() - 22 * 60 * 60 * 1000),
      },
      {
        id: 'a5',
        name: 'checkpoint_final.pt',
        type: 'model',
        url: '/checkpoints/qwen8b_wiki_arxiv_final.pt',
        timestamp: new Date(Date.now() - 22 * 60 * 60 * 1000),
      },
    ],
    isFavorite: true,
    tags: ['production'],
    notes: 'Knowledge-focused mixture. Strong on factual QA tasks.',
    color: '#facc15',
    isArchived: false,
  },
  {
    id: '5',
    name: 'Qwen8B-sft80-chat20',
    status: 'queued',
    progress: 0,
    startTime: new Date(Date.now() + 30 * 60 * 1000),
    command:
      'python train.py --model qwen-8b --lr 1e-5 --batch-size 32 --data sft:80%,chat:20%',
    config: {
      model: 'qwen-8b',
      learningRate: 0.00001,
      batchSize: 32,
      hiddenLayers: 32,
      dropout: 0.1,
      optimizer: 'AdamW',
      scheduler: 'cosine',
      warmupSteps: 500,
      maxEpochs: 20,
      dataMixture: { sft: 80, chat: 20 },
    },
    artifacts: [],
    isFavorite: false,
    tags: ['queued'],
    notes: 'Chat-focused fine-tuning. Waiting for GPU.',
    color: '#a78bfa',
    isArchived: false,
  },
  {
    id: '6',
    name: 'Qwen8B-code40-math40-arxiv20',
    status: 'completed',
    progress: 100,
    startTime: new Date(Date.now() - 52 * 60 * 60 * 1000),
    endTime: new Date(Date.now() - 44 * 60 * 60 * 1000),
    command:
      'python train.py --model qwen-8b --lr 2e-5 --batch-size 32 --data code:40%,math:40%,arxiv:20%',
    metrics: {
      loss: 0.145,
      accuracy: 91.6,
      epoch: 25,
    },
    config: {
      model: 'qwen-8b',
      learningRate: 0.00002,
      batchSize: 32,
      hiddenLayers: 32,
      dropout: 0.1,
      optimizer: 'AdamW',
      scheduler: 'linear',
      warmupSteps: 800,
      maxEpochs: 25,
      dataMixture: { code: 40, math: 40, arxiv: 20 },
    },
    lossHistory: generateRunLossHistory(25, 0.14),
    artifacts: [
      {
        id: 'a6',
        name: 'humaneval_results.json',
        type: 'text',
        content: 'HumanEval: 62.8%, MBPP: 58.4%',
        timestamp: new Date(Date.now() - 44 * 60 * 60 * 1000),
      },
    ],
    isFavorite: false,
    tags: ['code'],
    notes: 'Balanced code+math. Good for technical reasoning.',
    color: '#fb923c',
    isArchived: false,
  },
  {
    id: '7',
    name: 'Qwen8B-instruct50-code30-wiki20',
    status: 'canceled',
    progress: 18,
    startTime: new Date(Date.now() - 12 * 60 * 60 * 1000),
    endTime: new Date(Date.now() - 10 * 60 * 60 * 1000),
    command:
      'python train.py --model qwen-8b --lr 2e-5 --batch-size 32 --data instruct:50%,code:30%,wiki:20%',
    metrics: {
      loss: 0.534,
      accuracy: 72.1,
      epoch: 4,
    },
    config: {
      model: 'qwen-8b',
      learningRate: 0.00002,
      batchSize: 32,
      hiddenLayers: 32,
      dropout: 0.1,
      optimizer: 'AdamW',
      scheduler: 'linear',
      warmupSteps: 500,
      maxEpochs: 25,
      dataMixture: { instruct: 50, code: 30, wiki: 20 },
    },
    lossHistory: generateRunLossHistory(4, 0.5),
    artifacts: [],
    isFavorite: false,
    tags: [],
    notes: 'Canceled - found data quality issues in instruct set',
    color: '#2dd4bf',
    isArchived: true,
  },
  {
    id: '8',
    name: 'Qwen8B-math50-code30-sft20',
    status: 'completed',
    progress: 100,
    startTime: new Date(Date.now() - 72 * 60 * 60 * 1000),
    endTime: new Date(Date.now() - 64 * 60 * 60 * 1000),
    command:
      'python train.py --model qwen-8b --lr 2e-5 --batch-size 32 --data math:50%,code:30%,sft:20%',
    metrics: {
      loss: 0.134,
      accuracy: 92.3,
      epoch: 25,
    },
    config: {
      model: 'qwen-8b',
      learningRate: 0.00002,
      batchSize: 32,
      hiddenLayers: 32,
      dropout: 0.1,
      optimizer: 'AdamW',
      scheduler: 'cosine',
      warmupSteps: 600,
      maxEpochs: 25,
      dataMixture: { math: 50, code: 30, sft: 20 },
    },
    lossHistory: generateRunLossHistory(25, 0.12),
    artifacts: [
      {
        id: 'a8',
        name: 'math_eval.txt',
        type: 'text',
        content: 'GSM8K: 82.1%, MATH: 48.9%, SVAMP: 79.3%',
        timestamp: new Date(Date.now() - 64 * 60 * 60 * 1000),
      },
    ],
    isFavorite: true,
    tags: ['production'],
    notes: 'Best math performance so far. Consider for math-focused deployment.',
    color: '#818cf8',
    isArchived: false,
  },
  {
    id: '9',
    name: 'Qwen8B-arxiv60-wiki30-sft10',
    status: 'running',
    progress: 28,
    startTime: new Date(Date.now() - 1 * 60 * 60 * 1000),
    command:
      'python train.py --model qwen-8b --lr 2e-5 --batch-size 32 --data arxiv:60%,wiki:30%,sft:10%',
    metrics: {
      loss: 0.421,
      accuracy: 81.2,
      epoch: 7,
    },
    config: {
      model: 'qwen-8b',
      learningRate: 0.00002,
      batchSize: 32,
      hiddenLayers: 32,
      dropout: 0.1,
      optimizer: 'AdamW',
      scheduler: 'cosine',
      warmupSteps: 500,
      maxEpochs: 25,
      dataMixture: { arxiv: 60, wiki: 30, sft: 10 },
    },
    lossHistory: generateRunLossHistory(7, 0.4),
    artifacts: [],
    isFavorite: false,
    tags: [],
    notes: 'Research-heavy mixture for scientific reasoning',
    color: '#34d399',
    isArchived: false,
  },
  {
    id: '10',
    name: 'Qwen8B-chat40-sft40-code20',
    status: 'completed',
    progress: 100,
    startTime: new Date(Date.now() - 96 * 60 * 60 * 1000),
    endTime: new Date(Date.now() - 88 * 60 * 60 * 1000),
    command:
      'python train.py --model qwen-8b --lr 1.5e-5 --batch-size 32 --data chat:40%,sft:40%,code:20%',
    metrics: {
      loss: 0.098,
      accuracy: 95.1,
      epoch: 25,
    },
    config: {
      model: 'qwen-8b',
      learningRate: 0.000015,
      batchSize: 32,
      hiddenLayers: 32,
      dropout: 0.1,
      optimizer: 'AdamW',
      scheduler: 'cosine',
      warmupSteps: 700,
      maxEpochs: 25,
      dataMixture: { chat: 40, sft: 40, code: 20 },
    },
    lossHistory: generateRunLossHistory(25, 0.09),
    artifacts: [
      {
        id: 'a10',
        name: 'chat_eval.txt',
        type: 'text',
        content: 'MT-Bench: 7.8/10, AlpacaEval: 84.2%',
        timestamp: new Date(Date.now() - 88 * 60 * 60 * 1000),
      },
    ],
    isFavorite: true,
    tags: ['production'],
    notes: 'Best conversational quality. Deployed to chat-v2 endpoint.',
    color: '#f87171',
    isArchived: false,
  },
]

// Helper function to generate loss data for embedded charts
const generateEmbeddedLossData = (): { step: number; trainLoss: number; valLoss?: number }[] => {
  const data: { step: number; trainLoss: number; valLoss?: number }[] = []
  for (let i = 0; i <= 100; i += 2) {
    const trainLoss = 2.5 * Math.exp(-i / 30) + 0.1 + Math.random() * 0.05
    const valLoss = 2.5 * Math.exp(-i / 35) + 0.15 + Math.random() * 0.08
    data.push({
      step: i * 100,
      trainLoss: Number(trainLoss.toFixed(4)),
      valLoss: Number(valLoss.toFixed(4)),
    })
  }
  return data
}

export const mockMessages: ChatMessage[] = [
  {
    id: '1',
    role: 'user',
    content: 'Can you analyze the loss curve for my GPT-4 fine-tuning run?',
    timestamp: new Date(Date.now() - 10 * 60 * 1000),
  },
  {
    id: '2',
    role: 'assistant',
    content: `Looking at your GPT-4 fine-tuning run, here are my observations:

**Training Progress**
- Current epoch: 15/25
- Training loss: 0.234 (steadily decreasing)
- Validation accuracy: 92.4%

**Key Insights**
1. The loss curve shows healthy convergence with no signs of overfitting
2. Learning rate of 0.0001 appears optimal for this task
3. Batch size of 32 is providing stable gradient updates

**Recommendations**
- Consider implementing early stopping if val loss plateaus
- You might benefit from learning rate scheduling after epoch 20
- Monitor GPU memory usage as model size increases`,
    thinking: `Let me analyze the training metrics and loss curve data...

First, I'll look at the current training state:
- The model is at epoch 15 out of the planned 25
- Loss has decreased from initial ~2.5 to current 0.234
- This represents a ~90% reduction in loss

Checking for overfitting indicators:
- Training loss and validation loss are converging similarly
- No divergence detected between train/val metrics
- Accuracy is improving consistently

Evaluating hyperparameters:
- Learning rate of 0.0001 is within optimal range for fine-tuning
- Batch size of 32 provides good gradient estimates
- No need for immediate adjustments

Generating recommendations based on trajectory...`,
    timestamp: new Date(Date.now() - 9 * 60 * 1000),
    chart: {
      title: 'GPT-4 Fine-tune Training Loss',
      data: generateEmbeddedLossData(),
    },
  },
  {
    id: '3',
    role: 'user',
    content: 'What happened to the LLaMA alignment run? It shows as failed.',
    timestamp: new Date(Date.now() - 5 * 60 * 1000),
  },
  {
    id: '4',
    role: 'assistant',
    content: `The LLaMA Alignment run failed due to a CUDA out-of-memory error at epoch 8.

**Error Details**
\`\`\`
OOM: CUDA out of memory at epoch 8
Attempted to allocate 2.4 GB
GPU 0 has 24 GB total, 0.8 GB free
\`\`\`

**Root Cause Analysis**
The 7B parameter model with batch size 8 was too large for the available GPU memory, especially as gradient accumulation increased during training.

**Recommended Fixes**
1. Reduce batch size to 4 or 2
2. Enable gradient checkpointing
3. Use mixed precision training (fp16/bf16)
4. Consider model parallelism across multiple GPUs`,
    thinking: `Analyzing the failed run logs...

Error type: CUDA OOM (Out of Memory)
Occurred at: Epoch 8
Model: LLaMA 7B parameters

Memory calculation:
- Model parameters: ~14 GB (7B params * 2 bytes fp16)
- Gradients: ~14 GB
- Optimizer states: ~28 GB (Adam)
- Activations: Variable, increases with batch size

With batch size 8 and sequence length likely 2048+, activation memory exceeded available VRAM.

Solutions to consider:
1. Gradient checkpointing - trades compute for memory
2. Smaller batch size with gradient accumulation
3. Mixed precision to halve memory footprint
4. DeepSpeed ZeRO or FSDP for distributed training`,
    timestamp: new Date(Date.now() - 4 * 60 * 1000),
  },
]

export const generateLossData = (): LossDataPoint[] => {
  const data: LossDataPoint[] = []
  for (let i = 0; i <= 100; i += 2) {
    const trainLoss = 2.5 * Math.exp(-i / 30) + 0.1 + Math.random() * 0.05
    const valLoss = 2.5 * Math.exp(-i / 35) + 0.15 + Math.random() * 0.08
    data.push({
      step: i * 100,
      trainLoss: Number(trainLoss.toFixed(4)),
      valLoss: Number(valLoss.toFixed(4)),
    })
  }
  return data
}

export const getRunsOverview = (runs: ExperimentRun[]) => {
  return {
    total: runs.length,
    running: runs.filter((r) => r.status === 'running').length,
    completed: runs.filter((r) => r.status === 'completed').length,
    failed: runs.filter((r) => r.status === 'failed').length,
    queued: runs.filter((r) => r.status === 'queued').length,
    canceled: runs.filter((r) => r.status === 'canceled').length,
  }
}

export const getAllAlerts = (runs: ExperimentRun[]) => {
  const alerts: Array<{
    id: string
    runId: string
    runName: string
    type: 'error' | 'warning' | 'info'
    message: string
    timestamp: Date
  }> = []

  runs.forEach((run) => {
    if (run.alerts) {
      run.alerts.forEach((alert, index) => {
        alerts.push({
          id: `${run.id}-alert-${index}`,
          runId: run.id,
          runName: run.name,
          type: alert.type,
          message: alert.message,
          timestamp: alert.timestamp || run.startTime,
        })
      })
    }
    
    // Add synthetic alerts for abnormal conditions
    if (run.lossHistory && run.lossHistory.length > 2) {
      const lastTwo = run.lossHistory.slice(-2)
      if (lastTwo[1].trainLoss > lastTwo[0].trainLoss * 1.5) {
        alerts.push({
          id: `${run.id}-spike`,
          runId: run.id,
          runName: run.name,
          type: 'warning',
          message: `Loss spike detected: ${lastTwo[0].trainLoss.toFixed(3)} -> ${lastTwo[1].trainLoss.toFixed(3)}`,
          timestamp: new Date(),
        })
      }
    }
  })

  return alerts.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
}

export const getRunEvents = (runs: ExperimentRun[]): RunEvent[] => {
  const events: RunEvent[] = []

  runs.forEach((run) => {
    if (run.alerts) {
      run.alerts.forEach((alert, index) => {
        const isError = alert.type === 'error'
        events.push({
          id: `${run.id}-event-${index}`,
          runId: run.id,
          runName: run.name,
          runAlias: run.alias,
          type: alert.type,
          priority: isError ? 'critical' : alert.type === 'warning' ? 'high' : 'low',
          status: 'new',
          title: isError ? 'Runtime Error' : alert.type === 'warning' ? 'Warning' : 'Info',
          summary: alert.message,
          description: isError 
            ? `A critical error occurred during training. The process was terminated due to: ${alert.message}. This typically indicates insufficient GPU memory or a configuration issue.`
            : `${alert.message}. This may require attention to prevent degradation of model performance.`,
          timestamp: alert.timestamp || run.startTime,
          logs: isError ? [
            `[${new Date(alert.timestamp || run.startTime).toISOString()}] ERROR: ${alert.message}`,
            `[${new Date(alert.timestamp || run.startTime).toISOString()}] Stack trace:`,
            `  at training_loop (train.py:245)`,
            `  at forward_pass (model.py:128)`,
            `  at cuda_allocator (memory.cpp:512)`,
          ] : undefined,
          suggestedActions: isError ? [
            'Reduce batch size from 32 to 16',
            'Enable gradient checkpointing',
            'Use mixed precision training (fp16/bf16)',
            'Check GPU memory availability',
          ] : [
            'Monitor training progress closely',
            'Consider adjusting learning rate',
            'Review recent configuration changes',
          ],
          relatedMetrics: [
            { name: 'Epoch', value: run.metrics?.epoch?.toString() || 'N/A' },
            { name: 'Loss', value: run.metrics?.loss?.toFixed(4) || 'N/A' },
            { name: 'GPU Memory', value: '23.2 GB / 24 GB' },
          ],
        })
      })
    }
    
    // Add synthetic events for abnormal conditions
    if (run.lossHistory && run.lossHistory.length > 2) {
      const lastTwo = run.lossHistory.slice(-2)
      if (lastTwo[1].trainLoss > lastTwo[0].trainLoss * 1.5) {
        events.push({
          id: `${run.id}-spike-event`,
          runId: run.id,
          runName: run.name,
          runAlias: run.alias,
          type: 'warning',
          priority: 'medium',
          status: 'new',
          title: 'Loss Spike Detected',
          summary: `Training loss increased from ${lastTwo[0].trainLoss.toFixed(3)} to ${lastTwo[1].trainLoss.toFixed(3)}`,
          description: `A significant spike in training loss was detected between consecutive steps. This could indicate learning rate issues, data quality problems, or unstable gradients. The loss increased by ${((lastTwo[1].trainLoss / lastTwo[0].trainLoss - 1) * 100).toFixed(1)}%.`,
          timestamp: new Date(),
          suggestedActions: [
            'Check for NaN/Inf values in gradients',
            'Consider reducing learning rate',
            'Review recent data batch for anomalies',
            'Enable gradient clipping',
          ],
          relatedMetrics: [
            { name: 'Previous Loss', value: lastTwo[0].trainLoss.toFixed(4) },
            { name: 'Current Loss', value: lastTwo[1].trainLoss.toFixed(4) },
            { name: 'Change', value: `+${((lastTwo[1].trainLoss / lastTwo[0].trainLoss - 1) * 100).toFixed(1)}%` },
          ],
        })
      }
    }
  })

  // Sort by priority (errors first) then by timestamp
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 }
  return events.sort((a, b) => {
    if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
      return priorityOrder[a.priority] - priorityOrder[b.priority]
    }
    return b.timestamp.getTime() - a.timestamp.getTime()
  })
}

export const mockMemoryRules: MemoryRule[] = [
  {
    id: 'rule-1',
    title: 'Learning Rate Scheduling',
    description: 'Always use cosine annealing with warm restarts for training runs longer than 10 epochs. Start with warmup steps equal to 5% of total steps.',
    createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    source: 'user',
    isActive: true,
  },
  {
    id: 'rule-2',
    title: 'Batch Size Optimization',
    description: 'For models > 7B parameters, use gradient accumulation with effective batch size of 32. Never exceed physical batch size of 8 to prevent OOM errors.',
    createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    source: 'agent',
    isActive: true,
  },
  {
    id: 'rule-3',
    title: 'Early Stopping Criteria',
    description: 'Stop training if validation loss increases for 3 consecutive epochs or if training loss drops below 0.01 (likely overfitting).',
    createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    source: 'user',
    isActive: true,
  },
  {
    id: 'rule-4',
    title: 'Hyperparameter Search Priority',
    description: 'When running hyperparameter search, prioritize learning rate > batch size > dropout > weight decay. Use logarithmic scale for LR search.',
    createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    source: 'user',
    isActive: true,
  },
  {
    id: 'rule-5',
    title: 'Memory Management',
    description: 'Enable gradient checkpointing for all models above 3B parameters. Use mixed precision (bf16) by default on A100/H100 GPUs.',
    createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
    source: 'agent',
    isActive: false,
  },
]

export const mockInsightCharts: InsightChart[] = [
  {
    id: 'chart-1',
    title: 'Learning Rate vs Final Loss',
    description: 'Comparison of different learning rates across experiments',
    type: 'scatter',
    data: [
      { label: '1e-5', value: 0.45, secondary: 0.42 },
      { label: '5e-5', value: 0.23, secondary: 0.21 },
      { label: '1e-4', value: 0.18, secondary: 0.16 },
      { label: '2e-4', value: 0.22, secondary: 0.25 },
      { label: '5e-4', value: 0.35, secondary: 0.42 },
    ],
    createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    source: 'chat',
    metric: 'loss',
  },
  {
    id: 'chart-2',
    title: 'Model Size vs Training Time',
    description: 'Hours to convergence by model parameters',
    type: 'bar',
    data: [
      { label: '1B', value: 2.5 },
      { label: '3B', value: 6.8 },
      { label: '7B', value: 14.2 },
      { label: '13B', value: 28.5 },
      { label: '30B', value: 72.0 },
    ],
    createdAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
    source: 'coding',
    metric: 'hours',
  },
  {
    id: 'chart-3',
    title: 'Accuracy by Epoch',
    description: 'Average validation accuracy progression',
    type: 'line',
    data: [
      { label: '1', value: 45.2 },
      { label: '5', value: 67.8 },
      { label: '10', value: 82.3 },
      { label: '15', value: 89.1 },
      { label: '20', value: 92.4 },
      { label: '25', value: 94.2 },
    ],
    createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
    source: 'chat',
    metric: 'accuracy',
  },
  {
    id: 'chart-4',
    title: 'GPU Memory Usage',
    description: 'Peak VRAM by batch size configuration',
    type: 'area',
    data: [
      { label: 'BS=2', value: 8.2 },
      { label: 'BS=4', value: 12.4 },
      { label: 'BS=8', value: 18.6 },
      { label: 'BS=16', value: 22.1 },
      { label: 'BS=32', value: 23.8 },
    ],
    createdAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    source: 'coding',
    metric: 'GB',
  },
]

// Mock Sweep Configs
export const mockSweepConfigs: SweepConfig[] = [
  {
    id: 'sweep-config-1',
    name: 'Learning Rate Sweep',
    description: 'Hyperparameter sweep to find optimal learning rate for GPT-4 fine-tuning',
    goal: 'Find the optimal learning rate that minimizes validation loss while maintaining stable training',
    command: 'python train.py --model gpt-4-base --lr {learning_rate} --batch-size {batch_size} --epochs 25',
    hyperparameters: [
      {
        name: 'learning_rate',
        type: 'range',
        min: 0.00001,
        max: 0.001,
        step: 0.00001,
      },
      {
        name: 'batch_size',
        type: 'choice',
        values: [8, 16, 32, 64],
      },
      {
        name: 'warmup_steps',
        type: 'choice',
        values: [100, 200, 500, 1000],
      },
    ],
    metrics: [
      { name: 'Validation Loss', path: 'val/loss', goal: 'minimize', isPrimary: true },
      { name: 'Training Loss', path: 'train/loss', goal: 'minimize', isPrimary: false },
      { name: 'Accuracy', path: 'val/accuracy', goal: 'maximize', isPrimary: false },
    ],
    insights: [
      {
        id: 'insight-1',
        type: 'failure',
        condition: 'loss > 10 or NaN',
        description: 'Training has diverged, likely due to too high learning rate',
        action: 'Cancel run and exclude from analysis',
      },
      {
        id: 'insight-2',
        type: 'suspicious',
        condition: 'val_loss increases for 3 consecutive epochs',
        description: 'Possible overfitting detected',
        action: 'Flag for review',
      },
      {
        id: 'insight-3',
        type: 'review',
        condition: 'accuracy > 95%',
        description: 'Unusually high accuracy may indicate data leakage',
        action: 'Human review required',
      },
    ],
    maxRuns: 20,
    parallelRuns: 4,
    earlyStoppingEnabled: true,
    earlyStoppingPatience: 5,
    createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
  },
]

// Mock Sweeps
export const mockSweeps: Sweep[] = [
  {
    id: 'sweep-1',
    config: mockSweepConfigs[0],
    status: 'running',
    runIds: ['1', '2'],
    bestRunId: '1',
    bestMetricValue: 0.234,
    startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    progress: {
      completed: 5,
      total: 20,
      failed: 1,
      running: 2,
    },
  },
]

// Helper to create a default sweep config
export const createDefaultSweepConfig = (): SweepConfig => ({
  id: `sweep-config-${Date.now()}`,
  name: '',
  description: '',
  goal: '',
  command: '',
  hyperparameters: [],
  metrics: [
    { name: 'Validation Loss', path: 'val/loss', goal: 'minimize', isPrimary: true },
  ],
  insights: [],
  maxRuns: 10,
  parallelRuns: 2,
  earlyStoppingEnabled: true,
  earlyStoppingPatience: 3,
  createdAt: new Date(),
  updatedAt: new Date(),
})
