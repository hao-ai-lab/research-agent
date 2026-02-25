// ── Send to Worker — master → worker messaging ──

import { sendMessage } from '../../agent-mailbox.js'

export default function createSendToWorker(ctx = {}) {
    return {
        name: 'sendToWorker',
        description: 'Send a message to a worker agent by ID.',
        parameters: {
            type: 'object',
            properties: {
                workerId: { type: 'string', description: 'Worker agent ID' },
                message: { type: 'string', description: 'Message to send' },
            },
            required: ['workerId', 'message'],
        },
        execute: async ({ workerId, message }) => {
            sendMessage(workerId, message, ctx.mailboxBase)
            return `Message sent to worker ${workerId}`
        },
    }
}
