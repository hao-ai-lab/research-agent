// ── Agent Session Manager ──
// Manages long-lived Agent instances keyed by session ID.

import path from 'path'
import fs from 'fs'
import os from 'os'
import { createMasterAgent } from './agent-engine.js'

const SESSION_TTL_MS = 30 * 60 * 1000 // 30 min inactivity

const sessions = new Map()

/**
 * Get or create an agent session.
 */
export function getOrCreateSession(sessionId, config = {}) {
    if (sessions.has(sessionId)) {
        const session = sessions.get(sessionId)
        session.lastAccess = Date.now()
        return session
    }

    const mailboxBase = path.join(os.tmpdir(), 'agent-sessions', sessionId)
    fs.mkdirSync(mailboxBase, { recursive: true })

    const agent = createMasterAgent({ ...config, mailboxBase })

    const session = {
        sessionId,
        agent,
        mailboxBase,
        createdAt: Date.now(),
        lastAccess: Date.now(),
    }

    sessions.set(sessionId, session)
    return session
}

export function listSessions() {
    return Array.from(sessions.entries()).map(([id, s]) => ({
        sessionId: id,
        createdAt: s.createdAt,
        lastAccess: s.lastAccess,
        ageSec: Math.round((Date.now() - s.createdAt) / 1000),
    }))
}

export function destroySession(sessionId) {
    const session = sessions.get(sessionId)
    if (!session) return false
    try { fs.rmSync(session.mailboxBase, { recursive: true, force: true }) } catch { }
    sessions.delete(sessionId)
    return true
}

export function cleanupSessions() {
    const now = Date.now()
    for (const [id, session] of sessions) {
        if (now - session.lastAccess > SESSION_TTL_MS) {
            destroySession(id)
        }
    }
}

setInterval(cleanupSessions, 5 * 60 * 1000).unref()
