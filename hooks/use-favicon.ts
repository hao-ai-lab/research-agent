'use client'

import { useEffect, useRef } from 'react'

/**
 * Dynamically change the browser tab favicon to indicate connection state.
 *
 * When `isRetrying` is true, a small orange warning badge is drawn on top of
 * the existing favicon. When false, the original favicon is restored.
 */
export function useFavicon(isRetrying: boolean) {
    const originalHrefRef = useRef<string | null>(null)

    useEffect(() => {
        if (typeof document === 'undefined') return

        const link = document.querySelector<HTMLLinkElement>(
            'link[rel="icon"][type="image/svg+xml"], link[rel="icon"]'
        )
        if (!link) return

        // Capture the original href on first call
        if (originalHrefRef.current === null) {
            originalHrefRef.current = link.href
        }

        if (!isRetrying) {
            // Restore original
            if (originalHrefRef.current) {
                link.href = originalHrefRef.current
            }
            return
        }

        // Draw a badge on the favicon
        const img = new Image()
        img.crossOrigin = 'anonymous'
        img.onload = () => {
            const size = 32
            const canvas = document.createElement('canvas')
            canvas.width = size
            canvas.height = size
            const ctx = canvas.getContext('2d')
            if (!ctx) return

            // Draw original icon
            ctx.drawImage(img, 0, 0, size, size)

            // Draw orange dot badge (bottom-right)
            const badgeRadius = 7
            const cx = size - badgeRadius - 1
            const cy = size - badgeRadius - 1
            ctx.beginPath()
            ctx.arc(cx, cy, badgeRadius, 0, Math.PI * 2)
            ctx.fillStyle = '#f59e0b' // amber-500
            ctx.fill()
            ctx.strokeStyle = '#78350f' // amber-900
            ctx.lineWidth = 1.5
            ctx.stroke()

            // Draw a small "!" in the badge
            ctx.fillStyle = '#fff'
            ctx.font = 'bold 9px sans-serif'
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText('!', cx, cy)

            link.href = canvas.toDataURL('image/png')
        }
        img.src = originalHrefRef.current || link.href
    }, [isRetrying])
}
