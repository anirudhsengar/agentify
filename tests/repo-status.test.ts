import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inspectAgentifyRepoState } from "../src/core/repo-status.ts";
import {
  manifestFileFromContent,
  writeManifestAt,
  type ManagedManifestFile,
} from "../src/core/manifest.ts";
import { AGENTIFY_MANAGED_MARKERS } from "../src/core/artifact-exporters.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(relativePath: string, cwd: string): void {
  const filePath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "x\n");
}

function writeManaged(relativePath: string, cwd: string, mode: "brownfield" | "greenfield" = "brownfield"): ManagedManifestFile {
  const filePath = path.join(cwd, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const marker = relativePath.endsWith(".json")
    ? ""
    : relativePath.endsWith(".md")
      ? `${AGENTIFY_MANAGED_MARKERS.markdown}\n`
      : `${AGENTIFY_MANAGED_MARKERS.toml}\n`;
  const content = `${marker}x\n`;
  fs.writeFileSync(filePath, content);
  return manifestFileFromContent({
    relativePath,
    content,
    source: "test",
  }, mode, ".pi/agentify");
}

async function testReadyBrownfield(): Promise<void> {
  const cwd = tempDir("agentify-repo-status-brownfield-");
  const configDir = tempDir("agentify-repo-status-config-");
  try {
    const files = [
      "AGENTS.md",
      "specs/README.md",
      "ai_docs/README.md",
      ".pi/agentify/codebase_map.json",
      ".pi/workflows/payments-plan-build-review-fix.json",
      ".pi/prompts/experts/payments/expertise.yaml",
      ".pi/skills/billing/SKILL.md",
      "SETUP.md",
      ".github/workflows/agent-implement.yml",
      ".github/actions/run-pi/action.yml",
      ".github/scripts/setup-agentify.sh",
      ".pi/agents/payments.md",
    ].map((relativePath) => writeManaged(relativePath, cwd));
    writeManifestAt(cwd, {
      schema_version: "1",
      agentify_version: "test",
      generated_at: "2026-07-05T00:00:00.000Z",
      mode: "brownfield",
      files,
    }, ".pi/agentify");
    write(".pi/agents/user-extra.md", cwd);
    write(".pi/workflows/user-extra.json", cwd);
    write(".pi/prompts/experts/user-extra/expertise.yaml", cwd);
    write(".pi/skills/user-extra/SKILL.md", cwd);

    const state = inspectAgentifyRepoState(cwd, configDir, ".pi/agentify");
    assert.equal(state.mode, "brownfield");
    assert.equal(state.status, "ready");
    assert.equal(state.featureAgentCount, 1);
    assert.equal(state.workflowCount, 1);
    assert.equal(state.expertCount, 1);
    assert.equal(state.skillCount, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testUnmanagedBrownfieldIsPartial(): Promise<void> {
  const cwd = tempDir("agentify-repo-status-unmanaged-");
  const configDir = tempDir("agentify-repo-status-config-");
  try {
    for (const relativePath of [
      "AGENTS.md",
      "specs/README.md",
      "ai_docs/README.md",
      ".pi/agentify/codebase_map.json",
      "SETUP.md",
      ".github/workflows/agent-implement.yml",
      ".github/actions/run-pi/action.yml",
      ".github/scripts/setup-agentify.sh",
    ]) {
      write(relativePath, cwd);
    }
    const state = inspectAgentifyRepoState(cwd, configDir, ".pi/agentify");
    assert.equal(state.mode, "brownfield");
    assert.equal(state.status, "partial");
    assert.ok(state.missing.some((entry) => entry.includes("(unmanaged)")));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testPartialGreenfield(): Promise<void> {
  const cwd = tempDir("agentify-repo-status-greenfield-");
  const configDir = tempDir("agentify-repo-status-config-");
  try {
    write("GOALS.md", cwd);
    write("CONTEXT.md", cwd);
    const state = inspectAgentifyRepoState(cwd, configDir, ".pi/agentify");
    assert.equal(state.mode, "greenfield");
    assert.equal(state.status, "partial");
    assert.ok(state.missing.includes(".github/workflows/agent-implement.yml"));
    assert.ok(state.missing.includes(".github/actions/run-pi/action.yml"));
    assert.ok(state.missing.includes(".github/scripts/setup-agentify.sh"));
    assert.ok(state.missing.includes("SETUP.md"));
    assert.ok(state.missing.includes("GOALS.md (unmanaged)"));
    assert.ok(state.missing.includes("CONTEXT.md (unmanaged)"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testReadyGreenfieldManifest(): Promise<void> {
  const cwd = tempDir("agentify-repo-status-greenfield-ready-");
  const configDir = tempDir("agentify-repo-status-config-");
  try {
    const files = [
      "GOALS.md",
      "CONTEXT.md",
      "SETUP.md",
      ".github/workflows/agent-implement.yml",
      ".github/actions/run-pi/action.yml",
      ".github/scripts/setup-agentify.sh",
    ].map((relativePath) => writeManaged(relativePath, cwd, "greenfield"));
    writeManifestAt(cwd, {
      schema_version: "1",
      agentify_version: "test",
      generated_at: "2026-07-06T00:00:00.000Z",
      mode: "greenfield",
      files,
    }, ".pi/agentify");

    const state = inspectAgentifyRepoState(cwd, configDir, ".pi/agentify");

    assert.equal(state.mode, "greenfield");
    assert.equal(state.status, "ready");
    assert.deepEqual(state.missing, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testUninitializedRepo(): Promise<void> {
  const cwd = tempDir("agentify-repo-status-empty-");
  const configDir = tempDir("agentify-repo-status-config-");
  try {
    const state = inspectAgentifyRepoState(cwd, configDir, ".pi/agentify");
    assert.equal(state.mode, "unknown");
    assert.equal(state.status, "uninitialized");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "readyBrownfield", fn: testReadyBrownfield },
  { name: "unmanagedBrownfieldIsPartial", fn: testUnmanagedBrownfieldIsPartial },
  { name: "partialGreenfield", fn: testPartialGreenfield },
  { name: "readyGreenfieldManifest", fn: testReadyGreenfieldManifest },
  { name: "uninitializedRepo", fn: testUninitializedRepo },
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
console.log(`repo-status tests passed (${passed}/${tests.length}).`);
