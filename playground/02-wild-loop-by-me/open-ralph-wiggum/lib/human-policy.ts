/**
 * Wild Loop — Human policy engine
 *
 * Policy-driven escalation decisions and progress reporting.
 */

import type { Alert, AlertHistory, HumanPolicy, LoopState } from "./types";

// ─── Escalation decision ─────────────────────────────────────────────────────

export function shouldEscalateToHuman(
  alert: Alert,
  policy: HumanPolicy,
  history: AlertHistory
): {
  escalate: boolean;
  reason?: string;
  urgency: "low" | "medium" | "high";
  blocking: boolean;
} {
  // Check 1: Critical alerts
  if (alert.severity === "critical" && policy.escalateOn.criticalAlerts) {
    return {
      escalate: true,
      reason: "Critical alert - policy requires human notification",
      urgency: "high",
      blocking: policy.autonomyLevel === "low",
    };
  }

  // Check 2: Repeated failures
  const attempts = history.getAttempts(alert.id);
  if (attempts >= policy.maxRetryAttempts) {
    return {
      escalate: true,
      reason: `Tried ${attempts} times, still failing (max: ${policy.maxRetryAttempts})`,
      urgency: "medium",
      blocking: policy.autonomyLevel !== "high",
    };
  }

  // Check 3: Stuck for too long
  const minutesStuck = history.getMinutesSinceProgress();
  if (minutesStuck >= policy.escalateOn.stuckDuration) {
    return {
      escalate: true,
      reason: `No progress for ${minutesStuck} minutes (threshold: ${policy.escalateOn.stuckDuration})`,
      urgency: "medium",
      blocking: policy.autonomyLevel === "low",
    };
  }

  // Check 4: Low autonomy mode — escalate everything
  if (
    policy.autonomyLevel === "low" &&
    policy.escalationThreshold === "all"
  ) {
    return {
      escalate: true,
      reason: "Policy requires human confirmation for all alerts",
      urgency: "low",
      blocking: true,
    };
  }

  // Check 5: Warning threshold
  if (
    alert.severity === "warning" &&
    (policy.escalationThreshold === "all" ||
      policy.escalationThreshold === "warnings")
  ) {
    return {
      escalate: true,
      reason: "Warning alert - policy requires escalation",
      urgency: "medium",
      blocking: policy.autonomyLevel === "low",
    };
  }

  // Don't escalate
  return {
    escalate: false,
    urgency: "low",
    blocking: false,
  };
}

// ─── Progress reporting ──────────────────────────────────────────────────────

export function shouldSendProgressReport(
  policy: HumanPolicy,
  state: LoopState
): boolean {
  if (!policy.progressReportInterval || policy.progressReportInterval === 0) {
    return false;
  }

  const now = Date.now();
  const lastReport = state.lastProgressReport
    ? new Date(state.lastProgressReport).getTime()
    : new Date(state.startedAt).getTime();
  const minutesSinceReport = (now - lastReport) / 60000;

  return minutesSinceReport >= policy.progressReportInterval;
}

export function formatProgressReport(state: LoopState): string {
  return `
📊 Progress Report (${new Date().toLocaleTimeString()})

Iteration: ${state.iteration}
Active: ${state.active}
Current work: ${state.currentWork ? `${state.currentWork.type} (${state.currentWork.id})` : "none"}
  `.trim();
}

// ─── In-memory alert history tracker ─────────────────────────────────────────

export function createAlertHistory(): AlertHistory {
  const attempts = new Map<string, number>();
  let lastProgressTime = Date.now();

  return {
    getAttempts(alertId: string): number {
      return attempts.get(alertId) || 0;
    },
    getMinutesSinceProgress(): number {
      return (Date.now() - lastProgressTime) / 60000;
    },
    recordAttempt(alertId: string): void {
      attempts.set(alertId, (attempts.get(alertId) || 0) + 1);
    },
    recordProgress(): void {
      lastProgressTime = Date.now();
    },
  };
}
