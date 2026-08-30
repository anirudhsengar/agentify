import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Value } from "typebox/value";
import { runAgentifyApp } from "../../src/core/agentify-app.ts";
import { CodebaseMapSchema, type CodebaseMap } from "../../src/core/audit/schema.ts";
import {
  finalizeOneTimeInstallation,
  prepareOneTimeInstallationState,
  type RepositoryInstallationPreflight,
} from "../../src/core/installer/index.ts";
import {
  beginPendingInstallation,
  rollbackPendingInstallation,
} from "../../src/core/installer/installation-transaction.ts";
import type {
  AgentRuntime,
  AgentRuntimeResult,
  AgentifyUi,
} from "../../src/core/types.ts";
import { attestCodebaseMap, makeValidCodebaseMap } from "../fixtures/codebase-map.ts";

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
  readonly messages: string[] = [];
  status(message: string): void { this.messages.push(message); }
  info(message: string): void { this.messages.push(message); }
  error(message: string): void { this.messages.push(message); }
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

test("diagnostic map reuse never claims that a persistent team already exists", async () => {
  const { cwd } = createRepository();
  try {
    const head = git(cwd, "rev-parse", "HEAD");
    const mapPath = path.join(cwd, ".agentify", "runtime", "audit", "codebase_map.json");
    fs.mkdirSync(path.dirname(mapPath), { recursive: true });
    fs.writeFileSync(
      mapPath,
      JSON.stringify(attestCodebaseMap(makeValidCodebaseMap(), head), null, 2),
    );
    const ui = new SilentUi();
    await runAgentifyApp({
      args: [],
      cwd,
      ui,
      runtime: new NeverRuns(),
      configOverride: {
        schemaVersion: 1,
        provider: "openai",
        thinkingLevel: "high",
        models: {},
      },
    });
    assert.ok(ui.messages.includes("agentify: verified existing repository audit evidence"));
    assert.ok(!ui.messages.some((message) => /existing persistent repository team/i.test(message)));
    assert.equal(fs.existsSync(path.join(cwd, ".agentify", "manifest.json")), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

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

test("rollback restores a pre-existing managed installation instead of deleting it", () => {
  const { cwd } = createRepository();
  try {
    const manifestPath = path.join(cwd, ".agentify", "manifest.json");
    const scriptPath = path.join(cwd, ".github", "scripts", "run-task-lifecycle.mjs");
    const instructionsPath = path.join(cwd, "AGENTS.md");
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(manifestPath, "prior manifest\n");
    fs.writeFileSync(scriptPath, "prior runtime\n");
    fs.writeFileSync(instructionsPath, "prior instructions\n");

    beginPendingInstallation(cwd);
    fs.writeFileSync(manifestPath, "replacement manifest\n");
    fs.writeFileSync(scriptPath, "replacement runtime\n");
    fs.writeFileSync(instructionsPath, "replacement instructions\n");
    const newWorkflow = path.join(cwd, ".github", "workflows", "agentify-issue.yml");
    fs.mkdirSync(path.dirname(newWorkflow), { recursive: true });
    fs.writeFileSync(newWorkflow, "new workflow\n");

    assert.equal(rollbackPendingInstallation(cwd), true);
    assert.equal(fs.readFileSync(manifestPath, "utf8"), "prior manifest\n");
    assert.equal(fs.readFileSync(scriptPath, "utf8"), "prior runtime\n");
    assert.equal(fs.readFileSync(instructionsPath, "utf8"), "prior instructions\n");
    assert.equal(fs.existsSync(newWorkflow), false);
    assert.equal(fs.existsSync(path.dirname(newWorkflow)), false);
    assert.equal(fs.existsSync(path.dirname(scriptPath)), true);
  } finally {
    rollbackPendingInstallation(cwd);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("rollback never retains diagnostic bytes through a substituted symlink", { skip: process.platform === "win32" }, () => {
  const { cwd } = createRepository();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-rollback-map-outside-"));
  try {
    beginPendingInstallation(cwd);
    const auditDirectory = path.join(cwd, ".agentify", "runtime", "audit");
    const mapPath = path.join(auditDirectory, "codebase_map.json");
    const outsideFile = path.join(outside, "secret.txt");
    fs.mkdirSync(auditDirectory, { recursive: true });
    fs.writeFileSync(outsideFile, "outside bytes must not become a diagnostic map\n");
    fs.symlinkSync(outsideFile, mapPath);

    assert.equal(rollbackPendingInstallation(cwd), true);
    assert.equal(fs.existsSync(mapPath), false);
    assert.equal(fs.readFileSync(outsideFile, "utf8"), "outside bytes must not become a diagnostic map\n");
  } finally {
    rollbackPendingInstallation(cwd);
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
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

test("SIGTERM preserves one terminal audit result and charged budget through rollback", () => {
  const { cwd } = createRepository();
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-signal-audit-"));
  try {
    const moduleUrl = (relative: string): string => pathToFileURL(path.resolve(relative)).href;
    const script = `
      import fs from "node:fs";
      import os from "node:os";
      import path from "node:path";
      import { syncBuiltinESMExports } from "node:module";
      import { beginPendingInstallation } from ${JSON.stringify(moduleUrl("src/core/installer/installation-transaction.ts"))};
      import { runRepositoryAudit } from ${JSON.stringify(moduleUrl("src/core/runs/repository-audit-run.ts"))};
      const [cwd, configRoot] = process.argv.slice(1);
      os.homedir = () => configRoot;
      syncBuiltinESMExports();
      beginPendingInstallation(cwd);
      fs.mkdirSync(path.join(cwd, ".agentify"), { recursive: true });
      fs.writeFileSync(path.join(cwd, ".agentify/manifest.json"), "partial install");
      await runRepositoryAudit({
        cwd,
        config: { schemaVersion: 1, thinkingLevel: "high", models: {} },
        ui: { info() {}, status() {}, error() {} },
        runtime: { async runSession(options) {
          options.onEvent({ type: "message_end", message: {
            role: "assistant", usage: { input: 3, output: 2, cost: { total: 0.01 } }
          } });
          setTimeout(() => process.kill(process.pid, "SIGTERM"), 0);
          await new Promise(() => {});
        } }
      });
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, cwd, configRoot], {
      cwd: path.resolve("."), encoding: "utf8", timeout: 20_000,
    });
    assert.equal(child.status, 143, child.stderr);
    const logDir = path.join(configRoot, ".agentify/logs/agentify");
    const files = fs.readdirSync(logDir);
    assert.equal(files.length, 1);
    const events = fs.readFileSync(path.join(logDir, files[0]!), "utf8").trim().split("\n").map((line) => (
      JSON.parse(line) as { event: string; payload: string }
    ));
    const terminal = events.filter((event) => event.event === "agentify.run_end");
    assert.equal(terminal.length, 1, "SIGTERM must retain exactly one terminal audit result");
    assert.equal(JSON.parse(terminal[0]!.payload).exit_code, 143);
    assert.equal(JSON.parse(terminal[0]!.payload).status, "aborted");
    assert.equal(events.at(-1)?.event, "agentify.run_end");
    const map = JSON.parse(fs.readFileSync(path.join(cwd, ".agentify/runtime/audit/codebase_map.json"), "utf8")) as CodebaseMap;
    assert.equal(map.audit_budget_checkpoint?.usage.model_calls, 1);
    assert.equal(map.audit_budget_checkpoint?.usage.input_tokens, 3);
    assert.equal(map.audit_budget_checkpoint?.usage.output_tokens, 2);
    assert.equal(map.audit_budget_checkpoint?.usage.cost_usd, 0.01);
    assert.equal(fs.existsSync(path.join(cwd, ".agentify/manifest.json")), false);
    assert.deepEqual(
      fs.readdirSync(path.join(cwd, ".agentify/runtime/audit"), { recursive: true }),
      ["codebase_map.json"],
      "signal checkpoint must not recreate history after rollback",
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(configRoot, { recursive: true, force: true });
  }
});

test("a current-HEAD attested diagnostic-only map can resume installation without claiming other state", () => {
  const { cwd, preflight } = createRepository();
  try {
    const head = git(cwd, "rev-parse", "HEAD");
    const auditDir = path.join(cwd, ".agentify", "runtime", "audit");
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, "codebase_map.json"),
      JSON.stringify(attestCodebaseMap(makeValidCodebaseMap(), head), null, 2),
    );

    const resumedMap = attestCodebaseMap(makeValidCodebaseMap(), head);
    resumedMap.concern_evidence = {
      concerns: [{ concern: "New bounded diagnostic progress" }],
      not_concerns: [],
    } as never;

    assert.doesNotThrow(() => prepareOneTimeInstallationState(cwd, preflight));
    assert.equal(fs.existsSync(path.join(cwd, ".agentify", "manifest.json")), true);
    assert.equal(fs.existsSync(path.join(auditDir, "codebase_map.json")), true);
    fs.writeFileSync(
      path.join(auditDir, "codebase_map.json"),
      JSON.stringify(resumedMap, null, 2),
    );
    rollbackPendingInstallation(cwd);
    assert.equal(fs.existsSync(path.join(cwd, ".agentify", "manifest.json")), false);
    assert.equal(fs.existsSync(path.join(auditDir, "codebase_map.json")), true);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(auditDir, "codebase_map.json"), "utf8")),
      resumedMap,
      "a failed bounded continuation must retain its newest attested diagnostic checkpoint",
    );
  } finally {
    rollbackPendingInstallation(cwd);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a legacy diagnostic with only a malformed scout proposal is repaired before resume", () => {
  const { cwd, preflight } = createRepository();
  try {
    const head = git(cwd, "rev-parse", "HEAD");
    const auditDir = path.join(cwd, ".agentify", "runtime", "audit");
    const mapPath = path.join(auditDir, "codebase_map.json");
    fs.mkdirSync(auditDir, { recursive: true });
    const malformed = attestCodebaseMap(makeValidCodebaseMap(), head);
    malformed.explorer_receipts!.receipts[0]!.proposed_concerns = [
      "Argument declaration grammar one_line: " + "x".repeat(240),
    ];
    assert.equal(Value.Check(CodebaseMapSchema, malformed), false);
    fs.writeFileSync(mapPath, JSON.stringify(malformed, null, 2));

    assert.doesNotThrow(() => prepareOneTimeInstallationState(cwd, preflight));
    const repaired = JSON.parse(fs.readFileSync(mapPath, "utf8")) as unknown;
    assert.equal(Value.Check(CodebaseMapSchema, repaired), true);
    assert.deepEqual(
      (repaired as typeof malformed).explorer_receipts!.receipts[0]!.proposed_concerns,
      ["Argument declaration grammar"],
    );
  } finally {
    rollbackPendingInstallation(cwd);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("diagnostic recovery never repairs invalid receipt fields outside scout proposals", () => {
  const { cwd, preflight } = createRepository();
  try {
    const head = git(cwd, "rev-parse", "HEAD");
    const auditDir = path.join(cwd, ".agentify", "runtime", "audit");
    fs.mkdirSync(auditDir, { recursive: true });
    const invalid = attestCodebaseMap(makeValidCodebaseMap(), head);
    invalid.explorer_receipts!.receipts[0]!.sequence = 0;
    fs.writeFileSync(
      path.join(auditDir, "codebase_map.json"),
      JSON.stringify(invalid, null, 2),
    );

    assert.throws(
      () => prepareOneTimeInstallationState(cwd, preflight),
      /user-owned or unrecognized state/i,
    );
    assert.equal(fs.existsSync(path.join(cwd, ".agentify", "manifest.json")), false);
  } finally {
    rollbackPendingInstallation(cwd);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("an unattested diagnostic-shaped directory remains user-owned", () => {
  const { cwd, preflight } = createRepository();
  try {
    const auditDir = path.join(cwd, ".agentify", "runtime", "audit");
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, "codebase_map.json"),
      JSON.stringify(makeValidCodebaseMap(), null, 2),
    );
    assert.throws(
      () => prepareOneTimeInstallationState(cwd, preflight),
      /user-owned or unrecognized state/i,
    );
    assert.equal(fs.existsSync(path.join(cwd, ".agentify", "manifest.json")), false);
  } finally {
    rollbackPendingInstallation(cwd);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
