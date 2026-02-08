#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");

const scriptPath = resolve(__dirname, "..", "ralph.ts");
const result = spawnSync("bun", [scriptPath, ...process.argv.slice(2)], { stdio: "inherit" });

if (result.error) {
  console.error("Error: Bun is required to run ralph. Install Bun: https://bun.sh");
  process.exit(1);
}

process.exit(result.status ?? 1);
