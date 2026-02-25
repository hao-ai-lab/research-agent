// ── Send to Master — worker → master messaging ──

import { writeOutbox } from '../../agent-mailbox.js'

export default function createSendToMaster(ctx = {}) {
    return {
        name: 'sendToMaster',
        description: 'Send a message to the master agent (your supervisor). Use to report progress or ask questions.',
        parameters: {
            type: 'object',
            properties: {
                message: { type: 'string', description: 'Message to send to master' },
            },
            required: ['message'],
        },
        execute: async ({ message }) => {
            const agentId = ctx.agentId
            if (!agentId) return 'Error: no agentId in context'
            writeOutbox(agentId, message, ctx.mailboxBase)
            return `Message sent to master from ${agentId}`
        },
    }
}
