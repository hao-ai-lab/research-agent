// ── Tools Index — barrel export + composers ──

import { loadCursors } from '../agent-mailbox.js'

// ── Individual tool factories ──

// Communication
import createSendToMaster from './communication/sendToMaster.js'
import createSendToWorker from './communication/sendToWorker.js'
import createReportComplete from './communication/reportComplete.js'

// Orchestration
import createSpawnWorker from './orchestration/spawnWorker.js'
import createListWorkers from './orchestration/listWorkers.js'

// Coding
import createReadFile from './coding/readFile.js'
import createWriteFile from './coding/writeFile.js'
import createBash from './coding/bash.js'
import createListFiles from './coding/listFiles.js'

export {
    createSendToMaster, createSendToWorker, createReportComplete,
    createSpawnWorker, createListWorkers,
    createReadFile, createWriteFile, createBash, createListFiles,
}

// ── Tool Registry ──

export const TOOL_REGISTRY = {
    communication: {
        description: 'Inter-agent messaging',
        tools: {
            sendToMaster: { factory: createSendToMaster, description: 'Worker → Master message' },
            sendToWorker: { factory: createSendToWorker, description: 'Master → Worker message' },
            reportComplete: { factory: createReportComplete, description: 'Worker signals completion' },
        },
    },
    orchestration: {
        description: 'Agent lifecycle — spawn and monitor workers',
        tools: {
            spawnWorker: { factory: createSpawnWorker, description: 'Spawn worker subprocess' },
            listWorkers: { factory: createListWorkers, description: 'List workers with status' },
        },
    },
    coding: {
        description: 'File I/O and shell execution',
        tools: {
            readFile: { factory: createReadFile, description: 'Read file contents' },
            writeFile: { factory: createWriteFile, description: 'Write file contents' },
            bash: { factory: createBash, description: 'Execute bash command' },
            listFiles: { factory: createListFiles, description: 'List directory contents' },
        },
    },
}

// ── Composers ──

export function createMasterTools(ctx = {}) {
    const cursors = loadCursors(ctx.mailboxBase)
    const sharedCtx = { ...ctx, cursors }
    return [
        createSpawnWorker(sharedCtx), createSendToWorker(sharedCtx),
        createListWorkers(sharedCtx),
    ]
}

export function createWorkerTools(ctx = {}) {
    return [createSendToMaster(ctx), createReportComplete(ctx)]
}

export function createCodingTools(ctx = {}) {
    return [createReadFile(ctx), createWriteFile(ctx), createBash(ctx), createListFiles(ctx)]
}

/**
 * Discover available tools as human-readable summary.
 */
export function discoverTools(categories) {
    const cats = categories
        ? Object.entries(TOOL_REGISTRY).filter(([k]) => categories.includes(k))
        : Object.entries(TOOL_REGISTRY)
    return cats.map(([cat, { description, tools }]) => {
        const list = Object.entries(tools).map(([n, t]) => `  - ${n}: ${t.description}`).join('\n')
        return `[${cat}] ${description}\n${list}`
    }).join('\n\n')
}
