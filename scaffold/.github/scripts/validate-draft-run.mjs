#!/usr/bin/env node
// Executes only argv-vector checks configured on the trusted default branch.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
const [repoArg, baseArg, configArg, usageArg, outputArg] = process.argv.slice(2);
if (!repoArg || !baseArg || !configArg || !usageArg || !outputArg) throw new Error("usage: validate-draft-run.mjs REPO BASE CONFIG USAGE OUTPUT");
const root = fs.realpathSync(repoArg); const read = (file, label) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error(`${label} is missing or corrupt`); } };
const config = read(path.resolve(root, configArg), "draft configuration"); const usage = read(path.resolve(usageArg), "measured usage");
if (config.mode !== "draft" || !Array.isArray(config.validation_checks) || config.validation_checks.length === 0) throw new Error("structured validation policy is unavailable");
if (!Number.isFinite(usage.cost_usd) || usage.cost_usd < 0 || !Number.isInteger(usage.runtime_ms) || usage.runtime_ms < 0) throw new Error("measured cost/runtime is invalid");
const base = execFileSync("git", ["-C", root, "rev-parse", baseArg], { encoding: "utf8" }).trim(); const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const changed = execFileSync("git", ["-C", root, "diff", "--name-only", `${base}...${head}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean).sort();
const forbidden = Array.isArray(config.forbidden_paths) ? config.forbidden_paths : [".github/workflows", ".git", ".agentify"];
const forbiddenChanges = changed.filter((file) => forbidden.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)));
const dependencyFiles = new Set(["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "requirements.txt", "pyproject.toml", "poetry.lock", "go.mod", "go.sum", "Cargo.toml", "Cargo.lock"]);
const dependencyChanges = changed.filter((file) => dependencyFiles.has(file) || [...dependencyFiles].some((name) => file.endsWith(`/${name}`)));
const allowDependencies = config.allow_dependency_changes === true;
const checks = [];
const requiredKinds = ["build", "tests", "typecheck", "lint", "security"];
for (const check of config.validation_checks) {
  if (!check || typeof check.name !== "string" || !["build", "tests", "typecheck", "lint", "security"].includes(check.kind) || !Array.isArray(check.argv) || check.argv.length === 0 || check.argv.some((arg) => typeof arg !== "string" || !arg || /[\r\n\0]/.test(arg))) throw new Error("validation check configuration is invalid");
  const started = Date.now(); const result = spawnSync(check.argv[0], check.argv.slice(1), { cwd: root, encoding: "utf8", timeout: Number(check.timeout_ms ?? 600000), env: { ...process.env, GH_TOKEN: undefined, GITHUB_TOKEN: undefined, AGENT_PAT: undefined } });
  checks.push({ name: check.name.slice(0, 120), kind: check.kind, status: result.error?.code === "ETIMEDOUT" ? "timeout" : result.status === 0 ? "passed" : "failed", exit_code: result.status, runtime_ms: Date.now() - started, output_tail: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.slice(-2000).replace(/(gh[psoru]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/gi, "[REDACTED]") });
}
for (const kind of requiredKinds) if (!checks.some((check) => check.kind === kind)) checks.push({ name: `${kind} policy`, kind, status: "missing", exit_code: null, runtime_ms: 0, output_tail: "Required structured check is not configured." });
const configuredState = path.resolve(root, config.state_dir ?? ".agents/agentify"); const allowedStateRoots = [".agents/agentify", ".claude/agentify", ".pi/agentify"].map((item) => path.resolve(root, item));
if (!allowedStateRoots.includes(configuredState)) throw new Error("validation state directory is outside supported Agentify roots");
const manifestPath = path.join(configuredState, "manifest.json"); const manifest = fs.existsSync(manifestPath) ? read(manifestPath, "managed manifest") : { files: [] };
const managed = new Set(Array.isArray(manifest.files) ? manifest.files.map((entry) => typeof entry === "string" ? entry : entry.path).filter(Boolean) : []);
const generatedOwnershipFailures = changed.filter((file) => /^(?:\.agents|\.claude|\.codex|\.pi)\//.test(file) && !managed.has(file));
const policyChecks = { forbidden_paths: forbiddenChanges.length === 0, dependency_changes: allowDependencies || dependencyChanges.length === 0, generated_file_ownership: generatedOwnershipFailures.length === 0, diff_nonempty: changed.length > 0, cost: usage.cost_usd <= Number(config.maximum_cost_usd), runtime: usage.runtime_ms <= Number(config.maximum_runtime_ms) };
const passed = checks.every((check) => check.status === "passed") && Object.values(policyChecks).every(Boolean);
const report = { schema_version: "1", base_commit: base, head_commit: head, files_changed: changed, validation_results: checks, diff_policy: policyChecks, forbidden_path_changes: forbiddenChanges, dependency_changes: dependencyChanges, generated_ownership_failures: generatedOwnershipFailures, cost_usd: usage.cost_usd, cost_source: typeof usage.cost_source === "string" ? usage.cost_source : "measured", runtime_ms: usage.runtime_ms, retries: Number.isInteger(usage.retries) ? usage.retries : 0, passed, publication_allowed: passed || config.allow_failed_draft === true, failed_draft_policy_used: !passed && config.allow_failed_draft === true };
fs.writeFileSync(path.resolve(outputArg), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); if (!report.publication_allowed) process.exitCode = 1;
