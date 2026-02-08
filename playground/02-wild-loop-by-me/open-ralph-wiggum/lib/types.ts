/**
 * Wild Loop — Shared type definitions
 *
 * All interfaces for the event-driven autonomous agent system.
 */

// ─── Task ────────────────────────────────────────────────────────────────────

export interface Task {
  id: string;
  text: string;
  priority: number;                        // 1 = highest
  status: "todo" | "in-progress" | "complete";
  dependsOn?: string[];                    // Task IDs
  blockedBy?: string;                      // Barrier ID
  subtasks: Task[];
  parentId?: string;
  createdAt?: string;
}

// ─── Alert ───────────────────────────────────────────────────────────────────

export interface Alert {
  id: string;
  timestamp: string;                       // ISO 8601
  severity: "critical" | "warning" | "info";
  source: string;                          // e.g. "training-job-3"
  type: string;                            // e.g. "OOM", "divergence"
  description: string;
  status: "pending" | "in-progress" | "resolved" | "escalated";
  context?: Record<string, any>;
  resolvedAt?: string;
  escalatedAt?: string;
}

// ─── Barrier ─────────────────────────────────────────────────────────────────

export type BarrierType =
  | "command-check"
  | "file-exists"
  | "count-based"
  | "webhook"
  | "manual";

export interface Barrier {
  id: string;
  name: string;
  type: BarrierType;
  checkCommand?: string;
  expect?: string | number;
  checkInterval?: number;                  // seconds
  waitForFile?: string;
  target?: number;
  updateCommand?: string;
  status: "waiting" | "satisfied" | "failed";
  lastCheck?: string;
  lastCheckResult?: string;
  createdAt: string;
  satisfiedAt?: string;
  blocks?: string[];                       // Task IDs
}

// ─── Human Policy ────────────────────────────────────────────────────────────

export interface HumanPolicy {
  mode: "interactive" | "semi-autonomous" | "autonomous" | "hands-off";
  activeFrom: string;
  expiresAt?: string;
  autonomyLevel: "low" | "medium" | "high";
  maxRetryAttempts: number;
  escalationThreshold: "all" | "warnings" | "critical-only" | "never";
  progressReportInterval?: number;         // minutes (0 = none)
  contextSwitchPenalty: number;            // minutes
  escalateOn: {
    repeatedFailures: number;
    stuckDuration: number;                 // minutes
    criticalAlerts: boolean;
    unexpectedSuccess: boolean;
  };
  instructions: string;
}

// ─── Human Input ─────────────────────────────────────────────────────────────

export interface HumanInput {
  timestamp: string;
  priority: "urgent" | "normal" | "low";
  type:
    | "alert-resolution-guidance"
    | "task-addition"
    | "task-modification"
    | "policy-change"
    | "general-instruction";
  content: string;
  status: "pending" | "processed";
  processedAt?: string;
  relatedAlert?: string;                   // Alert ID
}

// ─── Work Selection ──────────────────────────────────────────────────────────

export type WorkType = "human-input" | "alert" | "task" | "blocked" | "complete";

export interface WorkSelection {
  type: WorkType;
  work?: Alert | Task | HumanInput;
  barriers?: Barrier[];
  canHelp?: boolean;
}

// ─── Loop State ──────────────────────────────────────────────────────────────

export interface LoopState {
  active: boolean;
  iteration: number;
  startedAt: string;
  prompt: string;
  agent: string;
  model: string;
  lastProgressReport?: string;
  alertsFilePosition: number;
  currentWork?: {
    type: WorkType;
    id: string;
    startedAt: string;
  };
}

// ─── Alert History (for escalation tracking) ─────────────────────────────────

export interface AlertHistory {
  getAttempts(alertId: string): number;
  getMinutesSinceProgress(): number;
  recordAttempt(alertId: string): void;
  recordProgress(): void;
}

// ─── Severity ordering ──────────────────────────────────────────────────────

export const severityOrder: Record<Alert["severity"], number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

// ─── Default policy ─────────────────────────────────────────────────────────

export const DEFAULT_POLICY: HumanPolicy = {
  mode: "semi-autonomous",
  activeFrom: new Date().toISOString(),
  autonomyLevel: "medium",
  maxRetryAttempts: 3,
  escalationThreshold: "warnings",
  progressReportInterval: 30,
  contextSwitchPenalty: 15,
  escalateOn: {
    repeatedFailures: 3,
    stuckDuration: 60,
    criticalAlerts: true,
    unexpectedSuccess: true,
  },
  instructions: "Default semi-autonomous policy. Escalate warnings and above.",
};
