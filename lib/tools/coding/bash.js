// ── Bash Tool — shell execution with timeout ──

import { execSync } from 'child_process'
import { Type } from '@sinclair/typebox'

export default function createBash(ctx = {}) {
    return {
        name: 'bash',
        label: 'Bash',
        description: 'Execute a bash command. Returns stdout and stderr.',
        parameters: Type.Object({
            command: Type.String({ description: 'The bash command to execute' }),
            timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds (default: 30)' })),
        }),
        execute: async (toolCallId, params) => {
            const timeoutMs = (params.timeout || 30) * 1000
            try {
                const output = execSync(params.command, {
                    timeout: timeoutMs,
                    maxBuffer: 1024 * 1024,
                    encoding: 'utf-8',
                    cwd: ctx.workspaceDir || process.cwd(),
                    env: { ...process.env, PAGER: 'cat' },
                    stdio: ['pipe', 'pipe', 'pipe'],
                })
                return {
                    content: [{ type: 'text', text: output?.trim() || '(no output)' }],
                    details: { exitCode: 0 },
                }
            } catch (err) {
                const output = (err.stdout || '') + (err.stderr || '')
                return {
                    content: [{ type: 'text', text: `Exit code ${err.status}: ${output || err.message}` }],
                    details: { exitCode: err.status, error: err.message, killed: err.killed },
                }
            }
        },
    }
}
