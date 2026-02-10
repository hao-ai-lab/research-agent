'use client'

/**
 * API Client - Runtime-configurable API switching
 * 
 * Uses localStorage for persistence (survives page refresh)
 * - API URL: configurable via Settings
 * - Mock mode: toggleable via Settings
 */

import { getApiUrl, isUsingMock } from './api-config'
import * as realApi from './api'
import * as mockApi from './api-mock'

// Export types from real API
export type {
    ChatSession,
    ChatMessageData,
    SessionWithMessages,
    StreamEventType,
    StreamEvent,
    RunStatus,
    Run,
    CreateRunRequest,
    RunRerunRequest,
    LogResponse,
    Artifact,
    Alert,
    Sweep,
    CreateSweepRequest,
    WildModeState,
    NotebookSession,
    CreateNotebookRequest,
    NotebookExecutionResult,
} from './api'

// Dynamic API selection based on runtime config
function getApi() {
    return isUsingMock() ? mockApi : realApi
}

// Re-export all functions with dynamic switching
export const listSessions = (...args: Parameters<typeof realApi.listSessions>) =>
    getApi().listSessions(...args)

export const createSession = (...args: Parameters<typeof realApi.createSession>) =>
    getApi().createSession(...args)

export const getSession = (...args: Parameters<typeof realApi.getSession>) =>
    getApi().getSession(...args)

export const deleteSession = (...args: Parameters<typeof realApi.deleteSession>) =>
    getApi().deleteSession(...args)

export const streamChat = (...args: Parameters<typeof realApi.streamChat>) =>
    getApi().streamChat(...args)

export const checkApiHealth = async (): Promise<boolean> => {
    if (isUsingMock()) {
        return true // Mock is always "healthy"
    }
    try {
        const response = await fetch(`${getApiUrl()}/`, {
            method: 'GET',
            signal: AbortSignal.timeout(5000)
        })
        return response.ok
    } catch {
        return false
    }
}

export const listRuns = (...args: Parameters<typeof realApi.listRuns>) =>
    getApi().listRuns(...args)

export const createRun = (...args: Parameters<typeof realApi.createRun>) =>
    getApi().createRun(...args)

export const getRun = (...args: Parameters<typeof realApi.getRun>) =>
    getApi().getRun(...args)

export const startRun = (...args: Parameters<typeof realApi.startRun>) =>
    getApi().startRun(...args)

export const stopRun = (...args: Parameters<typeof realApi.stopRun>) =>
    getApi().stopRun(...args)

export const rerunRun = (...args: Parameters<typeof realApi.rerunRun>) =>
    getApi().rerunRun(...args)

export const archiveRun = (...args: Parameters<typeof realApi.archiveRun>) =>
    getApi().archiveRun(...args)

export const unarchiveRun = (...args: Parameters<typeof realApi.unarchiveRun>) =>
    getApi().unarchiveRun(...args)

export const listAlerts = (...args: Parameters<typeof realApi.listAlerts>) =>
    getApi().listAlerts(...args)

export const respondToAlert = (...args: Parameters<typeof realApi.respondToAlert>) =>
    getApi().respondToAlert(...args)

export const stopSession = (...args: Parameters<typeof realApi.stopSession>) =>
    getApi().stopSession(...args)

export const getWildMode = (...args: Parameters<typeof realApi.getWildMode>) =>
    getApi().getWildMode(...args)

export const setWildMode = (...args: Parameters<typeof realApi.setWildMode>) =>
    getApi().setWildMode(...args)

export const getRunLogs = (...args: Parameters<typeof realApi.getRunLogs>) =>
    getApi().getRunLogs(...args)

export const streamRunLogs = (...args: Parameters<typeof realApi.streamRunLogs>) =>
    getApi().streamRunLogs(...args)

export const getRunArtifacts = (...args: Parameters<typeof realApi.getRunArtifacts>) =>
    getApi().getRunArtifacts(...args)

export const listNotebooks = (...args: Parameters<typeof realApi.listNotebooks>) =>
    getApi().listNotebooks(...args)

export const createNotebook = (...args: Parameters<typeof realApi.createNotebook>) =>
    getApi().createNotebook(...args)

export const executeNotebookCell = (...args: Parameters<typeof realApi.executeNotebookCell>) =>
    getApi().executeNotebookCell(...args)

export const stopNotebook = (...args: Parameters<typeof realApi.stopNotebook>) =>
    getApi().stopNotebook(...args)

export const queueRun = (...args: Parameters<typeof realApi.queueRun>) =>
    getApi().queueRun(...args)

export const listSweeps = (...args: Parameters<typeof realApi.listSweeps>) =>
    getApi().listSweeps(...args)

export const createSweep = (...args: Parameters<typeof realApi.createSweep>) =>
    getApi().createSweep(...args)

export const getSweep = (...args: Parameters<typeof realApi.getSweep>) =>
    getApi().getSweep(...args)

export const startSweep = (...args: Parameters<typeof realApi.startSweep>) =>
    getApi().startSweep(...args)
