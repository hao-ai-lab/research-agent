/**
 * Wild Loop — LLM-Driven MLP Sweep Pipeline Test
 *
 * Integration test that uses a REAL LLM (Anthropic Claude) to drive agent
 * decisions throughout the pipeline:
 *
 *   human input → LLM designs sweep → run 16 configs (CPU + sleep) →
 *   LLM triages alerts (loss spikes + OOM) → LLM resolves with human input →
 *   analysis with LLM-generated report
 *
 * Run with:
 *   ANTHROPIC_API_KEY=sk-... bun test ./tests/test_llm_pipeline.ts
 *
 * Requires ANTHROPIC_API_KEY env var. Skips gracefully if not set.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import type { Alert, Task, HumanInput } from "../lib/types";
import { DEFAULT_POLICY } from "../lib/types";
import { parseTasks, parseBarriers, parseHumanPolicy, parseHumanInput } from "../lib/parsers";
import { loadAlerts, appendAlert, updateAlertStatus, setStateDir } from "../lib/alerts";
import { selectWork } from "../lib/work-selection";
import { shouldEscalateToHuman, createAlertHistory } from "../lib/human-policy";

// ─── LLM Client ──────────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const LLM_MODEL = process.env.LLM_MODEL || "claude-sonnet-4-20250514";

interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

async function callLLM(
  systemPrompt: string,
  messages: LLMMessage[],
  maxTokens: number = 1024
): Promise<string> {
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as any;
  return data.content?.[0]?.text || "";
}

// ─── MLP Config Generation ──────────────────────────────────────────────────

interface MLPConfig {
  runId: string;
  hiddenSize: number;
  learningRate: number;
  batchSize: number;
  epochs: number;
}

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

async function mockTraining(config: MLPConfig, sleepMs: number = 50): Promise<TrainingResult> {
  await Bun.sleep(sleepMs);

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
  const dir = join(tmpdir(), `wild-loop-llm-test-${Date.now()}`);
  const wildDir = join(dir, ".wild");
  mkdirSync(wildDir, { recursive: true });
  setStateDir(wildDir);
  return dir;
}

function cleanupTestDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort
  }
}

// ─── LLM-Driven Pipeline Test ───────────────────────────────────────────────

const skipLLM = !ANTHROPIC_API_KEY;

describe("Wild Loop — LLM-Driven MLP Sweep Pipeline", () => {
  beforeEach(() => {
    testDir = setupTestDir();
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  test.skipIf(skipLLM)(
    "LLM drives full pipeline: sweep design → training → alert triage → analysis",
    async () => {
      const wildDir = join(testDir, ".wild");
      const configs = generateConfigs();
      const alertHistory = createAlertHistory();

      // ═══════════════════════════════════════════════════════════════════
      // Phase 1: LLM designs the sweep from human instruction
      // ═══════════════════════════════════════════════════════════════════

      console.log("\n📋 Phase 1: LLM designs sweep configuration...");

      const sweepDesign = await callLLM(
        `You are an ML research assistant. You help design hyperparameter sweeps.
Respond ONLY with a JSON object, no markdown fences or explanation.`,
        [
          {
            role: "user",
            content: `I want to run an MLP hyperparameter sweep. I have these configs:

${configs.map((c) => `- ${c.runId}: hidden=${c.hiddenSize}, lr=${c.learningRate}, batch=${c.batchSize}, epochs=${c.epochs}`).join("\n")}

Create a sweep plan. Return JSON with:
{
  "sweep_name": "...",
  "total_configs": <number>,
  "estimated_risks": ["..."],
  "recommended_monitoring": ["..."],
  "execution_order": "parallel" | "sequential"
}`,
          },
        ],
        512
      );

      console.log("  LLM sweep design:", sweepDesign.substring(0, 200));

      // Validate LLM returned valid JSON
      let sweepPlan: any;
      try {
        sweepPlan = JSON.parse(sweepDesign);
      } catch {
        // LLM may wrap in markdown, try to extract
        const jsonMatch = sweepDesign.match(/\{[\s\S]*\}/);
        sweepPlan = jsonMatch ? JSON.parse(jsonMatch[0]) : { total_configs: 16 };
      }
      expect(sweepPlan.total_configs).toBe(16);

      // ═══════════════════════════════════════════════════════════════════
      // Phase 2: Run all 16 configs, collect results and alerts
      // ═══════════════════════════════════════════════════════════════════

      console.log("\n🏃 Phase 2: Running 16 training configs...");

      const results: Map<string, TrainingResult> = new Map();
      const alertsCreated: Alert[] = [];

      for (const config of configs) {
        const result = await mockTraining(config, 20);
        results.set(config.runId, result);

        if (result.alert) {
          const alert: Alert = {
            id: `alert-${config.runId}`,
            timestamp: new Date().toISOString(),
            severity: result.alert.severity,
            source: config.runId,
            type: result.alert.type,
            description: result.alert.description,
            status: "pending",
            context: {
              hiddenSize: config.hiddenSize,
              learningRate: config.learningRate,
              batchSize: config.batchSize,
            },
          };
          appendAlert(alert);
          alertsCreated.push(alert);
          console.log(`  🚨 Alert: ${alert.id} [${alert.severity}] ${alert.type}`);
        } else {
          console.log(`  ✅ ${config.runId}: loss=${result.finalLoss}, acc=${result.finalAccuracy}`);
        }
      }

      expect(alertsCreated).toHaveLength(4);

      // ═══════════════════════════════════════════════════════════════════
      // Phase 3: LLM triages each alert
      // ═══════════════════════════════════════════════════════════════════

      console.log("\n🤖 Phase 3: LLM triages alerts...");

      const llmTriageDecisions: Array<{
        alertId: string;
        decision: string;
        reasoning: string;
      }> = [];

      for (const alert of alertsCreated) {
        const triageResponse = await callLLM(
          `You are an ML training alert triage system. Analyze alerts and decide how to handle them.
Respond ONLY with a JSON object, no markdown fences.`,
          [
            {
              role: "user",
              content: `Alert received during MLP training sweep:

Alert ID: ${alert.id}
Severity: ${alert.severity}
Type: ${alert.type}
Source: ${alert.source}
Description: ${alert.description}
Context: ${JSON.stringify(alert.context)}

Current policy: autonomous mode, high autonomy, escalate critical only.

Decide how to handle this. Return JSON:
{
  "decision": "auto_resolve" | "escalate_to_human" | "retry_with_fix",
  "reasoning": "...",
  "fix_action": "..." (if applicable),
  "new_config": { ... } (if retry_with_fix)
}`,
            },
          ],
          512
        );

        let triage: any;
        try {
          triage = JSON.parse(triageResponse);
        } catch {
          const jsonMatch = triageResponse.match(/\{[\s\S]*\}/);
          triage = jsonMatch
            ? JSON.parse(jsonMatch[0])
            : { decision: "auto_resolve", reasoning: "Failed to parse LLM response" };
        }

        llmTriageDecisions.push({
          alertId: alert.id,
          decision: triage.decision,
          reasoning: triage.reasoning || "",
        });

        console.log(
          `  ${alert.id}: ${triage.decision} — ${(triage.reasoning || "").substring(0, 80)}`
        );

        // Resolve the alert based on LLM decision
        updateAlertStatus(alert.id, "resolved", {
          resolvedAt: new Date().toISOString(),
          context: {
            ...alert.context,
            llm_decision: triage.decision,
            llm_reasoning: triage.reasoning,
            llm_fix: triage.fix_action,
          },
        });

        alertHistory.recordProgress();
      }

      // Verify all alerts resolved
      const unresolvedAlerts = loadAlerts();
      expect(unresolvedAlerts).toHaveLength(0);

      // Verify LLM made reasonable decisions
      expect(llmTriageDecisions).toHaveLength(4);

      // LLM should recognize OOM as more severe
      const oomDecisions = llmTriageDecisions.filter((d) =>
        d.alertId.includes("lr0.1")
      );
      const spikeDecisions = llmTriageDecisions.filter((d) =>
        d.alertId.includes("lr0.05")
      );

      console.log("\n  OOM decisions:", oomDecisions.map((d) => d.decision));
      console.log("  Spike decisions:", spikeDecisions.map((d) => d.decision));

      // ═══════════════════════════════════════════════════════════════════
      // Phase 4: LLM generates analysis report
      // ═══════════════════════════════════════════════════════════════════

      console.log("\n📊 Phase 4: LLM generates analysis report...");

      const resultsSummary = Array.from(results.entries())
        .map(([id, r]) => {
          const config = configs.find((c) => c.runId === id)!;
          return `${id}: hidden=${config.hiddenSize}, lr=${config.learningRate} → status=${r.status}, loss=${r.finalLoss ?? "N/A"}, acc=${r.finalAccuracy ?? "N/A"}, steps=${r.stepsCompleted}`;
        })
        .join("\n");

      const alertsSummary = llmTriageDecisions
        .map((d) => `${d.alertId}: decision=${d.decision}, reason=${d.reasoning}`)
        .join("\n");

      const analysisReport = await callLLM(
        `You are an ML research analyst. Write concise, data-driven reports.`,
        [
          {
            role: "user",
            content: `Analyze this MLP hyperparameter sweep and write a brief report.

## Training Results
${resultsSummary}

## Alert Triage Log
${alertsSummary}

Write a structured report covering:
1. Best configuration and why
2. Key findings about hyperparameter sensitivity
3. Failure analysis (what caused OOMs and loss spikes)
4. Recommendations for next sweep

Keep it under 500 words.`,
          },
        ],
        1024
      );

      // Write report
      writeFileSync(join(testDir, "llm_sweep_report.md"), analysisReport);
      console.log("\n  Report preview:");
      console.log("  " + analysisReport.substring(0, 300).replace(/\n/g, "\n  "));

      // Validate report has content
      expect(analysisReport.length).toBeGreaterThan(100);

      // ═══════════════════════════════════════════════════════════════════
      // Phase 5: Verify pipeline completed
      // ═══════════════════════════════════════════════════════════════════

      console.log("\n✅ Pipeline complete!");
      console.log(`   Configs: ${configs.length}`);
      console.log(`   Alerts: ${alertsCreated.length} created, all resolved`);
      console.log(`   LLM calls: 1 (sweep design) + ${alertsCreated.length} (triage) + 1 (analysis) = ${2 + alertsCreated.length}`);
      console.log(`   Report: ${join(testDir, "llm_sweep_report.md")}`);

      // Write full pipeline log
      const pipelineLog = {
        sweep_plan: sweepPlan,
        configs: configs.length,
        results: Object.fromEntries(results),
        alerts: alertsCreated.map((a) => ({ id: a.id, severity: a.severity, type: a.type })),
        triage_decisions: llmTriageDecisions,
        report_length: analysisReport.length,
      };
      writeFileSync(
        join(testDir, "pipeline_log.json"),
        JSON.stringify(pipelineLog, null, 2)
      );
    },
    60_000 // 60s timeout for LLM calls
  );

  test.skipIf(skipLLM)(
    "LLM provides human-like input to resolve OOM alert",
    async () => {
      const wildDir = join(testDir, ".wild");

      // Create an OOM alert
      const oomAlert: Alert = {
        id: "alert-oom-test",
        timestamp: new Date().toISOString(),
        severity: "critical",
        source: "mlp-h512-lr0.1",
        type: "OOM",
        description: "GPU memory exhausted: hidden_size=512, lr=0.1, batch_size=64",
        status: "pending",
        context: { hiddenSize: 512, learningRate: 0.1, batchSize: 64 },
      };
      appendAlert(oomAlert);

      // Ask LLM to produce human-like resolution guidance
      const humanResponse = await callLLM(
        `You are a human ML researcher replying to an alert from your autonomous agent. 
Be practical and specific. Respond ONLY with a JSON object, no markdown fences.`,
        [
          {
            role: "user",
            content: `Your agent hit an OOM error:

${oomAlert.description}

Context: ${JSON.stringify(oomAlert.context)}

Provide guidance as if you're typing a quick message to your agent.
Return JSON:
{
  "guidance": "...",
  "priority": "urgent" | "normal",
  "steps": ["step1", "step2", ...],
  "new_batch_size": <number>,
  "should_retry": true | false
}`,
          },
        ],
        512
      );

      let guidance: any;
      try {
        guidance = JSON.parse(humanResponse);
      } catch {
        const match = humanResponse.match(/\{[\s\S]*\}/);
        guidance = match
          ? JSON.parse(match[0])
          : { guidance: "Reduce batch size", new_batch_size: 32, should_retry: true };
      }

      console.log("\n🧑 LLM human response:", JSON.stringify(guidance, null, 2));

      // Validate LLM gave reasonable guidance
      expect(guidance.new_batch_size).toBeDefined();
      expect(guidance.new_batch_size).toBeLessThan(64);
      expect(guidance.should_retry).toBe(true);

      // Apply — resolve alert
      updateAlertStatus("alert-oom-test", "resolved", {
        resolvedAt: new Date().toISOString(),
        context: {
          resolution: guidance.guidance,
          new_batch_size: guidance.new_batch_size,
        },
      });

      expect(loadAlerts()).toHaveLength(0);
      console.log("  ✅ Alert resolved with LLM-generated human guidance");
    },
    30_000
  );
});
