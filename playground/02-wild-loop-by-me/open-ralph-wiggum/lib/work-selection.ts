/**
 * Wild Loop — Work selection engine
 *
 * Priority-based work selection: human input > alerts > tasks > blocked > complete.
 */

import type {
  Alert,
  Task,
  Barrier,
  HumanInput,
  HumanPolicy,
  WorkSelection,
} from "./types";
import { severityOrder } from "./types";

// ─── Main work selection ─────────────────────────────────────────────────────

export function selectWork(
  alerts: Alert[],
  tasks: Task[],
  barriers: Barrier[],
  humanInput: HumanInput[],
  _policy: HumanPolicy
): WorkSelection {
  // Priority 0: Human input (highest override)
  const pendingInput = humanInput.filter((h) => h.status === "pending");
  if (pendingInput.length > 0) {
    // Sort: urgent > normal > low
    const priorityMap = { urgent: 0, normal: 1, low: 2 };
    pendingInput.sort(
      (a, b) => priorityMap[a.priority] - priorityMap[b.priority]
    );
    return { type: "human-input", work: pendingInput[0] };
  }

  // Priority 1: In-progress alert (finish what you started)
  const activeAlert = alerts.find((a) => a.status === "in-progress");
  if (activeAlert) {
    return { type: "alert", work: activeAlert };
  }

  // Priority 2: Pending alerts (new interrupts)
  const pendingAlerts = alerts
    .filter((a) => a.status === "pending")
    .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  if (pendingAlerts.length > 0) {
    return { type: "alert", work: pendingAlerts[0] };
  }

  // Priority 3: In-progress task (continue current work)
  const activeTask = tasks.find(
    (t) => t.status === "in-progress" && !isBlocked(t, tasks, barriers)
  );
  if (activeTask) {
    return { type: "task", work: activeTask };
  }

  // Priority 4: Next available task (not blocked)
  const availableTasks = tasks
    .filter(
      (t) => t.status === "todo" && !isBlocked(t, tasks, barriers)
    )
    .sort((a, b) => a.priority - b.priority);
  if (availableTasks.length > 0) {
    return { type: "task", work: availableTasks[0] };
  }

  // Priority 5: Blocked — check if we can help
  const blockingBarriers = getBlockingBarriers(tasks, barriers);
  if (blockingBarriers.length > 0) {
    return {
      type: "blocked",
      barriers: blockingBarriers,
      canHelp: canMakeProgressOnBarrier(blockingBarriers),
    };
  }

  // Priority 6: All done
  return { type: "complete" };
}

// ─── Blocking checks ────────────────────────────────────────────────────────

export function isBlocked(
  task: Task,
  tasks: Task[],
  barriers: Barrier[]
): boolean {
  // Check task dependencies (dependsOn)
  if (task.dependsOn && task.dependsOn.length > 0) {
    const allDepsComplete = task.dependsOn.every((depId) => {
      const depTask = tasks.find((t) => t.id === depId);
      return depTask?.status === "complete";
    });
    if (!allDepsComplete) return true;
  }

  // Check barrier dependencies (blockedBy)
  if (task.blockedBy) {
    const barrier = barriers.find((b) => b.id === task.blockedBy);
    if (barrier && barrier.status === "waiting") return true;
  }

  return false;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getBlockingBarriers(
  tasks: Task[],
  barriers: Barrier[]
): Barrier[] {
  const incompleteTasks = tasks.filter((t) => t.status !== "complete");
  const barrierIds = new Set(
    incompleteTasks
      .filter((t) => t.blockedBy)
      .map((t) => t.blockedBy!)
  );

  return barriers.filter(
    (b) => barrierIds.has(b.id) && b.status === "waiting"
  );
}

function canMakeProgressOnBarrier(barriers: Barrier[]): boolean {
  return barriers.some(
    (b) => b.type === "command-check" || b.type === "file-exists"
  );
}
