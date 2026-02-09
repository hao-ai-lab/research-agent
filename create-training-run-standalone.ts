/**
 * Training Run Creator - Standalone Script
 * Creates and starts a new training run with mock API
 * Run with: npx ts-node create-training-run-standalone.ts
 */

// Generate a unique ID
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 7)
}

// Delay function to simulate API latency
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Run type definition
interface Run {
  id: string
  name: string
  command: string
  workdir?: string
  status: 'ready' | 'queued' | 'launching' | 'running' | 'finished' | 'failed' | 'stopped'
  is_archived: boolean
  created_at: number
  started_at?: number
  stopped_at?: number
  ended_at?: number
  sweep_id?: string
  parent_run_id?: string | null
  origin_alert_id?: string | null
  exit_code?: number | null
  error?: string | null
  tmux_window?: string
  tmux_pane?: string
  run_dir?: string
  progress?: number
}

// Create run request interface
interface CreateRunRequest {
  name: string
  command: string
  workdir?: string
  sweep_id?: string
  parent_run_id?: string
  origin_alert_id?: string
  auto_start?: boolean
}

// In-memory store for mock runs
const mockRuns: Map<string, Run> = new Map()

// Create a new run
async function createRun(request: CreateRunRequest): Promise<Run> {
  await delay(200)
  const id = `run-${generateId()}`
  const run: Run = {
    id,
    name: request.name,
    command: request.command,
    workdir: request.workdir || '/workspace',
    status: request.auto_start ? 'queued' : 'ready',
    is_archived: false,
    parent_run_id: request.parent_run_id || null,
    origin_alert_id: request.origin_alert_id || null,
    created_at: Date.now() / 1000,
    sweep_id: request.sweep_id,
  }
  mockRuns.set(id, run)
  return run
}

// Start a run
async function startRun(runId: string): Promise<{ message: string; tmux_window: string }> {
  await delay(300)
  const run = mockRuns.get(runId)
  if (!run) {
    throw new Error('Run not found')
  }
  run.status = 'running'
  run.started_at = Date.now() / 1000
  run.tmux_window = `ra-${runId.substring(0, 8)}`
  run.progress = 0
  return { message: 'Run started', tmux_window: run.tmux_window }
}

// Main function to create and start training
async function createAndStartTraining(): Promise<string> {
  const timestamp = new Date().toISOString().split('T')[0]
  
  console.log('🏃 Creating training run...\n')
  
  // Create the run request
  const runRequest: CreateRunRequest = {
    name: `Training Run ${timestamp}`,
    command: 'python train.py --model transformer-base --lr 0.0001 --batch-size 32 --epochs 50 --data ./data/training',
    workdir: './experiments',
    auto_start: true,
  }
  
  console.log('Configuration:')
  console.log('  Name:', runRequest.name)
  console.log('  Command:', runRequest.command)
  console.log('  Workdir:', runRequest.workdir)
  console.log('  Auto-start:', runRequest.auto_start)
  console.log()
  
  // Create the run
  const newRun = await createRun(runRequest)
  console.log('✓ Run created')
  console.log('  ID:', newRun.id)
  console.log('  Status:', newRun.status)
  console.log('  Created at:', new Date(newRun.created_at * 1000).toISOString())
  console.log()
  
  // Start the run
  console.log('▶️  Starting training...')
  const startResult = await startRun(newRun.id)
  console.log('✓ Training started')
  console.log('  tmux window:', startResult.tmux_window)
  console.log()
  
  // Get updated run info
  const runningRun = mockRuns.get(newRun.id)!
  
  console.log('Training is now running!')
  console.log('  Status:', runningRun.status)
  console.log('  Started at:', new Date(runningRun.started_at! * 1000).toISOString())
  console.log()
  
  return newRun.id
}

// Execute
createAndStartTraining()
  .then((runId) => {
    console.log('='.repeat(60))
    console.log('TRAINING RUN ID:', runId)
    console.log('='.repeat(60))
    process.exit(0)
  })
  .catch((error) => {
    console.error('❌ Error:', error)
    process.exit(1)
  })

export { createAndStartTraining }
