// ── List Files Tool ──

import fs from 'fs'
import path from 'path'

export default function createListFiles(ctx = {}) {
    return {
        name: 'listFiles',
        description: 'List files and directories at a given path.',
        parameters: {
            type: 'object',
            properties: {
                dirPath: { type: 'string', description: 'Directory path to list (default: cwd)' },
                recursive: { type: 'boolean', description: 'If true, list recursively' },
            },
        },
        execute: async ({ dirPath = '.', recursive = false }) => {
            try {
                const resolved = path.resolve(ctx.workspaceDir || process.cwd(), dirPath)
                const entries = fs.readdirSync(resolved, { withFileTypes: true })
                const lines = entries.map(e => {
                    const prefix = e.isDirectory() ? '📁' : '📄'
                    return `${prefix} ${e.name}`
                })
                return lines.join('\n') || '(empty directory)'
            } catch (err) {
                return `Error: ${err.message}`
            }
        },
    }
}
