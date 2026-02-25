// ── Report Complete — worker signals task done ──

import { updateStatus, writeOutbox } from '../../agent-mailbox.js'
import { Type } from '@sinclair/typebox'

export default function createReportComplete(ctx = {}) {
    return {
        name: 'reportComplete',
        label: 'Report Complete',
        description: 'Report that your task is complete. Include a summary of what you did.',
        parameters: Type.Object({
            summary: Type.String({ description: 'Summary of completed work' }),
        }),
        execute: async (toolCallId, params) => {
            const agentId = ctx.agentId
            if (!agentId) return { content: [{ type: 'text', text: 'Error: no agentId' }], details: {} }
            updateStatus(agentId, { status: 'complete', result: params.summary, exitCode: 0 }, ctx.mailboxBase)
            writeOutbox(agentId, `[COMPLETE] ${params.summary}`, ctx.mailboxBase)
            return {
                content: [{ type: 'text', text: 'Task marked as complete' }],
                details: { agentId },
            }
        },
    }
}
