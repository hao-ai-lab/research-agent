'use client'

/**
 * API Client - Environment-based API switching
 * 
 * In development: Uses real backend at localhost:10000
 * On Vercel (NEXT_PUBLIC_USE_MOCK=true): Uses mock API with demo data
 */

const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK === 'true'

// Dynamically re-export based on environment
// Note: We use conditional exports to enable tree-shaking

export * from './api'

// Override with mock implementations when in mock mode
if (USE_MOCK) {
    console.log('[API] Running in MOCK mode - using demo data')
}

// For mock mode, we need to use dynamic imports at runtime
// This approach works with Next.js client components

import * as realApi from './api'
import * as mockApi from './api-mock'

const api = USE_MOCK ? mockApi : realApi

// Re-export all functions
export const listSessions = api.listSessions
export const createSession = api.createSession
export const getSession = api.getSession
export const deleteSession = api.deleteSession
export const streamChat = api.streamChat
export const checkApiHealth = api.checkApiHealth

export const listRuns = api.listRuns
export const createRun = api.createRun
export const getRun = api.getRun
export const startRun = api.startRun
export const stopRun = api.stopRun
export const archiveRun = api.archiveRun
export const unarchiveRun = api.unarchiveRun
export const getRunLogs = api.getRunLogs
export const streamRunLogs = api.streamRunLogs
export const getRunArtifacts = api.getRunArtifacts
export const queueRun = api.queueRun

export const listSweeps = api.listSweeps
export const createSweep = api.createSweep
export const getSweep = api.getSweep
export const startSweep = api.startSweep
