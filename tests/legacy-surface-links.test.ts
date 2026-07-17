import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { linkLegacyPiSurface } from "../src/core/legacy-surface-links.ts";

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-legacy-links-"));
try {
  const stateDir = ".claude/agentify";
  for (const entry of ["agents", "prompts", "workflows", "extensions"]) {
    fs.mkdirSync(path.join(cwd, stateDir, entry), { recursive: true });
  }
  fs.writeFileSync(path.join(cwd, stateDir, "conditional_docs.md"), "# Docs\n");

  const first = linkLegacyPiSurface(cwd, stateDir);
  assert.deepEqual(first.retained, []);
  assert.deepEqual(first.created, [
    ".pi/agents",
    ".pi/prompts",
    ".pi/workflows",
    ".pi/extensions",
    ".pi/conditional_docs.md",
  ]);
  assert.equal(fs.readFileSync(path.join(cwd, ".pi/conditional_docs.md"), "utf8"), "# Docs\n");
  assert.equal(fs.lstatSync(path.join(cwd, ".pi/agents")).isSymbolicLink(), true);
  assert.deepEqual(linkLegacyPiSurface(cwd, stateDir), { created: [], retained: [] });
} finally {
  fs.rmSync(cwd, { recursive: true, force: true });
}
console.log("legacy surface link tests passed.");
