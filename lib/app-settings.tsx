'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { AppSettings } from '@/lib/types'

const STORAGE_KEY_APP_SETTINGS = 'research-agent-app-settings'
const STORAGE_KEY_APPEARANCE_THEME = 'research-agent-appearance-theme'
const STORAGE_KEY_APPEARANCE_FONT_SIZE = 'research-agent-appearance-font-size'
const STORAGE_KEY_APPEARANCE_BUTTON_SIZE = 'research-agent-appearance-button-size'
const STORAGE_KEY_APPEARANCE_RUN_ITEM_INTERACTION = 'research-agent-appearance-run-item-interaction-mode'
const STORAGE_KEY_APPEARANCE_CUSTOM_FONT_SIZE_PX = 'research-agent-appearance-custom-font-size-px'
const STORAGE_KEY_APPEARANCE_CUSTOM_BUTTON_SCALE_PERCENT = 'research-agent-appearance-custom-button-scale-percent'
const STORAGE_KEY_APPEARANCE_CHAT_TOOLBAR_BUTTON_SIZE_PX = 'research-agent-appearance-chat-toolbar-button-size-px'
const STORAGE_KEY_APPEARANCE_CHAT_INPUT_INITIAL_HEIGHT_PX = 'research-agent-appearance-chat-input-initial-height-px'

export const defaultAppSettings: AppSettings = {
  appearance: {
    theme: 'light',
    fontSize: 'medium',
    buttonSize: 'default',
    runItemInteractionMode: 'detail-page',
    showRunItemMetadata: true,
    customFontSizePx: null,
    customButtonScalePercent: null,
    chatToolbarButtonSizePx: null,
    chatInputInitialHeightPx: null,
    showStarterCards: false,
    showSidebarNewChatButton: false,
  },
  integrations: {},
  notifications: {
    alertsEnabled: true,
    alertTypes: ['error', 'warning', 'info'],
    webNotificationsEnabled: true,
  },
  leftPanel: {
    items: [
      { id: 'chat', label: 'Chat', visible: true, order: 0 },
      { id: 'runs', label: 'Runs', visible: true, order: 1 },
      { id: 'charts', label: 'Charts', visible: true, order: 2 },
      { id: 'insights', label: 'Insights', visible: true, order: 3 },
    ],
  },
}

interface AppSettingsContextValue {
  settings: AppSettings
  setSettings: (settings: AppSettings) => void
}

const AppSettingsContext = createContext<AppSettingsContextValue | null>(null)

function isValidTheme(value: unknown): value is AppSettings['appearance']['theme'] {
  return value === 'dark' || value === 'light' || value === 'system'
}

function isValidFontSize(value: unknown): value is AppSettings['appearance']['fontSize'] {
  return value === 'small' || value === 'medium' || value === 'large'
}

function isValidButtonSize(value: unknown): value is AppSettings['appearance']['buttonSize'] {
  return value === 'compact' || value === 'default' || value === 'large'
}

function isValidRunItemInteractionMode(
  value: unknown,
): value is NonNullable<AppSettings['appearance']['runItemInteractionMode']> {
  return value === 'detail-page' || value === 'inline-expand'
}

function parseStoredNumber(value: string | null): number | null {
  if (value === null || value.trim() === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return parsed
}

function sanitizePositiveNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return value
}

function writeSettingsToStorage(nextSettings: AppSettings) {
  localStorage.setItem(STORAGE_KEY_APP_SETTINGS, JSON.stringify(nextSettings))
  localStorage.setItem(STORAGE_KEY_APPEARANCE_THEME, nextSettings.appearance.theme)
  localStorage.setItem(STORAGE_KEY_APPEARANCE_FONT_SIZE, nextSettings.appearance.fontSize)
  localStorage.setItem(STORAGE_KEY_APPEARANCE_BUTTON_SIZE, nextSettings.appearance.buttonSize)
  localStorage.setItem(
    STORAGE_KEY_APPEARANCE_RUN_ITEM_INTERACTION,
    nextSettings.appearance.runItemInteractionMode || defaultAppSettings.appearance.runItemInteractionMode || 'detail-page'
  )

  const customFontSizePx = sanitizePositiveNumber(nextSettings.appearance.customFontSizePx)
  if (customFontSizePx === null) {
    localStorage.removeItem(STORAGE_KEY_APPEARANCE_CUSTOM_FONT_SIZE_PX)
  } else {
    localStorage.setItem(STORAGE_KEY_APPEARANCE_CUSTOM_FONT_SIZE_PX, String(customFontSizePx))
  }

  const customButtonScalePercent = sanitizePositiveNumber(nextSettings.appearance.customButtonScalePercent)
  if (customButtonScalePercent === null) {
    localStorage.removeItem(STORAGE_KEY_APPEARANCE_CUSTOM_BUTTON_SCALE_PERCENT)
  } else {
    localStorage.setItem(STORAGE_KEY_APPEARANCE_CUSTOM_BUTTON_SCALE_PERCENT, String(customButtonScalePercent))
  }

  const chatToolbarButtonSizePx = sanitizePositiveNumber(nextSettings.appearance.chatToolbarButtonSizePx)
  if (chatToolbarButtonSizePx === null) {
    localStorage.removeItem(STORAGE_KEY_APPEARANCE_CHAT_TOOLBAR_BUTTON_SIZE_PX)
  } else {
    localStorage.setItem(STORAGE_KEY_APPEARANCE_CHAT_TOOLBAR_BUTTON_SIZE_PX, String(chatToolbarButtonSizePx))
  }

  const chatInputInitialHeightPx = sanitizePositiveNumber(nextSettings.appearance.chatInputInitialHeightPx)
  if (chatInputInitialHeightPx === null) {
    localStorage.removeItem(STORAGE_KEY_APPEARANCE_CHAT_INPUT_INITIAL_HEIGHT_PX)
  } else {
    localStorage.setItem(STORAGE_KEY_APPEARANCE_CHAT_INPUT_INITIAL_HEIGHT_PX, String(chatInputInitialHeightPx))
  }
}

function readStoredSettings(): AppSettings {
  if (typeof window === 'undefined') {
    return defaultAppSettings
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY_APP_SETTINGS)
    let parsed: Partial<AppSettings> | null = null
    if (raw) {
      try {
        parsed = JSON.parse(raw) as Partial<AppSettings>
      } catch {
        parsed = null
      }
    }

    const themeFromBlob = parsed?.appearance?.theme
    const fontSizeFromBlob = parsed?.appearance?.fontSize
    const buttonSizeFromBlob = parsed?.appearance?.buttonSize
    const runItemInteractionModeFromBlob = parsed?.appearance?.runItemInteractionMode
    const customFontSizePxFromBlob = sanitizePositiveNumber(parsed?.appearance?.customFontSizePx)
    const customButtonScalePercentFromBlob = sanitizePositiveNumber(parsed?.appearance?.customButtonScalePercent)
    const chatToolbarButtonSizePxFromBlob = sanitizePositiveNumber(parsed?.appearance?.chatToolbarButtonSizePx)
    const chatInputInitialHeightPxFromBlob = sanitizePositiveNumber(parsed?.appearance?.chatInputInitialHeightPx)

    const storedTheme = localStorage.getItem(STORAGE_KEY_APPEARANCE_THEME)
    const storedFontSize = localStorage.getItem(STORAGE_KEY_APPEARANCE_FONT_SIZE)
    const storedButtonSize = localStorage.getItem(STORAGE_KEY_APPEARANCE_BUTTON_SIZE)
    const storedRunItemInteractionMode = localStorage.getItem(STORAGE_KEY_APPEARANCE_RUN_ITEM_INTERACTION)
    const storedCustomFontSizePx = parseStoredNumber(localStorage.getItem(STORAGE_KEY_APPEARANCE_CUSTOM_FONT_SIZE_PX))
    const storedCustomButtonScalePercent = parseStoredNumber(localStorage.getItem(STORAGE_KEY_APPEARANCE_CUSTOM_BUTTON_SCALE_PERCENT))
    const storedChatToolbarButtonSizePx = parseStoredNumber(localStorage.getItem(STORAGE_KEY_APPEARANCE_CHAT_TOOLBAR_BUTTON_SIZE_PX))
    const storedChatInputInitialHeightPx = parseStoredNumber(localStorage.getItem(STORAGE_KEY_APPEARANCE_CHAT_INPUT_INITIAL_HEIGHT_PX))

    const resolvedTheme = isValidTheme(storedTheme)
      ? storedTheme
      : (isValidTheme(themeFromBlob) ? themeFromBlob : defaultAppSettings.appearance.theme)

    const resolvedFontSize = isValidFontSize(storedFontSize)
      ? storedFontSize
      : (isValidFontSize(fontSizeFromBlob) ? fontSizeFromBlob : defaultAppSettings.appearance.fontSize)

    const resolvedButtonSize = isValidButtonSize(storedButtonSize)
      ? storedButtonSize
      : (isValidButtonSize(buttonSizeFromBlob) ? buttonSizeFromBlob : defaultAppSettings.appearance.buttonSize)

    const resolvedRunItemInteractionMode = isValidRunItemInteractionMode(storedRunItemInteractionMode)
      ? storedRunItemInteractionMode
      : (isValidRunItemInteractionMode(runItemInteractionModeFromBlob)
        ? runItemInteractionModeFromBlob
        : defaultAppSettings.appearance.runItemInteractionMode)

    return {
      appearance: {
        theme: resolvedTheme,
        fontSize: resolvedFontSize,
        buttonSize: resolvedButtonSize,
        runItemInteractionMode: resolvedRunItemInteractionMode,
        showRunItemMetadata: parsed?.appearance?.showRunItemMetadata ?? defaultAppSettings.appearance.showRunItemMetadata,
        customFontSizePx: sanitizePositiveNumber(storedCustomFontSizePx) ?? customFontSizePxFromBlob ?? defaultAppSettings.appearance.customFontSizePx,
        customButtonScalePercent: sanitizePositiveNumber(storedCustomButtonScalePercent) ?? customButtonScalePercentFromBlob ?? defaultAppSettings.appearance.customButtonScalePercent,
        chatToolbarButtonSizePx: sanitizePositiveNumber(storedChatToolbarButtonSizePx) ?? chatToolbarButtonSizePxFromBlob ?? defaultAppSettings.appearance.chatToolbarButtonSizePx,
        chatInputInitialHeightPx: sanitizePositiveNumber(storedChatInputInitialHeightPx) ?? chatInputInitialHeightPxFromBlob ?? defaultAppSettings.appearance.chatInputInitialHeightPx,
        showStarterCards: parsed?.appearance?.showStarterCards ?? defaultAppSettings.appearance.showStarterCards,
        showSidebarNewChatButton: parsed?.appearance?.showSidebarNewChatButton ?? defaultAppSettings.appearance.showSidebarNewChatButton,
        starterCardTemplates: parsed?.appearance?.starterCardTemplates ?? {},
      },
      integrations: parsed?.integrations || defaultAppSettings.integrations,
      notifications: {
        alertsEnabled: parsed?.notifications?.alertsEnabled ?? defaultAppSettings.notifications.alertsEnabled,
        alertTypes: parsed?.notifications?.alertTypes || defaultAppSettings.notifications.alertTypes,
        webNotificationsEnabled: parsed?.notifications?.webNotificationsEnabled ?? defaultAppSettings.notifications.webNotificationsEnabled,
      },
      developer: parsed?.developer ?? defaultAppSettings.developer,
      leftPanel: parsed?.leftPanel ?? defaultAppSettings.leftPanel,
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
    try {
      writeSettingsToStorage(settings)
    } catch {
      // Ignore storage write failures (e.g. private mode / quota exceeded).
    }
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

    const customFontSizePx = settings.appearance.customFontSizePx
    if (typeof customFontSizePx === 'number' && Number.isFinite(customFontSizePx) && customFontSizePx > 0) {
      root.style.setProperty('font-size', `${customFontSizePx}px`)
    } else {
      root.style.removeProperty('font-size')
    }

    const customButtonScalePercent = settings.appearance.customButtonScalePercent
    if (typeof customButtonScalePercent === 'number' && Number.isFinite(customButtonScalePercent) && customButtonScalePercent > 0) {
      root.style.setProperty('--app-button-scale', `${customButtonScalePercent / 100}`)
    } else {
      root.style.removeProperty('--app-button-scale')
    }

    const chatToolbarButtonSizePx = settings.appearance.chatToolbarButtonSizePx
    if (typeof chatToolbarButtonSizePx === 'number' && Number.isFinite(chatToolbarButtonSizePx) && chatToolbarButtonSizePx > 0) {
      root.style.setProperty('--app-chat-toolbar-btn-size', `${chatToolbarButtonSizePx}px`)
    } else {
      root.style.removeProperty('--app-chat-toolbar-btn-size')
    }

    const chatInputInitialHeightPx = settings.appearance.chatInputInitialHeightPx
    if (typeof chatInputInitialHeightPx === 'number' && Number.isFinite(chatInputInitialHeightPx) && chatInputInitialHeightPx > 0) {
      root.style.setProperty('--app-chat-input-initial-height', `${chatInputInitialHeightPx}px`)
    } else {
      root.style.removeProperty('--app-chat-input-initial-height')
    }

    const streamingToolBoxHeightRem = settings.appearance.streamingToolBoxHeightRem
    if (typeof streamingToolBoxHeightRem === 'number' && Number.isFinite(streamingToolBoxHeightRem) && streamingToolBoxHeightRem > 0) {
      root.style.setProperty('--app-streaming-tool-box-height', `${streamingToolBoxHeightRem}rem`)
    } else {
      root.style.removeProperty('--app-streaming-tool-box-height')
    }

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
