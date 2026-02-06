import { SweepConfig, SweepHyperparameter, SweepMetric, SweepInsight } from './types'

// Define the hyperparameters
const learningRateHyperparameters: SweepHyperparameter[] = [
  {
    name: 'learning_rate',
    type: 'choice',
    values: [1e-5, 5e-5, 1e-4, 2e-4, 5e-4]
  },
  {
    name: 'batch_size',
    type: 'choice',
    values: [8, 16, 32]
  },
  {
    name: 'warmup_steps',
    type: 'choice',
    values: [100, 500]
  }
]

// Define the metrics to track
const sweepMetrics: SweepMetric[] = [
  {
    name: 'Validation Loss',
    path: 'validation_loss',
    goal: 'minimize',
    isPrimary: true
  },
  {
    name: 'Training Loss',
    path: 'train_loss',
    goal: 'minimize',
    isPrimary: false
  }
]

// Define potential insights
const sweepInsights: SweepInsight[] = [
  {
    id: 'lr_sensitivity',
    type: 'review',
    condition: 'Large variance in validation loss',
    description: 'Learning rate shows significant impact on model performance',
    action: 'Refine learning rate range'
  },
  {
    id: 'batch_size_impact',
    type: 'suspicious',
    condition: 'Performance drops with specific batch sizes',
    description: 'Investigate batch size interactions',
    action: 'Analyze batch size correlation'
  }
]

// Comprehensive Sweep Configuration
export const learningRateSweepConfig: SweepConfig = {
  id: 'lr_optimization_sweep_v1',
  name: 'Learning Rate Optimization Sweep',
  description: 'Systematic exploration of learning rates, batch sizes, and warmup strategies',
  goal: 'Minimize validation loss through optimal hyperparameter selection',
  command: 'python train.py',
  script: 'train_sweep.py',
  hyperparameters: learningRateHyperparameters,
  metrics: sweepMetrics,
  insights: sweepInsights,
  maxRuns: 50,
  parallelRuns: 4,
  earlyStoppingEnabled: true,
  earlyStoppingPatience: 5,
  createdAt: new Date(),
  updatedAt: new Date()
}