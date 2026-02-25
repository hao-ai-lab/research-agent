// ── Read File Tool ──

import fs from 'fs'
import path from 'path'
import { Type } from '@sinclair/typebox'

export default function createReadFile(ctx = {}) {
    return {
        name: 'readFile',
        label: 'Read File',
        description: 'Read the contents of a file.',
        parameters: Type.Object({
            filePath: Type.String({ description: 'Path to the file to read' }),
        }),
        execute: async (toolCallId, params) => {
            try {
                const resolved = path.resolve(ctx.workspaceDir || process.cwd(), params.filePath)
                const content = fs.readFileSync(resolved, 'utf-8')
                return {
                    content: [{ type: 'text', text: content }],
                    details: { path: resolved, size: content.length },
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
