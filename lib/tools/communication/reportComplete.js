// ── Report Complete — worker signals task done ──

import { updateStatus, writeOutbox } from '../../agent-mailbox.js'

export default function createReportComplete(ctx = {}) {
    return {
        name: 'reportComplete',
        description: 'Report that your task is complete. Include a summary of what you did.',
        parameters: {
            type: 'object',
            properties: {
                summary: { type: 'string', description: 'Summary of completed work' },
            },
            required: ['summary'],
        },
        execute: async ({ summary }) => {
            const agentId = ctx.agentId
            if (!agentId) return 'Error: no agentId in context'
            updateStatus(agentId, { status: 'complete', result: summary, exitCode: 0 }, ctx.mailboxBase)
            writeOutbox(agentId, `[COMPLETE] ${summary}`, ctx.mailboxBase)
            return 'Task marked as complete'
        },
    }
}
