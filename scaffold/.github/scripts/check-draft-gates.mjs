#!/usr/bin/env node
// Trusted deterministic admission gate for the human-approved draft PR mode.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const [repoArg, stateArg, configArg, issueArg, approvalArg, permissionsArg, outputArg] = process.argv.slice(2);
if (!repoArg || !stateArg || !configArg || !issueArg || !approvalArg || !permissionsArg || !outputArg) throw new Error("usage: check-draft-gates.mjs REPO STATE CONFIG ISSUE APPROVAL PERMISSIONS OUTPUT");
const root = fs.realpathSync(repoArg); const state = path.resolve(root, stateArg); const output = path.resolve(outputArg);
const read = (file, label) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error(`${label} is missing or corrupt`); } };
const safeId = (value, label) => { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`${label} is invalid`); return value; };
const inside = (child, parent) => { const relative = path.relative(parent, child); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); };
if (![".agents/agentify", ".claude/agentify", ".pi/agentify"].map((item) => path.resolve(root, item)).some((candidate) => inside(state, candidate))) throw new Error("state directory is outside the supported Agentify roots");
function readState(file, label) {
  const resolved = path.resolve(file); if (!inside(resolved, state)) throw new Error(`${label} escapes Agentify state`);
  let cursor = state; for (const part of path.relative(state, resolved).split(path.sep)) { cursor = path.join(cursor, part); try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`${label} contains a symlink`); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  return read(resolved, label);
}
const config = read(path.resolve(root, configArg), "draft configuration");
if (config.schema_version !== "1" || config.mode !== "draft") throw new Error("draft mode is not enabled");
const engagementId = safeId(config.engagement_id, "engagement ID"); const issueNumber = Number(issueArg);
safeId(config.eval_suite_id, "eval suite ID"); safeId(config.task_id, "eval task ID");
const stateRelative = path.relative(root, state).replaceAll(path.sep, "/");
const configRelative = path.relative(root, path.resolve(root, configArg)).replaceAll(path.sep, "/");
const dirtySource = execFileSync("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map((line) => line.slice(3)).filter((file) => file !== configRelative && file !== ".agentify-runtime" && !file.startsWith(".agentify-runtime/") && file !== stateRelative && !file.startsWith(`${stateRelative}/`));
if (!process.env.DRAFT_BASE_COMMIT && dirtySource.length > 0) throw new Error(`implementation checkout is not clean: ${dirtySource.join(", ")}`);
if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error("issue number is invalid");
if (!Number.isFinite(config.maximum_cost_usd) || config.maximum_cost_usd < 0 || !Number.isInteger(config.maximum_runtime_ms) || config.maximum_runtime_ms < 1) throw new Error("cost/runtime policy is unavailable");
const engagementRoot = path.join(state, "engagements", engagementId);
const charter = readState(path.join(engagementRoot, "charter.json"), "engagement charter");
if (!['shadow', 'draft_pilot'].includes(charter.status)) throw new Error(`engagement lifecycle ${charter.status} is not eligible for draft mode`);
const promotion = readState(path.join(engagementRoot, "promotion-state.json"), "promotion state");
if (promotion.engagement_id !== engagementId || !Array.isArray(promotion.records)) throw new Error("promotion state identity is invalid");
let active = null;
for (const record of promotion.records) { if (record.decision === "approved" && record.candidate_level === "draft") active = record; else if (record.decision === "revoked" || record.decision === "expired") active = null; }
if (!active) throw new Error("no active approved promotion to draft exists");
const now = Date.now(); if ((active.expires_at && Date.parse(active.expires_at) <= now) || (active.review_at && Date.parse(active.review_at) <= now)) throw new Error("draft promotion approval is expired or due for review");
const approval = read(path.resolve(approvalArg), "human run approval");
if (approval.schema_version !== "1" || approval.status !== "approved" || approval.engagement_id !== engagementId || approval.issue_number !== issueNumber || typeof approval.approved_by !== "string" || !approval.approved_by.trim() || /\[bot\]$/i.test(approval.approved_by)) throw new Error("explicit human run approval is invalid");
if (Date.parse(approval.expires_at) <= now) throw new Error("human run approval has expired");
const head = process.env.DRAFT_BASE_COMMIT || execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!/^[0-9a-f]{40}$/.test(approval.expected_base_commit) || approval.expected_base_commit !== head) throw new Error(`base commit moved; expected ${approval.expected_base_commit}, found ${head}`);
if (!Array.isArray(active.evidence_run_ids) || active.evidence_run_ids.length === 0) throw new Error("promotion has no required eval and safety evidence");
for (const runIdValue of active.evidence_run_ids) {
  const runId = safeId(runIdValue, "evidence run ID"); const packet = readState(path.join(state, "shadow", runId, "evidence-packet.json"), `shadow evidence ${runId}`);
  if (packet.engagement_id !== engagementId || packet.readiness?.status !== "ready" || packet.eval?.classification !== "valid_live_shadow_evidence" || packet.repository?.commit_sha !== head || packet.policy?.forbidden_action_attempted !== false) throw new Error(`shadow evidence ${runId} is ineligible or stale`);
  if (!Array.isArray(packet.eval.results) || packet.eval.results.some((result) => result.passed !== true)) throw new Error(`eval or safety evidence ${runId} did not pass`);
}
const risks = readState(path.join(engagementRoot, "risk-register.json"), "risk register");
if (!Array.isArray(risks.risks) || risks.risks.some((risk) => risk.severity === "critical" && !["accepted", "closed", "mitigated"].includes(risk.status))) throw new Error("an unresolved critical risk blocks draft mode");
const permissions = read(path.resolve(permissionsArg), "GitHub permissions");
for (const [name, accepted] of Object.entries({ contents: ["write"], pull_requests: ["write"], issues: ["write"] })) if (!accepted.includes(permissions[name])) throw new Error(`GitHub ${name} permission is insufficient`);
const gate = { schema_version: "1", status: "ready", engagement_id: engagementId, issue_number: issueNumber, base_commit: head, promotion_record_id: active.record_id, evidence_run_ids: active.evidence_run_ids, human_approval: { approved_by: approval.approved_by, approved_at: approval.approved_at, expires_at: approval.expires_at, approval_id: approval.approval_id }, limits: { maximum_cost_usd: config.maximum_cost_usd, maximum_runtime_ms: config.maximum_runtime_ms }, risks: risks.risks.slice(0, 100).map((risk) => ({ risk_id: risk.risk_id, severity: risk.severity, status: risk.status, rollback_or_fallback: risk.rollback_or_fallback })), rollback_level: active.rollback_level, checked_at: new Date().toISOString(), explicit_no_merge_authority: true };
fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, `${JSON.stringify(gate, null, 2)}\n`, { mode: 0o600 }); process.stdout.write(`${JSON.stringify(gate)}\n`);
