// ── List Workers — show all workers with status ──

import { loadRegistry, getStatus, readOutbox } from '../../agent-mailbox.js'

export default function createListWorkers(ctx = {}) {
    return {
        name: 'listWorkers',
        description: 'List all worker agents and their current status.',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
            const mailboxBase = ctx.mailboxBase
            if (!mailboxBase) return 'Error: no mailboxBase in context'

            const registry = loadRegistry(mailboxBase)
            const agents = Object.entries(registry.agents)
            if (agents.length === 0) return 'No workers registered.'

            const lines = agents.map(([id, info]) => {
                const status = getStatus(id, mailboxBase)
                const { messages } = readOutbox(id, 0, mailboxBase)
                const lastMsg = messages.length > 0 ? messages[messages.length - 1].content.slice(0, 100) : '(no output)'
                return `- ${id}: ${status?.status || 'unknown'} | task: ${info.task?.slice(0, 60) || '?'} | turns: ${status?.turns || 0} | last: ${lastMsg}`
            })
            return lines.join('\n')
        },
    }
}
