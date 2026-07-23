import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { dispatchSubcommand } from "../../src/core/cli-commands.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentify-shadow-cli-"));
}

function makeSink(): { out: NodeJS.WritableStream; err: NodeJS.WritableStream; output: { stdout: string[]; stderr: string[] } } {
  const output = { stdout: [] as string[], stderr: [] as string[] };
  return {
    output,
    out: { write: (chunk: string) => { output.stdout.push(String(chunk)); return true; } } as unknown as NodeJS.WritableStream,
    err: { write: (chunk: string) => { output.stderr.push(String(chunk)); return true; } } as unknown as NodeJS.WritableStream,
  };
}

function buildCtx(cwd: string): { ctx: Parameters<typeof dispatchSubcommand>[1]; output: { stdout: string[]; stderr: string[] } } {
  const sink = makeSink();
  const ctx = {
    cwd,
    configDir: path.join(cwd, ".agentify"),
    ui: {
      promptSelect: async () => "yes",
      promptText: async () => "ok",
      promptSecret: async () => "ok",
    } as never,
    out: sink.out,
    err: sink.err,
    stdinIsTTY: false,
  };
  return { ctx, output: sink.output };
}

function writeShadowConfig(cwd: string): string {
  const cfg = {
    schema_version: "1",
    mode: "shadow",
    comment_on_issue: false,
    engagement_id: "test-engagement",
    eval_suite_id: "test-suite",
    task_id: "test-task",
    validation_policy: "configured-eval-suite",
    maximum_runtime_ms: 60000,
    maximum_cost_usd: 5,
    require_measured_cost: true,
    maximum_input_tokens: 200000,
    maximum_output_tokens: 8192,
    pricing_policy: { version: "2026-07-22", models: [] },
    allow_failed_draft: false,
    allow_dependency_changes: false,
    forbidden_paths: [".github/workflows", ".git", ".agentify", ".pi/agentify/engagements"],
    validation_checks: [],
  };
  const target = path.join(cwd, ".github", "agentify-shadow.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(cfg));
  return target;
}

test("agentify engage shadow help prints the supported local subactions", async () => {
  const cwd = tmp();
  try {
    const { ctx, output } = buildCtx(cwd);
    const code = await dispatchSubcommand(["engage", "shadow", "help"], ctx);
    assert.equal(typeof code, "boolean"); assert.equal(process.exitCode ?? 0, 0);
    assert.match(output.stdout.join(""), /run-local/);
    assert.match(output.stdout.join(""), /status-local/);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("agentify engage shadow rejects unknown subactions with a concise error", async () => {
  const cwd = tmp();
  try {
    const { ctx, output } = buildCtx(cwd);
    const code = await dispatchSubcommand(["engage", "shadow", "bogus"], ctx);
    assert.equal(typeof code, "boolean"); assert.equal(process.exitCode, 1);
    assert.match(output.stderr.join(""), /unknown action 'bogus'/);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("agentify engage shadow run-local requires --id, --issue, --repo, and --pilot-root", async () => {
  const cwd = tmp();
  try {
    const { ctx, output } = buildCtx(cwd);
    const code = await dispatchSubcommand(["engage", "shadow", "run-local"], ctx);
    assert.equal(typeof code, "boolean"); assert.equal(process.exitCode, 1);
    assert.match(output.stderr.join(""), /--id is required|--issue is required|--repo is required|--pilot-root is required/);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("agentify engage shadow run-local rejects invalid issue numbers", async () => {
  const cwd = tmp();
  try {
    writeShadowConfig(cwd);
    const { ctx, output } = buildCtx(cwd);
    const code = await dispatchSubcommand(["engage", "shadow", "run-local", "--id", "eng", "--issue", "abc", "--repo", "owner/repo", "--pilot-root", cwd, "--non-interactive"], ctx);
    assert.equal(typeof code, "boolean"); assert.equal(process.exitCode, 1);
    assert.match(output.stderr.join(""), /--issue must be a positive integer/);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("agentify engage shadow run-local rejects malformed repo values", async () => {
  const cwd = tmp();
  try {
    writeShadowConfig(cwd);
    const { ctx, output } = buildCtx(cwd);
    const code = await dispatchSubcommand(["engage", "shadow", "run-local", "--id", "eng", "--issue", "1", "--repo", "owner-no-slash", "--pilot-root", cwd, "--non-interactive"], ctx);
    assert.equal(typeof code, "boolean"); assert.equal(process.exitCode, 1);
    assert.match(output.stderr.join(""), /--repo must be of the form owner\/name/);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("agentify engage shadow run-local rejects unknown flags", async () => {
  const cwd = tmp();
  try {
    const { ctx, output } = buildCtx(cwd);
    const code = await dispatchSubcommand(["engage", "shadow", "run-local", "--nope"], ctx);
    assert.equal(typeof code, "boolean"); assert.equal(process.exitCode, 1);
    assert.match(output.stderr.join(""), /unknown flag --nope/);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("agentify engage shadow status-local requires --id and --pilot-root", async () => {
  const cwd = tmp();
  try {
    const { ctx, output } = buildCtx(cwd);
    const code = await dispatchSubcommand(["engage", "shadow", "status-local"], ctx);
    assert.equal(typeof code, "boolean"); assert.equal(process.exitCode, 1);
    assert.match(output.stderr.join(""), /--id is required|--pilot-root is required/);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("agentify engage shadow status-local reports the local workspace state", async () => {
  const cwd = tmp();
  try {
    const { ctx, output } = buildCtx(cwd);
    const code = await dispatchSubcommand(["engage", "shadow", "status-local", "--id", "eng", "--pilot-root", cwd], ctx);
    assert.equal(typeof code, "boolean"); assert.equal(process.exitCode ?? 0, 0);
    assert.match(output.stdout.join(""), /Engagement: eng/);
    assert.match(output.stdout.join(""), /No local workspace yet/);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("agentify CLI --help advertises the local shadow subcommand", () => {
  const bin = path.resolve("./bin/agentify.js");
  if (!fs.existsSync(bin)) return; // skip if the package is not yet built
  const result = execFileSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
  assert.match(result, /agentify engage shadow/);
});