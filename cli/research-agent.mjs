#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { copyFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_INSTALL_DIR = path.join(os.homedir(), ".research-agent", "app");
const DEFAULT_BACKEND_BINARY_URL =
  "https://drive.google.com/uc?export=download&id=1CIdMPZzF2GceTZkSwK_8_8T9crN1cfDl";
const DEFAULT_FRONTEND_BUNDLE_URL =
  "https://drive.google.com/uc?export=download&id=14kuhcyxGBtBl_oa774AaIcW4-FtyE7QR";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");

const installDir = process.env.RESEARCH_AGENT_INSTALL_DIR || DEFAULT_INSTALL_DIR;
const stateDir = process.env.RESEARCH_AGENT_STATE_DIR || path.join(os.homedir(), ".research-agent");
const onboardedFile = path.join(stateDir, "onboarded");
const sourceManagerScript = path.join(packageRoot, "scripts", "research-agent");
const managerScript = path.join(installDir, "scripts", "research-agent");
const argv = process.argv.slice(2);
const command = argv[0] || "start";

if (!process.env.RESEARCH_AGENT_BACKEND_BINARY_URL) {
  process.env.RESEARCH_AGENT_BACKEND_BINARY_URL = DEFAULT_BACKEND_BINARY_URL;
}
if (!process.env.RESEARCH_AGENT_FRONTEND_BUNDLE_URL) {
  process.env.RESEARCH_AGENT_FRONTEND_BUNDLE_URL = DEFAULT_FRONTEND_BUNDLE_URL;
}

function printError(message) {
  process.stderr.write(`[research-agent-cli] ${message}\n`);
}

function ensureManagerScript() {
  if (!existsSync(sourceManagerScript)) {
    throw new Error(`Packaged manager script is missing: ${sourceManagerScript}`);
  }
  mkdirSync(path.dirname(managerScript), { recursive: true });
  copyFileSync(sourceManagerScript, managerScript);
  chmodSync(managerScript, 0o755);
}

function runScript(scriptPath, args, { exit = true } = {}) {
  const result = spawnSync(scriptPath, args, {
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }

  const code = result.status ?? 1;
  if (exit) {
    process.exit(code);
  }
  return code;
}

function runManager(args, options = {}) {
  return runScript(managerScript, args, options);
}

function shouldAutoBootstrap(cmd) {
  return cmd !== "help" && cmd !== "-h" && cmd !== "--help";
}

try {
  if (!shouldAutoBootstrap(command)) {
    runScript(sourceManagerScript, argv);
  }

  ensureManagerScript();

  if (!existsSync(onboardedFile) && shouldAutoBootstrap(command) && command !== "install") {
    printError(`Runtime not initialized. Bootstrapping into ${installDir}`);
    const bootstrapCode = runManager(["install", "--install-dir", installDir], { exit: false });
    if (bootstrapCode !== 0) {
      process.exit(bootstrapCode);
    }
  }

  runManager(argv);
} catch (error) {
  printError(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
