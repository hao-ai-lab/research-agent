/**
 * Wild Loop — File parsers
 *
 * Parse markdown/JSONL state files into typed structures.
 */

import type { Task, Barrier, HumanPolicy, HumanInput } from "./types";
import { DEFAULT_POLICY } from "./types";

// ─── Parse tasks.md ──────────────────────────────────────────────────────────

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
        .map((s) => s.trim());
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

// ─── Parse barriers.md ───────────────────────────────────────────────────────

export function parseBarriers(content: string): Barrier[] {
  const barriers: Barrier[] = [];
  const lines = content.split("\n");
  let currentBarrier: Partial<Barrier> | null = null;

  for (const line of lines) {
    // Barrier header: ## [WAITING] barrier-training-complete
    const headerMatch = line.match(
      /^## \[(WAITING|SATISFIED|FAILED)\] (.+)/
    );
    if (headerMatch) {
      if (currentBarrier && currentBarrier.id) {
        barriers.push(currentBarrier as Barrier);
      }

      const [, status, id] = headerMatch;
      currentBarrier = {
        id,
        name: id,
        status: status.toLowerCase() as Barrier["status"],
        createdAt: new Date().toISOString(),
      };
      continue;
    }

    if (!currentBarrier) continue;

    // Parse fields
    const typeMatch = line.match(/^- Type: (.+)/);
    if (typeMatch) currentBarrier.type = typeMatch[1] as Barrier["type"];

    const checkMatch = line.match(/^- Check: (.+)/);
    if (checkMatch) currentBarrier.checkCommand = checkMatch[1];

    const expectMatch = line.match(/^- Expect: (.+)/);
    if (expectMatch) {
      const val = expectMatch[1];
      currentBarrier.expect = isNaN(Number(val)) ? val : Number(val);
    }

    const intervalMatch = line.match(/^- Interval: (\d+)s/);
    if (intervalMatch) currentBarrier.checkInterval = parseInt(intervalMatch[1]);

    const fileMatch = line.match(/^- File: (.+)/);
    if (fileMatch) currentBarrier.waitForFile = fileMatch[1];

    const createdMatch = line.match(/^- Created: (.+)/);
    if (createdMatch) currentBarrier.createdAt = createdMatch[1];

    const lastCheckMatch = line.match(/^- Last check: (.+)/);
    if (lastCheckMatch) currentBarrier.lastCheck = lastCheckMatch[1];

    const resultMatch = line.match(/^- Result: "(.+)"/);
    if (resultMatch) currentBarrier.lastCheckResult = resultMatch[1];

    const blocksMatch = line.match(/^- Blocks: (.+)/);
    if (blocksMatch) {
      currentBarrier.blocks = blocksMatch[1].split(",").map((s) => s.trim());
    }

    const targetMatch = line.match(/^- Target: (\d+)/);
    if (targetMatch) currentBarrier.target = parseInt(targetMatch[1]);

    const updateCmdMatch = line.match(/^- UpdateCommand: (.+)/);
    if (updateCmdMatch) currentBarrier.updateCommand = updateCmdMatch[1];
  }

  if (currentBarrier && currentBarrier.id) {
    barriers.push(currentBarrier as Barrier);
  }

  return barriers;
}

// ─── Parse human-policy.md ───────────────────────────────────────────────────

export function parseHumanPolicy(content: string): HumanPolicy {
  const policy: HumanPolicy = { ...DEFAULT_POLICY };

  // Mode line: - **Mode:** autonomous
  const modeMatch = content.match(
    /\*\*Mode:\*\*\s*(interactive|semi-autonomous|autonomous|hands-off)/i
  );
  if (modeMatch)
    policy.mode = modeMatch[1].toLowerCase() as HumanPolicy["mode"];

  // Active from
  const activeFromMatch = content.match(
    /\*\*Active From:\*\*\s*(\S+)/
  );
  if (activeFromMatch) policy.activeFrom = activeFromMatch[1];

  // Duration / Expires
  const expiresMatch = content.match(
    /\*\*Expires At:\*\*\s*(\S+)/
  );
  if (expiresMatch) policy.expiresAt = expiresMatch[1];

  // Autonomy Level
  const autonomyMatch = content.match(
    /\*\*Autonomy Level:\*\*\s*(low|medium|high)/i
  );
  if (autonomyMatch)
    policy.autonomyLevel =
      autonomyMatch[1].toLowerCase() as HumanPolicy["autonomyLevel"];

  // Max Retry Attempts
  const retryMatch = content.match(
    /\*\*Max Retry Attempts:\*\*\s*(\d+)/
  );
  if (retryMatch) policy.maxRetryAttempts = parseInt(retryMatch[1]);

  // Escalation Threshold
  const thresholdMatch = content.match(
    /\*\*Escalation Threshold:\*\*\s*(all|warnings|critical-only|never)/i
  );
  if (thresholdMatch)
    policy.escalationThreshold =
      thresholdMatch[1].toLowerCase() as HumanPolicy["escalationThreshold"];

  // Progress Reports
  const progressMatch = content.match(
    /\*\*Progress Reports:\*\*\s*Every\s*(\d+)\s*minutes/i
  );
  if (progressMatch)
    policy.progressReportInterval = parseInt(progressMatch[1]);

  // Context Switch Penalty
  const switchMatch = content.match(
    /\*\*Context Switch Penalty:\*\*\s*(\d+)\s*minutes/i
  );
  if (switchMatch) policy.contextSwitchPenalty = parseInt(switchMatch[1]);

  // Escalation Rules
  const failureMatch = content.match(
    /\*\*Repeated Failures:\*\*\s*Escalate after\s*(\d+)/i
  );
  if (failureMatch)
    policy.escalateOn.repeatedFailures = parseInt(failureMatch[1]);

  const stuckMatch = content.match(
    /\*\*Stuck Duration:\*\*\s*Escalate if no progress for\s*(\d+)\s*minutes/i
  );
  if (stuckMatch)
    policy.escalateOn.stuckDuration = parseInt(stuckMatch[1]);

  const criticalMatch = content.match(
    /\*\*Critical Alerts:\*\*\s*(Always escalate|Never)/i
  );
  if (criticalMatch)
    policy.escalateOn.criticalAlerts =
      criticalMatch[1].toLowerCase().includes("always");

  // Instructions block (everything after "### Instructions")
  const instrMatch = content.match(
    /### Instructions\s*\n([\s\S]*?)(?:\n---|\n## |$)/
  );
  if (instrMatch) policy.instructions = instrMatch[1].trim();

  return policy;
}

// ─── Parse human.md ──────────────────────────────────────────────────────────

export function parseHumanInput(content: string): HumanInput[] {
  const inputs: HumanInput[] = [];
  // Split on section headers: ## [STATUS] timestamp - PRIORITY
  const sections = content.split(/(?=^## \[)/m).filter((s) => s.trim());

  for (const section of sections) {
    const headerMatch = section.match(
      /^## \[(PENDING|PROCESSED)\]\s*(\S+)\s*-?\s*(URGENT|normal|low)?/i
    );
    if (!headerMatch) continue;

    const [, statusRaw, timestamp, priorityRaw] = headerMatch;
    const status = statusRaw.toLowerCase() as HumanInput["status"];
    const priority = (priorityRaw?.toLowerCase() || "normal") as HumanInput["priority"];

    // Type
    const typeMatch = section.match(
      /\*\*Type:\*\*\s*([\w-]+)/
    );
    const type = (typeMatch?.[1] || "general-instruction") as HumanInput["type"];

    // Related alert
    const alertMatch = section.match(
      /\*\*Alert:\*\*\s*(alert-\S+)/
    );
    const relatedAlert = alertMatch?.[1];

    // Input content
    const inputMatch = section.match(
      /### Input:\s*\n([\s\S]*?)(?:\n### |\n---\s*$|$)/
    );
    const inputContent = inputMatch?.[1]?.trim() || "";

    // Processed timestamp
    const processedMatch = section.match(
      /### Processed:\s*\n(\S+)/
    );
    const processedAt = processedMatch?.[1];

    inputs.push({
      timestamp,
      priority,
      type,
      content: inputContent,
      status,
      processedAt,
      relatedAlert,
    });
  }

  return inputs;
}
