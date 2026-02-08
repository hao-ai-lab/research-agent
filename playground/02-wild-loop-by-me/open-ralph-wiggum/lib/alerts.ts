/**
 * Wild Loop — Alert management
 *
 * JSONL-based alert system: append-only log with latest-entry-per-ID semantics.
 */

import {
  existsSync,
  readFileSync,
  appendFileSync,
  mkdirSync,
  openSync,
  readSync,
  fstatSync,
  closeSync,
} from "fs";
import { join } from "path";
import type { Alert } from "./types";

// ─── Paths ───────────────────────────────────────────────────────────────────

let stateDir = ".wild";
let alertsPath = join(stateDir, "alerts.jsonl");

export function setStateDir(dir: string): void {
  stateDir = dir;
  alertsPath = join(stateDir, "alerts.jsonl");
}

export function getAlertsPath(): string {
  return alertsPath;
}

// ─── Load all alerts (full read, dedupe by ID) ──────────────────────────────

export function loadAlerts(): Alert[] {
  if (!existsSync(alertsPath)) {
    return [];
  }

  const content = readFileSync(alertsPath, "utf-8");
  const lines = content.trim().split("\n").filter((l) => l.trim());

  // Parse all JSONL entries
  const allEntries: Alert[] = [];
  for (const line of lines) {
    try {
      allEntries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }

  // Build current state: last entry per alert ID wins (positional ordering).
  // In an append-only log the later line is always the most recent update,
  // regardless of timestamp granularity.
  const alertMap = new Map<string, Alert>();
  for (const entry of allEntries) {
    alertMap.set(entry.id, entry);
  }

  // Return only non-resolved alerts
  return Array.from(alertMap.values()).filter(
    (a) => a.status !== "resolved"
  );
}

// ─── Load ALL alerts including resolved (for analysis) ──────────────────────

export function loadAllAlerts(): Alert[] {
  if (!existsSync(alertsPath)) {
    return [];
  }

  const content = readFileSync(alertsPath, "utf-8");
  const lines = content.trim().split("\n").filter((l) => l.trim());

  const alertMap = new Map<string, Alert>();
  for (const line of lines) {
    try {
      const entry: Alert = JSON.parse(line);
      alertMap.set(entry.id, entry);
    } catch {
      // Skip malformed lines
    }
  }

  return Array.from(alertMap.values());
}

// ─── Append a new alert entry ────────────────────────────────────────────────

export function appendAlert(alert: Alert): void {
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }

  const line = JSON.stringify(alert) + "\n";
  appendFileSync(alertsPath, line);
}

// ─── Update alert status (append new entry with same ID) ─────────────────────

export function updateAlertStatus(
  alertId: string,
  status: Alert["status"],
  additionalFields?: Partial<Alert>
): void {
  // Load all entries to find the alert
  const allAlerts = loadAllAlerts();
  const alert = allAlerts.find((a) => a.id === alertId);

  if (!alert) {
    throw new Error(`Alert not found: ${alertId}`);
  }

  const updated: Alert = {
    ...alert,
    status,
    timestamp: new Date().toISOString(),
    ...additionalFields,
  };

  appendAlert(updated);
}

// ─── Incremental read (optimization for large files) ─────────────────────────

export function loadAlertsIncremental(lastPosition: number): {
  alerts: Alert[];
  newPosition: number;
} {
  if (!existsSync(alertsPath)) {
    return { alerts: [], newPosition: 0 };
  }

  const fd = openSync(alertsPath, "r");
  const stats = fstatSync(fd);
  const fileSize = stats.size;

  if (lastPosition >= fileSize) {
    closeSync(fd);
    return { alerts: [], newPosition: lastPosition };
  }

  const buffer = Buffer.alloc(fileSize - lastPosition);
  readSync(fd, buffer, 0, buffer.length, lastPosition);
  closeSync(fd);

  const content = buffer.toString("utf-8");
  const lines = content.trim().split("\n").filter((l) => l.trim());
  const alerts: Alert[] = [];
  for (const line of lines) {
    try {
      alerts.push(JSON.parse(line));
    } catch {
      // Skip malformed
    }
  }

  return { alerts, newPosition: fileSize };
}
