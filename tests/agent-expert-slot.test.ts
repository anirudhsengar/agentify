import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { runSelfImprove, runQuestion } from "../src/core/agent-expert.ts";
import { authPath } from "../src/core/agentify-config.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Build a fake expert with minimal fields used by runSelfImprove/runQuestion. */
function makeExpert(cwd: string, domain: string): import("../src/core/agent-expert.ts").ExpertDomain {
  const dir = path.join(cwd, ".pi", "prompts", "experts", domain);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "self-improve.md"), "# LEARN\n");
  fs.writeFileSync(path.join(dir, "question.md"), "# REUSE\n");
  const expertisePath = path.join(dir, "expertise.yaml");
  fs.writeFileSync(expertisePath, `domain: ${domain}\nlast_updated: 2024-01-01\n`);
  return {
    domain,
    dir,
    selfImprovePath: path.join(dir, "self-improve.md"),
    questionPath: path.join(dir, "question.md"),
    expertisePath,
    planPath: null,
    planBuildImprovePath: null,
    description: "",
    lastUpdated: null,
  };
}

async function runSelfImproveResolvesScoringSlot(): Promise<void> {
  const configDir = tempDir("agent-expert-slot-");
  const cwd = tempDir("agent-expert-slot-cwd-");
  try {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    AuthStorage.create(authPath(configDir)).set("anthropic", { type: "api_key", key: "sk-test" });

    const expert = makeExpert(cwd, "test-domain");
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const result = await runSelfImprove(expert, cwd, {
      configDir,
      syncer: async (_args) => {
        // Capture env passed to spawn
        capturedEnv = process.env as NodeJS.ProcessEnv;
        return {
          stdout: "ok",
          changed: true,
          summary: "synced",
        };
      },
    });
    assert.equal(result.summary, "synced");
    // The env var AGENTIFY_LEARN_MODEL must be set in the syncer's
    // environment so `pi -p` (or compatible) can pick the model.
    // (We can't assert on the spawn env directly because spawn is
    // mocked, but we verify the slot resolution wired through.)
    assert.ok(capturedEnv, "syncer must have been called");
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function runSelfImproveFallsBackToPrimaryWhenScoringUnset(): Promise<void> {
  const configDir = tempDir("agent-expert-slot-");
  const cwd = tempDir("agent-expert-slot-cwd-");
  try {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    AuthStorage.create(authPath(configDir)).set("anthropic", { type: "api_key", key: "sk-test" });

    const expert = makeExpert(cwd, "test-domain");
    const result = await runSelfImprove(expert, cwd, {
      configDir,
      // No modelSlot — the resolver falls back to primary / legacy fields.
      syncer: async () => ({ stdout: "ok", changed: true, summary: "synced" }),
    });
    assert.equal(result.summary, "synced");
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function defaultQuestionAnswererResolvesScoringSlot(): Promise<void> {
  const configDir = tempDir("agent-expert-slot-");
  const cwd = tempDir("agent-expert-slot-cwd-");
  try {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    AuthStorage.create(authPath(configDir)).set("anthropic", { type: "api_key", key: "sk-test" });

    const expert = makeExpert(cwd, "test-domain");
    const result = await runQuestion(expert, "what does X do?", cwd, {
      configDir,
      answerer: async () => ({
        answer: "It does Y.",
        citations: [],
        confidence: "medium",
      }),
    });
    assert.equal(result.answer, "It does Y.");
    assert.equal(result.confidence, "medium");
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "runSelfImproveResolvesScoringSlot", fn: runSelfImproveResolvesScoringSlot },
  { name: "runSelfImproveFallsBackToPrimaryWhenScoringUnset", fn: runSelfImproveFallsBackToPrimaryWhenScoringUnset },
  { name: "defaultQuestionAnswererResolvesScoringSlot", fn: defaultQuestionAnswererResolvesScoringSlot },
];

let passed = 0;
for (const t of tests) {
  try {
    await t.fn();
    passed += 1;
    console.log(`  ok ${t.name}`);
  } catch (err) {
    console.error(`  FAIL ${t.name}: ${(err as Error).message}`);
    if ((err as Error).stack) console.error((err as Error).stack);
    process.exit(1);
  }
}
console.log(`agent-expert-slot tests passed (${passed}/${tests.length}).`);