// ── List Files Tool ──

import fs from 'fs'
import path from 'path'
import { Type } from '@sinclair/typebox'

export default function createListFiles(ctx = {}) {
    return {
        name: 'listFiles',
        label: 'List Files',
        description: 'List files and directories at a given path.',
        parameters: Type.Object({
            dirPath: Type.Optional(Type.String({ description: 'Directory path to list (default: cwd)' })),
        }),
        execute: async (toolCallId, params) => {
            try {
                const resolved = path.resolve(ctx.workspaceDir || process.cwd(), params.dirPath || '.')
                const entries = fs.readdirSync(resolved, { withFileTypes: true })
                const lines = entries.map(e => {
                    const prefix = e.isDirectory() ? '📁' : '📄'
                    return `${prefix} ${e.name}`
                })
                const text = lines.join('\n') || '(empty directory)'
                return {
                    content: [{ type: 'text', text }],
                    details: { path: resolved, count: entries.length },
                }
            } catch (err) {
                return {
                    content: [{ type: 'text', text: `Error: ${err.message}` }],
                    details: { error: err.message },
                }
            }
        },
    }
}
