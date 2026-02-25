// ── Write File Tool ──

import fs from 'fs'
import path from 'path'
import { Type } from '@sinclair/typebox'

export default function createWriteFile(ctx = {}) {
    return {
        name: 'writeFile',
        label: 'Write File',
        description: 'Write content to a file. Creates parent directories if needed.',
        parameters: Type.Object({
            filePath: Type.String({ description: 'Path to the file to write' }),
            content: Type.String({ description: 'Content to write' }),
        }),
        execute: async (toolCallId, params) => {
            try {
                const resolved = path.resolve(ctx.workspaceDir || process.cwd(), params.filePath)
                fs.mkdirSync(path.dirname(resolved), { recursive: true })
                fs.writeFileSync(resolved, params.content)
                return {
                    content: [{ type: 'text', text: `Written ${params.content.length} bytes to ${params.filePath}` }],
                    details: { path: resolved, bytesWritten: params.content.length },
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
