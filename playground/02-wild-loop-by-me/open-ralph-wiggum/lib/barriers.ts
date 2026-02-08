/**
 * Wild Loop — Barrier checking system
 *
 * Checks external conditions: command exit codes, file existence, counts.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { $ } from "bun";
import type { Barrier } from "./types";
import type { EventEmitter } from "events";
import { parseBarriers } from "./parsers";

// ─── Paths ───────────────────────────────────────────────────────────────────

let barriersPath = ".wild/barriers.md";

export function setBarriersPath(path: string): void {
  barriersPath = path;
}

// ─── Check a single barrier ──────────────────────────────────────────────────

export async function checkBarrier(
  barrier: Barrier
): Promise<{
  satisfied: boolean;
  status: string;
  error?: string;
}> {
  switch (barrier.type) {
    case "command-check": {
      try {
        const result =
          await $`sh -c ${barrier.checkCommand!}`.quiet().nothrow();
        const exitCode = result.exitCode;
        const output = result.stdout.toString().trim();

        if (barrier.expect !== undefined) {
          if (typeof barrier.expect === "number") {
            if (exitCode === barrier.expect) {
              return { satisfied: true, status: output };
            }
          } else {
            if (output === barrier.expect) {
              return { satisfied: true, status: output };
            }
          }
        } else {
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
        status: exists
          ? "File found"
          : `Waiting for ${barrier.waitForFile}`,
      };
    }

    case "count-based": {
      try {
        const result =
          await $`sh -c ${barrier.updateCommand!}`.quiet().nothrow();
        const current = parseInt(result.stdout.toString().trim());
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
      return {
        satisfied: barrier.status === "satisfied",
        status:
          barrier.status === "satisfied"
            ? barrier.type === "webhook"
              ? "Webhook received"
              : "Manually approved"
            : barrier.type === "webhook"
              ? "Waiting for webhook"
              : "Waiting for manual approval",
      };
    }

    default:
      return { satisfied: false, status: `Unknown barrier type: ${barrier.type}` };
  }
}

// ─── Load / Save barriers ────────────────────────────────────────────────────

export function loadBarriers(): Barrier[] {
  if (!existsSync(barriersPath)) return [];
  return parseBarriers(readFileSync(barriersPath, "utf-8"));
}

export function saveBarriers(barriers: Barrier[]): void {
  const lines: string[] = ["# Wild Loop Barriers", ""];

  for (const b of barriers) {
    const statusLabel = b.status.toUpperCase();
    lines.push(`## [${statusLabel}] ${b.id}`);
    if (b.type) lines.push(`- Type: ${b.type}`);
    if (b.checkCommand) lines.push(`- Check: ${b.checkCommand}`);
    if (b.expect !== undefined) lines.push(`- Expect: ${b.expect}`);
    if (b.checkInterval) lines.push(`- Interval: ${b.checkInterval}s`);
    if (b.waitForFile) lines.push(`- File: ${b.waitForFile}`);
    if (b.target !== undefined) lines.push(`- Target: ${b.target}`);
    if (b.updateCommand) lines.push(`- UpdateCommand: ${b.updateCommand}`);
    if (b.createdAt) lines.push(`- Created: ${b.createdAt}`);
    if (b.lastCheck) lines.push(`- Last check: ${b.lastCheck}`);
    if (b.lastCheckResult) lines.push(`- Result: "${b.lastCheckResult}"`);
    if (b.satisfiedAt) lines.push(`- Satisfied: ${b.satisfiedAt}`);
    if (b.blocks && b.blocks.length > 0)
      lines.push(`- Blocks: ${b.blocks.join(", ")}`);
    lines.push("");
  }

  writeFileSync(barriersPath, lines.join("\n"));
}

// ─── Background barrier checker ─────────────────────────────────────────────

export async function startBarrierChecker(
  eventQueue: EventEmitter,
  intervalMs: number = 10000
): Promise<{ stop: () => void }> {
  let running = true;

  const checkLoop = async () => {
    while (running) {
      const barriers = loadBarriers();
      const waiting = barriers.filter((b) => b.status === "waiting");

      for (const barrier of waiting) {
        if (!running) break;

        const now = Date.now();
        const lastCheck = barrier.lastCheck
          ? new Date(barrier.lastCheck).getTime()
          : 0;
        const interval = (barrier.checkInterval || 60) * 1000;

        if (now - lastCheck < interval) continue;

        const result = await checkBarrier(barrier);
        barrier.lastCheck = new Date().toISOString();
        barrier.lastCheckResult = result.status;

        if (result.satisfied) {
          barrier.status = "satisfied";
          barrier.satisfiedAt = new Date().toISOString();
          console.log(`✅ Barrier satisfied: ${barrier.name}`);
          eventQueue.emit("wake", {
            type: "barrier-satisfied",
            barrierId: barrier.id,
          });
        } else if (result.error) {
          console.warn(
            `⚠️ Barrier check error: ${barrier.name} - ${result.error}`
          );
        }

        saveBarriers(barriers);
      }

      await Bun.sleep(intervalMs);
    }
  };

  // Start in background
  checkLoop().catch(console.error);

  return {
    stop: () => {
      running = false;
    },
  };
}
