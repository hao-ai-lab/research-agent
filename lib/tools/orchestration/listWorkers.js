// ── List Workers — show all workers with status ──

import { loadRegistry, getStatus, readOutbox } from '../../agent-mailbox.js'
import { Type } from '@sinclair/typebox'

export default function createListWorkers(ctx = {}) {
    return {
        name: 'listWorkers',
        label: 'List Workers',
        description: 'List all worker agents and their current status.',
        parameters: Type.Object({}),
        execute: async (toolCallId, params) => {
            const mailboxBase = ctx.mailboxBase
            if (!mailboxBase) return { content: [{ type: 'text', text: 'Error: no mailboxBase' }], details: {} }

            const registry = loadRegistry(mailboxBase)
            const agents = Object.entries(registry.agents)
            if (agents.length === 0) {
                return { content: [{ type: 'text', text: 'No workers registered.' }], details: { count: 0 } }
            }

            const lines = agents.map(([id, info]) => {
                const status = getStatus(id, mailboxBase)
                const { messages } = readOutbox(id, 0, mailboxBase)
                const lastMsg = messages.length > 0 ? messages[messages.length - 1].content.slice(0, 100) : '(no output)'
                return `- ${id}: ${status?.status || 'unknown'} | task: ${info.task?.slice(0, 60) || '?'} | turns: ${status?.turns || 0} | last: ${lastMsg}`
            })

            return {
                content: [{ type: 'text', text: lines.join('\n') }],
                details: { count: agents.length },
            }
        },
    }
}
