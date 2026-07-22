import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Writable } from "node:stream";
import { engageCommand, printEngageHelp } from "../../src/core/engagement/cli.ts";
import { engagementArtifactPath } from "../../src/core/engagement/index.ts";
import type { AgentifyUi } from "../../src/core/types.ts";

class Capture extends Writable { value = ""; _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void { this.value += chunk.toString(); callback(); } }
const ui: AgentifyUi = { status() {}, info() {}, error() {}, async promptSelect(_m, choices) { return choices[0]!.value; }, async promptMultiSelect() { return []; }, async promptCheckboxList() { return []; }, async promptSecret() { return ""; }, async promptText() { return ""; } };
function repo(): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-engage-cli-")); fs.mkdirSync(path.join(root, ".git")); return root; }
function charterInput(root: string): object { return { repository: { root, remote: null }, workflow_name: "Invoice Review", workflow_owner: "Ops", intended_users: ["analyst"], systems_involved: ["ledger"], problem_statement: "Reviews are slow.", workflow_frequency: "daily", baseline_metrics: [{ name: "cycle", unit: "minutes", value: 20 }], desired_primary_outcome: "Reduce cycle time", target: { direction: "decrease", value: 10, unit: "minutes" }, guardrail_metrics: [], forbidden_actions: [], requires_human_approval: true, business_owner: "Finance", technical_owner: "Platform", evidence_references: ["ticket:1"] }; }
async function run(root: string, argv: string[]): Promise<{ code: number; out: string; err: string }> { const out = new Capture(); const err = new Capture(); const code = await engageCommand(argv, { cwd: root, configDir: path.join(root, "config"), ui, out, err, stdinIsTTY: false }); return { code, out: out.value, err: err.value }; }
function write(root: string, name: Parameters<typeof engagementArtifactPath>[2], value: unknown): void { const target = engagementArtifactPath(path.join(root, ".claude", "agentify"), "invoice-review", name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`); }

test("engage help and unknown action are concise", async () => {
  const out = new Capture(); printEngageHelp(out); assert.match(out.value, /engage init/); assert.match(out.value, /Examples:/);
  const root = repo(); try { const result = await run(root, ["unknown"]); assert.equal(result.code, 1); assert.match(result.err, /Valid: init, status, validate, report/); } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("engage init requires a repository and creates deterministic state without overwrite", async () => {
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-engage-no-repo-"));
  try { const file = path.join(missing, "input.json"); fs.writeFileSync(file, JSON.stringify(charterInput(missing))); const result = await run(missing, ["init", "--input", file, "--yes"]); assert.equal(result.code, 1); assert.match(result.err, /requires a Git repository/); } finally { fs.rmSync(missing, { recursive: true, force: true }); }
  const root = repo(); try {
    const file = path.join(root, "input.json"); fs.writeFileSync(file, JSON.stringify(charterInput(root)));
    const created = await run(root, ["init", "--input", file, "--yes"]); assert.equal(created.code, 0); assert.match(created.out, /Created engagement invoice-review/);
    assert.ok(fs.existsSync(path.join(root, ".claude", "agentify", "engagements", "invoice-review", "charter.json")));
    const duplicate = await run(root, ["init", "--input", file, "--yes"]); assert.equal(duplicate.code, 1); assert.match(duplicate.err, /already exists/);
    const invalid = await run(root, ["init", "--input", file, "--id", "..", "--yes"]); assert.equal(invalid.code, 1); assert.match(invalid.err, /engagement ID/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("status is human-readable, tolerates incomplete drafts, and requires selection", async () => {
  const root = repo(); try {
    const file = path.join(root, "input.json"); fs.writeFileSync(file, JSON.stringify(charterInput(root))); await run(root, ["init", "--input", file, "--yes"]);
    const status = await run(root, ["status"]); assert.equal(status.code, 0); assert.match(status.out, /Lifecycle: draft/); assert.match(status.out, /Qualification: missing/); assert.match(status.out, /Missing artifacts:/);
    await run(root, ["init", "--input", file, "--id", "second", "--yes"]); const multiple = await run(root, ["status"]); assert.equal(multiple.code, 1); assert.match(multiple.err, /select one with --id/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("validate checks cross-file references and corrupt state", async () => {
  const root = repo(); try {
    const file = path.join(root, "input.json"); fs.writeFileSync(file, JSON.stringify(charterInput(root))); await run(root, ["init", "--input", file, "--yes"]);
    const person = { stakeholder_id: "owner", name: "Owner", roles: ["workflow_owner"], decision_rights: [], escalation_contact: true, goals: [], concerns: [] };
    write(root, "stakeholders.json", { schema_version: "1", engagement_id: "invoice-review", stakeholders: [person], workflow_owner_id: "owner", adoption_owner_id: "owner" });
    const step = { step_id: "review", name: "Review", actors: ["owner"], systems: ["ledger"], data_sources: ["ledger"], inputs: [], outputs: [], decisions: [], handoff_to_step_ids: [], approvals: [], waiting_period_minutes: 0, exceptions: [], workarounds: [], failure_modes: [], evidence: ["ticket:1"] };
    const map = { schema_version: "1", engagement_id: "invoice-review", workflow_id: "invoice", name: "Invoice", trigger: "arrival", actors: ["owner"], systems: ["ledger"], data_sources: ["ledger"], steps: [step], source_of_truth_system: "ledger", evidence: ["ticket:1"], baseline_metrics: [] };
    write(root, "current-workflow.json", { ...map, variant: "current" }); write(root, "target-workflow.json", { ...map, variant: "target" });
    write(root, "opportunity-matrix.json", { schema_version: "1", engagement_id: "invoice-review", opportunities: [] });
    write(root, "automation-decisions.json", { schema_version: "1", engagement_id: "invoice-review", decisions: [] });
    write(root, "risk-register.json", { schema_version: "1", engagement_id: "invoice-review", risks: [] });
    write(root, "qualification.json", { schema_version: "1", engagement_id: "invoice-review", status: "qualified", reasons: [] });
    assert.equal((await run(root, ["validate"])).code, 0);
    write(root, "current-workflow.json", { ...map, variant: "current", steps: [{ ...step, handoff_to_step_ids: ["missing"] }] });
    const invalid = await run(root, ["validate"]); assert.equal(invalid.code, 1); assert.match(invalid.err, /missing handoff step/);
    fs.writeFileSync(path.join(root, ".claude", "agentify", "engagements", "invoice-review", "charter.json"), "{broken");
    const corrupt = await run(root, ["status"]); assert.equal(corrupt.code, 1); assert.match(corrupt.err, /invalid JSON|malformed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("report is deterministic and does not fabricate ROI or deployment", async () => {
  const root = repo(); try {
    const file = path.join(root, "input.json"); fs.writeFileSync(file, JSON.stringify(charterInput(root))); await run(root, ["init", "--input", file, "--yes"]);
    const person = { stakeholder_id: "owner", name: "Owner", roles: ["workflow_owner"], decision_rights: [], escalation_contact: true, goals: [], concerns: [] };
    write(root, "stakeholders.json", { schema_version: "1", engagement_id: "invoice-review", stakeholders: [person], workflow_owner_id: "owner", adoption_owner_id: "owner" });
    const step = { step_id: "review", name: "Review", actors: ["owner"], systems: [], data_sources: [], inputs: [], outputs: [], decisions: [], handoff_to_step_ids: [], approvals: [], waiting_period_minutes: 0, exceptions: [], workarounds: [], failure_modes: [], evidence: [] };
    const map = { schema_version: "1", engagement_id: "invoice-review", workflow_id: "invoice", name: "Invoice", trigger: "arrival", actors: ["owner"], systems: [], data_sources: [], steps: [step], source_of_truth_system: "ledger", evidence: [], baseline_metrics: [] };
    write(root, "current-workflow.json", { ...map, variant: "current" }); write(root, "target-workflow.json", { ...map, variant: "target" }); write(root, "opportunity-matrix.json", { schema_version: "1", engagement_id: "invoice-review", opportunities: [] }); write(root, "automation-decisions.json", { schema_version: "1", engagement_id: "invoice-review", decisions: [] }); write(root, "risk-register.json", { schema_version: "1", engagement_id: "invoice-review", risks: [] }); write(root, "qualification.json", { schema_version: "1", engagement_id: "invoice-review", status: "qualified", reasons: [] });
    const first = await run(root, ["report", "--stdout"]); const second = await run(root, ["report", "--stdout"]); assert.equal(first.code, 0); assert.equal(first.out.replace(/^Report:.*\n/, ""), second.out.replace(/^Report:.*\n/, "")); assert.match(first.out, /ROI: not supplied/); assert.match(first.out, /Implementation\/deployment: not claimed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
