import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { runAgentifyApp } from "../../src/core/agentify-app.ts";
import {
  finalizeOneTimeInstallation,
  prepareOneTimeInstallationState,
  type RepositoryInstallationPreflight,
} from "../../src/core/installer/index.ts";
import type {
  AgentRuntime,
  AgentRuntimeResult,
  AgentifyUi,
} from "../../src/core/types.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function createRepository(): { cwd: string; preflight: RepositoryInstallationPreflight } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-atomic-install-"));
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "tests"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "README.md"), "# Fixture\n");
  fs.writeFileSync(path.join(cwd, "src", "index.ts"), "export const value = 1;\n");
  fs.writeFileSync(path.join(cwd, "tests", "index.test.ts"), "// test\n");
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Agentify Test");
  git(cwd, "config", "user.email", "agentify@example.invalid");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "fixture");
  const head = git(cwd, "rev-parse", "HEAD");

  const preflight = {
    analysis_allowed: true,
    disposition: "ready",
    blockers: [],
    identity: {
      repository_id: "123",
      full_name: "owner/repo",
      default_branch: "main",
      current_commit: head,
      actor_login: "maintainer",
    },
    allowed_write_paths: ["src", "tests"],
    commands: [],
  } as unknown as RepositoryInstallationPreflight;
  return { cwd, preflight };
}

class SilentUi implements AgentifyUi {
  status(): void {}
  info(): void {}
  error(): void {}
  async promptSelect(): Promise<string> { throw new Error("must not prompt"); }
  async promptMultiSelect(): Promise<ReadonlyArray<string>> { throw new Error("must not prompt"); }
  async promptCheckboxList(): Promise<ReadonlyArray<string>> { throw new Error("must not prompt"); }
  async promptSecret(): Promise<string> { throw new Error("must not prompt"); }
  async promptText(): Promise<string> { throw new Error("must not prompt"); }
}

class NeverRuns implements AgentRuntime {
  async runSession(): Promise<AgentRuntimeResult> {
    throw new Error("runtime must not run");
  }
}

test("failed specialist compilation rolls back every persistent team artifact but retains the diagnostic map", () => {
  const { cwd, preflight } = createRepository();
  try {
    prepareOneTimeInstallationState(cwd, preflight);
    assert.ok(fs.existsSync(path.join(cwd, ".agentify", "manifest.json")));
    assert.ok(fs.existsSync(path.join(cwd, ".agentify", "agents", "orchestrator.json")));

    const map = makeValidCodebaseMap();
    delete map.expert_evidence;
    delete map.concern_evidence;
    const mapPath = path.join(cwd, ".agentify", "runtime", "audit", "codebase_map.json");
    fs.mkdirSync(path.dirname(mapPath), { recursive: true });
    const diagnostic = `${JSON.stringify(map, null, 2)}\n`;
    fs.writeFileSync(mapPath, diagnostic);

    assert.throws(
      () => finalizeOneTimeInstallation({
        cwd,
        preflight,
        agentifyVersion: "1.1.0",
        provider: "openai",
        model: "gpt-5",
        providerVerified: true,
      }),
      /specialist compilation failed before installation/i,
    );

    assert.equal(fs.existsSync(path.join(cwd, ".agentify", "manifest.json")), false);
    assert.equal(fs.existsSync(path.join(cwd, ".agentify", "agents")), false);
    assert.equal(fs.existsSync(path.join(cwd, "AGENTS.md")), false);
    assert.equal(fs.existsSync(path.join(cwd, ".github", "workflows", "agentify-issue.yml")), false);
    assert.equal(fs.readFileSync(mapPath, "utf8"), diagnostic);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("any audit exception aborts the pending installation transaction", async () => {
  const { cwd, preflight } = createRepository();
  try {
    prepareOneTimeInstallationState(cwd, preflight);
    assert.ok(fs.existsSync(path.join(cwd, ".agentify", "manifest.json")));

    await assert.rejects(
      runAgentifyApp({
        args: ["unexpected"],
        cwd,
        ui: new SilentUi(),
        runtime: new NeverRuns(),
        configOverride: {
          schemaVersion: 1,
          provider: "openai",
          thinkingLevel: "high",
          models: {},
        },
      }),
      /does not accept/i,
    );

    assert.equal(fs.existsSync(path.join(cwd, ".agentify", "manifest.json")), false);
    assert.equal(fs.existsSync(path.join(cwd, ".agentify", "agents")), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("SIGTERM rolls a pending installation back to diagnostic-map-only state", async () => {
  const { cwd } = createRepository();
  try {
    const transactionModule = pathToFileURL(
      path.resolve("src/core/installer/installation-transaction.ts"),
    ).href;
    const diagnostic = JSON.stringify({ status: "partial", reason: "signal fixture" });
    const script = `
      import fs from "node:fs";
      import path from "node:path";
      import { beginPendingInstallation } from ${JSON.stringify(transactionModule)};
      const cwd = process.argv[1];
      beginPendingInstallation(cwd);
      const auditDir = path.join(cwd, ".agentify", "runtime", "audit");
      fs.mkdirSync(auditDir, { recursive: true });
      fs.writeFileSync(path.join(auditDir, "codebase_map.json"), ${JSON.stringify(diagnostic)});
      fs.writeFileSync(path.join(cwd, ".agentify", "manifest.json"), "partial install");
      process.stdout.write("READY\\n");
      setInterval(() => {}, 1_000);
    `;
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      script,
      cwd,
    ], {
      cwd: path.resolve("."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    await new Promise<void>((resolve, reject) => {
      let stdout = "";
      const timeout = setTimeout(() => reject(new Error(`signal fixture did not become ready: ${stderr}`)), 5_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (!stdout.includes("READY")) return;
        clearTimeout(timeout);
        resolve();
      });
      child.once("error", reject);
    });
    child.kill("SIGTERM");
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.deepEqual(outcome, { code: 143, signal: null }, stderr);
    assert.equal(fs.existsSync(path.join(cwd, ".agentify", "manifest.json")), false);
    assert.equal(
      fs.readFileSync(path.join(cwd, ".agentify", "runtime", "audit", "codebase_map.json"), "utf8"),
      diagnostic,
    );
    const retainedFiles = fs.readdirSync(path.join(cwd, ".agentify", "runtime", "audit"));
    assert.deepEqual(retainedFiles, ["codebase_map.json"]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
