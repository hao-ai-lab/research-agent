'use client'

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'

// Storage keys
const STORAGE_KEY_API_URL = 'research-agent-api-url'
const STORAGE_KEY_USE_MOCK = 'research-agent-use-mock'
const STORAGE_KEY_AUTH_TOKEN = 'research-agent-auth-token'
const STORAGE_KEY_RESEARCH_AGENT_KEY = 'research-agent-key'
const STORAGE_KEY_TELEMETRY_URL = 'research-agent-telemetry-url'

const DEFAULT_TELEMETRY_URL = process.env.NEXT_PUBLIC_TELEMETRY_URL || ''

// Default values (can be overridden via env vars for CI)
const DEFAULT_API_URL = process.env.NEXT_PUBLIC_DEFAULT_SERVER_URL || 'http://localhost:10000'
const DEFAULT_AUTH_TOKEN = process.env.NEXT_PUBLIC_DEFAULT_AUTH_TOKEN || ''
const DEFAULT_USE_MOCK = false
const ENV_API_URL = process.env.NEXT_PUBLIC_API_URL || ''

interface LinkSetupConfig {
    apiUrl?: string
    authToken?: string
}

function resolveEnvApiUrl(): string {
    if (ENV_API_URL === 'auto') {
        if (typeof window === 'undefined') {
            return ''
        }
        return window.location.origin
    }
    return ENV_API_URL
}

function decodeBase64Url(value: string): string | null {
    try {
        const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
        const paddingLength = (4 - (normalized.length % 4)) % 4
        const padded = normalized + '='.repeat(paddingLength)
        return atob(padded)
    } catch {
        return null
    }
}

function encodeBase64Url(value: string): string {
    return btoa(value)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '')
}

export function createSetupShareLink(config: { apiUrl: string; authToken: string }): string | null {
    if (typeof window === 'undefined') {
        return null
    }

    const nextApiUrl = config.apiUrl.trim()
    const nextAuthToken = config.authToken.trim()
    if (!nextApiUrl || !nextAuthToken) {
        return null
    }

    const encodedSetup = encodeBase64Url(JSON.stringify({
        apiUrl: nextApiUrl,
        authToken: nextAuthToken,
    }))

    const baseUrl = `${window.location.origin}${window.location.pathname}`
    return `${baseUrl}#setup=${encodedSetup}`
}

function parseLinkSetupConfig(): LinkSetupConfig | null {
    if (typeof window === 'undefined') {
        return null
    }

    const hash = window.location.hash?.startsWith('#')
        ? window.location.hash.slice(1)
        : window.location.hash
    if (!hash) {
        return null
    }

    const params = new URLSearchParams(hash)
    const encodedSetup = params.get('setup')
    if (!encodedSetup) {
        return null
    }

    const decoded = decodeBase64Url(encodedSetup)
    if (!decoded) {
        return null
    }

    try {
        const parsed = JSON.parse(decoded)
        if (!parsed || typeof parsed !== 'object') {
            return null
        }

        const nextConfig: LinkSetupConfig = {}
        if (typeof parsed.apiUrl === 'string' && parsed.apiUrl.length <= 2048) {
            nextConfig.apiUrl = parsed.apiUrl.trim()
        }
        if (typeof parsed.authToken === 'string' && parsed.authToken.length <= 512) {
            nextConfig.authToken = parsed.authToken.trim()
        }

        return (nextConfig.apiUrl || nextConfig.authToken) ? nextConfig : null
    } catch {
        return null
    }
}

function clearLinkSetupHash(): void {
    if (typeof window === 'undefined') {
        return
    }
    if (!window.location.hash) {
        return
    }
    const cleanUrl = `${window.location.pathname}${window.location.search}`
    window.history.replaceState(window.history.state, '', cleanUrl)
}

interface ApiConfig {
    apiUrl: string
    useMock: boolean
    authToken: string
    researchAgentKey: string
    setApiUrl: (url: string) => void
    setUseMock: (useMock: boolean) => void
    setAuthToken: (token: string) => void
    setResearchAgentKey: (key: string) => void
    resetToDefaults: () => void
    testConnection: (overrides?: { apiUrl?: string; authToken?: string; researchAgentKey?: string }) => Promise<boolean>
}

const ApiConfigContext = createContext<ApiConfig | null>(null)

/**
 * Get the current API URL from localStorage or default
 * This can be called outside of React components
 */
export function getApiUrl(): string {
    if (typeof window === 'undefined') {
        return resolveEnvApiUrl() || DEFAULT_API_URL
    }

    const stored = localStorage.getItem(STORAGE_KEY_API_URL)
    return stored || resolveEnvApiUrl() || DEFAULT_API_URL
}

/**
 * Check if mock mode is enabled
 * This can be called outside of React components
 * Pure runtime behavior - defaults to false (demo mode off)
 */
export function isUsingMock(): boolean {
    if (typeof window === 'undefined') {
        return DEFAULT_USE_MOCK
    }

    const stored = localStorage.getItem(STORAGE_KEY_USE_MOCK)
    if (stored !== null) {
        return stored === 'true'
    }
    return DEFAULT_USE_MOCK
}

/**
 * Get the auth token from localStorage
 * This can be called outside of React components
 */
export function getAuthToken(): string {
    if (typeof window === 'undefined') {
        return ''
    }
    return localStorage.getItem(STORAGE_KEY_AUTH_TOKEN) || ''
}

/**
 * Get the RESEARCH_AGENT_KEY from localStorage
 * This can be called outside of React components
 */
export function getResearchAgentKey(): string {
    if (typeof window === 'undefined') {
        return ''
    }
    return localStorage.getItem(STORAGE_KEY_RESEARCH_AGENT_KEY) || ''
}

/**
 * Get the telemetry endpoint URL from localStorage or env default.
 * Returns empty string when telemetry is disabled.
 */
export function getTelemetryUrl(): string {
    if (typeof window === 'undefined') {
        return ''
    }
    return localStorage.getItem(STORAGE_KEY_TELEMETRY_URL) || DEFAULT_TELEMETRY_URL
}

export function ApiConfigProvider({ children }: { children: React.ReactNode }) {
    const [apiUrl, setApiUrlState] = useState<string>(DEFAULT_API_URL)
    const [useMock, setUseMockState] = useState<boolean>(DEFAULT_USE_MOCK)
    const [authToken, setAuthTokenState] = useState<string>(DEFAULT_AUTH_TOKEN)
    const [researchAgentKey, setResearchAgentKeyState] = useState<string>('')
    const [isHydrated, setIsHydrated] = useState(false)

    // Load from localStorage on mount
    useEffect(() => {
        const storedUrl = localStorage.getItem(STORAGE_KEY_API_URL)
        const storedMock = localStorage.getItem(STORAGE_KEY_USE_MOCK)
        const storedToken = localStorage.getItem(STORAGE_KEY_AUTH_TOKEN)
        const storedResearchAgentKey = localStorage.getItem(STORAGE_KEY_RESEARCH_AGENT_KEY)
        const setupConfig = parseLinkSetupConfig()

        if (setupConfig?.apiUrl) {
            setApiUrlState(setupConfig.apiUrl)
            localStorage.setItem(STORAGE_KEY_API_URL, setupConfig.apiUrl)
        } else if (storedUrl) {
            setApiUrlState(storedUrl)
        } else if (process.env.NEXT_PUBLIC_DEFAULT_SERVER_URL) {
            // CI: persist the explicit default so auto-resolve doesn't override it
            setApiUrlState(DEFAULT_API_URL)
            localStorage.setItem(STORAGE_KEY_API_URL, DEFAULT_API_URL)
        } else {
            const envApiUrl = resolveEnvApiUrl()
            if (envApiUrl) {
                setApiUrlState(envApiUrl)
            }
        }

        // Use localStorage value or keep default (false)
        if (storedMock !== null) {
            setUseMockState(storedMock === 'true')
        }
        // If no stored value, keep the default (false - demo mode off)

        if (typeof setupConfig?.authToken === 'string') {
            setAuthTokenState(setupConfig.authToken)
            if (setupConfig.authToken) {
                localStorage.setItem(STORAGE_KEY_AUTH_TOKEN, setupConfig.authToken)
            } else {
                localStorage.removeItem(STORAGE_KEY_AUTH_TOKEN)
            }
        } else if (storedToken) {
            setAuthTokenState(storedToken)
        } else if (DEFAULT_AUTH_TOKEN) {
            setAuthTokenState(DEFAULT_AUTH_TOKEN)
            localStorage.setItem(STORAGE_KEY_AUTH_TOKEN, DEFAULT_AUTH_TOKEN)
        }

        if (storedResearchAgentKey) {
            setResearchAgentKeyState(storedResearchAgentKey)
        }

        if (setupConfig) {
            clearLinkSetupHash()
        }

        setIsHydrated(true)
    }, [])

    const setApiUrl = useCallback((url: string) => {
        setApiUrlState(url)
        localStorage.setItem(STORAGE_KEY_API_URL, url)
    }, [])

    const setUseMock = useCallback((mock: boolean) => {
        setUseMockState(mock)
        localStorage.setItem(STORAGE_KEY_USE_MOCK, String(mock))
    }, [])

    const setAuthToken = useCallback((token: string) => {
        setAuthTokenState(token)
        if (token) {
            localStorage.setItem(STORAGE_KEY_AUTH_TOKEN, token)
        } else {
            localStorage.removeItem(STORAGE_KEY_AUTH_TOKEN)
        }
    }, [])

    const setResearchAgentKey = useCallback((key: string) => {
        setResearchAgentKeyState(key)
        if (key) {
            localStorage.setItem(STORAGE_KEY_RESEARCH_AGENT_KEY, key)
        } else {
            localStorage.removeItem(STORAGE_KEY_RESEARCH_AGENT_KEY)
        }
    }, [])

    const resetToDefaults = useCallback(() => {
        localStorage.removeItem(STORAGE_KEY_API_URL)
        localStorage.removeItem(STORAGE_KEY_USE_MOCK)
        localStorage.removeItem(STORAGE_KEY_AUTH_TOKEN)
        localStorage.removeItem(STORAGE_KEY_RESEARCH_AGENT_KEY)
        setApiUrlState(resolveEnvApiUrl() || DEFAULT_API_URL)
        setUseMockState(DEFAULT_USE_MOCK)
        setAuthTokenState('')
        setResearchAgentKeyState('')
    }, [])

    const testConnection = useCallback(async (
        overrides?: { apiUrl?: string; authToken?: string; researchAgentKey?: string }
    ): Promise<boolean> => {
        if (useMock) {
            return true // Mock is always "connected"
        }

        const targetApiUrl = (overrides?.apiUrl ?? apiUrl).trim()
        const targetAuthToken = overrides?.authToken ?? authToken
        const targetResearchAgentKey = (overrides?.researchAgentKey ?? researchAgentKey).trim()

        try {
            const headers: HeadersInit = {}
            if (targetAuthToken) {
                headers['X-Auth-Token'] = targetAuthToken
            }
            if (targetResearchAgentKey) {
                headers['X-Research-Agent-Key'] = targetResearchAgentKey
            }

            const response = await fetch(`${targetApiUrl}/sessions`, {
                method: 'GET',
                headers,
                signal: AbortSignal.timeout(5000)
            })
            return response.ok
        } catch {
            return false
        }
    }, [apiUrl, authToken, researchAgentKey, useMock])

    // Don't render children until hydrated to avoid hydration mismatch
    if (!isHydrated) {
        return null
    }

    return (
        <ApiConfigContext.Provider value={{
            apiUrl,
            useMock,
            authToken,
            researchAgentKey,
            setApiUrl,
            setUseMock,
            setAuthToken,
            setResearchAgentKey,
            resetToDefaults,
            testConnection,
        }}>
            {children}
        </ApiConfigContext.Provider>
    )
}

export function useApiConfig(): ApiConfig {
    const context = useContext(ApiConfigContext)
    if (!context) {
        throw new Error('useApiConfig must be used within an ApiConfigProvider')
    }
    return context
}
