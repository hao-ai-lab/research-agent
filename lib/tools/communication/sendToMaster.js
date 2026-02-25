// ── Send to Master — worker → master messaging ──

import { writeOutbox } from '../../agent-mailbox.js'
import { Type } from '@sinclair/typebox'

export default function createSendToMaster(ctx = {}) {
    return {
        name: 'sendToMaster',
        label: 'Send to Master',
        description: 'Send a message to the master agent (your supervisor). Use to report progress or ask questions.',
        parameters: Type.Object({
            message: Type.String({ description: 'Message to send to master' }),
        }),
        execute: async (toolCallId, params) => {
            const agentId = ctx.agentId
            if (!agentId) return { content: [{ type: 'text', text: 'Error: no agentId' }], details: {} }
            writeOutbox(agentId, params.message, ctx.mailboxBase)
            return {
                content: [{ type: 'text', text: `Message sent to master from ${agentId}` }],
                details: { from: agentId },
            }
        },
    }
}
