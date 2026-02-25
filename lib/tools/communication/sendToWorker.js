// ── Send to Worker — master → worker messaging ──

import { sendMessage } from '../../agent-mailbox.js'
import { Type } from '@sinclair/typebox'

export default function createSendToWorker(ctx = {}) {
    return {
        name: 'sendToWorker',
        label: 'Send to Worker',
        description: 'Send a message to a worker agent by ID.',
        parameters: Type.Object({
            workerId: Type.String({ description: 'Worker agent ID' }),
            message: Type.String({ description: 'Message to send' }),
        }),
        execute: async (toolCallId, params) => {
            sendMessage(params.workerId, params.message, ctx.mailboxBase)
            return {
                content: [{ type: 'text', text: `Message sent to worker ${params.workerId}` }],
                details: { to: params.workerId },
            }
        },
    }
}
