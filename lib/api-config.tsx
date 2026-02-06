'use client'

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'

// Storage keys
const STORAGE_KEY_API_URL = 'research-agent-api-url'
const STORAGE_KEY_USE_MOCK = 'research-agent-use-mock'
const STORAGE_KEY_AUTH_TOKEN = 'research-agent-auth-token'

// Default values
const DEFAULT_API_URL = 'http://localhost:10000'

interface ApiConfig {
    apiUrl: string
    useMock: boolean
    authToken: string
    setApiUrl: (url: string) => void
    setUseMock: (useMock: boolean) => void
    setAuthToken: (token: string) => void
    resetToDefaults: () => void
    testConnection: () => Promise<boolean>
}

const ApiConfigContext = createContext<ApiConfig | null>(null)

/**
 * Get the current API URL from localStorage or default
 * This can be called outside of React components
 */
export function getApiUrl(): string {
    if (typeof window === 'undefined') {
        return process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_URL
    }

    const stored = localStorage.getItem(STORAGE_KEY_API_URL)
    return stored || process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_URL
}

/**
 * Check if mock mode is enabled
 * This can be called outside of React components
 * Pure runtime behavior - defaults to demo mode (true)
 */
export function isUsingMock(): boolean {
    if (typeof window === 'undefined') {
        // Server-side: default to demo mode
        return true
    }

    const stored = localStorage.getItem(STORAGE_KEY_USE_MOCK)
    if (stored !== null) {
        return stored === 'true'
    }
    // Default to demo mode if not explicitly set
    return true
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

export function ApiConfigProvider({ children }: { children: React.ReactNode }) {
    const [apiUrl, setApiUrlState] = useState<string>(DEFAULT_API_URL)
    const [useMock, setUseMockState] = useState<boolean>(true) // Default to demo mode
    const [authToken, setAuthTokenState] = useState<string>('')
    const [isHydrated, setIsHydrated] = useState(false)

    // Load from localStorage on mount
    useEffect(() => {
        const storedUrl = localStorage.getItem(STORAGE_KEY_API_URL)
        const storedMock = localStorage.getItem(STORAGE_KEY_USE_MOCK)
        const storedToken = localStorage.getItem(STORAGE_KEY_AUTH_TOKEN)

        if (storedUrl) {
            setApiUrlState(storedUrl)
        } else if (process.env.NEXT_PUBLIC_API_URL) {
            setApiUrlState(process.env.NEXT_PUBLIC_API_URL)
        }

        // Pure runtime: use localStorage value or default to true
        if (storedMock !== null) {
            setUseMockState(storedMock === 'true')
        }
        // If no stored value, keep the default (true)

        if (storedToken) {
            setAuthTokenState(storedToken)
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

    const resetToDefaults = useCallback(() => {
        localStorage.removeItem(STORAGE_KEY_API_URL)
        localStorage.removeItem(STORAGE_KEY_USE_MOCK)
        localStorage.removeItem(STORAGE_KEY_AUTH_TOKEN)
        setApiUrlState(process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_URL)
        setUseMockState(process.env.NEXT_PUBLIC_USE_MOCK === 'true')
        setAuthTokenState('')
    }, [])

    const testConnection = useCallback(async (): Promise<boolean> => {
        if (useMock) {
            return true // Mock is always "connected"
        }

        try {
            const response = await fetch(`${apiUrl}/`, {
                method: 'GET',
                signal: AbortSignal.timeout(5000)
            })
            return response.ok
        } catch {
            return false
        }
    }, [apiUrl, useMock])

    // Don't render children until hydrated to avoid hydration mismatch
    if (!isHydrated) {
        return null
    }

    return (
        <ApiConfigContext.Provider value={{
            apiUrl,
            useMock,
            authToken,
            setApiUrl,
            setUseMock,
            setAuthToken,
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
