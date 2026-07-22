import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Value } from "typebox/value";
import { loadAgentifyConfig } from "../agentify-config.ts";
import { discoverExistingStateDir, resolveStateDir } from "../state-dir.ts";
import type { AgentifyUi } from "../types.ts";
import { readEngagementArtifact } from "./artifacts.ts";
import { EngagementError } from "./errors.ts";
import { engagementArtifactPath, engagementReportPath } from "./paths.ts";
import { renderEngagementReport } from "./report.ts";
import { validateAutomationDecisionRegister, validateOpportunityMatrix, validateStakeholderRegister } from "./registers.ts";
import { AutomationDecisionRegisterSchema, type AutomationDecisionRegister } from "./schema/automation-decision.ts";
import { EngagementCharterSchema, type EngagementCharter } from "./schema/engagement-charter.ts";
import { OpportunityMatrixSchema, type OpportunityMatrix } from "./schema/opportunity.ts";
import { QualificationResultSchema, type QualificationResult } from "./schema/qualification.ts";
import { RiskRegisterSchema, type RiskRegister } from "./schema/risk-register.ts";
import { StakeholderRegisterSchema, type StakeholderRegister } from "./schema/stakeholders.ts";
import { WorkflowMapSchema, type WorkflowMap } from "./schema/workflow-map.ts";
import { createEngagement, listEngagements, readEngagement, type CreateEngagementInput } from "./state.ts";
import { validateRiskRegister } from "./risk-register.ts";
import { validateWorkflowMap } from "./workflow-map.ts";

export interface EngageCommandContext {
  cwd: string; configDir: string; ui: AgentifyUi;
  out: NodeJS.WritableStream; err: NodeJS.WritableStream; stdinIsTTY?: boolean;
}
interface Flags { id?: string; input?: string; yes: boolean; stdout: boolean; positionals: string[]; errors: string[] }
const ARTIFACTS = ["stakeholders.json", "current-workflow.json", "target-workflow.json", "opportunity-matrix.json", "automation-decisions.json", "risk-register.json", "qualification.json"] as const;

function parse(argv: readonly string[]): Flags {
  const result: Flags = { yes: false, stdout: false, positionals: [], errors: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--yes") result.yes = true;
    else if (token === "--stdout") result.stdout = true;
    else if (token === "--id" || token === "--input") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) result.errors.push(`${token} requires a value`);
      else { if (token === "--id") result.id = value; else result.input = value; index += 1; }
    } else if (token.startsWith("--")) result.errors.push(`unknown flag ${token}`);
    else result.positionals.push(token);
  }
  return result;
}

function hasGitRepository(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, ".git"));
}

function resolveEngagementStateDir(ctx: EngageCommandContext): string {
  if (!hasGitRepository(ctx.cwd)) throw new Error("engage requires a Git repository");
  const discovered = discoverExistingStateDir(ctx.cwd);
  if (discovered) return path.join(ctx.cwd, discovered.relativeDir);
  const configured = loadAgentifyConfig(ctx.configDir).targets ?? ["claude", "codex", "pi"];
  return path.join(ctx.cwd, resolveStateDir(configured).relativeDir);
}

function slug(value: string): string {
  const normalized = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 128);
  if (!normalized) throw new EngagementError("invalid_id", "workflow name cannot produce a deterministic engagement ID; supply --id");
  return normalized;
}

function parseList(value: string): string[] { return value.split(",").map((item) => item.trim()).filter(Boolean); }
function numberValue(value: string, label: string): number {
  const parsed = Number(value); if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number`); return parsed;
}

async function promptInput(ctx: EngageCommandContext): Promise<CreateEngagementInput> {
  if (!ctx.ui.promptText) throw new Error("the selected UI does not support engagement text input; use --input <json>");
  const ask = (message: string): Promise<string> => ctx.ui.promptText!(message);
  const workflowName = await ask("Workflow name");
  const workflowOwner = await ask("Workflow owner");
  const problemStatement = await ask("Problem statement");
  const metricName = await ask("Observed baseline metric name");
  const metricUnit = await ask("Observed baseline metric unit");
  const metricValue = numberValue(await ask("Observed baseline metric value"), "baseline metric value");
  const direction = await ctx.ui.promptSelect("Target direction", [
    { label: "Increase", value: "increase" }, { label: "Decrease", value: "decrease" }, { label: "Maintain", value: "maintain" },
  ]) as "increase" | "decrease" | "maintain";
  return {
    repository: { root: ctx.cwd, remote: null }, workflow_name: workflowName, workflow_owner: workflowOwner,
    intended_users: parseList(await ask("Intended users (comma-separated)")), systems_involved: parseList(await ask("Systems involved (comma-separated)")),
    problem_statement: problemStatement, workflow_frequency: await ask("Workflow frequency"),
    baseline_metrics: [{ name: metricName, unit: metricUnit, value: metricValue }], desired_primary_outcome: await ask("Desired primary outcome"),
    target: { direction, value: numberValue(await ask("Target value"), "target value"), unit: await ask("Target unit") },
    guardrail_metrics: [], forbidden_actions: [], requires_human_approval: true,
    business_owner: await ask("Business owner"), technical_owner: await ask("Technical owner"), evidence_references: [],
  };
}

function readInputFile(cwd: string, inputPath: string): CreateEngagementInput {
  const absolute = path.resolve(cwd, inputPath);
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(absolute, "utf-8")); }
  catch (error) { throw new Error(`cannot read engagement input ${inputPath}: ${error instanceof Error ? error.message : String(error)}`); }
  const synthetic = { ...parsed as object, schema_version: "1", revision: 1, engagement_id: "validation", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", status: "draft", stop_reason: null };
  if (!Value.Check(EngagementCharterSchema, synthetic)) throw new Error(`engagement input ${inputPath} does not satisfy the charter fields`);
  const { schema_version: _schema, revision: _revision, engagement_id: _id, created_at: _created, updated_at: _updated, status: _status, stop_reason: _stop, ...input } = synthetic;
  return input;
}

async function selectEngagement(ctx: EngageCommandContext, stateDir: string, id?: string): Promise<EngagementCharter> {
  if (id) return readEngagement(stateDir, id);
  const engagements = listEngagements(stateDir);
  if (engagements.length === 0) throw new EngagementError("not_found", "no engagements exist; run `agentify engage init`");
  if (engagements.length === 1) return engagements[0]!;
  if (!(ctx.stdinIsTTY ?? process.stdin.isTTY)) throw new Error("multiple engagements exist; select one with --id <engagement-id>");
  const selected = await ctx.ui.promptSelect("Select an engagement", engagements.map((item) => ({ label: `${item.engagement_id} — ${item.workflow_name}`, value: item.engagement_id })));
  return readEngagement(stateDir, selected);
}

function missingArtifacts(stateDir: string, id: string): string[] {
  return ARTIFACTS.filter((name) => !fs.existsSync(engagementArtifactPath(stateDir, id, name)));
}

async function initCommand(argv: readonly string[], ctx: EngageCommandContext): Promise<number> {
  const flags = parse(argv); if (flags.errors.length || flags.positionals.length) return usageError(ctx, "init", flags.errors[0] ?? `unexpected argument: ${flags.positionals[0]}`);
  const interactive = ctx.stdinIsTTY ?? process.stdin.isTTY;
  if (!flags.input && !interactive) return usageError(ctx, "init", "non-interactive use requires --input <json>");
  const input = flags.input ? readInputFile(ctx.cwd, flags.input) : await promptInput(ctx);
  const id = flags.id ?? slug(input.workflow_name);
  const stateDir = resolveEngagementStateDir(ctx);
  if (interactive && !flags.yes) {
    ctx.out.write(`Engagement ${id}\nState: ${path.join(stateDir, "engagements", id)}\nWorkflow: ${input.workflow_name}\nOwner: ${input.workflow_owner}\n`);
    const choice = await ctx.ui.promptSelect("Create this draft engagement?", [{ label: "Create", value: "yes" }, { label: "Cancel", value: "no" }]);
    if (choice !== "yes") { ctx.out.write("Engagement creation cancelled.\n"); return 0; }
  }
  const charter = createEngagement(stateDir, id, input);
  ctx.out.write(`Created engagement ${charter.engagement_id}\nState: ${path.dirname(engagementArtifactPath(stateDir, id, "charter.json"))}\n`);
  return 0;
}

function qualificationText(stateDir: string, id: string): string {
  try { return readEngagementArtifact<QualificationResult>(stateDir, id, "qualification.json", QualificationResultSchema).status; }
  catch (error) { if (error instanceof EngagementError && error.code === "not_found") return "missing"; throw error; }
}

async function statusCommand(argv: readonly string[], ctx: EngageCommandContext): Promise<number> {
  const flags = parse(argv); if (flags.errors.length || flags.positionals.length || flags.input || flags.yes || flags.stdout) return usageError(ctx, "status", flags.errors[0] ?? "unsupported option or argument");
  const stateDir = resolveEngagementStateDir(ctx); const charter = await selectEngagement(ctx, stateDir, flags.id); const missing = missingArtifacts(stateDir, charter.engagement_id);
  ctx.out.write(`Engagement: ${charter.engagement_id}\nWorkflow: ${charter.workflow_name}\nLifecycle: ${charter.status}\nQualification: ${qualificationText(stateDir, charter.engagement_id)}\nRevision: ${charter.revision}\nLatest update: ${charter.updated_at}\nAutonomy: not recorded\nMissing artifacts: ${missing.join(", ") || "none"}\n`);
  return 0;
}

interface LoadedArtifacts { stakeholders: StakeholderRegister; current: WorkflowMap; target: WorkflowMap; opportunities: OpportunityMatrix; decisions: AutomationDecisionRegister; risks: RiskRegister; qualification: QualificationResult }
function loadAndValidate(stateDir: string, charter: EngagementCharter): LoadedArtifacts {
  const id = charter.engagement_id;
  const stakeholders = validateStakeholderRegister(readEngagementArtifact<StakeholderRegister>(stateDir, id, "stakeholders.json", StakeholderRegisterSchema));
  const current = validateWorkflowMap(readEngagementArtifact<WorkflowMap>(stateDir, id, "current-workflow.json", WorkflowMapSchema));
  const target = validateWorkflowMap(readEngagementArtifact<WorkflowMap>(stateDir, id, "target-workflow.json", WorkflowMapSchema));
  if (current.variant !== "current" || target.variant !== "target") throw new EngagementError("invalid_reference", "workflow artifact variant does not match its path");
  if (current.workflow_id !== target.workflow_id) throw new EngagementError("invalid_reference", "current and target workflow IDs differ");
  const stepIds = new Set([...current.steps, ...target.steps].map(({ step_id }) => step_id));
  const stakeholderIds = new Set(stakeholders.stakeholders.map(({ stakeholder_id }) => stakeholder_id));
  const opportunities = validateOpportunityMatrix(readEngagementArtifact<OpportunityMatrix>(stateDir, id, "opportunity-matrix.json", OpportunityMatrixSchema), current.workflow_id, stepIds);
  const decisions = validateAutomationDecisionRegister(readEngagementArtifact<AutomationDecisionRegister>(stateDir, id, "automation-decisions.json", AutomationDecisionRegisterSchema), current.workflow_id, stepIds, stakeholderIds);
  const risks = validateRiskRegister(readEngagementArtifact<RiskRegister>(stateDir, id, "risk-register.json", RiskRegisterSchema), stepIds);
  const qualification = readEngagementArtifact<QualificationResult>(stateDir, id, "qualification.json", QualificationResultSchema);
  if (charter.status !== "draft" && qualification.status === "rejected") throw new EngagementError("invalid_reference", `lifecycle ${charter.status} conflicts with rejected qualification`);
  return { stakeholders, current, target, opportunities, decisions, risks, qualification };
}

async function validateCommand(argv: readonly string[], ctx: EngageCommandContext): Promise<number> {
  const flags = parse(argv); if (flags.errors.length || flags.positionals.length || flags.input || flags.yes || flags.stdout) return usageError(ctx, "validate", flags.errors[0] ?? "unsupported option or argument");
  try { const stateDir = resolveEngagementStateDir(ctx); const charter = await selectEngagement(ctx, stateDir, flags.id); loadAndValidate(stateDir, charter); ctx.out.write(`Engagement ${charter.engagement_id} is valid.\n`); return 0; }
  catch (error) { ctx.err.write(`agentify: engage validate: ${error instanceof Error ? error.message : String(error)}\n`); return 1; }
}

async function reportCommand(argv: readonly string[], ctx: EngageCommandContext): Promise<number> {
  const flags = parse(argv); if (flags.errors.length || flags.positionals.length || flags.input || flags.yes) return usageError(ctx, "report", flags.errors[0] ?? "unsupported option or argument");
  const stateDir = resolveEngagementStateDir(ctx); const charter = await selectEngagement(ctx, stateDir, flags.id); const loaded = loadAndValidate(stateDir, charter);
  const report = renderEngagementReport(charter, loaded); const reportPath = engagementReportPath(stateDir, charter.engagement_id); const reportsDir = path.dirname(reportPath);
  fs.mkdirSync(reportsDir, { recursive: true, mode: 0o700 });
  const temporary = `${reportPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try { fs.writeFileSync(temporary, report, { encoding: "utf-8", mode: 0o600 }); fs.renameSync(temporary, reportPath); }
  catch (error) { try { fs.unlinkSync(temporary); } catch { /* best-effort temporary cleanup */ } throw error; }
  ctx.out.write(`Report: ${reportPath}\n`); if (flags.stdout) ctx.out.write(report); return 0;
}

function usageError(ctx: EngageCommandContext, action: string, message: string): number { ctx.err.write(`agentify: engage ${action}: ${message}\n`); return 1; }
export async function engageCommand(argv: readonly string[], ctx: EngageCommandContext): Promise<number> {
  const action = argv[0];
  if (!action || action === "help") { printEngageHelp(ctx.out); return action ? 0 : usageError(ctx, "", "missing action. Usage: agentify engage <init|status|validate|report>"); }
  try {
    if (action === "init") return await initCommand(argv.slice(1), ctx);
    if (action === "status") return await statusCommand(argv.slice(1), ctx);
    if (action === "validate") return await validateCommand(argv.slice(1), ctx);
    if (action === "report") return await reportCommand(argv.slice(1), ctx);
    return usageError(ctx, "", `unknown action '${action}'. Valid: init, status, validate, report`);
  } catch (error) { ctx.err.write(`agentify: engage ${action}: ${error instanceof Error ? error.message : String(error)}\n`); return 1; }
}
export function printEngageHelp(out: NodeJS.WritableStream): void {
  out.write("Usage: agentify engage <init|status|validate|report> [options]\n\n");
  out.write("  agentify engage init [--id <id>] [--input <json>] [--yes]\n");
  out.write("  agentify engage status [--id <id>]\n  agentify engage validate [--id <id>]\n");
  out.write("  agentify engage report [--id <id>] [--stdout]\n\n");
  out.write("Examples:\n  agentify engage init --input engagement.json --yes\n  agentify engage status --id invoice-review\n");
}
