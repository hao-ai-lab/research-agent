// ── Read File Tool ──

import fs from 'fs'
import path from 'path'

export default function createReadFile(ctx = {}) {
    return {
        name: 'readFile',
        description: 'Read the contents of a file.',
        parameters: {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: 'Path to the file to read' },
            },
            required: ['filePath'],
        },
        execute: async ({ filePath }) => {
            try {
                const resolved = path.resolve(ctx.workspaceDir || process.cwd(), filePath)
                return fs.readFileSync(resolved, 'utf-8')
            } catch (err) {
                return `Error: ${err.message}`
            }
        },
    }
}
