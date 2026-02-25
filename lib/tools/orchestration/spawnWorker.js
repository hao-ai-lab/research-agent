// ── Spawn Worker — master spawns a worker subprocess ──

import { fork } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import { createMailbox, registerAgent } from '../../agent-mailbox.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const WORKER_ENTRY = path.resolve(__dirname, '../../worker-entry.js')

export default function createSpawnWorker(ctx = {}) {
    return {
        name: 'spawnWorker',
        description: 'Spawn a new worker agent as a subprocess to handle a task. The worker runs independently and reports back via mailbox.',
        parameters: {
            type: 'object',
            properties: {
                agentId: { type: 'string', description: 'Unique ID for the worker (e.g. "analyzer-1")' },
                task: { type: 'string', description: 'Task description for the worker' },
                type: { type: 'string', description: 'Worker type: "general" or "code"', default: 'general' },
            },
            required: ['agentId', 'task'],
        },
        execute: async ({ agentId, task, type = 'general' }) => {
            const mailboxBase = ctx.mailboxBase
            if (!mailboxBase) return 'Error: no mailboxBase in context'

            createMailbox(agentId, mailboxBase)
            registerAgent(agentId, { task, type, status: 'starting', parentAgent: 'master' }, mailboxBase)

            const child = fork(WORKER_ENTRY, [
                '--id', agentId,
                '--mailbox', mailboxBase,
                '--task', task,
                '--type', type,
            ], {
                stdio: 'pipe',
                env: process.env,
            })

            child.on('exit', (code) => {
                console.log(`[Master] Worker ${agentId} exited with code ${code}`)
            })

            if (ctx.onWorkerSpawned) ctx.onWorkerSpawned(agentId)

            return `Worker ${agentId} spawned (pid ${child.pid}). Check output with listWorkers.`
        },
    }
}
