#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
const [repoArg, gateArg, validationArg, planArg, issueArg, branchArg, outputArg] = process.argv.slice(2);
if (!repoArg || !gateArg || !validationArg || !planArg || !issueArg || !branchArg || !outputArg) throw new Error("usage: build-draft-evidence.mjs REPO GATE VALIDATION PLAN ISSUE BRANCH OUTPUT");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8")); const root = fs.realpathSync(repoArg); const gate = read(gateArg); const validation = read(validationArg);
if (!validation.publication_allowed) throw new Error("validation policy blocks draft publication");
const redact = (value) => String(value).slice(0, 12000).replace(/(gh[psoru]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:sk|key|token|secret)[-_][A-Za-z0-9_-]{16,})/gi, "[REDACTED]");
const diffSummary = execFileSync("git", ["-C", root, "diff", "--stat", `${gate.base_commit}...HEAD`], { encoding: "utf8" }).slice(0, 8000);
const packet = { schema_version: "1", engagement_id: gate.engagement_id, issue_number: Number(issueArg), base_commit: gate.base_commit, implementation_branch: branchArg, approved_plan: redact(fs.readFileSync(planArg, "utf8")), files_changed: validation.files_changed, diff_summary: redact(diffSummary), validation_results: validation, eval_results: gate.evidence_run_ids, cost_usd: validation.cost_usd, cost_source: validation.cost_source, runtime_ms: validation.runtime_ms, retries: validation.retries, human_approval: gate.human_approval, risks: gate.risks ?? [], uncertainties: validation.failed_draft_policy_used ? ["A human-approved failed-draft publication policy was used."] : [], escalations: validation.passed ? [] : ["Validation did not pass; human review is mandatory."], rollback_instructions: `Close the draft PR and delete branch ${branchArg}; promotion rollback level is ${gate.rollback_level}.`, publication_status: "draft_unmerged", explicit_statement: "This pull request is a draft and is unmerged. Agentify never merges it automatically.", traces_included: false };
fs.writeFileSync(outputArg, `${JSON.stringify(packet, null, 2)}\n`, { mode: 0o600 });
