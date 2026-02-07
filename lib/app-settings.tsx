'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { AppSettings } from '@/lib/types'

const STORAGE_KEY_APP_SETTINGS = 'research-agent-app-settings'

export const defaultAppSettings: AppSettings = {
  appearance: {
    theme: 'dark',
    fontSize: 'medium',
    buttonSize: 'default',
  },
  integrations: {},
  notifications: {
    alertsEnabled: true,
    alertTypes: ['error', 'warning', 'info'],
    webNotificationsEnabled: true,
  },
}

interface AppSettingsContextValue {
  settings: AppSettings
  setSettings: (settings: AppSettings) => void
}

const AppSettingsContext = createContext<AppSettingsContextValue | null>(null)

function readStoredSettings(): AppSettings {
  if (typeof window === 'undefined') {
    return defaultAppSettings
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY_APP_SETTINGS)
    if (!raw) return defaultAppSettings

    const parsed = JSON.parse(raw) as Partial<AppSettings>
    return {
      appearance: {
        theme: parsed.appearance?.theme || defaultAppSettings.appearance.theme,
        fontSize: parsed.appearance?.fontSize || defaultAppSettings.appearance.fontSize,
        buttonSize: parsed.appearance?.buttonSize || defaultAppSettings.appearance.buttonSize,
      },
      integrations: parsed.integrations || defaultAppSettings.integrations,
      notifications: {
        alertsEnabled: parsed.notifications?.alertsEnabled ?? defaultAppSettings.notifications.alertsEnabled,
        alertTypes: parsed.notifications?.alertTypes || defaultAppSettings.notifications.alertTypes,
        webNotificationsEnabled: parsed.notifications?.webNotificationsEnabled ?? defaultAppSettings.notifications.webNotificationsEnabled,
      },
    }
  } catch {
    return defaultAppSettings
  }
}

export function AppSettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettingsState] = useState<AppSettings>(defaultAppSettings)
  const [isHydrated, setIsHydrated] = useState(false)

  useEffect(() => {
    setSettingsState(readStoredSettings())
    setIsHydrated(true)
  }, [])

  const setSettings = useCallback((nextSettings: AppSettings) => {
    setSettingsState(nextSettings)
  }, [])

  useEffect(() => {
    if (!isHydrated) return
    localStorage.setItem(STORAGE_KEY_APP_SETTINGS, JSON.stringify(settings))
  }, [settings, isHydrated])

  useEffect(() => {
    if (!isHydrated) return

    const root = document.documentElement
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

    const applyTheme = () => {
      const resolvedTheme = settings.appearance.theme === 'system'
        ? (mediaQuery.matches ? 'dark' : 'light')
        : settings.appearance.theme

      root.classList.toggle('dark', resolvedTheme === 'dark')
    }

    applyTheme()

    root.setAttribute('data-font-size', settings.appearance.fontSize)
    root.setAttribute('data-button-size', settings.appearance.buttonSize)

    const handleThemeChange = () => {
      if (settings.appearance.theme === 'system') {
        applyTheme()
      }
    }

    mediaQuery.addEventListener('change', handleThemeChange)
    return () => {
      mediaQuery.removeEventListener('change', handleThemeChange)
    }
  }, [settings, isHydrated])

  const value = useMemo(
    () => ({ settings, setSettings }),
    [settings, setSettings],
  )

  if (!isHydrated) {
    return null
  }

  return (
    <AppSettingsContext.Provider value={value}>
      {children}
    </AppSettingsContext.Provider>
  )
}

export function useAppSettings(): AppSettingsContextValue {
  const context = useContext(AppSettingsContext)
  if (!context) {
    throw new Error('useAppSettings must be used within AppSettingsProvider')
  }
  return context
}
