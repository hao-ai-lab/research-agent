// ── Bash Tool — shell execution with timeout ──

import { execSync } from 'child_process'

export default function createBash(ctx = {}) {
    return {
        name: 'bash',
        description: 'Execute a bash command. Returns stdout. Use for running scripts, checking files, installing packages, etc.',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'The bash command to execute' },
                timeout: { type: 'number', description: 'Timeout in seconds (default: 30)' },
            },
            required: ['command'],
        },
        execute: async ({ command, timeout = 30 }) => {
            try {
                const result = execSync(command, {
                    timeout: timeout * 1000,
                    maxBuffer: 1024 * 1024,
                    encoding: 'utf-8',
                    cwd: ctx.workspaceDir || process.cwd(),
                    env: { ...process.env, PAGER: 'cat' },
                })
                return result.trim() || '(no output)'
            } catch (err) {
                if (err.killed) return `Error: command timed out after ${timeout}s`
                return `Error (exit ${err.status}): ${err.stderr || err.message}`
            }
        },
    }
}
