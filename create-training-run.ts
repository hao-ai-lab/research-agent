/**
 * Training Run Creator
 * Creates and starts a new training run
 */

import type { CreateRunRequest, Run } from './lib/api'
import { createRun, startRun } from './lib/api-client'

async function createTrainingRun(): Promise<string> {
  // Generate a unique run ID
  const timestamp = Date.now()
  const runId = `train-${timestamp}`
  
  // Define the training run configuration
  const runRequest: CreateRunRequest = {
    name: `Training Run ${new Date().toISOString().split('T')[0]}`,
    command: 'python train.py --model gpt-4-base --lr 0.0001 --batch-size 32 --epochs 25 --data ./data/training_set',
    workdir: './experiments',
    auto_start: true, // Automatically start the training
  }
  
  try {
    console.log('Creating training run...')
    console.log('Name:', runRequest.name)
    console.log('Command:', runRequest.command)
    console.log('Workdir:', runRequest.workdir)
    
    // Create the run
    const newRun: Run = await createRun(runRequest)
    
    console.log('\n✓ Training run created successfully!')
    console.log('Run ID:', newRun.id)
    console.log('Status:', newRun.status)
    
    // If auto_start is false, explicitly start the run
    if (!runRequest.auto_start && newRun.status !== 'running') {
      console.log('\nStarting training...')
      await startRun(newRun.id)
      console.log('✓ Training started!')
    }
    
    return newRun.id
  } catch (error) {
    console.error('Failed to create training run:', error)
    throw error
  }
}

// Execute the function
if (require.main === module) {
  createTrainingRun()
    .then((runId) => {
      console.log('\n========================================')
      console.log('TRAINING RUN ID:', runId)
      console.log('========================================')
      process.exit(0)
    })
    .catch((error) => {
      console.error('Error:', error)
      process.exit(1)
    })
}

export { createTrainingRun }
