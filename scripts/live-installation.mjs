#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export const MODEL_CONFIG = Object.freeze({
  schemaVersion: 1,
  provider: "minimax",
  thinkingLevel: "high",
  models: Object.fromEntries(["primary", "explorer", "lite"].map((role) => [
    role, { provider: "minimax", model: "MiniMax-M3" },
  ])),
});
const SOURCE_ROOT = path.resolve(import.meta.dirname, "..");
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 128 * 1024 * 1024;
const MAX_PROCESS_MS = 33 * 60_000;
const EXECUTION_PATHS = [
  ".github/workflows/agentify-issue.yml", ".github/workflows/agentify-learn.yml",
  ".github/agentify/runtime-loader.mjs", ".github/agentify/task-runtime.mjs",
  ".github/agentify/learning-runtime.mjs", ".github/agentify/validation-smoke.mjs",
  ".github/scripts/complete-accepted-task-merge.mjs", ".github/scripts/publish-task-draft.mjs",
  ".github/scripts/run-task-lifecycle.mjs", ".github/scripts/task-state-github.mjs",
];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function validateTarget(repository, commit) {
  assert.match(repository ?? "", /^anirudhsengar\/[A-Za-z0-9][A-Za-z0-9._-]*$/, "use a maintainer-owned evaluation fork");
  assert.match(commit ?? "", /^[a-f0-9]{40}$/, "target commit must be an immutable full SHA");
  return { repository, commit };
}

export function redactSecrets(text, secrets) {
  let result = text;
  for (const secret of secrets.filter((value) => typeof value === "string" && value.length >= 8)) {
    for (const encoded of [secret, JSON.stringify(secret).slice(1, -1), Buffer.from(secret).toString("base64")]) {
      result = result.split(encoded).join("[REDACTED]");
    }
  }
  return result.replace(/(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{16,}/g, "[REDACTED]");
}

function command(program, args, cwd, env = process.env) {
  const result = spawnSync(program, args, { cwd, env, encoding: "utf8", timeout: 10 * 60_000, maxBuffer: MAX_OUTPUT_BYTES, shell: false });
  assert.equal(result.status, 0, `${program} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

export function readEvidenceFile(file, maximum = MAX_OUTPUT_BYTES) {
  assert.ok(Number.isSafeInteger(maximum) && maximum >= 0, "invalid evidence size limit");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    assert.ok(stat.isFile(), "evidence must be a regular file");
    assert.ok(stat.size <= maximum, "evidence size limit exceeded");
    const chunks = [];
    let size = 0;
    while (size <= maximum) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maximum + 1 - size));
      const length = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (length === 0) break;
      size += length;
      assert.ok(size <= maximum, "evidence size limit exceeded");
      chunks.push(chunk.subarray(0, length));
    }
    const after = fs.fstatSync(descriptor);
    assert.ok(after.size === size && after.size === stat.size && after.mtimeMs === stat.mtimeMs,
      "evidence changed during descriptor read");
    return { bytes: Buffer.concat(chunks), mode: stat.mode & 0o777 };
  } finally {
    fs.closeSync(descriptor);
  }
}

function snapshot(target) {
  return Object.fromEntries(command("git", ["ls-files", "-z"], target).split("\0").filter(Boolean).map((file) => {
    const absolute = path.join(target, file);
    try {
      const record = readEvidenceFile(absolute);
      return [file, { kind: "file", mode: record.mode, digest: sha256(record.bytes) }];
    } catch (error) {
      if (error.code === "ENOENT") return [file, { kind: "missing" }];
      if (error.code !== "ELOOP") throw error;
      return [file, { kind: "symlink", digest: sha256(fs.readlinkSync(absolute)) }];
    }
  }));
}

export function assessInstallation({ exitCode, signal, terminalEvents, budget, sourceUnchanged, manifest, specialists, policy, executionPaths, observedModel }) {
  const failures = [];
  if (exitCode !== 0 || signal) failures.push("installer process did not exit successfully");
  if (terminalEvents.length !== 1 || terminalEvents[0]?.status !== "success" || terminalEvents[0]?.exit_code !== 0) failures.push("expected exactly one successful terminal event");
  if (!(budget?.usage?.model_calls > 0)) failures.push("no accounted live model request");
  if (observedModel !== "MiniMax-M3" && observedModel !== "minimax/MiniMax-M3") failures.push("requested MiniMax M3 was not recorded");
  if (!sourceUnchanged) failures.push("original tracked files changed");
  if (!manifest || specialists < 1) failures.push("no persistent specialist team installed");
  if (!policy || typeof policy.configured !== "boolean") failures.push("missing installation policy");
  if (policy?.configured === false && (policy.policy !== null || executionPaths.length > 0)) failures.push("analysis-ready installation retained execution authority");
  return { passed: failures.length === 0, failures, readiness: policy?.configured === true ? "operational" : policy?.configured === false ? "analysis-ready" : "none" };
}

function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function readJson(file) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null; }
function filesUnder(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(file));
    else if (entry.isFile()) result.push(file);
    else throw new Error("refusing symlink or non-regular evidence");
  }
  return result;
}

async function runInstaller(bin, target, environment) {
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin], { cwd: target, env: environment, stdio: ["ignore", "pipe", "pipe"], detached: true, shell: false });
    const chunks = { stdout: [], stderr: [] };
    let bytes = 0;
    let interrupted = null;
    let escalation;
    const terminate = (reason) => {
      if (interrupted) return;
      interrupted = reason;
      try { process.kill(-child.pid, "SIGINT"); } catch { /* Already exited. */ }
      escalation = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } }, 10_000);
    };
    const timer = setTimeout(() => terminate("external process deadline"), MAX_PROCESS_MS);
    const onInterrupt = () => terminate("workflow cancellation");
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);
    for (const stream of ["stdout", "stderr"]) child[stream].on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes <= MAX_OUTPUT_BYTES) chunks[stream].push(chunk);
      else terminate("process output limit");
    });
    const cleanup = () => {
      clearTimeout(timer); clearTimeout(escalation);
      process.removeListener("SIGINT", onInterrupt); process.removeListener("SIGTERM", onInterrupt);
    };
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("close", (code, signal) => {
      cleanup();
      resolve({ exit_code: code, signal, interrupted, elapsed_ms: Date.now() - started,
        stdout: Buffer.concat(chunks.stdout).toString("utf8"), stderr: Buffer.concat(chunks.stderr).toString("utf8") });
    });
  });
}

async function prepare(root) {
  const selected = validateTarget(process.env.LIVE_REPOSITORY, process.env.LIVE_TARGET_SHA);
  assert.ok(!process.env.PI_API_KEY && !process.env.MINIMAX_API_KEY, "prepare must run without model credentials");
  fs.mkdirSync(root, { recursive: false });
  for (const dir of ["evidence", "home/.agentify", "install", "target"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const packed = readJson(process.env.LIVE_PACK_RESULT);
  assert.equal(packed?.name, "@anirudhsengar/agentify");
  assert.match(packed.filename, /^anirudhsengar-agentify-[A-Za-z0-9.-]+\.tgz$/);
  const tarball = path.join(SOURCE_ROOT, packed.filename);
  assert.equal(sha256(fs.readFileSync(tarball)), packed.sha256, "package hash mismatch");
  const distribution = path.join(root, "agentify.tgz");
  fs.copyFileSync(tarball, distribution);
  command("npm", ["install", "--prefix", path.join(root, "install"), "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", distribution], root);
  const target = path.join(root, "target");
  command("git", ["init", "-q"], target);
  command("git", ["remote", "add", "origin", `https://github.com/${selected.repository}.git`], target);
  command("git", ["fetch", "--depth=1", "origin", selected.commit], target);
  command("git", ["checkout", "-q", "--detach", "FETCH_HEAD"], target);
  assert.equal(command("git", ["rev-parse", "HEAD"], target), selected.commit);
  assert.equal(command("git", ["status", "--porcelain"], target), "");
  assert.equal(fs.existsSync(path.join(target, ".agentify")), false, "qualification requires a fresh target without prior evidence");
  writeJson(path.join(root, "before.json"), snapshot(target));
  writeJson(path.join(root, "home/.agentify/config.json"), MODEL_CONFIG);
  writeJson(path.join(root, "evidence/provenance.json"), {
    schema_version: 1, candidate_sha: command("git", ["rev-parse", "HEAD"], SOURCE_ROOT),
    target: selected, package_sha256: packed.sha256, package_version: packed.version,
    node: process.version, npm: command("npm", ["--version"], root), model_config: MODEL_CONFIG,
    github_run_id: process.env.GITHUB_RUN_ID ?? null, github_run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    production_budget_overrides: false, fresh: true,
    github_authority: "read-only Actions token; no replayed GitHub responses or permission overrides",
    prepared_at: new Date().toISOString(), release_ready: false,
  });
  console.log(`Prepared ${selected.repository}@${selected.commit}; package ${packed.sha256}`);
}

async function live(root) {
  assert.ok(process.env.PI_API_KEY?.trim(), "PI_API_KEY GitHub Actions secret is missing");
  const secrets = [process.env.PI_API_KEY, process.env.GH_TOKEN, process.env.GITHUB_TOKEN];
  const clean = (text) => redactSecrets(text, secrets);
  const evidence = path.join(root, "evidence");
  const target = path.join(root, "target");
  const home = path.join(root, "home");
  assert.deepEqual(readJson(path.join(home, ".agentify/config.json")), MODEL_CONFIG);
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"), MINIMAX_API_KEY: process.env.PI_API_KEY, CI: "1", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" };
  delete env.PI_API_KEY;
  const bin = path.join(root, "install/node_modules/@anirudhsengar/agentify/bin/agentify.js");
  const result = await runInstaller(bin, target, env);
  fs.writeFileSync(path.join(evidence, "stdout.txt"), clean(result.stdout));
  fs.writeFileSync(path.join(evidence, "stderr.txt"), clean(result.stderr));
  let total = 0;
  const copyText = (source, destination) => {
    const record = readEvidenceFile(source);
    total += record.bytes.length;
    assert.ok(total <= MAX_EVIDENCE_BYTES, "evidence size limit exceeded");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, clean(record.bytes.toString("utf8")));
  };
  for (const [directory, prefix] of [[path.join(home, ".agentify/logs"), "logs"], [path.join(target, ".agentify"), "installed-team"]]) {
    for (const file of filesUnder(directory)) {
      if (/\.(?:json|jsonl|md|txt)$/.test(file)) copyText(file, path.join(evidence, prefix, path.relative(directory, file)));
    }
  }
  for (const file of ["AGENTS.md", "SETUP.md", ".github/agentify-task-policy.json"]) {
    if (fs.existsSync(path.join(target, file))) copyText(path.join(target, file), path.join(evidence, "controls", file));
  }
  const logFiles = filesUnder(path.join(evidence, "logs/agentify")).filter((file) => file.endsWith(".jsonl"));
  const events = logFiles.flatMap((file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)));
  const terminals = events.filter((event) => event.event === "agentify.run_end").map((event) => event.payload);
  const budget = events.filter((event) => event.event === "agentify.audit_budget").at(-1)?.payload ?? null;
  const model = events.find((event) => event.event === "agentify.run_start")?.payload?.model ?? null;
  const before = readJson(path.join(root, "before.json"));
  const after = snapshot(target);
  const changed = Object.keys(before).filter((file) => JSON.stringify(before[file]) !== JSON.stringify(after[file]));
  const specialistFiles = filesUnder(path.join(target, ".agentify/agents/specialists")).filter((file) => file.endsWith(".json"));
  const policy = readJson(path.join(target, ".github/agentify-task-policy.json"));
  const assessment = assessInstallation({ exitCode: result.exit_code, signal: result.signal,
    terminalEvents: terminals, budget, sourceUnchanged: changed.length === 0,
    manifest: readJson(path.join(target, ".agentify/manifest.json")), specialists: specialistFiles.length,
    policy, executionPaths: EXECUTION_PATHS.filter((file) => fs.existsSync(path.join(target, file))), observedModel: model });
  const report = { ...readJson(path.join(evidence, "provenance.json")), ...assessment,
    completed_at: new Date().toISOString(), elapsed_ms: result.elapsed_ms, exit_code: result.exit_code,
    signal: result.signal, interruption: result.interrupted, terminal_events: terminals,
    audit_budget: budget, observed_model: model, specialist_count: specialistFiles.length,
    changed_original_paths: changed, git_status: command("git", ["status", "--porcelain"], target),
    readiness_blockers: [...`${result.stdout}\n${result.stderr}`.matchAll(/Blocker \[([^\]]+)\]:?[^\n]*/gi)].map((match) => match[0]),
    installed_team_review: "not performed", release_ready: false };
  const serialized = clean(JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(evidence, "report.json"), `${serialized}\n`);
  console.log(serialized);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## Live installation\n\nCandidate: \`${report.candidate_sha}\`\n\nTarget: \`${report.target.repository}@${report.target.commit}\`\n\nModel: MiniMax M3. Fresh installed npm artifact.\n\nResult: **${assessment.passed ? "PASS" : "FAIL"}**; readiness: ${assessment.readiness}; specialists: ${specialistFiles.length}.\n\nRelease-ready: **no**. This run does not replace the matrix, manual review, or cancellation gates.\n`);
  if (!assessment.passed) process.exitCode = 1;
}

export async function main(args = process.argv.slice(2)) {
  const root = process.env.LIVE_WORK_DIR;
  assert.ok(root && path.isAbsolute(root), "LIVE_WORK_DIR must be an absolute disposable directory");
  if (args[0] === "prepare" && args.length === 1) await prepare(root);
  else if (args[0] === "run" && args.length === 1) await live(root);
  else throw new Error("usage: live-installation.mjs prepare|run");
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(redactSecrets(error instanceof Error ? error.message : String(error), [process.env.PI_API_KEY, process.env.GH_TOKEN, process.env.GITHUB_TOKEN]));
    process.exitCode = 1;
  });
}
