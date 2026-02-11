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
    name: 'GPT-4 Fine-tune v2.3',
    status: 'running',
    progress: 67,
    startTime: new Date(Date.now() - 2 * 60 * 60 * 1000),
    command:
      'python train.py --model gpt-4-base --lr 0.0001 --batch-size 32 --epochs 25 --data ./data/finetune_v2',
    metrics: {
      loss: 0.234,
      accuracy: 92.4,
      epoch: 15,
    },
    config: {
      model: 'gpt-4-base',
      learningRate: 0.0001,
      batchSize: 32,
      hiddenLayers: 32,
      dropout: 0.1,
      optimizer: 'AdamW',
      scheduler: 'cosine',
      warmupSteps: 500,
      maxEpochs: 25,
    },
    lossHistory: generateRunLossHistory(15, 0.2),
    artifacts: [
      {
        id: 'a1',
        name: 'eval_sample_1.txt',
        type: 'text',
        content:
          'Input: What is the capital of France?\nOutput: The capital of France is Paris, a city known for its iconic Eiffel Tower and rich cultural heritage.',
        timestamp: new Date(Date.now() - 30 * 60 * 1000),
      },
      {
        id: 'a2',
        name: 'eval_sample_2.txt',
        type: 'text',
        content:
          'Input: Explain quantum computing in simple terms.\nOutput: Quantum computing uses quantum bits (qubits) that can exist in multiple states simultaneously, allowing for parallel processing of complex problems.',
        timestamp: new Date(Date.now() - 15 * 60 * 1000),
      },
    ],
    isFavorite: true,
    tags: ['production', 'gpt-4'],
    notes: 'Main production fine-tuning run. Showing great results so far.',
    color: '#4ade80',
    isArchived: false,
  },
  {
    id: '2',
    name: 'BERT Classification',
    status: 'running',
    progress: 34,
    startTime: new Date(Date.now() - 45 * 60 * 1000),
    command:
      'python train_bert.py --model bert-base-uncased --lr 5e-5 --batch-size 16 --task classification',
    metrics: {
      loss: 0.567,
      accuracy: 78.2,
      epoch: 5,
    },
    config: {
      model: 'bert-base-uncased',
      learningRate: 0.00005,
      batchSize: 16,
      hiddenLayers: 12,
      dropout: 0.1,
      optimizer: 'Adam',
      scheduler: 'linear',
      warmupSteps: 100,
      maxEpochs: 15,
    },
    lossHistory: generateRunLossHistory(5, 0.5),
    artifacts: [],
    isFavorite: false,
    tags: ['classification'],
    notes: '',
    color: '#60a5fa',
    isArchived: false,
  },
  {
    id: '3',
    name: 'LLaMA Alignment',
    status: 'failed',
    progress: 45,
    startTime: new Date(Date.now() - 5 * 60 * 60 * 1000),
    endTime: new Date(Date.now() - 3 * 60 * 60 * 1000),
    command:
      'python rlhf_train.py --model llama-7b --lr 0.0002 --batch-size 8 --reward-model ./models/rm_v1',
    metrics: {
      loss: 1.234,
      accuracy: 45.6,
      epoch: 8,
    },
    config: {
      model: 'llama-7b',
      learningRate: 0.0002,
      batchSize: 8,
      hiddenLayers: 32,
      dropout: 0.05,
      optimizer: 'AdamW',
      scheduler: 'cosine',
      warmupSteps: 200,
      maxEpochs: 20,
    },
    alerts: [
      {
        type: 'error',
        message: 'OOM: CUDA out of memory at epoch 8',
        runId: '3',
        timestamp: new Date(Date.now() - 3 * 60 * 60 * 1000),
      },
    ],
    lossHistory: generateRunLossHistory(8, 1.2, 0.1),
    artifacts: [
      {
        id: 'a3',
        name: 'error_log.txt',
        type: 'log',
        content:
          'RuntimeError: CUDA out of memory. Tried to allocate 2.4 GB (GPU 0; 24 GB total capacity; 23.2 GB already allocated)',
        timestamp: new Date(Date.now() - 3 * 60 * 60 * 1000),
      },
    ],
    isFavorite: false,
    tags: ['rlhf', 'failed'],
    notes: 'Need to reduce batch size or enable gradient checkpointing',
    color: '#f472b6',
    isArchived: false,
  },
  {
    id: '4',
    name: 'Mistral RAG Tune',
    status: 'completed',
    progress: 100,
    startTime: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endTime: new Date(Date.now() - 20 * 60 * 60 * 1000),
    command:
      'python train_rag.py --model mistral-7b --lr 3e-5 --batch-size 24 --retriever bm25 --index ./data/wiki_index',
    metrics: {
      loss: 0.089,
      accuracy: 96.8,
      epoch: 30,
    },
    config: {
      model: 'mistral-7b',
      learningRate: 0.00003,
      batchSize: 24,
      hiddenLayers: 32,
      dropout: 0.1,
      optimizer: 'AdamW',
      scheduler: 'cosine_with_restarts',
      warmupSteps: 1000,
      maxEpochs: 30,
    },
    lossHistory: generateRunLossHistory(30, 0.08),
    artifacts: [
      {
        id: 'a4',
        name: 'generated_summary.txt',
        type: 'text',
        content:
          'The retrieval-augmented generation model successfully generated coherent and factually accurate responses across 95% of test cases.',
        timestamp: new Date(Date.now() - 20 * 60 * 60 * 1000),
      },
      {
        id: 'a5',
        name: 'model_checkpoint.pt',
        type: 'model',
        url: '/checkpoints/mistral_rag_final.pt',
        timestamp: new Date(Date.now() - 20 * 60 * 60 * 1000),
      },
    ],
    isFavorite: true,
    tags: ['rag', 'production'],
    notes: 'Best performing RAG model. Consider as baseline.',
    color: '#facc15',
    isArchived: false,
  },
  {
    id: '5',
    name: 'Code Assistant v1.0',
    status: 'queued',
    progress: 0,
    startTime: new Date(Date.now() + 30 * 60 * 1000),
    command:
      'python train_code.py --model codellama-13b --lr 0.0001 --batch-size 16 --data ./data/code_corpus',
    config: {
      model: 'codellama-13b',
      learningRate: 0.0001,
      batchSize: 16,
      hiddenLayers: 40,
      dropout: 0.1,
      optimizer: 'AdamW',
      scheduler: 'cosine',
      warmupSteps: 500,
      maxEpochs: 20,
    },
    artifacts: [],
    isFavorite: false,
    tags: ['code', 'queued'],
    notes: 'Waiting for GPU availability',
    color: '#a78bfa',
    isArchived: false,
  },
  {
    id: '6',
    name: 'Vision Transformer CLIP',
    status: 'completed',
    progress: 100,
    startTime: new Date(Date.now() - 48 * 60 * 60 * 1000),
    endTime: new Date(Date.now() - 36 * 60 * 60 * 1000),
    command:
      'python train_vit.py --model vit-large --lr 1e-4 --batch-size 64 --data ./data/imagenet',
    metrics: {
      loss: 0.156,
      accuracy: 89.2,
      epoch: 50,
    },
    config: {
      model: 'vit-large-patch16',
      learningRate: 0.0001,
      batchSize: 64,
      hiddenLayers: 24,
      dropout: 0.1,
      optimizer: 'Adam',
      scheduler: 'linear',
      warmupSteps: 2000,
      maxEpochs: 50,
    },
    lossHistory: generateRunLossHistory(50, 0.15),
    artifacts: [
      {
        id: 'a6',
        name: 'attention_map.png',
        type: 'image',
        url: '/artifacts/attention_map.png',
        timestamp: new Date(Date.now() - 36 * 60 * 60 * 1000),
      },
    ],
    isFavorite: false,
    tags: ['vision', 'clip'],
    notes: '',
    color: '#fb923c',
    isArchived: false,
  },
  {
    id: '7',
    name: 'Sentiment Analysis',
    status: 'canceled',
    progress: 23,
    startTime: new Date(Date.now() - 10 * 60 * 60 * 1000),
    endTime: new Date(Date.now() - 8 * 60 * 60 * 1000),
    command:
      'python train_sentiment.py --model roberta-base --lr 2e-5 --batch-size 32',
    metrics: {
      loss: 0.789,
      accuracy: 65.4,
      epoch: 3,
    },
    config: {
      model: 'roberta-base',
      learningRate: 0.00002,
      batchSize: 32,
      hiddenLayers: 12,
      dropout: 0.1,
      optimizer: 'Adam',
      scheduler: 'linear',
      warmupSteps: 100,
      maxEpochs: 10,
    },
    lossHistory: generateRunLossHistory(3, 0.75),
    artifacts: [],
    isFavorite: false,
    tags: ['sentiment'],
    notes: 'Canceled due to data quality issues',
    color: '#2dd4bf',
    isArchived: true,
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

// Model Type Comparison Sweep - helps find the best architecture
export const modelTypeComparisonSweepConfig: SweepConfig = {
  id: `sweep-config-model-comparison-${Date.now()}`,
  name: 'Model Type Comparison Sweep',
  description: 'Compare different model architectures to find the best type for this task. Tests encoder-only (BERT/RoBERTa), decoder-only (GPT/LLaMA/Mistral), code models (CodeLLaMA), and vision transformers.',
  goal: 'Identify which model architecture achieves the best validation performance with optimal convergence speed',
  command: 'python train.py --model {model_type} --lr {learning_rate} --batch-size {batch_size} --dropout {dropout} --epochs 25',
  hyperparameters: [
    // Model type - the key parameter we're sweeping
    {
      name: 'model_type',
      type: 'choice',
      values: [
        'bert-base-uncased',
        'roberta-base',
        'gpt-4-base',
        'llama-7b',
        'mistral-7b',
      ],
    },
    // Learning rate tuned per model family
    {
      name: 'learning_rate',
      type: 'choice',
      values: [1e-5, 3e-5, 5e-5, 1e-4, 2e-4],
    },
    // Batch size - smaller for larger models
    {
      name: 'batch_size',
      type: 'choice',
      values: [8, 16, 32],
    },
    // Dropout for regularization
    {
      name: 'dropout',
      type: 'choice',
      values: [0.0, 0.1, 0.2],
    },
    // Optimizer choice
    {
      name: 'optimizer',
      type: 'choice',
      values: ['Adam', 'AdamW'],
    },
    // Warmup steps
    {
      name: 'warmup_steps',
      type: 'choice',
      values: [100, 500, 1000],
    },
  ],
  metrics: [
    { name: 'Validation Loss', path: 'val/loss', goal: 'minimize', isPrimary: true },
    { name: 'Validation Accuracy', path: 'val/accuracy', goal: 'maximize', isPrimary: true },
    { name: 'Training Loss', path: 'train/loss', goal: 'minimize', isPrimary: false },
    { name: 'F1 Score', path: 'val/f1', goal: 'maximize', isPrimary: false },
    { name: 'Convergence Epoch', path: 'train/epoch', goal: 'minimize', isPrimary: false },
    { name: 'GPU Memory (GB)', path: 'system/gpu_memory_gb', goal: 'minimize', isPrimary: false },
  ],
  insights: [
    {
      id: 'oom-large-models',
      type: 'failure',
      condition: 'model_type in ["llama-7b", "mistral-7b"] and system/gpu_memory_gb > 22',
      description: 'Large decoder models consuming excessive memory',
      action: 'Consider gradient checkpointing or smaller batch sizes',
    },
    {
      id: 'bert-fast-converge',
      type: 'review',
      condition: 'model_type in ["bert-base-uncased", "roberta-base"] and val/loss < 0.5 and train/epoch < 10',
      description: 'Encoder model showing fast convergence - good for quick iteration',
      action: 'Note as efficient baseline',
    },
    {
      id: 'decoder-high-perf',
      type: 'review',
      condition: 'model_type in ["gpt-4-base", "llama-7b", "mistral-7b"] and val/accuracy > 0.90',
      description: 'Large decoder model achieving high accuracy',
      action: 'Strong candidate for production if compute permits',
    },
    {
      id: 'divergence-check',
      type: 'failure',
      condition: 'train/loss > 5 or is_nan(val/loss)',
      description: 'Training divergence detected',
      action: 'Stop run - learning rate too high for this model',
    },
    {
      id: 'overfitting-alert',
      type: 'suspicious',
      condition: 'val/loss increases for 3 consecutive epochs',
      description: 'Overfitting detected',
      action: 'Consider increasing dropout or reducing model capacity',
    },
    {
      id: 'compute-efficiency',
      type: 'review',
      condition: 'val/accuracy > 0.85 and system/gpu_memory_gb < 12',
      description: 'Good performance with moderate memory usage',
      action: 'Optimal efficiency point found',
    },
  ],
  maxRuns: 30,
  parallelRuns: 3,
  earlyStoppingEnabled: true,
  earlyStoppingPatience: 5,
  notes: 'Model comparison sweep: Tests 5 architectures (BERT, RoBERTa, GPT-4, LLaMA, Mistral) with varying hyperparameters. Primary metric: validation accuracy. Will identify best model type for this specific task.',
  createdAt: new Date(),
  updatedAt: new Date(),
}

// Add to mock configs
mockSweepConfigs.push(modelTypeComparisonSweepConfig)

// Mock Sweeps
export const mockSweeps: Sweep[] = [
  {
    id: 'sweep-model-comparison',
    config: modelTypeComparisonSweepConfig,
    creationContext: {
      name: modelTypeComparisonSweepConfig.name,
      goal: modelTypeComparisonSweepConfig.goal,
      description: modelTypeComparisonSweepConfig.description,
      command: modelTypeComparisonSweepConfig.command,
      notes: modelTypeComparisonSweepConfig.notes || null,
      maxRuns: modelTypeComparisonSweepConfig.maxRuns || null,
      parallelRuns: modelTypeComparisonSweepConfig.parallelRuns || null,
      earlyStoppingEnabled: modelTypeComparisonSweepConfig.earlyStoppingEnabled ?? null,
      earlyStoppingPatience: modelTypeComparisonSweepConfig.earlyStoppingPatience || null,
      hyperparameterCount: modelTypeComparisonSweepConfig.hyperparameters.length,
      metricCount: modelTypeComparisonSweepConfig.metrics.length,
      insightCount: modelTypeComparisonSweepConfig.insights.length,
      createdAt: modelTypeComparisonSweepConfig.createdAt,
    },
    status: 'draft',
    runIds: [],
    createdAt: modelTypeComparisonSweepConfig.createdAt,
    progress: {
      completed: 0,
      total: 30,
      failed: 0,
      running: 0,
    },
  },
  {
    id: 'sweep-1',
    config: mockSweepConfigs[0],
    creationContext: {
      name: mockSweepConfigs[0].name,
      goal: mockSweepConfigs[0].goal,
      description: mockSweepConfigs[0].description,
      command: mockSweepConfigs[0].command,
      notes: mockSweepConfigs[0].notes || null,
      maxRuns: mockSweepConfigs[0].maxRuns || null,
      parallelRuns: mockSweepConfigs[0].parallelRuns || null,
      earlyStoppingEnabled: mockSweepConfigs[0].earlyStoppingEnabled ?? null,
      earlyStoppingPatience: mockSweepConfigs[0].earlyStoppingPatience || null,
      hyperparameterCount: mockSweepConfigs[0].hyperparameters.length,
      metricCount: mockSweepConfigs[0].metrics.length,
      insightCount: mockSweepConfigs[0].insights.length,
      createdAt: mockSweepConfigs[0].createdAt,
    },
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

// Optimized sweep config for sweep-1770657961524 (Pre-launch optimization)
export const optimizedSweepConfig1770657961524: SweepConfig = {
  id: 'sweep-config-1770657961524',
  name: 'Transformer Hyperparameter Optimization',
  description: 'Bayesian optimization sweep for optimal transformer training configuration with adaptive learning rates and regularization',
  goal: 'Minimize validation loss while maximizing convergence stability and computational efficiency',
  command: 'python train.py --model transformer --lr {learning_rate} --dropout {dropout} --attention-heads {attention_heads} --warmup-ratio {warmup_ratio} --weight-decay {weight_decay} --batch-size {batch_size} --epochs 50',
  hyperparameters: [
    // Learning rate with log-uniform sampling for better coverage
    {
      name: 'learning_rate',
      type: 'choice',
      values: [1e-5, 3e-5, 5e-5, 1e-4, 3e-4, 5e-4, 1e-3],
    },
    // Dropout for regularization
    {
      name: 'dropout',
      type: 'range',
      min: 0.0,
      max: 0.5,
      step: 0.05,
    },
    // Attention heads (architectural parameter)
    {
      name: 'attention_heads',
      type: 'choice',
      values: [4, 8, 12, 16],
    },
    // Warmup ratio for scheduler
    {
      name: 'warmup_ratio',
      type: 'choice',
      values: [0.0, 0.05, 0.1, 0.15, 0.2],
    },
    // Weight decay for regularization
    {
      name: 'weight_decay',
      type: 'choice',
      values: [0.0, 0.001, 0.01, 0.1],
    },
    // Batch size (memory vs speed tradeoff)
    {
      name: 'batch_size',
      type: 'choice',
      values: [16, 32, 64, 128],
    },
  ],
  metrics: [
    { name: 'Validation Loss', path: 'val/loss', goal: 'minimize', isPrimary: true },
    { name: 'Training Loss', path: 'train/loss', goal: 'minimize', isPrimary: false },
    { name: 'Validation Accuracy', path: 'val/accuracy', goal: 'maximize', isPrimary: false },
    { name: 'F1 Score', path: 'val/f1', goal: 'maximize', isPrimary: false },
    { name: 'Perplexity', path: 'val/perplexity', goal: 'minimize', isPrimary: false },
    { name: 'Learning Rate', path: 'train/learning_rate', goal: 'minimize', isPrimary: false },
  ],
  insights: [
    {
      id: 'stop-divergence',
      type: 'failure',
      condition: 'val/loss > 5 or train/loss > 10 or is_nan(val/loss)',
      description: 'Training divergence detected - loss exploding or NaN',
      action: 'Stop run immediately and report failure',
    },
    {
      id: 'stop-overfit',
      type: 'suspicious',
      condition: 'val/loss increases for 3 consecutive epochs and train/loss decreases',
      description: 'Overfitting detected - validation loss rising while training loss falling',
      action: 'Flag for early stopping consideration',
    },
    {
      id: 'stop-plateau',
      type: 'suspicious',
      condition: 'val/loss std < 0.001 for 10 consecutive epochs after epoch 20',
      description: 'Training plateau - no meaningful improvement',
      action: 'Stop to conserve compute resources',
    },
    {
      id: 'review-high-perf',
      type: 'review',
      condition: 'val/accuracy > 0.95',
      description: 'Suspiciously high accuracy - verify no data leakage',
      action: 'Human review required before deployment',
    },
    {
      id: 'stop-convergence',
      type: 'suspicious',
      condition: 'val/loss < 0.1 and train/loss < 0.1',
      description: 'Excellent convergence achieved',
      action: 'Stop early - save checkpoint for final evaluation',
    },
    {
      id: 'detect-oom-risk',
      type: 'failure',
      condition: 'gpu_memory_usage > 0.95',
      description: 'GPU memory critically high - OOM risk imminent',
      action: 'Stop run to prevent system crash',
    },
  ],
  maxRuns: 50,
  parallelRuns: 4,
  earlyStoppingEnabled: true,
  earlyStoppingPatience: 7,
  notes: 'Optimized for production launch: Bayesian search with multi-metric tracking, aggressive stopping for divergent runs, and comprehensive overfitting detection. Targeting < 0.3 val loss within 30 runs.',
  createdAt: new Date('2025-12-10'),
  updatedAt: new Date('2025-12-10'),
}

// Append after declaration to avoid temporal dead zone when this module initializes.
mockSweepConfigs.push(optimizedSweepConfig1770657961524)

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
