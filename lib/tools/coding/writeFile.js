// ── Write File Tool ──

import fs from 'fs'
import path from 'path'

export default function createWriteFile(ctx = {}) {
    return {
        name: 'writeFile',
        description: 'Write content to a file. Creates parent directories if needed.',
        parameters: {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: 'Path to the file to write' },
                content: { type: 'string', description: 'Content to write' },
            },
            required: ['filePath', 'content'],
        },
        execute: async ({ filePath, content }) => {
            try {
                const resolved = path.resolve(ctx.workspaceDir || process.cwd(), filePath)
                fs.mkdirSync(path.dirname(resolved), { recursive: true })
                fs.writeFileSync(resolved, content)
                return `Written ${content.length} bytes to ${filePath}`
            } catch (err) {
                return `Error: ${err.message}`
            }
        },
    }
}
