/**
 * Wild Loop — Event system
 *
 * File watchers and event-driven wake mechanism.
 * Uses polling for broad compatibility (no chokidar dependency).
 */

import { EventEmitter } from "events";
import { existsSync, statSync } from "fs";

// ─── WildEventSystem ─────────────────────────────────────────────────────────

export class WildEventSystem extends EventEmitter {
  private timers: ReturnType<typeof setInterval>[] = [];
  private fileTimes = new Map<string, number>();
  private pollIntervalMs: number;

  constructor(pollIntervalMs: number = 1000) {
    super();
    this.pollIntervalMs = pollIntervalMs;
  }

  /**
   * Start watching files in the .wild/ directory for changes.
   */
  startWatchers(stateDir: string = ".wild"): void {
    const filesToWatch = [
      `${stateDir}/alerts.jsonl`,
      `${stateDir}/human.md`,
      `${stateDir}/barriers.md`,
      `${stateDir}/tasks.md`,
    ];

    const eventTypes: Record<string, string> = {
      "alerts.jsonl": "new-alert",
      "human.md": "human-input",
      "barriers.md": "barrier-update",
      "tasks.md": "task-update",
    };

    // Record initial file times
    for (const file of filesToWatch) {
      if (existsSync(file)) {
        this.fileTimes.set(file, statSync(file).mtimeMs);
      }
    }

    // Poll for changes
    const timer = setInterval(() => {
      for (const file of filesToWatch) {
        if (!existsSync(file)) continue;
        const currentMtime = statSync(file).mtimeMs;
        const lastMtime = this.fileTimes.get(file) || 0;

        if (currentMtime > lastMtime) {
          this.fileTimes.set(file, currentMtime);
          const basename = file.split("/").pop() || "";
          const eventType = eventTypes[basename] || "file-change";
          this.emit("wake", { type: eventType, file });
        }
      }
    }, this.pollIntervalMs);

    this.timers.push(timer);
    console.log("🔔 Event watchers started");
  }

  /**
   * Stop all file watchers.
   */
  stopWatchers(): void {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers = [];
  }
}

// ─── Wait for event (promise wrapper) ────────────────────────────────────────

export function waitForEvent(
  eventQueue: EventEmitter,
  timeoutMs?: number
): Promise<{ type: string } | null> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const handler = (event: { type: string }) => {
      if (timer) clearTimeout(timer);
      resolve(event);
    };

    eventQueue.once("wake", handler);

    if (timeoutMs) {
      timer = setTimeout(() => {
        eventQueue.removeListener("wake", handler);
        resolve(null);
      }, timeoutMs);
    }
  });
}
