/**
 * Wild Loop — MLP Training Sweep Test
 *
 * End-to-end test: human input → design sweep → run 16 configs (CPU + sleep) →
 * handle alerts (loss spikes + OOM) → human resolution → analysis pipeline.
 *
 * 16 MLP configurations:
 *   hidden_sizes: [64, 128, 256, 512]
 *   learning_rates: [0.001, 0.01, 0.05, 0.1]
 *
 * Deterministic failures:
 *   - lr=0.1,  hidden=512 → OOM
 *   - lr=0.1,  hidden=256 → OOM
 *   - lr=0.05, hidden=512 → loss spike at step 50
 *   - lr=0.05, hidden=256 → loss spike at step 30
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import type { Alert, Task, Barrier, HumanInput } from "../lib/types";
import { parseTasks, parseBarriers, parseHumanPolicy, parseHumanInput } from "../lib/parsers";
import { loadAlerts, appendAlert, updateAlertStatus, setStateDir, loadAllAlerts } from "../lib/alerts";
import { selectWork, isBlocked } from "../lib/work-selection";
import { shouldEscalateToHuman, createAlertHistory } from "../lib/human-policy";
import { DEFAULT_POLICY } from "../lib/types";

// ─── MLP Config Generation ──────────────────────────────────────────────────

interface MLPConfig {
  runId: string;
  hiddenSize: number;
  learningRate: number;
  batchSize: number;
  epochs: number;
}

const HIDDEN_SIZES = [64, 128, 256, 512];
const LEARNING_RATES = [0.001, 0.01, 0.05, 0.1];

function generateConfigs(): MLPConfig[] {
  const configs: MLPConfig[] = [];
  for (const hidden of HIDDEN_SIZES) {
    for (const lr of LEARNING_RATES) {
      configs.push({
        runId: `mlp-h${hidden}-lr${lr}`,
        hiddenSize: hidden,
        learningRate: lr,
        batchSize: 64,
        epochs: 100,
      });
    }
  }
  return configs;
}

// ─── Mock Training ───────────────────────────────────────────────────────────

interface TrainingResult {
  status: "success" | "failed" | "oom";
  finalLoss?: number;
  finalAccuracy?: number;
  stepsCompleted?: number;
  alert?: {
    type: string;
    severity: "critical" | "warning";
    description: string;
    step?: number;
  };
}

/**
 * Simulate MLP training. Deterministic outcomes based on config.
 * Uses Bun.sleep to mock real training time (short for tests).
 */
async function mockTraining(config: MLPConfig, sleepMs: number = 50): Promise<TrainingResult> {
  await Bun.sleep(sleepMs);

  // Deterministic failure: OOM for high lr + large hidden
  if (config.learningRate >= 0.1 && config.hiddenSize >= 256) {
    return {
      status: "oom",
      stepsCompleted: 0,
      alert: {
        type: "OOM",
        severity: "critical",
        description: `GPU memory exhausted with hidden_size=${config.hiddenSize}, lr=${config.learningRate}, batch_size=${config.batchSize}`,
        step: 0,
      },
    };
  }

  // Deterministic failure: loss spike for lr=0.05 + hidden>=256
  if (config.learningRate >= 0.05 && config.hiddenSize >= 256) {
    const spikeStep = config.hiddenSize === 512 ? 50 : 30;
    return {
      status: "failed",
      finalLoss: 15.7,
      stepsCompleted: spikeStep,
      alert: {
        type: "divergence",
        severity: "warning",
        description: `Loss spike at step ${spikeStep}: loss went from 2.3 to 15.7 (hidden=${config.hiddenSize}, lr=${config.learningRate})`,
        step: spikeStep,
      },
    };
  }

  // Success: synthetic metrics based on config
  const baseLoss = 0.5 + config.learningRate * 2;
  const finalLoss = Math.max(0.01, baseLoss - config.hiddenSize * 0.001);
  const finalAccuracy = Math.min(0.99, 1 - finalLoss * 0.3);

  return {
    status: "success",
    finalLoss: parseFloat(finalLoss.toFixed(4)),
    finalAccuracy: parseFloat(finalAccuracy.toFixed(4)),
    stepsCompleted: config.epochs,
  };
}

// ─── Test helpers ────────────────────────────────────────────────────────────

let testDir: string;

function setupTestDir(): string {
  const dir = join(tmpdir(), `wild-loop-test-${Date.now()}`);
  const wildDir = join(dir, ".wild");
  mkdirSync(wildDir, { recursive: true });
  setStateDir(wildDir);
  return dir;
}

function cleanupTestDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup
  }
}

function writeTasksFile(wildDir: string, tasks: string): void {
  writeFileSync(join(wildDir, "tasks.md"), tasks);
}

function writeBarriersFile(wildDir: string, content: string): void {
  writeFileSync(join(wildDir, "barriers.md"), content);
}

function writeHumanInputFile(wildDir: string, content: string): void {
  writeFileSync(join(wildDir, "human.md"), content);
}

function writePolicyFile(wildDir: string, content: string): void {
  writeFileSync(join(wildDir, "human-policy.md"), content);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Wild Loop — Parsers", () => {
  test("parseTasks: parses markdown task list", () => {
    const content = `# Wild Loop Tasks

- [x] [P1] task-001: Preprocess training data
- [/] [P1] task-002: Launch training sweep
  - dependsOn: task-001
- [ ] [P2] task-003: Analyze training results
  - dependsOn: task-002
  - blockedBy: barrier-training-complete
  - [ ] Load checkpoint files
  - [ ] Compute metrics
`;

    const tasks = parseTasks(content);
    expect(tasks).toHaveLength(3);
    expect(tasks[0].id).toBe("task-001");
    expect(tasks[0].status).toBe("complete");
    expect(tasks[0].priority).toBe(1);

    expect(tasks[1].id).toBe("task-002");
    expect(tasks[1].status).toBe("in-progress");
    expect(tasks[1].dependsOn).toEqual(["task-001"]);

    expect(tasks[2].id).toBe("task-003");
    expect(tasks[2].status).toBe("todo");
    expect(tasks[2].blockedBy).toBe("barrier-training-complete");
    expect(tasks[2].subtasks).toHaveLength(2);
  });

  test("parseBarriers: parses barrier definitions", () => {
    const content = `# Wild Loop Barriers

## [WAITING] barrier-training-complete
- Type: command-check
- Check: echo 0
- Expect: 0
- Interval: 60s
- Blocks: task-003, task-004

## [SATISFIED] barrier-data-ready
- Type: file-exists
- File: /tmp/data.csv
- Satisfied: 2026-02-08T10:00:00Z
`;

    const barriers = parseBarriers(content);
    expect(barriers).toHaveLength(2);
    expect(barriers[0].id).toBe("barrier-training-complete");
    expect(barriers[0].status).toBe("waiting");
    expect(barriers[0].type).toBe("command-check");
    expect(barriers[0].blocks).toEqual(["task-003", "task-004"]);

    expect(barriers[1].id).toBe("barrier-data-ready");
    expect(barriers[1].status).toBe("satisfied");
  });

  test("parseHumanPolicy: parses policy markdown", () => {
    const content = `# Human Policy

## Current Policy: Autonomous Mode

**Active From:** 2026-02-08T10:00:00Z
**Expires At:** 2026-02-08T16:00:00Z

### Settings

- **Mode:** autonomous
- **Autonomy Level:** high
- **Max Retry Attempts:** 5
- **Escalation Threshold:** critical-only
- **Progress Reports:** Every 30 minutes
- **Context Switch Penalty:** 15 minutes

### Escalation Rules

- **Repeated Failures:** Escalate after 5 failed attempts
- **Stuck Duration:** Escalate if no progress for 60 minutes
- **Critical Alerts:** Always escalate

### Instructions

Do your best. Only bug me for critical issues.
`;

    const policy = parseHumanPolicy(content);
    expect(policy.mode).toBe("autonomous");
    expect(policy.autonomyLevel).toBe("high");
    expect(policy.maxRetryAttempts).toBe(5);
    expect(policy.escalationThreshold).toBe("critical-only");
    expect(policy.progressReportInterval).toBe(30);
    expect(policy.escalateOn.repeatedFailures).toBe(5);
    expect(policy.escalateOn.stuckDuration).toBe(60);
    expect(policy.escalateOn.criticalAlerts).toBe(true);
  });

  test("parseHumanInput: parses input queue", () => {
    const content = `# Human Input Queue

## [PENDING] 2026-02-08T12:30:00Z - URGENT
**Type:** alert-resolution-guidance
**Alert:** alert-005

### Input:
Reduce batch size from 64 to 32 and retry.

---

## [PROCESSED] 2026-02-08T11:00:00Z
**Type:** task-addition

### Input:
Add visualization task after analysis.

### Processed:
2026-02-08T11:01:00Z
`;

    const inputs = parseHumanInput(content);
    expect(inputs).toHaveLength(2);
    expect(inputs[0].status).toBe("pending");
    expect(inputs[0].priority).toBe("urgent");
    expect(inputs[0].type).toBe("alert-resolution-guidance");
    expect(inputs[0].relatedAlert).toBe("alert-005");
    expect(inputs[0].content).toContain("Reduce batch size");

    expect(inputs[1].status).toBe("processed");
    expect(inputs[1].type).toBe("task-addition");
  });
});

describe("Wild Loop — Alerts", () => {
  beforeEach(() => {
    testDir = setupTestDir();
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  test("appendAlert + loadAlerts round-trip", () => {
    const alert: Alert = {
      id: "alert-001",
      timestamp: "2026-02-08T10:00:00Z",
      severity: "critical",
      source: "training-job-1",
      type: "OOM",
      description: "GPU memory exhausted",
      status: "pending",
    };

    appendAlert(alert);
    const loaded = loadAlerts();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("alert-001");
    expect(loaded[0].severity).toBe("critical");
  });

  test("updateAlertStatus appends new entry", () => {
    appendAlert({
      id: "alert-002",
      timestamp: "2026-02-08T10:00:00Z",
      severity: "warning",
      source: "job-5",
      type: "divergence",
      description: "Loss spike",
      status: "pending",
    });

    updateAlertStatus("alert-002", "resolved", {
      resolvedAt: "2026-02-08T10:05:00Z",
    });

    const active = loadAlerts();
    expect(active).toHaveLength(0); // resolved, so filtered out

    const all = loadAllAlerts();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("resolved");
  });

  test("latest entry per ID wins", () => {
    appendAlert({
      id: "alert-003",
      timestamp: "2026-02-08T10:00:00Z",
      severity: "critical",
      source: "job-3",
      type: "OOM",
      description: "OOM v1",
      status: "pending",
    });

    appendAlert({
      id: "alert-003",
      timestamp: "2026-02-08T10:05:00Z",
      severity: "critical",
      source: "job-3",
      type: "OOM",
      description: "OOM v2 - being handled",
      status: "in-progress",
    });

    const loaded = loadAlerts();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].status).toBe("in-progress");
    expect(loaded[0].description).toBe("OOM v2 - being handled");
  });
});

describe("Wild Loop — Work Selection", () => {
  test("human input has highest priority", () => {
    const alerts: Alert[] = [
      {
        id: "a1",
        timestamp: "t",
        severity: "critical",
        source: "s",
        type: "OOM",
        description: "d",
        status: "pending",
      },
    ];
    const tasks: Task[] = [];
    const barriers: Barrier[] = [];
    const humanInput: HumanInput[] = [
      {
        timestamp: "t",
        priority: "urgent",
        type: "general-instruction",
        content: "Fix this now",
        status: "pending",
      },
    ];

    const work = selectWork(alerts, tasks, barriers, humanInput, DEFAULT_POLICY);
    expect(work.type).toBe("human-input");
  });

  test("in-progress alert beats pending alert", () => {
    const alerts: Alert[] = [
      {
        id: "a1",
        timestamp: "t",
        severity: "critical",
        source: "s",
        type: "OOM",
        description: "d",
        status: "pending",
      },
      {
        id: "a2",
        timestamp: "t",
        severity: "warning",
        source: "s",
        type: "divergence",
        description: "d",
        status: "in-progress",
      },
    ];

    const work = selectWork(alerts, [], [], [], DEFAULT_POLICY);
    expect(work.type).toBe("alert");
    expect((work.work as Alert).id).toBe("a2");
  });

  test("pending alerts sorted by severity", () => {
    const alerts: Alert[] = [
      {
        id: "a-info",
        timestamp: "t",
        severity: "info",
        source: "s",
        type: "info",
        description: "d",
        status: "pending",
      },
      {
        id: "a-crit",
        timestamp: "t",
        severity: "critical",
        source: "s",
        type: "OOM",
        description: "d",
        status: "pending",
      },
    ];

    const work = selectWork(alerts, [], [], [], DEFAULT_POLICY);
    expect((work.work as Alert).id).toBe("a-crit");
  });

  test("tasks blocked by dependencies", () => {
    const tasks: Task[] = [
      {
        id: "task-001",
        text: "First",
        priority: 1,
        status: "todo",
        subtasks: [],
      },
      {
        id: "task-002",
        text: "Second",
        priority: 1,
        status: "todo",
        dependsOn: ["task-001"],
        subtasks: [],
      },
    ];

    expect(isBlocked(tasks[1], tasks, [])).toBe(true);
    expect(isBlocked(tasks[0], tasks, [])).toBe(false);

    // After task-001 completes, task-002 is unblocked
    tasks[0].status = "complete";
    expect(isBlocked(tasks[1], tasks, [])).toBe(false);
  });

  test("tasks blocked by barriers", () => {
    const tasks: Task[] = [
      {
        id: "task-003",
        text: "Analyze",
        priority: 2,
        status: "todo",
        blockedBy: "barrier-training",
        subtasks: [],
      },
    ];
    const barriers: Barrier[] = [
      {
        id: "barrier-training",
        name: "barrier-training",
        type: "file-exists",
        status: "waiting",
        createdAt: "t",
      },
    ];

    expect(isBlocked(tasks[0], tasks, barriers)).toBe(true);

    barriers[0].status = "satisfied";
    expect(isBlocked(tasks[0], tasks, barriers)).toBe(false);
  });

  test("complete when no work left", () => {
    const tasks: Task[] = [
      {
        id: "task-001",
        text: "Done",
        priority: 1,
        status: "complete",
        subtasks: [],
      },
    ];

    const work = selectWork([], tasks, [], [], DEFAULT_POLICY);
    expect(work.type).toBe("complete");
  });
});

describe("Wild Loop — Escalation Policy", () => {
  test("critical alert escalated with critical-only threshold", () => {
    const alert: Alert = {
      id: "a1",
      timestamp: "t",
      severity: "critical",
      source: "s",
      type: "OOM",
      description: "d",
      status: "pending",
    };

    const policy = {
      ...DEFAULT_POLICY,
      escalationThreshold: "critical-only" as const,
      escalateOn: { ...DEFAULT_POLICY.escalateOn, criticalAlerts: true },
    };

    const history = createAlertHistory();
    const result = shouldEscalateToHuman(alert, policy, history);
    expect(result.escalate).toBe(true);
    expect(result.urgency).toBe("high");
  });

  test("warning not escalated with critical-only threshold", () => {
    const alert: Alert = {
      id: "a2",
      timestamp: "t",
      severity: "warning",
      source: "s",
      type: "divergence",
      description: "d",
      status: "pending",
    };

    const policy = {
      ...DEFAULT_POLICY,
      escalationThreshold: "critical-only" as const,
      autonomyLevel: "high" as const,
    };

    const history = createAlertHistory();
    const result = shouldEscalateToHuman(alert, policy, history);
    expect(result.escalate).toBe(false);
  });

  test("repeated failures trigger escalation", () => {
    const alert: Alert = {
      id: "a3",
      timestamp: "t",
      severity: "warning",
      source: "s",
      type: "divergence",
      description: "d",
      status: "pending",
    };

    const policy = {
      ...DEFAULT_POLICY,
      maxRetryAttempts: 3,
      escalationThreshold: "never" as const,
      escalateOn: {
        ...DEFAULT_POLICY.escalateOn,
        criticalAlerts: false,
        repeatedFailures: 3,
      },
    };

    const history = createAlertHistory();
    // Simulate 3 failed attempts
    history.recordAttempt("a3");
    history.recordAttempt("a3");
    history.recordAttempt("a3");

    const result = shouldEscalateToHuman(alert, policy, history);
    expect(result.escalate).toBe(true);
    expect(result.reason).toContain("Tried 3 times");
  });
});

describe("Wild Loop — MLP Sweep Pipeline (Integration)", () => {
  beforeEach(() => {
    testDir = setupTestDir();
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  test("generates 16 MLP configurations", () => {
    const configs = generateConfigs();
    expect(configs).toHaveLength(16);

    const uniqueIds = new Set(configs.map((c) => c.runId));
    expect(uniqueIds.size).toBe(16);
  });

  test("mock training produces deterministic failures", async () => {
    const configs = generateConfigs();

    // OOM: lr=0.1, hidden=512
    const oomConfig = configs.find(
      (c) => c.learningRate === 0.1 && c.hiddenSize === 512
    )!;
    const oomResult = await mockTraining(oomConfig, 10);
    expect(oomResult.status).toBe("oom");
    expect(oomResult.alert?.type).toBe("OOM");
    expect(oomResult.alert?.severity).toBe("critical");

    // OOM: lr=0.1, hidden=256
    const oom2Config = configs.find(
      (c) => c.learningRate === 0.1 && c.hiddenSize === 256
    )!;
    const oom2Result = await mockTraining(oom2Config, 10);
    expect(oom2Result.status).toBe("oom");

    // Loss spike: lr=0.05, hidden=512
    const spikeConfig = configs.find(
      (c) => c.learningRate === 0.05 && c.hiddenSize === 512
    )!;
    const spikeResult = await mockTraining(spikeConfig, 10);
    expect(spikeResult.status).toBe("failed");
    expect(spikeResult.alert?.type).toBe("divergence");
    expect(spikeResult.alert?.step).toBe(50);

    // Loss spike: lr=0.05, hidden=256
    const spike2Config = configs.find(
      (c) => c.learningRate === 0.05 && c.hiddenSize === 256
    )!;
    const spike2Result = await mockTraining(spike2Config, 10);
    expect(spike2Result.status).toBe("failed");
    expect(spike2Result.alert?.step).toBe(30);

    // Success: lr=0.001, hidden=64
    const successConfig = configs.find(
      (c) => c.learningRate === 0.001 && c.hiddenSize === 64
    )!;
    const successResult = await mockTraining(successConfig, 10);
    expect(successResult.status).toBe("success");
    expect(successResult.finalLoss).toBeDefined();
    expect(successResult.finalAccuracy).toBeDefined();
  });

  test("full pipeline: sweep → alerts → resolution → analysis", async () => {
    const wildDir = join(testDir, ".wild");
    const configs = generateConfigs();
    const alertHistory = createAlertHistory();

    // ═══════════════════════════════════════════════════════════════════════
    // Phase 1: Human Input → Design the sweep
    // ═══════════════════════════════════════════════════════════════════════

    writeHumanInputFile(
      wildDir,
      `# Human Input Queue

## [PENDING] 2026-02-08T10:00:00Z - normal
**Type:** general-instruction

### Input:
Run an MLP hyperparameter sweep with 16 configurations.
Vary hidden sizes [64, 128, 256, 512] and learning rates [0.001, 0.01, 0.05, 0.1].
Use batch size 64 and train for 100 epochs each.
`
    );

    const humanInputs = parseHumanInput(
      readFileSync(join(wildDir, "human.md"), "utf-8")
    );
    expect(humanInputs).toHaveLength(1);
    expect(humanInputs[0].status).toBe("pending");

    // Work selection picks human input first
    let work = selectWork([], [], [], humanInputs, DEFAULT_POLICY);
    expect(work.type).toBe("human-input");

    // ═══════════════════════════════════════════════════════════════════════
    // Phase 2: Design the sweep → Create tasks
    // ═══════════════════════════════════════════════════════════════════════

    // Generate tasks.md from configs
    const taskLines = [
      "# Wild Loop Tasks",
      "",
      "- [x] [P1] task-001: Design MLP sweep configuration",
    ];

    for (let i = 0; i < configs.length; i++) {
      const c = configs[i];
      taskLines.push(
        `- [ ] [P1] task-${String(i + 2).padStart(3, "0")}: Train MLP h=${c.hiddenSize} lr=${c.learningRate}`
      );
      taskLines.push("  - dependsOn: task-001");
    }

    // Analysis task: depends on all training tasks, blocked by barrier
    taskLines.push(
      `- [ ] [P2] task-${String(configs.length + 2).padStart(3, "0")}: Analyze sweep results`
    );
    taskLines.push(
      `  - blockedBy: barrier-all-runs-complete`
    );

    writeTasksFile(wildDir, taskLines.join("\n"));

    // Create barrier for all runs
    writeBarriersFile(
      wildDir,
      `# Wild Loop Barriers

## [WAITING] barrier-all-runs-complete
- Type: count-based
- Target: ${configs.length}
- Interval: 5s
- Blocks: task-${String(configs.length + 2).padStart(3, "0")}
`
    );

    // Set up autonomous policy
    writePolicyFile(
      wildDir,
      `# Human Policy

## Current Policy: Autonomous Mode

**Active From:** 2026-02-08T10:00:00Z
**Expires At:** 2026-02-08T16:00:00Z

### Settings

- **Mode:** autonomous
- **Autonomy Level:** high
- **Max Retry Attempts:** 3
- **Escalation Threshold:** critical-only
- **Progress Reports:** Every 30 minutes
- **Context Switch Penalty:** 15 minutes

### Escalation Rules

- **Repeated Failures:** Escalate after 3 failed attempts
- **Stuck Duration:** Escalate if no progress for 60 minutes
- **Critical Alerts:** Always escalate

### Instructions

Running MLP sweep. Handle loss spikes autonomously. Escalate OOM errors.
`
    );

    // Verify tasks parsed
    const tasks = parseTasks(readFileSync(join(wildDir, "tasks.md"), "utf-8"));
    expect(tasks).toHaveLength(configs.length + 2); // design + 16 runs + analysis
    expect(tasks[0].status).toBe("complete"); // design task already done

    // Verify barrier
    const barriers = parseBarriers(
      readFileSync(join(wildDir, "barriers.md"), "utf-8")
    );
    expect(barriers).toHaveLength(1);
    expect(barriers[0].status).toBe("waiting");

    // Verify policy
    const policy = parseHumanPolicy(
      readFileSync(join(wildDir, "human-policy.md"), "utf-8")
    );
    expect(policy.mode).toBe("autonomous");
    expect(policy.autonomyLevel).toBe("high");
    expect(policy.escalationThreshold).toBe("critical-only");

    // ═══════════════════════════════════════════════════════════════════════
    // Phase 3: Run the sweep — execute all 16 configs
    // ═══════════════════════════════════════════════════════════════════════

    const results: Map<string, TrainingResult> = new Map();
    const alertsCreated: Alert[] = [];
    let completedCount = 0;

    for (const config of configs) {
      // Select work — should pick next available training task
      const currentTasks = parseTasks(
        readFileSync(join(wildDir, "tasks.md"), "utf-8")
      );
      const currentAlerts = loadAlerts();
      const currentBarriers = parseBarriers(
        readFileSync(join(wildDir, "barriers.md"), "utf-8")
      );

      work = selectWork(currentAlerts, currentTasks, currentBarriers, [], policy);

      // If there's a pending alert, handle it first
      if (work.type === "alert") {
        const alert = work.work as Alert;

        // Check escalation
        const escalation = shouldEscalateToHuman(alert, policy, alertHistory);
        alertHistory.recordAttempt(alert.id);

        if (escalation.escalate) {
          // For OOM: escalate to human (critical)
          expect(alert.severity).toBe("critical");
          updateAlertStatus(alert.id, "escalated", {
            escalatedAt: new Date().toISOString(),
          });

          // Simulate human response: reduce batch size
          updateAlertStatus(alert.id, "resolved", {
            resolvedAt: new Date().toISOString(),
            context: {
              resolution: "Human reduced batch size from 64 to 32",
            },
          });
        } else {
          // For warnings: auto-handle (loss spikes)
          updateAlertStatus(alert.id, "resolved", {
            resolvedAt: new Date().toISOString(),
            context: { resolution: "Auto-handled: adjusted learning rate" },
          });
        }

        alertHistory.recordProgress();
      }

      // Run mock training
      const result = await mockTraining(config, 10);
      results.set(config.runId, result);

      // Create alerts for failures
      if (result.alert) {
        const alert: Alert = {
          id: `alert-${config.runId}`,
          timestamp: new Date().toISOString(),
          severity: result.alert.severity,
          source: config.runId,
          type: result.alert.type,
          description: result.alert.description,
          status: "pending",
        };
        appendAlert(alert);
        alertsCreated.push(alert);
      }

      // Update task status
      const taskContent = readFileSync(join(wildDir, "tasks.md"), "utf-8");
      const taskIdx = configs.indexOf(config) + 2; // +2 because task-001 is design
      const taskId = `task-${String(taskIdx).padStart(3, "0")}`;
      const updatedContent = taskContent.replace(
        `- [ ] [P1] ${taskId}:`,
        `- [x] [P1] ${taskId}:`
      );
      writeFileSync(join(wildDir, "tasks.md"), updatedContent);

      if (result.status === "success") completedCount++;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Phase 3b: Handle remaining unresolved alerts
    // ═══════════════════════════════════════════════════════════════════════

    let unresolvedAlerts = loadAlerts();
    for (const alert of unresolvedAlerts) {
      const escalation = shouldEscalateToHuman(alert, policy, alertHistory);
      alertHistory.recordAttempt(alert.id);

      if (alert.severity === "critical") {
        // OOM: human resolves
        updateAlertStatus(alert.id, "resolved", {
          resolvedAt: new Date().toISOString(),
          context: {
            resolution: "Human reduced batch size from 64 to 32, retry successful",
          },
        });
      } else {
        // Warning: auto-resolve
        updateAlertStatus(alert.id, "resolved", {
          resolvedAt: new Date().toISOString(),
          context: { resolution: "Auto-handled: reduced learning rate" },
        });
      }
    }

    // Verify all alerts resolved
    unresolvedAlerts = loadAlerts();
    expect(unresolvedAlerts).toHaveLength(0);

    // ═══════════════════════════════════════════════════════════════════════
    // Phase 4: Verify alert counts
    // ═══════════════════════════════════════════════════════════════════════

    // 2 OOM (critical) + 2 loss spike (warning) = 4 alerts
    expect(alertsCreated).toHaveLength(4);

    const oomAlerts = alertsCreated.filter((a) => a.type === "OOM");
    expect(oomAlerts).toHaveLength(2);
    expect(oomAlerts.every((a) => a.severity === "critical")).toBe(true);

    const spikeAlerts = alertsCreated.filter((a) => a.type === "divergence");
    expect(spikeAlerts).toHaveLength(2);
    expect(spikeAlerts.every((a) => a.severity === "warning")).toBe(true);

    // ═══════════════════════════════════════════════════════════════════════
    // Phase 5: Barrier satisfied → Analysis pipeline
    // ═══════════════════════════════════════════════════════════════════════

    // Mark barrier as satisfied (all runs complete)
    const finalBarriers = parseBarriers(
      readFileSync(join(wildDir, "barriers.md"), "utf-8")
    );
    finalBarriers[0].status = "satisfied";
    finalBarriers[0].satisfiedAt = new Date().toISOString();

    // Rewrite barriers file
    const barrierLines = [
      "# Wild Loop Barriers",
      "",
      `## [SATISFIED] ${finalBarriers[0].id}`,
      `- Type: ${finalBarriers[0].type}`,
      `- Target: ${configs.length}`,
      `- Satisfied: ${finalBarriers[0].satisfiedAt}`,
      "",
    ];
    writeFileSync(join(wildDir, "barriers.md"), barrierLines.join("\n"));

    // Update analysis task to in-progress
    let finalTaskContent = readFileSync(join(wildDir, "tasks.md"), "utf-8");
    const analysisTaskId = `task-${String(configs.length + 2).padStart(3, "0")}`;
    finalTaskContent = finalTaskContent.replace(
      `- [ ] [P2] ${analysisTaskId}:`,
      `- [/] [P2] ${analysisTaskId}:`
    );
    writeFileSync(join(wildDir, "tasks.md"), finalTaskContent);

    // Analysis: generate report
    const successfulRuns = Array.from(results.entries())
      .filter(([, r]) => r.status === "success")
      .sort((a, b) => (a[1].finalLoss || 99) - (b[1].finalLoss || 99));

    const failedRuns = Array.from(results.entries()).filter(
      ([, r]) => r.status !== "success"
    );

    const report = [
      "# MLP Hyperparameter Sweep Report",
      "",
      `## Summary`,
      `- Total configurations: ${configs.length}`,
      `- Successful: ${successfulRuns.length}`,
      `- Failed (loss spike): ${failedRuns.filter(([, r]) => r.status === "failed").length}`,
      `- OOM: ${failedRuns.filter(([, r]) => r.status === "oom").length}`,
      `- Alerts generated: ${alertsCreated.length}`,
      `- Alerts resolved: ${alertsCreated.length}`,
      "",
      "## Best Configurations (by final loss)",
      "",
      "| Rank | Config | Hidden Size | LR | Final Loss | Accuracy |",
      "|------|--------|-------------|-----|------------|----------|",
    ];

    for (let i = 0; i < Math.min(5, successfulRuns.length); i++) {
      const [id, r] = successfulRuns[i];
      const config = configs.find((c) => c.runId === id)!;
      report.push(
        `| ${i + 1} | ${id} | ${config.hiddenSize} | ${config.learningRate} | ${r.finalLoss} | ${r.finalAccuracy} |`
      );
    }

    report.push("");
    report.push("## Failed Runs");
    report.push("");
    for (const [id, r] of failedRuns) {
      report.push(
        `- **${id}**: ${r.status} — ${r.alert?.description || "unknown"}`
      );
    }

    const reportContent = report.join("\n");

    // Write report
    writeFileSync(join(testDir, "sweep_report.md"), reportContent);

    // Mark analysis task complete
    finalTaskContent = readFileSync(join(wildDir, "tasks.md"), "utf-8");
    finalTaskContent = finalTaskContent.replace(
      `- [/] [P2] ${analysisTaskId}:`,
      `- [x] [P2] ${analysisTaskId}:`
    );
    writeFileSync(join(wildDir, "tasks.md"), finalTaskContent);

    // ═══════════════════════════════════════════════════════════════════════
    // Phase 6: Verify completion
    // ═══════════════════════════════════════════════════════════════════════

    // All tasks should be complete
    const allTasks = parseTasks(
      readFileSync(join(wildDir, "tasks.md"), "utf-8")
    );
    const allComplete = allTasks.every((t) => t.status === "complete");
    expect(allComplete).toBe(true);

    // No unresolved alerts
    expect(loadAlerts()).toHaveLength(0);

    // Report exists and has content
    expect(existsSync(join(testDir, "sweep_report.md"))).toBe(true);
    const savedReport = readFileSync(
      join(testDir, "sweep_report.md"),
      "utf-8"
    );
    expect(savedReport).toContain("MLP Hyperparameter Sweep Report");
    expect(savedReport).toContain(`Total configurations: 16`);
    expect(savedReport).toContain("Successful: 12");
    expect(savedReport).toContain("Failed (loss spike): 2");
    expect(savedReport).toContain("OOM: 2");

    // Work selection should now return "complete"
    const finalWork = selectWork(
      loadAlerts(),
      allTasks,
      parseBarriers(readFileSync(join(wildDir, "barriers.md"), "utf-8")),
      [],
      policy
    );
    expect(finalWork.type).toBe("complete");

    console.log("✅ Full MLP sweep pipeline test passed!");
    console.log(`   ${configs.length} configs, ${alertsCreated.length} alerts, report generated`);
  });
});
