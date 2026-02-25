// ── Spawn Worker — master spawns a worker subprocess ──

import { fork } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import { Type } from '@sinclair/typebox'
import { createMailbox, registerAgent } from '../../agent-mailbox.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const WORKER_ENTRY = path.resolve(__dirname, '../../worker-entry.js')

export default function createSpawnWorker(ctx = {}) {
    return {
        name: 'spawnWorker',
        label: 'Spawn Worker',
        description: 'Spawn a new worker agent as a subprocess to handle a task.',
        parameters: Type.Object({
            agentId: Type.String({ description: 'Unique ID for the worker (e.g. "analyzer-1")' }),
            task: Type.String({ description: 'Task description for the worker' }),
            type: Type.Optional(Type.String({ description: 'Worker type: "general" or "code"' })),
        }),
        execute: async (toolCallId, params) => {
            const mailboxBase = ctx.mailboxBase
            if (!mailboxBase) return { content: [{ type: 'text', text: 'Error: no mailboxBase' }], details: {} }

            createMailbox(params.agentId, mailboxBase)
            registerAgent(params.agentId, {
                task: params.task, type: params.type || 'general',
                status: 'starting', parentAgent: 'master',
            }, mailboxBase)

            const child = fork(WORKER_ENTRY, [
                '--id', params.agentId,
                '--mailbox', mailboxBase,
                '--task', params.task,
                '--type', params.type || 'general',
            ], { stdio: 'pipe', env: process.env })

            child.on('exit', (code) => {
                console.log(`[Master] Worker ${params.agentId} exited with code ${code}`)
            })

            if (ctx.onWorkerSpawned) ctx.onWorkerSpawned(params.agentId)

            return {
                content: [{ type: 'text', text: `Worker ${params.agentId} spawned (pid ${child.pid}). Check output with listWorkers.` }],
                details: { agentId: params.agentId, pid: child.pid },
            }
        },
    }
}
