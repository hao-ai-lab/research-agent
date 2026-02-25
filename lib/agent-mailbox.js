// ── Agent Mailbox — file-based inter-agent communication ──
// Each agent: .agents/mailbox/<id>/{inbox.jsonl, outbox.jsonl, status.json}

import fs from 'fs'
import path from 'path'

const DEFAULT_MAILBOX_BASE = path.join(process.cwd(), '.agents', 'mailbox')

// ── Directory setup ──

export function getMailboxDir(agentId, baseDir = DEFAULT_MAILBOX_BASE) {
    return path.join(baseDir, agentId)
}

export function createMailbox(agentId, baseDir = DEFAULT_MAILBOX_BASE) {
    const dir = getMailboxDir(agentId, baseDir)
    fs.mkdirSync(dir, { recursive: true })
    const inbox = path.join(dir, 'inbox.jsonl')
    const outbox = path.join(dir, 'outbox.jsonl')
    const status = path.join(dir, 'status.json')
    if (!fs.existsSync(inbox)) fs.writeFileSync(inbox, '')
    if (!fs.existsSync(outbox)) fs.writeFileSync(outbox, '')
    if (!fs.existsSync(status)) {
        fs.writeFileSync(status, JSON.stringify({
            status: 'starting', agentId, task: '', pid: null,
            result: null, exitCode: null, createdAt: Date.now(),
        }))
    }
    return { dir, inbox, outbox, status }
}

// ── JSONL I/O ──

function appendJsonl(filePath, obj) {
    fs.appendFileSync(filePath, JSON.stringify(obj) + '\n')
}

function readJsonl(filePath) {
    if (!fs.existsSync(filePath)) return []
    const content = fs.readFileSync(filePath, 'utf-8').trim()
    if (!content) return []
    return content.split('\n').map(line => {
        try { return JSON.parse(line) }
        catch { return null }
    }).filter(Boolean)
}

function readNewJsonl(filePath, afterLine = 0) {
    const all = readJsonl(filePath)
    return { messages: all.slice(afterLine), totalLines: all.length }
}

// ── Send / Read ──

export function sendMessage(agentId, message, baseDir = DEFAULT_MAILBOX_BASE) {
    const inbox = path.join(getMailboxDir(agentId, baseDir), 'inbox.jsonl')
    const msg = {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        content: message,
        timestamp: Date.now(),
    }
    appendJsonl(inbox, msg)
    return msg
}

/**
 * Send a steer message — tagged [STEER] for urgent course correction.
 */
export function sendSteer(agentId, message, baseDir = DEFAULT_MAILBOX_BASE) {
    return sendMessage(agentId, `[STEER] ${message}`, baseDir)
}

/**
 * Queue a task — untagged, processed FIFO after current work.
 */
export function queueTask(agentId, task, baseDir = DEFAULT_MAILBOX_BASE) {
    return sendMessage(agentId, task, baseDir)
}

export function writeOutbox(agentId, message, baseDir = DEFAULT_MAILBOX_BASE) {
    const outbox = path.join(getMailboxDir(agentId, baseDir), 'outbox.jsonl')
    const msg = {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        from: agentId,
        content: message,
        timestamp: Date.now(),
    }
    appendJsonl(outbox, msg)
    return msg
}

export function readInbox(agentId, afterLine = 0, baseDir = DEFAULT_MAILBOX_BASE) {
    const inbox = path.join(getMailboxDir(agentId, baseDir), 'inbox.jsonl')
    return readNewJsonl(inbox, afterLine)
}

export function readOutbox(agentId, afterLine = 0, baseDir = DEFAULT_MAILBOX_BASE) {
    const outbox = path.join(getMailboxDir(agentId, baseDir), 'outbox.jsonl')
    return readNewJsonl(outbox, afterLine)
}

// ── Status ──

export function updateStatus(agentId, updates, baseDir = DEFAULT_MAILBOX_BASE) {
    const statusPath = path.join(getMailboxDir(agentId, baseDir), 'status.json')
    let current = {}
    try { current = JSON.parse(fs.readFileSync(statusPath, 'utf-8')) } catch { }
    const updated = { ...current, ...updates, updatedAt: Date.now() }
    fs.writeFileSync(statusPath, JSON.stringify(updated, null, 2))
    return updated
}

export function getStatus(agentId, baseDir = DEFAULT_MAILBOX_BASE) {
    const statusPath = path.join(getMailboxDir(agentId, baseDir), 'status.json')
    try { return JSON.parse(fs.readFileSync(statusPath, 'utf-8')) }
    catch { return null }
}

// ── Registry ──

function getRegistryPath(baseDir = DEFAULT_MAILBOX_BASE) {
    return path.join(baseDir, 'registry.json')
}

export function loadRegistry(baseDir = DEFAULT_MAILBOX_BASE) {
    const p = getRegistryPath(baseDir)
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')) }
    catch { return { agents: {} } }
}

export function saveRegistry(registry, baseDir = DEFAULT_MAILBOX_BASE) {
    fs.mkdirSync(baseDir, { recursive: true })
    fs.writeFileSync(getRegistryPath(baseDir), JSON.stringify(registry, null, 2))
}

export function registerAgent(agentId, info, baseDir = DEFAULT_MAILBOX_BASE) {
    const registry = loadRegistry(baseDir)
    registry.agents[agentId] = { ...info, agentId, registeredAt: Date.now() }
    saveRegistry(registry, baseDir)
    return registry.agents[agentId]
}

export function unregisterAgent(agentId, baseDir = DEFAULT_MAILBOX_BASE) {
    const registry = loadRegistry(baseDir)
    delete registry.agents[agentId]
    saveRegistry(registry, baseDir)
}

export function findAgentsByWorkspace(workspace, baseDir = DEFAULT_MAILBOX_BASE) {
    const registry = loadRegistry(baseDir)
    return Object.entries(registry.agents)
        .filter(([, info]) => info.workspace === workspace)
        .map(([id, info]) => ({ agentId: id, ...info }))
}

// ── Polling / Signal detection ──

export function pollSignals(outboxCursors = {}, baseDir = DEFAULT_MAILBOX_BASE) {
    const registry = loadRegistry(baseDir)
    const signals = []

    for (const [agentId] of Object.entries(registry.agents)) {
        const status = getStatus(agentId, baseDir)
        if (status && (status.status === 'complete' || status.status === 'error')) {
            signals.push({
                type: 'agent_exit', agentId,
                status: status.status, result: status.result, exitCode: status.exitCode,
            })
        }
        const cursor = outboxCursors[agentId] || 0
        const { messages, totalLines } = readOutbox(agentId, cursor, baseDir)
        if (messages.length > 0) {
            signals.push({ type: 'agent_message', agentId, messages, newCursor: totalLines })
        }
    }
    return signals
}

// ── Cursor persistence ──

function getCursorsPath(baseDir = DEFAULT_MAILBOX_BASE) {
    return path.join(baseDir, 'cursors.json')
}

export function saveCursors(cursors, baseDir = DEFAULT_MAILBOX_BASE) {
    fs.mkdirSync(baseDir, { recursive: true })
    fs.writeFileSync(getCursorsPath(baseDir), JSON.stringify(cursors, null, 2))
}

export function loadCursors(baseDir = DEFAULT_MAILBOX_BASE) {
    const p = getCursorsPath(baseDir)
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')) }
    catch { return {} }
}
