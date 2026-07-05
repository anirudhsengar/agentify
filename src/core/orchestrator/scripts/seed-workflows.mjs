#!/usr/bin/env node
// seed-workflows.mjs — materialize the agentify starter workflow
// library into the user-level `~/.agentify/workflows/` directory.
//
// Idempotent: never overwrites an existing user file. Run by the
// callable directly:
//
//     node ./src/core/orchestrator/scripts/seed-workflows.mjs
//
// Mirrors the Class 1 G1 audit semantic of "report conflicts and
// leave intact" — the user always wins.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_WORKFLOWS_DIR = path.join(__dirname, "..", "workflows");
const USER_WORKFLOWS_DIR = path.join(os.homedir(), ".agentify", "workflows");

export function seedWorkflows(opts = {}) {
  const source = opts.source ?? PACKAGE_WORKFLOWS_DIR;
  const target = opts.target ?? USER_WORKFLOWS_DIR;
  if (!fs.existsSync(source)) return { created: [], conflicts: [], skipped: true, reason: "no_source" };

  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const created = [];
  const conflicts = [];
  const skipped = [];

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const src = path.join(source, entry.name);
    const dst = path.join(target, entry.name);
    if (fs.existsSync(dst)) {
      conflicts.push(entry.name);
      continue;
    }
    try {
      const raw = fs.readFileSync(src, "utf-8");
      // Validate before placing (defensive — the package files should be valid).
      JSON.parse(raw);
      fs.writeFileSync(dst, raw, { mode: 0o600 });
      created.push(entry.name);
    } catch (err) {
      conflicts.push(`${entry.name} (read/parse error: ${(err).message})`);
    }
  }
  return { created, conflicts, skipped: false };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = seedWorkflows();
  if (result.skipped) {
    console.error(`seed-workflows: skipped (${result.reason})`);
    process.exit(1);
  }
  console.log(`seed-workflows: created=${result.created.length} conflicts=${result.conflicts.length}`);
  for (const f of result.created) console.log(`  + ${f}`);
  for (const f of result.conflicts) console.log(`  = ${f} (already present)`);
}
