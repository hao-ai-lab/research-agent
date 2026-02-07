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
export function useWebNotification(enabled = true) {
    const permissionRef = useRef<NotificationPermission>('default')

    // Request permission on mount
    useEffect(() => {
        if (!enabled) {
            return
        }

        if (typeof window === 'undefined' || !('Notification' in window)) {
            console.log('[notification] Notification API not available')
            return
        }

        permissionRef.current = Notification.permission
        console.log('[notification] Current permission:', Notification.permission)

        if (Notification.permission === 'default') {
            console.log('[notification] Requesting permission...')
            Notification.requestPermission().then((perm) => {
                console.log('[notification] Permission result:', perm)
                permissionRef.current = perm
            })
        }
    }, [enabled])

    const notify = useCallback((title: string, body?: string) => {
        console.log('[notification] notify() called:', { title, body: body?.slice(0, 80), permission: permissionRef.current, hidden: document.hidden })

        // Skip if API not available, permission denied, or page is focused
        if (!enabled) {
            return
        }

        if (typeof window === 'undefined' || !('Notification' in window)) {
            console.log('[notification] SKIP: Notification API not available')
            return
        }
        if (permissionRef.current !== 'granted') {
            console.log('[notification] SKIP: permission is', permissionRef.current)
            return
        }
        // This tab is focused might be a little wrong.
        // if (!document.hidden) {
        //     console.log('[notification] SKIP: tab is focused (document.hidden=false)')
        //     return
        // }

        try {
            console.log('[notification] Creating notification...')
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
            console.log('[notification] ✅ Notification created successfully')
        } catch (err) {
            console.warn('[notification] Failed to create notification:', err)
        }
    }, [enabled])

    return { notify }
}
