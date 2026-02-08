# Wild Loop: Event-Driven Autonomous Agent System

## Overview

Wild Loop is an extension of the Ralph Wiggum loop designed for long-running, event-driven agent workflows with human-in-the-loop capabilities. It supports:

- **Priority-based work queue** (alerts > tasks)
- **Async barriers** (wait for external jobs/signals)
- **Human policy-driven autonomy** (adjustable human engagement)
- **Event-driven idle** (true sleep, not spinning)
- **Multi-hour autonomous operation** (with strategic human escalation)

## Repository Structure

```
Th0rgal/open-ralph-wiggum/
├── ralph.ts                    # Original Ralph loop (reference)
├── wild.ts                     # NEW: Wild Loop implementation
├── lib/
│   ├── work-selection.ts       # NEW: Priority queue and work selection logic
│   ├── barriers.ts             # NEW: Barrier checking system
│   ├── human-policy.ts         # NEW: Human engagement policy engine
│   ├── event-system.ts         # NEW: Event emitter and watchers
│   ├── alerts.ts               # NEW: Alert management
│   └── parsers.ts              # NEW: Parse markdown task files and JSONL alerts
├── scripts/
│   └── check_barriers/         # NEW: Generated barrier checking scripts
└── .wild/                      # NEW: Wild Loop state directory
    ├── tasks.md                # Task queue (human-readable, AI edits directly)
    ├── alerts.jsonl            # Alert log (append-only, one JSON per line)
    ├── barriers.md             # Barrier definitions (human-readable)
    ├── human-policy.md         # Current human engagement policy
    ├── human.md                # Human input queue
    ├── state.json              # Loop state
    └── events.log              # Event stream (optional, for debugging)
```

## Key Differences from Ralph Loop

| Feature               | Ralph Loop        | Wild Loop                                                    |
| --------------------- | ----------------- | ------------------------------------------------------------ |
| **Work Source**       | Single task queue | Alerts + Tasks + Barriers + Human Input                      |
| **Priority**          | Sequential        | Human > Alert (in-progress) > Alert (pending) > Task         |
| **Blocking**          | No                | Tasks can be blocked by barriers or dependencies             |
| **External Events**   | No                | Event-driven (file watchers, webhooks, job completions)      |
| **Idle Behavior**     | Keeps looping     | True idle (sleep until event or timeout)                     |
| **Human Engagement**  | Manual            | Policy-driven (autonomous to interactive)                    |
| **Completion Signal** | `COMPLETE`        | `COMPLETE` + `ALERT_RESOLVED` + `TASK_COMPLETE` + `NEED_HUMAN_INPUT` |

## File Format Design

### `.wild/tasks.md` (Markdown - AI Edits Directly)

**Why Markdown?** The AI agent edits this file directly using text editing tools. Natural for the AI to update status by changing `[ ]` → `[/]` → `[x]`.

**Format:**
```markdown
# Wild Loop Tasks

- [x] [P1] task-001: Preprocess training data
- [x] [P1] task-002: Launch training sweep (8 jobs)
  - dependsOn: task-001
- [/] [P1] task-007: Monitor training jobs
  - dependsOn: task-002
- [ ] [P2] task-003: Analyze training results
  - dependsOn: task-002
  - blockedBy: barrier-training-complete
  - [ ] Load checkpoint files
  - [ ] Compute metrics
  - [ ] Generate report
- [ ] [P2] task-004: Select best checkpoint
  - dependsOn: task-003
- [ ] [P3] task-006: Write final report
  - dependsOn: task-004
```

**Task Line Format:**
```
- [STATUS] [PRIORITY] task-id: description
  - dependsOn: task-id-1, task-id-2
  - blockedBy: barrier-id
  - [STATUS] subtask description
```

**Status:**
- `[ ]` = todo
- `[/]` = in-progress
- `[x]` = complete

**Priority:**
- `[P1]` = highest priority
- `[P2]` = medium priority
- `[P3]` = lower priority
- Lower number = higher priority

---

### `.wild/alerts.jsonl` (JSONL - Append-Only Log)

**Why JSONL?** Alerts can be frequent (dozens per hour in production). Append-only JSONL is efficient and doesn't require parsing the entire file each time.

**Format:** One JSON object per line

```jsonl
{"id":"alert-001","timestamp":"2026-02-08T10:45:23Z","severity":"critical","source":"training-job-3","type":"OOM","description":"GPU memory exhausted (24GB/24GB) during batch 1250","status":"pending","context":{"batch_size":64,"model":"llama-7b","gpu":"A100-40GB"}}
{"id":"alert-002","timestamp":"2026-02-08T10:47:15Z","severity":"warning","source":"training-job-5","type":"divergence","description":"Loss increased from 2.3 to 15.7 in 10 steps","status":"pending"}
{"id":"alert-001","timestamp":"2026-02-08T10:50:00Z","severity":"critical","source":"training-job-3","type":"OOM","description":"GPU memory exhausted (24GB/24GB) during batch 1250","status":"in-progress","context":{"batch_size":64,"model":"llama-7b","gpu":"A100-40GB","attempt":1}}
{"id":"alert-001","timestamp":"2026-02-08T10:55:00Z","severity":"critical","source":"training-job-3","type":"OOM","description":"GPU memory exhausted (24GB/24GB) during batch 1250","status":"resolved","context":{"batch_size":32,"solution":"reduced batch size to 32"},"resolvedAt":"2026-02-08T10:55:00Z"}
```

**Alert Fields:**
```typescript
{
  id: string;              // Unique alert ID
  timestamp: string;       // ISO 8601
  severity: "critical" | "warning" | "info";
  source: string;          // e.g., "training-job-3", "system"
  type: string;            // e.g., "OOM", "divergence", "timeout"
  description: string;     // Human-readable description
  status: "pending" | "in-progress" | "resolved" | "escalated";
  context?: object;        // Additional metadata
  resolvedAt?: string;     // ISO 8601 when resolved
  escalatedAt?: string;    // ISO 8601 when escalated to human
}
```

**Reading Strategy:**
- **Initial load:** Read entire file to build current state
- **Optimization (future):** Track file position, only read new lines since last check
- **Query pattern:** Filter by status (pending, in-progress), sort by severity

**Writing Strategy:**
- **Append only:** New events appended to end
- **Status updates:** Append new line with updated status (same ID, new timestamp)
- **Compaction (future):** Periodically archive resolved alerts to `.wild/alerts.archive.jsonl`

---

### `.wild/barriers.md` (Markdown - Human-Readable)

**Why Markdown?** Barriers are infrequent (a few per session) and benefit from human readability. AI can create/update them with text editing.

**Format:**
```markdown
# Wild Loop Barriers

## [WAITING] barrier-training-complete
- Type: command-check
- Check: squeue -u $USER --name=sweep-2026-02-08 | wc -l
- Expect: 0
- Interval: 60s
- Created: 2026-02-08T10:00:00Z
- Last check: 2026-02-08T10:15:00Z
- Result: "5 jobs still running"
- Blocks: task-003, task-004, task-005

## [SATISFIED] barrier-data-preprocessed
- Type: file-exists
- File: /data/processed/COMPLETE.flag
- Created: 2026-02-08T09:00:00Z
- Satisfied: 2026-02-08T09:45:00Z

## [WAITING] barrier-model-validation
- Type: command-check
- Check: python scripts/validate_sweep.py --sweep-id sweep-001 --min-accuracy 0.85
- Interval: 120s
- Created: 2026-02-08T10:30:00Z
- Last check: 2026-02-08T10:35:00Z
- Result: "3/8 models meet accuracy threshold"
- Blocks: task-006
```

**Barrier Status:**
- `[WAITING]` = condition not yet met
- `[SATISFIED]` = condition met, tasks unblocked
- `[FAILED]` = check failed with error

**Barrier Types:**
- `command-check`: Execute shell command, check exit code
- `file-exists`: Check if file exists
- `count-based`: Poll command output, compare to target count
- `webhook`: Wait for external HTTP POST
- `manual`: Human manually marks as satisfied

---

### `.wild/human-policy.md` (Markdown - Natural Language)

**Format:**
```markdown
# Human Policy

## Current Policy: Autonomous Mode (6 hours)

**Active From:** 2026-02-08T10:00:00Z  
**Duration:** 6 hours  
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
- **Unexpected Success:** Notify me of breakthroughs

### Instructions

I'm stepping away for 6 hours. GPUs are all yours. Try everything you can to make progress.

DO NOT stop the loop for minor issues - be creative and try alternatives.

ONLY escalate to me if:
- You've tried 5 different approaches and all failed
- Critical system failure (cluster down, data corruption)
- Unexpected breakthrough that changes the plan significantly

Otherwise, keep going. I trust you.

---

## Policy History

### 2026-02-08 09:00 - Interactive Mode
- Mode: interactive
- Used during initial setup

### 2026-02-08 10:00 - Autonomous Mode
- Mode: autonomous
- Long unattended run
```

---

### `.wild/human.md` (Markdown - Human Input Queue)

**Format:**
```markdown
# Human Input Queue

## [PENDING] 2026-02-08T12:30:00Z - URGENT
**Type:** alert-resolution-guidance  
**Alert:** alert-005 (OOM in job 3)  
**Priority:** urgent

### Input:
The OOM is because batch size is too large for this GPU. 

Try these in order:
1. Reduce batch size from 64 to 32
2. If that fails, try gradient accumulation: batch=16, accum_steps=4
3. If both fail, switch to smaller model variant

### Policy Update:
None - continue with current autonomous policy

---

## [PROCESSED] 2026-02-08T11:15:00Z
**Type:** task-addition  
**Priority:** normal

### Input:
Add a new task to visualize training curves after analysis completes.
Use matplotlib, save plots to results/plots/

### Processed:
2026-02-08T11:16:00Z - Added task-008

---

## [PROCESSED] 2026-02-08T10:30:00Z
**Type:** policy-change  
**Priority:** normal

### Input:
Switch to autonomous mode for the next 6 hours

### Processed:
2026-02-08T10:31:00Z - Policy updated
```

---

### `.wild/state.json` (JSON - Loop State)

**Format:**
```json
{
  "active": true,
  "iteration": 15,
  "startedAt": "2026-02-08T10:00:00Z",
  "prompt": "Run training sweep and analyze results",
  "agent": "opencode",
  "model": "anthropic/claude-sonnet",
  "lastProgressReport": "2026-02-08T10:30:00Z",
  "alertsFilePosition": 4096,
  "currentWork": {
    "type": "alert",
    "id": "alert-001",
    "startedAt": "2026-02-08T10:50:00Z"
  }
}
```

**Optimization Note:** `alertsFilePosition` tracks byte offset in `alerts.jsonl` for incremental reads (future optimization).

---

## Data Structures

### Task Interface

```typescript
interface Task {
  id: string;                      // e.g., "task-003"
  text: string;                    // e.g., "Analyze training results"
  priority: number;                // 1 = highest
  status: "todo" | "in-progress" | "complete";
  
  // Dependencies
  dependsOn?: string[];            // Task IDs - can't start until these complete
  blockedBy?: string;              // Barrier ID - waiting for external condition
  
  // Hierarchy
  subtasks: Task[];
  parentId?: string;
  
  // Metadata
  createdAt?: string;
}
```

### Alert Interface

```typescript
interface Alert {
  id: string;
  timestamp: string;               // ISO 8601
  severity: "critical" | "warning" | "info";
  source: string;                  // e.g., "training-job-3"
  type: string;                    // e.g., "OOM", "divergence"
  description: string;
  status: "pending" | "in-progress" | "resolved" | "escalated";
  context?: Record<string, any>;   // Additional metadata
  resolvedAt?: string;
  escalatedAt?: string;
}
```

### Barrier Interface

```typescript
interface Barrier {
  id: string;
  name: string;
  type: "command-check" | "file-exists" | "count-based" | "webhook" | "manual";
  
  // For command-check type
  checkCommand?: string;
  expect?: string | number;        // Expected output/exit code
  checkInterval?: number;          // Seconds between checks
  
  // For file-exists type
  waitForFile?: string;
  
  // For count-based type
  target?: number;
  updateCommand?: string;
  
  // Status
  status: "waiting" | "satisfied" | "failed";
  lastCheck?: string;
  lastCheckResult?: string;
  
  // Metadata
  createdAt: string;
  satisfiedAt?: string;
  blocks?: string[];               // Task IDs blocked by this barrier
}
```

### Human Policy Interface

```typescript
interface HumanPolicy {
  mode: "interactive" | "semi-autonomous" | "autonomous" | "hands-off";
  activeFrom: string;
  expiresAt?: string;
  
  // Autonomy settings
  autonomyLevel: "low" | "medium" | "high";
  maxRetryAttempts: number;
  escalationThreshold: "all" | "warnings" | "critical-only" | "never";
  
  // Communication
  progressReportInterval?: number;     // Minutes (0 = none)
  contextSwitchPenalty: number;        // Minutes
  
  // Escalation rules
  escalateOn: {
    repeatedFailures: number;
    stuckDuration: number;             // Minutes
    criticalAlerts: boolean;
    unexpectedSuccess: boolean;
  };
  
  // Natural language instructions
  instructions: string;
}
```

### Human Input Interface

```typescript
interface HumanInput {
  timestamp: string;
  priority: "urgent" | "normal" | "low";
  type: "alert-resolution-guidance" | "task-addition" | "task-modification" | 
        "policy-change" | "general-instruction";
  content: string;
  status: "pending" | "processed";
  processedAt?: string;
  relatedAlert?: string;            // Alert ID if responding to escalation
}
```

---

## Implementation Requirements

### 1. Work Selection (`lib/work-selection.ts`)

```typescript
export function selectWork(
  alerts: Alert[],
  tasks: Task[],
  barriers: Barrier[],
  humanInput: HumanInput[],
  policy: HumanPolicy
): WorkSelection {
  // Priority 0: Human input (highest override)
  if (hasPendingHumanInput(humanInput)) {
    return { type: "human-input", work: getLatestHumanInput(humanInput) };
  }
  
  // Priority 1: In-progress alert (finish what you started)
  const activeAlert = alerts.find(a => a.status === "in-progress");
  if (activeAlert) {
    return { type: "alert", work: activeAlert };
  }
  
  // Priority 2: Pending alerts (new interrupts)
  const pendingAlerts = alerts
    .filter(a => a.status === "pending")
    .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  if (pendingAlerts.length > 0) {
    return { type: "alert", work: pendingAlerts[0] };
  }
  
  // Priority 3: In-progress task (continue current work)
  const activeTask = tasks.find(t => 
    t.status === "in-progress" && !isBlocked(t, tasks, barriers)
  );
  if (activeTask) {
    return { type: "task", work: activeTask };
  }
  
  // Priority 4: Next available task (not blocked)
  const availableTasks = tasks
    .filter(t => t.status === "todo" && !isBlocked(t, tasks, barriers))
    .sort((a, b) => a.priority - b.priority);
  if (availableTasks.length > 0) {
    return { type: "task", work: availableTasks[0] };
  }
  
  // Priority 5: Blocked - check if we can help
  const blockingBarriers = getBlockingBarriers(tasks, barriers);
  if (blockingBarriers.length > 0) {
    return { 
      type: "blocked", 
      barriers: blockingBarriers,
      canHelp: canMakeProgressOnBarrier(blockingBarriers)
    };
  }
  
  // Priority 6: All done
  return { type: "complete" };
}

export function isBlocked(task: Task, tasks: Task[], barriers: Barrier[]): boolean {
  // Check task dependencies (dependsOn)
  if (task.dependsOn && task.dependsOn.length > 0) {
    const allDepsComplete = task.dependsOn.every(depId => {
      const depTask = tasks.find(t => t.id === depId);
      return depTask?.status === "complete";
    });
    if (!allDepsComplete) return true;
  }
  
  // Check barrier dependencies (blockedBy)
  if (task.blockedBy) {
    const barrier = barriers.find(b => b.id === task.blockedBy);
    if (barrier && barrier.status === "waiting") return true;
  }
  
  return false;
}

function getBlockingBarriers(tasks: Task[], barriers: Barrier[]): Barrier[] {
  const incompleteTasks = tasks.filter(t => t.status !== "complete");
  const barrierIds = new Set(
    incompleteTasks
      .filter(t => t.blockedBy)
      .map(t => t.blockedBy!)
  );
  
  return barriers.filter(b => 
    barrierIds.has(b.id) && b.status === "waiting"
  );
}

function canMakeProgressOnBarrier(barriers: Barrier[]): boolean {
  // Can AI actively help? (e.g., check logs, debug issues)
  // vs pure wait (e.g., waiting for manual approval)
  return barriers.some(b => 
    b.type === "command-check" || b.type === "file-exists"
  );
}
```

---

### 2. Barrier System (`lib/barriers.ts`)

```typescript
export async function checkBarrier(barrier: Barrier): Promise<{
  satisfied: boolean;
  status: string;
  error?: string;
}> {
  switch (barrier.type) {
    case "command-check": {
      try {
        const result = await $`${barrier.checkCommand}`.quiet();
        const exitCode = result.exitCode;
        const output = result.stdout.trim();
        
        // Check if expectation is met
        if (barrier.expect !== undefined) {
          if (typeof barrier.expect === "number") {
            // Expect specific exit code
            if (exitCode === barrier.expect) {
              return { satisfied: true, status: output };
            }
          } else {
            // Expect specific output
            if (output === barrier.expect) {
              return { satisfied: true, status: output };
            }
          }
        } else {
          // Default: expect exit code 0
          if (exitCode === 0) {
            return { satisfied: true, status: output };
          }
        }
        
        return { satisfied: false, status: output };
      } catch (error) {
        return { satisfied: false, status: "", error: String(error) };
      }
    }
    
    case "file-exists": {
      const exists = existsSync(barrier.waitForFile!);
      return {
        satisfied: exists,
        status: exists ? "File found" : `Waiting for ${barrier.waitForFile}`,
      };
    }
    
    case "count-based": {
      try {
        const result = await $`${barrier.updateCommand}`.quiet();
        const current = parseInt(result.stdout.trim());
        const satisfied = current >= barrier.target!;
        return {
          satisfied,
          status: `${current}/${barrier.target} complete`,
        };
      } catch (error) {
        return { satisfied: false, status: "", error: String(error) };
      }
    }
    
    case "webhook":
    case "manual": {
      // Status updated externally
      return {
        satisfied: barrier.status === "satisfied",
        status: barrier.status === "satisfied" 
          ? (barrier.type === "webhook" ? "Webhook received" : "Manually approved")
          : (barrier.type === "webhook" ? "Waiting for webhook" : "Waiting for manual approval"),
      };
    }
  }
}

export async function startBarrierChecker(eventQueue: EventEmitter): Promise<void> {
  const checkLoop = async () => {
    while (true) {
      const barriers = loadBarriers();
      const waiting = barriers.filter(b => b.status === "waiting");
      
      for (const barrier of waiting) {
        const now = Date.now();
        const lastCheck = barrier.lastCheck ? new Date(barrier.lastCheck).getTime() : 0;
        const interval = (barrier.checkInterval || 60) * 1000;
        
        // Check if enough time passed
        if (now - lastCheck < interval) {
          continue;
        }
        
        // Run check
        const result = await checkBarrier(barrier);
        barrier.lastCheck = new Date().toISOString();
        barrier.lastCheckResult = result.status;
        
        if (result.satisfied) {
          barrier.status = "satisfied";
          barrier.satisfiedAt = new Date().toISOString();
          console.log(`✅ Barrier satisfied: ${barrier.name}`);
          eventQueue.emit("wake", { 
            type: "barrier-satisfied", 
            barrierId: barrier.id 
          });
        } else if (result.error) {
          console.warn(`⚠️ Barrier check error: ${barrier.name} - ${result.error}`);
        }
        
        saveBarriers(barriers);
      }
      
      await sleep(10000);  // Check all barriers every 10s
    }
  };
  
  checkLoop().catch(console.error);
}
```

---

### 3. Alert Management (`lib/alerts.ts`)

```typescript
export function loadAlerts(): Alert[] {
  if (!existsSync(alertsPath)) {
    return [];
  }
  
  const content = readFileSync(alertsPath, "utf-8");
  const lines = content.trim().split("\n").filter(l => l.trim());
  
  // Parse all JSONL entries
  const allEntries: Alert[] = lines.map(line => JSON.parse(line));
  
  // Build current state: latest entry per alert ID
  const alertMap = new Map<string, Alert>();
  for (const entry of allEntries) {
    const existing = alertMap.get(entry.id);
    if (!existing || new Date(entry.timestamp) > new Date(existing.timestamp)) {
      alertMap.set(entry.id, entry);
    }
  }
  
  // Return only non-resolved alerts
  return Array.from(alertMap.values()).filter(a => a.status !== "resolved");
}

export function appendAlert(alert: Alert): void {
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
  
  const line = JSON.stringify(alert) + "\n";
  appendFileSync(alertsPath, line);
}

export function updateAlertStatus(
  alertId: string, 
  status: Alert["status"],
  additionalFields?: Partial<Alert>
): void {
  const alerts = loadAlerts();
  const alert = alerts.find(a => a.id === alertId);
  
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

// Future optimization: Incremental read
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
  const lines = content.trim().split("\n").filter(l => l.trim());
  const alerts = lines.map(line => JSON.parse(line));
  
  return { alerts, newPosition: fileSize };
}
```

---

### 4. Human Policy Engine (`lib/human-policy.ts`)

```typescript
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
  
  // Check 4: Low autonomy mode
  if (policy.autonomyLevel === "low" && policy.escalationThreshold === "all") {
    return {
      escalate: true,
      reason: "Policy requires human confirmation for all alerts",
      urgency: "low",
      blocking: true,
    };
  }
  
  // Don't escalate
  return {
    escalate: false,
    urgency: "low",
    blocking: false,
  };
}

export async function sendProgressReport(
  policy: HumanPolicy, 
  state: LoopState
): Promise<void> {
  if (!policy.progressReportInterval || policy.progressReportInterval === 0) {
    return;
  }
  
  const now = Date.now();
  const lastReport = state.lastProgressReport 
    ? new Date(state.lastProgressReport).getTime()
    : new Date(state.startedAt).getTime();
  const minutesSinceReport = (now - lastReport) / 60000;
  
  if (minutesSinceReport < policy.progressReportInterval) {
    return;
  }
  
  const summary = generateProgressSummary(state);
  
  console.log(`
📊 Progress Report (${new Date().toLocaleTimeString()})

Tasks: ${summary.tasksComplete}/${summary.tasksTotal} complete
Alerts: ${summary.alertsResolved} resolved, ${summary.alertsPending} pending
Barriers: ${summary.barriersWaiting.join(", ") || "none"}

Current work: ${summary.currentWork}

Next check-in: ${policy.progressReportInterval} minutes
  `.trim());
  
  state.lastProgressReport = new Date().toISOString();
  saveState(state);
}
```

---

### 5. Event System (`lib/event-system.ts`)

```typescript
import { EventEmitter } from "events";
import chokidar from "chokidar";

export class WildEventSystem extends EventEmitter {
  private watchers: chokidar.FSWatcher[] = [];
  
  async startWatchers(): Promise<void> {
    // Watch alerts.jsonl
    const alertsWatcher = chokidar.watch(alertsPath, {
      persistent: true,
      ignoreInitial: true,
    });
    alertsWatcher.on("change", () => {
      this.emit("wake", { type: "new-alert" });
    });
    this.watchers.push(alertsWatcher);
    
    // Watch human.md
    const humanWatcher = chokidar.watch(humanInputPath, {
      persistent: true,
      ignoreInitial: true,
    });
    humanWatcher.on("change", () => {
      this.emit("wake", { type: "human-input" });
    });
    this.watchers.push(humanWatcher);
    
    // Watch barriers.md
    const barriersWatcher = chokidar.watch(barriersPath, {
      persistent: true,
      ignoreInitial: true,
    });
    barriersWatcher.on("change", () => {
      this.emit("wake", { type: "barrier-update" });
    });
    this.watchers.push(barriersWatcher);
    
    console.log("🔔 Event watchers started");
  }
  
  async stopWatchers(): Promise<void> {
    await Promise.all(this.watchers.map(w => w.close()));
    this.watchers = [];
  }
}

export async function waitForEvent(eventQueue: EventEmitter): Promise<void> {
  return new Promise(resolve => {
    eventQueue.once("wake", (event) => {
      console.log(`🔔 Event received: ${event.type}`);
      resolve();
    });
  });
}
```

---

### 6. File Parsers (`lib/parsers.ts`)

```typescript
export function parseTasks(content: string): Task[] {
  const tasks: Task[] = [];
  const lines = content.split("\n");
  let currentTask: Task | null = null;
  
  for (const line of lines) {
    // Top-level task: - [ ] [P2] task-003: Analyze results
    const taskMatch = line.match(/^- \[([ x\/])\] \[P(\d+)\] (task-\d+): (.+)/);
    if (taskMatch) {
      const [, statusChar, priority, id, text] = taskMatch;
      
      let status: Task["status"] = "todo";
      if (statusChar === "x") status = "complete";
      else if (statusChar === "/") status = "in-progress";
      
      currentTask = {
        id,
        text,
        priority: parseInt(priority),
        status,
        subtasks: [],
        createdAt: new Date().toISOString(),
      };
      tasks.push(currentTask);
      continue;
    }
    
    // Dependency: - dependsOn: task-001, task-002
    const dependsMatch = line.match(/^\s+- dependsOn: (.+)/);
    if (dependsMatch && currentTask) {
      currentTask.dependsOn = dependsMatch[1]
        .split(",")
        .map(s => s.trim());
      continue;
    }
    
    // Blocked by: - blockedBy: barrier-training-complete
    const blockedMatch = line.match(/^\s+- blockedBy: (.+)/);
    if (blockedMatch && currentTask) {
      currentTask.blockedBy = blockedMatch[1].trim();
      continue;
    }
    
    // Subtask: - [ ] Configure parameters
    const subtaskMatch = line.match(/^\s+- \[([ x\/])\] (.+)/);
    if (subtaskMatch && currentTask) {
      const [, statusChar, text] = subtaskMatch;
      let status: Task["status"] = "todo";
      if (statusChar === "x") status = "complete";
      else if (statusChar === "/") status = "in-progress";
      
      currentTask.subtasks.push({
        id: `${currentTask.id}-${currentTask.subtasks.length + 1}`,
        text,
        priority: currentTask.priority,
        status,
        subtasks: [],
        parentId: currentTask.id,
        createdAt: new Date().toISOString(),
      });
    }
  }
  
  return tasks;
}

export function parseBarriers(content: string): Barrier[] {
  const barriers: Barrier[] = [];
  const lines = content.split("\n");
  let currentBarrier: Partial<Barrier> | null = null;
  
  for (const line of lines) {
    // Barrier header: ## [WAITING] barrier-training-complete
    const headerMatch = line.match(/^## \[(WAITING|SATISFIED|FAILED)\] (.+)/);
    if (headerMatch) {
      if (currentBarrier && currentBarrier.id) {
        barriers.push(currentBarrier as Barrier);
      }
      
      const [, status, id] = headerMatch;
      currentBarrier = {
        id,
        name: id,
        status: status.toLowerCase() as Barrier["status"],
      };
      continue;
    }
    
    if (!currentBarrier) continue;
    
    // Parse fields
    const typeMatch = line.match(/^- Type: (.+)/);
    if (typeMatch) {
      currentBarrier.type = typeMatch[1] as Barrier["type"];
    }
    
    const checkMatch = line.match(/^- Check: (.+)/);
    if (checkMatch) {
      currentBarrier.checkCommand = checkMatch[1];
    }
    
    const expectMatch = line.match(/^- Expect: (.+)/);
    if (expectMatch) {
      const val = expectMatch[1];
      currentBarrier.expect = isNaN(Number(val)) ? val : Number(val);
    }
    
    const intervalMatch = line.match(/^- Interval: (\d+)s/);
    if (intervalMatch) {
      currentBarrier.checkInterval = parseInt(intervalMatch[1]);
    }
    
    const fileMatch = line.match(/^- File: (.+)/);
    if (fileMatch) {
      currentBarrier.waitForFile = fileMatch[1];
    }
    
    const createdMatch = line.match(/^- Created: (.+)/);
    if (createdMatch) {
      currentBarrier.createdAt = createdMatch[1];
    }
    
    const lastCheckMatch = line.match(/^- Last check: (.+)/);
    if (lastCheckMatch) {
      currentBarrier.lastCheck = lastCheckMatch[1];
    }
    
    const resultMatch = line.match(/^- Result: "(.+)"/);
    if (resultMatch) {
      currentBarrier.lastCheckResult = resultMatch[1];
    }
    
    const blocksMatch = line.match(/^- Blocks: (.+)/);
    if (blocksMatch) {
      currentBarrier.blocks = blocksMatch[1].split(",").map(s => s.trim());
    }
  }
  
  if (currentBarrier && currentBarrier.id) {
    barriers.push(currentBarrier as Barrier);
  }
  
  return barriers;
}

export function parseHumanPolicy(content: string): HumanPolicy {
  // Parse markdown format into HumanPolicy object
  // Extract values from ## Settings section
  // Parse escalation rules
  // Extract natural language instructions
  // Return structured policy
}

export function parseHumanInput(content: string): HumanInput[] {
  // Parse markdown format into HumanInput array
  // Extract [PENDING] and [PROCESSED] entries
  // Return list of inputs with metadata
}
```

---

### 7. Main Loop (`wild.ts`)

```typescript
async function runWildLoop(options: WildLoopOptions): Promise<void> {
  // Setup
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                      Wild Loop                            ║
║         Event-Driven Autonomous Agent System              ║
╚═══════════════════════════════════════════════════════════╝
  `);
  
  const state = initializeState(options);
  const policy = loadHumanPolicy();
  const eventQueue = new WildEventSystem();
  await eventQueue.startWatchers();
  
  // Background: Start barrier checker
  startBarrierChecker(eventQueue);
  
  // Signal handlers
  process.on("SIGINT", async () => {
    console.log("\n🛑 Gracefully stopping Wild Loop...");
    await eventQueue.stopWatchers();
    clearState();
    process.exit(0);
  });
  
  // Main loop
  while (true) {
    // 1. Load current state
    const alerts = loadAlerts();
    const tasks = parseTasks(readFileSync(tasksPath, "utf-8"));
    const barriers = parseBarriers(readFileSync(barriersPath, "utf-8"));
    const humanInput = parseHumanInput(readFileSync(humanInputPath, "utf-8"));
    
    // 2. Send progress report if due
    await sendProgressReport(policy, state);
    
    // 3. Select work
    const work = selectWork(alerts, tasks, barriers, humanInput, policy);
    
    // 4. Handle work
    switch (work.type) {
      case "human-input": {
        const input = work.work as HumanInput;
        await handleHumanInput(input, state);
        break;
      }
      
      case "alert": {
        const alert = work.work as Alert;
        const history = loadAlertHistory();
        const escalation = shouldEscalateToHuman(alert, policy, history);
        
        if (escalation.escalate && escalation.blocking) {
          // Blocking escalation
          await createHumanInputRequest(alert, escalation);
          console.log(`⏸️  BLOCKED: Waiting for human input on ${alert.id}`);
          
          // Enter wait mode
          await Promise.race([
            waitForEvent(eventQueue),
            sleep(5 * 60 * 1000)
          ]);
          continue;  // Don't increment iteration
          
        } else if (escalation.escalate) {
          // Non-blocking notification
          console.log(`📤 Notifying human (non-blocking): ${escalation.reason}`);
          // Continue to handle autonomously
        }
        
        // Handle alert
        await handleAlert(alert, policy, state);
        break;
      }
      
      case "task": {
        const task = work.work as Task;
        await handleTask(task, state);
        break;
      }
      
      case "blocked": {
        if (work.canHelp) {
          // Monitor barriers
          await monitorBarriers(work.barriers, state);
        } else {
          // True idle
          console.log(`⏳ Entering wait mode (no active work)`);
          console.log(`   Waiting for: ${work.barriers.map(b => b.name).join(", ")}`);
          console.log(`   Will check every 5 minutes or when events arrive`);
          
          await Promise.race([
            waitForEvent(eventQueue),
            sleep(5 * 60 * 1000)
          ]);
          
          console.log("⏰ Woke up - checking for updates...");
          continue;  // Don't increment iteration, re-evaluate
        }
        break;
      }
      
      case "complete": {
        console.log(`
╔═══════════════════════════════════════════════════════════╗
║  ✅ All work complete!                                    ║
║  Total time: ${formatDuration(Date.now() - new Date(state.startedAt).getTime())}
╚═══════════════════════════════════════════════════════════╝
        `);
        await eventQueue.stopWatchers();
        clearState();
        return;
      }
    }
    
    // 5. Update state
    state.iteration++;
    saveState(state);
    
    // 6. Brief pause between active iterations
    await sleep(2000);
  }
}

async function handleAlert(alert: Alert, policy: HumanPolicy, state: LoopState) {
  const prompt = buildAlertPrompt(alert, policy, state);
  const output = await runAgent(prompt, state);
  
  const resolved = checkCompletion(output, "ALERT_RESOLVED");
  if (resolved) {
    updateAlertStatus(alert.id, "resolved", {
      resolvedAt: new Date().toISOString(),
    });
    console.log(`✅ Alert resolved: ${alert.id}`);
  }
}

async function handleTask(task: Task, state: LoopState) {
  const prompt = buildTaskPrompt(task, state);
  const output = await runAgent(prompt, state);
  
  const complete = checkCompletion(output, "TASK_COMPLETE");
  if (complete) {
    console.log(`✅ Task complete: ${task.id}`);
  }
}

async function handleHumanInput(input: HumanInput, state: LoopState) {
  const prompt = buildHumanInputPrompt(input, state);
  const output = await runAgent(prompt, state);
  
  const processed = checkCompletion(output, "HUMAN_INPUT_PROCESSED");
  if (processed) {
    markHumanInputProcessed(input);
    console.log(`✅ Human input processed`);
  }
}
```

---

## Prompt Building

```typescript
function buildAlertPrompt(alert: Alert, policy: HumanPolicy, state: LoopState): string {
  const context = buildContextSummary(state);
  
  return `
# Wild Loop - Iteration ${state.iteration}

${context}

---

## 🚨 CURRENT WORK: Handling Alert

**You are responding to an alert. This is your primary focus.**

### Alert Details:
- **ID:** ${alert.id}
- **Severity:** ${alert.severity.toUpperCase()}
- **Source:** ${alert.source}
- **Type:** ${alert.type}
- **Description:** ${alert.description}

### Policy Context:
- **Autonomy Level:** ${policy.autonomyLevel}
- **Max Retry Attempts:** ${policy.maxRetryAttempts}
- **Current Attempt:** ${getAlertAttempts(alert.id)}

### Instructions:
1. Investigate the root cause
2. Take corrective action (fix code, adjust config, restart job, etc.)
3. Verify the fix
4. Update alert status in .wild/alerts.jsonl
5. When resolved, output: <promise>ALERT_RESOLVED</promise>

### Available Actions:
- Edit code to fix bugs
- Modify training configs
- Restart failed jobs
- Add monitoring/logging
- Update task list if needed
- Create barriers if launching new jobs

## Main Goal
${state.prompt}

## Critical Rules
- Finish this alert before moving to other work
- Try creative solutions within policy limits
- Update .wild/alerts.jsonl with your progress
- Use appropriate promise tags

Current iteration: ${state.iteration}
  `.trim();
}

function buildContextSummary(state: LoopState): string {
  const alerts = loadAlerts();
  const tasks = parseTasks(readFileSync(tasksPath, "utf-8"));
  const barriers = parseBarriers(readFileSync(barriersPath, "utf-8"));
  
  const pendingAlerts = alerts.filter(a => a.status === "pending");
  const incompleteTasks = tasks.filter(t => t.status !== "complete");
  const waitingBarriers = barriers.filter(b => b.status === "waiting");
  
  return `
## 📊 Current System State

### Alerts: ${pendingAlerts.length} pending
${pendingAlerts.slice(0, 3).map(a => 
  `- [${a.severity.toUpperCase()}] ${a.source}: ${a.description}`
).join("\n")}
${pendingAlerts.length > 3 ? `- ... and ${pendingAlerts.length - 3} more` : ""}

### Tasks: ${incompleteTasks.length} remaining
${incompleteTasks.slice(0, 5).map(t => 
  `- ${t.status === "in-progress" ? "🔄" : "⏸️"} [P${t.priority}] ${t.text}${t.blockedBy ? ` (blocked by ${t.blockedBy})` : ""}`
).join("\n")}

### Barriers: ${waitingBarriers.length} active
${waitingBarriers.map(b => 
  `- ⏳ ${b.name}: ${b.lastCheckResult || "waiting"}`
).join("\n")}
  `.trim();
}
```

---

## Command Line Interface

```bash
# Start Wild Loop
wild "Run training sweep and analyze results"

# Start with specific policy
wild "Run experiments" --policy autonomous --duration 6h

# Start with policy file
wild "Run experiments" --policy-file my-policy.md

# Status check
wild --status

# Add human input mid-loop
wild --human-input "Reduce batch size to 32 and retry"

# Update policy mid-loop
wild --update-policy semi-autonomous

# List all work
wild --list-work

# Show policy
wild --show-policy

# Migrate from Ralph
wild --migrate
```

---

## Promise Signals

```typescript
// Task completion
<promise>TASK_COMPLETE</promise>

// Alert resolution
<promise>ALERT_RESOLVED</promise>

// Barrier monitoring done
<promise>MONITORING_COMPLETE</promise>

// Need human input (blocking)
<promise>NEED_HUMAN_INPUT</promise>
<reason>Tried 5 approaches, all failed. Need guidance.</reason>
<urgency>high</urgency>

// Notify human (non-blocking)
<promise>NOTIFY_HUMAN</promise>
<reason>Making progress on difficult issue, FYI</reason>

// Human input processed
<promise>HUMAN_INPUT_PROCESSED</promise>

// All work complete
<promise>COMPLETE</promise>
```

---

## Testing Requirements

1. **Work selection priority** (human > in-progress alert > pending alert > task > blocked)
2. **Task dependency resolution** (dependsOn unblocks when parent completes)
3. **Barrier satisfaction** (command-check, file-exists, count-based)
4. **Policy-driven escalation** (different autonomy levels)
5. **Event-driven wake** (file watchers, not spinning)
6. **JSONL alert handling** (append, query, incremental read)
7. **Multi-signal handling** (NEED_HUMAN_INPUT blocks, NOTIFY_HUMAN doesn't)

---

## Migration from Ralph Loop

```bash
wild --migrate
```

Converts:
- `.ralph/tasks.md` → `.wild/tasks.md`
- Creates default `human-policy.md` (semi-autonomous)
- Initializes empty `alerts.jsonl`, `barriers.md`, `human.md`

---

## Success Criteria

Wild Loop should:
1. ✅ Run autonomously for hours with minimal human intervention
2. ✅ Escalate intelligently based on policy
3. ✅ Use 0% CPU when idle (true sleep)
4. ✅ Wake instantly on external events
5. ✅ Allow humans to adjust autonomy on the fly
6. ✅ Maintain full auditability
7. ✅ Handle complex workflows (1000+ async jobs, multiple barriers)

---

## References

- Original Ralph Loop: `ralph.ts` in this repo
- Ralph technique: https://ghuntley.com/ralph/
- Design discussion: [This conversation]

---

**End of specification document.**