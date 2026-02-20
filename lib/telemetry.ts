'use client'

/**
 * Telemetry Client — fire-and-forget request tracking.
 *
 * Batches events in memory and flushes them to the Modal telemetry endpoint
 * every FLUSH_INTERVAL_MS or when the batch reaches MAX_BATCH_SIZE.
 * Uses `navigator.sendBeacon` on page unload as a last-resort flush.
 *
 * Silently no-ops when the telemetry endpoint or API key is unavailable.
 */

import { getTelemetryUrl, getResearchAgentKey } from './api-config'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TelemetryEvent {
    event: string
    method?: string
    path?: string
    status?: number
    duration_ms?: number
    timestamp: string
    session_id?: string
    user_agent?: string
    metadata?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FLUSH_INTERVAL_MS = 10_000 // 10 seconds
const MAX_BATCH_SIZE = 20

// ---------------------------------------------------------------------------
// TelemetryClient
// ---------------------------------------------------------------------------

class TelemetryClient {
    private queue: TelemetryEvent[] = []
    private timer: ReturnType<typeof setInterval> | null = null
    private flushing = false

    constructor() {
        if (typeof window !== 'undefined') {
            this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS)
            window.addEventListener('beforeunload', () => this.beaconFlush())
        }
    }

    /** Record an API request. */
    trackRequest(
        method: string,
        path: string,
        status: number,
        durationMs: number,
        metadata?: Record<string, unknown>,
    ) {
        this.queue.push({
            event: 'api_request',
            method,
            path,
            status,
            duration_ms: Math.round(durationMs),
            timestamp: new Date().toISOString(),
            user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
            metadata,
        })

        if (this.queue.length >= MAX_BATCH_SIZE) {
            this.flush()
        }
    }

    /** Flush the current batch to the telemetry endpoint. */
    async flush(): Promise<void> {
        if (this.flushing || this.queue.length === 0) return

        const url = getTelemetryUrl()
        const key = getResearchAgentKey()
        if (!url || !key) return // telemetry disabled

        const batch = this.queue.splice(0, MAX_BATCH_SIZE)
        this.flushing = true

        try {
            await fetch(`${url}/v1/telemetry`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': key,
                },
                body: JSON.stringify(batch),
                // Very short timeout — we don't want to block anything
                signal: AbortSignal.timeout(5000),
            })
        } catch {
            // Silently swallow — telemetry must never break the app
        } finally {
            this.flushing = false
        }
    }

    /** Best-effort flush via sendBeacon (page unload). */
    private beaconFlush() {
        if (this.queue.length === 0) return
        const url = getTelemetryUrl()
        const key = getResearchAgentKey()
        if (!url || !key) return

        const payload = JSON.stringify(this.queue.splice(0))
        // sendBeacon doesn't support custom headers, so we encode the key in the URL
        try {
            navigator.sendBeacon(
                `${url}/v1/telemetry?key=${encodeURIComponent(key)}`,
                new Blob([payload], { type: 'application/json' }),
            )
        } catch {
            // ignore
        }
    }

    /** Stop the periodic flush timer. */
    destroy() {
        if (this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }
    }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const telemetry = new TelemetryClient()
