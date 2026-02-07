'use client'

import { useEffect, useCallback, useRef } from 'react'

/**
 * Hook for sending browser/OS notifications.
 * - Requests permission on mount (if Notification API is available).
 * - Only fires when the page is NOT focused (document.hidden).
 * - Clicking the notification focuses the originating tab.
 *
 * Works on macOS (Notification Center), Android Chrome, and iOS Safari 16.4+ PWAs.
 */
export function useWebNotification() {
    const permissionRef = useRef<NotificationPermission>('default')

    // Request permission on mount
    useEffect(() => {
        if (typeof window === 'undefined' || !('Notification' in window)) return

        permissionRef.current = Notification.permission

        if (Notification.permission === 'default') {
            Notification.requestPermission().then((perm) => {
                permissionRef.current = perm
            })
        }
    }, [])

    const notify = useCallback((title: string, body?: string) => {
        // Skip if API not available, permission denied, or page is focused
        if (typeof window === 'undefined' || !('Notification' in window)) return
        if (permissionRef.current !== 'granted') return
        if (!document.hidden) return

        try {
            const notification = new Notification(title, {
                body: body || undefined,
                icon: '/favicon.ico',
                tag: 'bot-response',       // Collapse duplicate notifications
            })

            notification.onclick = () => {
                window.focus()
                notification.close()
            }

            // Auto-close after 8 seconds
            setTimeout(() => notification.close(), 8000)
        } catch {
            // Silently fail — some environments don't support Notification constructor
            console.debug('[notification] Failed to create notification')
        }
    }, [])

    return { notify }
}
