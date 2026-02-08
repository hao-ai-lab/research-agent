#!/usr/bin/env bun
/**
 * Wild Loop — Event-Driven Autonomous Agent System
 *
 * Extension of Ralph Wiggum loop for long-running, event-driven workflows
 * with human-in-the-loop capabilities.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import type {
  Alert,
  Task,
  Barrier,
  HumanInput,
  HumanPolicy,
  LoopState,
  WorkSelection,
} from "./lib/types";
import { DEFAULT_POLICY } from "./lib/types";
import { parseTasks, parseBarriers, parseHumanPolicy, parseHumanInput } from "./lib/parsers";
import { loadAlerts, appendAlert, updateAlertStatus, setStateDir } from "./lib/alerts";
import { selectWork } from "./lib/work-selection";
import { loadBarriers, saveBarriers, setBarriersPath, startBarrierChecker } from "./lib/barriers";
import {
  shouldEscalateToHuman,
  shouldSendProgressReport,
  formatProgressReport,
  createAlertHistory,
} from "./lib/human-policy";
import { WildEventSystem, waitForEvent } from "./lib/event-system";

// ─── Paths ───────────────────────────────────────────────────────────────────

let stateDir = ".wild";
let tasksPath = join(stateDir, "tasks.md");
let barriersPath = join(stateDir, "barriers.md");
let humanInputPath = join(stateDir, "human.md");
let humanPolicyPath = join(stateDir, "human-policy.md");
let statePath = join(stateDir, "state.json");

function setPaths(dir: string): void {
  stateDir = dir;
  tasksPath = join(stateDir, "tasks.md");
  barriersPath = join(stateDir, "barriers.md");
  humanInputPath = join(stateDir, "human.md");
  humanPolicyPath = join(stateDir, "human-policy.md");
  statePath = join(stateDir, "state.json");
  setStateDir(dir);
  setBarriersPath(barriersPath);
}

// ─── State management ────────────────────────────────────────────────────────

function initializeState(prompt: string): LoopState {
  const state: LoopState = {
    active: true,
    iteration: 0,
    startedAt: new Date().toISOString(),
    prompt,
    agent: "opencode",
    model: "anthropic/claude-sonnet",
    alertsFilePosition: 0,
  };
  saveState(state);
  return state;
}

function loadState(): LoopState | null {
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, "utf-8"));
  } catch {
    return null;
  }
}

function saveState(state: LoopState): void {
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function clearState(): void {
  if (existsSync(statePath)) {
    writeFileSync(statePath, "{}");
  }
}

// ─── File loading helpers ────────────────────────────────────────────────────

function loadTasks(): Task[] {
  if (!existsSync(tasksPath)) return [];
  return parseTasks(readFileSync(tasksPath, "utf-8"));
}

function loadHumanPolicy(): HumanPolicy {
  if (!existsSync(humanPolicyPath)) return DEFAULT_POLICY;
  return parseHumanPolicy(readFileSync(humanPolicyPath, "utf-8"));
}

function loadHumanInputs(): HumanInput[] {
  if (!existsSync(humanInputPath)) return [];
  return parseHumanInput(readFileSync(humanInputPath, "utf-8"));
}

// ─── Duration formatting ────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// ─── Context summary ────────────────────────────────────────────────────────

function buildContextSummary(): string {
  const alerts = loadAlerts();
  const tasks = loadTasks();
  const barriers = loadBarriers();

  const pendingAlerts = alerts.filter((a) => a.status === "pending");
  const incompleteTasks = tasks.filter((t) => t.status !== "complete");
  const waitingBarriers = barriers.filter((b) => b.status === "waiting");

  return `
## 📊 Current System State

### Alerts: ${pendingAlerts.length} pending
${pendingAlerts
  .slice(0, 3)
  .map((a) => `- [${a.severity.toUpperCase()}] ${a.source}: ${a.description}`)
  .join("\n")}
${pendingAlerts.length > 3 ? `- ... and ${pendingAlerts.length - 3} more` : ""}

### Tasks: ${incompleteTasks.length} remaining
${incompleteTasks
  .slice(0, 5)
  .map(
    (t) =>
      `- ${t.status === "in-progress" ? "🔄" : "⏸️"} [P${t.priority}] ${t.text}${t.blockedBy ? ` (blocked by ${t.blockedBy})` : ""}`
  )
  .join("\n")}

### Barriers: ${waitingBarriers.length} active
${waitingBarriers.map((b) => `- ⏳ ${b.name}: ${b.lastCheckResult || "waiting"}`).join("\n")}
  `.trim();
}

// ─── Main loop ───────────────────────────────────────────────────────────────

export interface WildLoopOptions {
  prompt: string;
  stateDir?: string;
  maxIterations?: number;
  onAlert?: (alert: Alert, work: WorkSelection) => Promise<void>;
  onTask?: (task: Task, work: WorkSelection) => Promise<void>;
  onHumanInput?: (input: HumanInput) => Promise<void>;
  onComplete?: () => Promise<void>;
  onBlocked?: (barriers: Barrier[]) => Promise<void>;
  barrierCheckIntervalMs?: number;
  idleTimeoutMs?: number;
  iterationDelayMs?: number;
}

export async function runWildLoop(options: WildLoopOptions): Promise<{
  state: LoopState;
  completionReason: "complete" | "max-iterations" | "error" | "interrupted";
}> {
  // Setup
  if (options.stateDir) setPaths(options.stateDir);

  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                      Wild Loop                            ║
║         Event-Driven Autonomous Agent System              ║
╚═══════════════════════════════════════════════════════════╝
  `);

  // Ensure state directory
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }

  const state = initializeState(options.prompt);
  const policy = loadHumanPolicy();
  const alertHistory = createAlertHistory();
  const eventQueue = new WildEventSystem();
  eventQueue.startWatchers(stateDir);

  // Start barrier checker
  const barrierChecker = await startBarrierChecker(
    eventQueue,
    options.barrierCheckIntervalMs || 10000
  );

  const maxIterations = options.maxIterations || Infinity;
  const idleTimeoutMs = options.idleTimeoutMs || 5 * 60 * 1000;
  const iterationDelayMs = options.iterationDelayMs || 2000;

  let completionReason: "complete" | "max-iterations" | "error" | "interrupted" = "complete";

  try {
    // Main loop
    while (state.iteration < maxIterations) {
      // 1. Load current state
      const alerts = loadAlerts();
      const tasks = loadTasks();
      const barriers = loadBarriers();
      const humanInput = loadHumanInputs();

      // 2. Send progress report if due
      if (shouldSendProgressReport(policy, state)) {
        console.log(formatProgressReport(state));
        state.lastProgressReport = new Date().toISOString();
        saveState(state);
      }

      // 3. Select work
      const work = selectWork(alerts, tasks, barriers, humanInput, policy);

      // 4. Handle work
      switch (work.type) {
        case "human-input": {
          const input = work.work as HumanInput;
          console.log(`📥 Processing human input: ${input.type}`);
          if (options.onHumanInput) {
            await options.onHumanInput(input);
          }
          alertHistory.recordProgress();
          break;
        }

        case "alert": {
          const alert = work.work as Alert;
          const escalation = shouldEscalateToHuman(
            alert,
            policy,
            alertHistory
          );

          alertHistory.recordAttempt(alert.id);

          if (escalation.escalate && escalation.blocking) {
            console.log(
              `⏸️  BLOCKED: Waiting for human input on ${alert.id} (${escalation.reason})`
            );
            // Wait for event or timeout
            await Promise.race([
              waitForEvent(eventQueue, idleTimeoutMs),
              Bun.sleep(idleTimeoutMs),
            ]);
            continue;
          } else if (escalation.escalate) {
            console.log(
              `📤 Notifying human (non-blocking): ${escalation.reason}`
            );
          }

          // Handle alert
          console.log(
            `🚨 Handling alert: ${alert.id} [${alert.severity}] ${alert.description}`
          );
          if (options.onAlert) {
            await options.onAlert(alert, work);
          }
          alertHistory.recordProgress();
          break;
        }

        case "task": {
          const task = work.work as Task;
          console.log(`📋 Working on task: ${task.id} - ${task.text}`);
          state.currentWork = {
            type: "task",
            id: task.id,
            startedAt: new Date().toISOString(),
          };
          if (options.onTask) {
            await options.onTask(task, work);
          }
          alertHistory.recordProgress();
          break;
        }

        case "blocked": {
          if (work.canHelp) {
            console.log("🔍 Monitoring barriers...");
            if (options.onBlocked) {
              await options.onBlocked(work.barriers!);
            }
          } else {
            console.log(`⏳ Entering wait mode (no active work)`);
            console.log(
              `   Waiting for: ${work.barriers!.map((b) => b.name).join(", ")}`
            );
            await Promise.race([
              waitForEvent(eventQueue, idleTimeoutMs),
              Bun.sleep(idleTimeoutMs),
            ]);
            console.log("⏰ Woke up - checking for updates...");
            continue; // Don't increment iteration
          }
          break;
        }

        case "complete": {
          const elapsed = Date.now() - new Date(state.startedAt).getTime();
          console.log(`
╔═══════════════════════════════════════════════════════════╗
║  ✅ All work complete!                                    ║
║  Total time: ${formatDuration(elapsed).padEnd(43)}║
╚═══════════════════════════════════════════════════════════╝
          `);
          if (options.onComplete) {
            await options.onComplete();
          }
          completionReason = "complete";
          state.active = false;
          saveState(state);
          break;
        }
      }

      if (!state.active || work.type === "complete") break;

      // 5. Update state
      state.iteration++;
      saveState(state);

      // 6. Brief pause between active iterations
      if (iterationDelayMs > 0) {
        await Bun.sleep(iterationDelayMs);
      }
    }

    if (state.iteration >= maxIterations) {
      completionReason = "max-iterations";
    }
  } catch (error) {
    console.error("❌ Wild Loop error:", error);
    completionReason = "error";
  } finally {
    eventQueue.stopWatchers();
    barrierChecker.stop();
    state.active = false;
    saveState(state);
  }

  return { state, completionReason };
}

// ─── Exports for programmatic use ────────────────────────────────────────────

export {
  setPaths,
  initializeState,
  loadState,
  saveState,
  clearState,
  loadTasks,
  loadHumanPolicy,
  loadHumanInputs,
  buildContextSummary,
  formatDuration,
};

// Re-export lib modules
export * from "./lib/types";
export * from "./lib/parsers";
export * from "./lib/alerts";
export * from "./lib/work-selection";
export * from "./lib/barriers";
export * from "./lib/human-policy";
export * from "./lib/event-system";
