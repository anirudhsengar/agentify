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
import { PromotionActualsSchema, PromotionPolicySchema, type PromotionActuals, type PromotionPolicy } from "./schema/promotion.ts";
import { appendPromotionRecord, assertEngagementPromotable, createPromotionState, currentAutonomyLevel, evaluatePromotion, promotionReportPath, promotionStatePath, readPromotionState, renderPromotionReport, revokePromotion } from "./promotion.ts";
import { writeEngagementJsonAtomic } from "./state.ts";
import { aggregatePilotEvents, metricsDirectory, readMetricEvents, recordMetricEvent, renderPilotReport, type MetricEventInput } from "./metrics/index.ts";
import { runLocalShadow, lockPathFor, readLock, removeIfStale, resolveWorkspacePaths } from "../shadow/index.ts";

export interface EngageCommandContext {
  cwd: string; configDir: string; ui: AgentifyUi;
  out: NodeJS.WritableStream; err: NodeJS.WritableStream; stdinIsTTY?: boolean;
}
interface Flags { id?: string; input?: string; actor?: string; reason?: string; yes: boolean; stdout: boolean; positionals: string[]; errors: string[] }
const ARTIFACTS = ["stakeholders.json", "current-workflow.json", "target-workflow.json", "opportunity-matrix.json", "automation-decisions.json", "risk-register.json", "qualification.json"] as const;

function parse(argv: readonly string[]): Flags {
  const result: Flags = { yes: false, stdout: false, positionals: [], errors: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--yes") result.yes = true;
    else if (token === "--stdout") result.stdout = true;
    else if (token === "--id" || token === "--input" || token === "--actor" || token === "--reason") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) result.errors.push(`${token} requires a value`);
      else { if (token === "--id") result.id = value; else if (token === "--input") result.input = value; else if (token === "--actor") result.actor = value; else result.reason = value; index += 1; }
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
  const autonomy = fs.existsSync(promotionStatePath(stateDir, charter.engagement_id)) ? currentAutonomyLevel(readPromotionState(stateDir, charter.engagement_id)) : "not recorded";
  ctx.out.write(`Engagement: ${charter.engagement_id}\nWorkflow: ${charter.workflow_name}\nLifecycle: ${charter.status}\nQualification: ${qualificationText(stateDir, charter.engagement_id)}\nRevision: ${charter.revision}\nLatest update: ${charter.updated_at}\nAutonomy: ${autonomy}\nMissing artifacts: ${missing.join(", ") || "none"}\n`);
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

function readPromotionInput(cwd: string, input: string): { policy: PromotionPolicy; actual_condition_results: PromotionActuals } {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(cwd, input), "utf8")) as Record<string, unknown>;
  if (!Value.Check(PromotionPolicySchema, parsed.policy) || !Value.Check(PromotionActualsSchema, parsed.actual_condition_results)) throw new Error("promotion input must contain valid policy and actual_condition_results objects");
  return parsed as { policy: PromotionPolicy; actual_condition_results: PromotionActuals };
}
function writePromotionReport(stateDir: string, id: string, report: string): string { const target = promotionReportPath(stateDir, id); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`; fs.writeFileSync(temporary, report, { encoding: "utf8", mode: 0o600, flag: "wx" }); fs.renameSync(temporary, target); return target; }
async function promotionCommand(argv: readonly string[], ctx: EngageCommandContext): Promise<number> {
  const action = argv[0]; const flags = parse(argv.slice(1)); if (!action || !["status", "evaluate", "approve", "revoke"].includes(action)) return usageError(ctx, "promotion", "Usage: agentify engage promotion <status|evaluate|approve|revoke>");
  if (flags.errors.length || flags.positionals.length) return usageError(ctx, `promotion ${action}`, flags.errors[0] ?? "unexpected argument");
  const stateDir = resolveEngagementStateDir(ctx); const charter = await selectEngagement(ctx, stateDir, flags.id); const id = charter.engagement_id;
  if (action === "status") { const state = readPromotionState(stateDir, id); ctx.out.write(renderPromotionReport(state)); return 0; }
  assertEngagementPromotable(stateDir, id);
  if (action === "evaluate") {
    if (!flags.input) return usageError(ctx, "promotion evaluate", "--input <json> is required");
    const input = readPromotionInput(ctx.cwd, flags.input); if (input.policy.engagement_id !== id) throw new Error("promotion policy engagement ID does not match --id");
    let state; if (!fs.existsSync(promotionStatePath(stateDir, id))) { state = createPromotionState(input.policy); writeEngagementJsonAtomic(promotionStatePath(stateDir, id), state); } else { state = readPromotionState(stateDir, id); if (JSON.stringify(state.policy) !== JSON.stringify(input.policy)) throw new Error("stored promotion policy differs; policy history cannot be replaced"); }
    const record = evaluatePromotion(state.policy, input.actual_condition_results, new Date().toISOString()); state = appendPromotionRecord(stateDir, state, record, state.revision); const report = renderPromotionReport(state, record); const reportPath = writePromotionReport(stateDir, id, report); ctx.out.write(`Decision: ${record.decision}\nReport: ${reportPath}\n`); return record.decision === "approved" ? 0 : 2;
  }
  const state = readPromotionState(stateDir, id);
  if (!flags.actor?.trim()) return usageError(ctx, `promotion ${action}`, "--actor <name> is required");
  if (!flags.yes) return usageError(ctx, `promotion ${action}`, "explicit confirmation requires --yes");
  if (action === "approve") { const evaluated = [...state.records].reverse().find((record) => record.decision !== "revoked"); if (!evaluated) throw new Error("evaluate promotion evidence before approval"); const record = evaluatePromotion(state.policy, evaluated.actual_condition_results, new Date().toISOString(), flags.actor.trim()); const next = appendPromotionRecord(stateDir, state, record, state.revision); writePromotionReport(stateDir, id, renderPromotionReport(next, record)); ctx.out.write(`Decision: ${record.decision}\nCurrent level: ${currentAutonomyLevel(next)}\nGitHub behavior: unchanged\n`); return record.decision === "approved" ? 0 : 2; }
  if (!flags.reason?.trim()) return usageError(ctx, "promotion revoke", "--reason <text> is required"); const next = revokePromotion(stateDir, state, flags.actor.trim(), new Date().toISOString(), flags.reason.trim()); writePromotionReport(stateDir, id, renderPromotionReport(next)); ctx.out.write(`Decision: revoked\nCurrent level: ${currentAutonomyLevel(next)}\n`); return 0;
}

function usageError(ctx: EngageCommandContext, action: string, message: string): number { ctx.err.write(`agentify: engage ${action}: ${message}\n`); return 1; }
async function metricsCommand(argv: readonly string[], ctx: EngageCommandContext): Promise<number> {
  const action = argv[0]; const flags = parse(argv.slice(1));
  if (!action || !["status", "record-baseline", "record-review", "record-adoption", "report"].includes(action)) return usageError(ctx, "metrics", "Usage: agentify engage metrics <status|record-baseline|record-review|record-adoption|report> [--id <id>] [--input <json>] [--yes] [--stdout]");
  if (flags.errors.length || flags.positionals.length) return usageError(ctx, `metrics ${action}`, flags.errors[0] ?? "unexpected argument");
  const stateDir = resolveEngagementStateDir(ctx); const charter = await selectEngagement(ctx, stateDir, flags.id); const id = charter.engagement_id;
  if (action.startsWith("record-")) {
    if (!flags.input) return usageError(ctx, `metrics ${action}`, "--input <json> is required");
    if (!flags.yes) return usageError(ctx, `metrics ${action}`, "human-entered measurements require explicit confirmation with --yes");
    let parsed: MetricEventInput;
    try {
      parsed = JSON.parse(fs.readFileSync(path.resolve(ctx.cwd, flags.input), "utf8")) as MetricEventInput;
    } catch (error) {
      throw new Error(`cannot read metric input ${flags.input}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const expected = action === "record-baseline" ? "baseline_recorded" : action === "record-review" ? "human_review_recorded" : "adoption_recorded";
    if (parsed.event_type !== expected || parsed.engagement_id !== id || parsed.source !== "operator" || parsed.provenance.quality !== "human_supplied") throw new Error(`input must be a ${expected} event with matching engagement, operator source, and human_supplied provenance`);
    const result = recordMetricEvent(stateDir, parsed); ctx.out.write(`${result.created ? "Recorded" : "Already recorded"} ${result.event.event_type} ${result.event.event_id}\nProvenance: ${result.event.provenance.quality} — ${result.event.provenance.method}\n`); return 0;
  }
  const events = readMetricEvents(stateDir, id); const aggregates = aggregatePilotEvents(events);
  if (action === "status") { ctx.out.write(`Engagement: ${id}\nMetric events: ${events.length}\nRuns: ${aggregates.runs.total}\nMeasured cost USD: ${aggregates.costs.measured_usd ?? "unavailable"}\nEstimated cost USD: ${aggregates.costs.estimated_usd ?? "unavailable"}\nWarning: ${aggregates.sample_warning ?? "none"}\n`); return 0; }
  const directory = metricsDirectory(stateDir, id); writeEngagementJsonAtomic(path.join(directory, "aggregates.json"), aggregates); const report = renderPilotReport(charter, events); const target = path.join(directory, "pilot-report.md");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try { fs.writeFileSync(temporary, report, { encoding: "utf8", mode: 0o600, flag: "wx" }); fs.renameSync(temporary, target); }
  catch (error) { try { fs.unlinkSync(temporary); } catch { /* best-effort temporary cleanup */ } throw error; }
  ctx.out.write(`Report: ${target}\n`); if (flags.stdout) ctx.out.write(report); return 0;
}

// =========================================================================
// `agentify engage shadow ...`  (Milestone 6A-L: local supported runner)
// =========================================================================

const SHADOW_RUN_LOCAL_FLAGS = new Set([
  "id", "issue", "repo", "suite", "task", "pilot-root", "config", "yes", "non-interactive",
]);
const SHADOW_RUN_LOCAL_TAKES = new Set([
  "id", "issue", "repo", "suite", "task", "pilot-root", "config",
]);

function parseShadowFlags(argv: readonly string[]): { flags: Record<string, string | true>; positionals: string[]; errors: string[] } {
  const flags: Record<string, string | true> = {};
  const positionals: string[] = [];
  const errors: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i]!;
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      let name: string; let value: string | true;
      if (eq >= 0) { name = tok.slice(2, eq); value = tok.slice(eq + 1); }
      else { name = tok.slice(2); value = true; }
      if (!SHADOW_RUN_LOCAL_FLAGS.has(name)) { errors.push(`unknown flag --${name}`); i += 1; continue; }
      if (SHADOW_RUN_LOCAL_TAKES.has(name)) {
        if (typeof value !== "string") {
          const next = argv[i + 1];
          if (!next || next.startsWith("--")) { errors.push(`--${name} requires a value`); i += 1; continue; }
          flags[name] = next; i += 2; continue;
        }
        flags[name] = value;
      } else { flags[name] = true; }
      i += 1;
      continue;
    }
    positionals.push(tok); i += 1;
  }
  return { flags, positionals, errors };
}

function resolveShadowConfigPath(_repoSlug: string): string {
  // The local shadow runner always uses the same config file as the GitHub
  // workflow. We refuse to invent one because that would let a caller
  // accidentally craft a relaxed policy.
  const candidates = [".github/agentify-shadow.json", "agentify-shadow.json"];
  for (const candidate of candidates) {
    if (fs.existsSync(path.resolve(candidate))) return path.resolve(candidate);
  }
  throw new Error(
    `shadow configuration was not found; checked ${candidates.join(" and ")}`,
  );
}

async function shadowRunLocalCommand(argv: readonly string[], ctx: EngageCommandContext): Promise<number> {
  const parsed = parseShadowFlags(argv);
  if (parsed.errors.length) return usageError(ctx, "shadow run-local", parsed.errors[0]!);
  if (parsed.positionals.length) return usageError(ctx, "shadow run-local", `unexpected argument: ${parsed.positionals[0]}`);

  const required = ["id", "issue", "repo", "pilot-root"] as const;
  for (const flag of required) {
    if (typeof parsed.flags[flag] !== "string") return usageError(ctx, "shadow run-local", `--${flag} is required`);
  }
  const id = parsed.flags.id as string;
  const repo = parsed.flags.repo as string;
  const pilotRoot = parsed.flags["pilot-root"] as string;
  const issueRaw = parsed.flags.issue as string;
  const issueNumber = Number(issueRaw);
  if (!Number.isInteger(issueNumber) || issueNumber < 1) return usageError(ctx, "shadow run-local", `--issue must be a positive integer (received '${issueRaw}')`);
  if (!/^[^/]+\/[^/]+$/.test(repo)) return usageError(ctx, "shadow run-local", `--repo must be of the form owner/name (received '${repo}')`);

  const interactive = (ctx.stdinIsTTY ?? Boolean(process.stdin.isTTY)) && !parsed.flags["non-interactive"];
  if (interactive && !parsed.flags.yes) {
    ctx.out.write(
      `Local shadow analysis for engagement ${id} on ${repo}#${issueNumber}\n` +
        `Pilot root: ${pilotRoot}\n` +
        "This is read-only local shadow analysis and performs no implementation.\n",
    );
    const choice = await ctx.ui.promptSelect("Run local shadow analysis now?", [
      { label: "Run", value: "yes" },
      { label: "Cancel", value: "no" },
    ]);
    if (choice !== "yes") { ctx.out.write("Cancelled.\n"); return 0; }
  }

  const suiteRaw = typeof parsed.flags.suite === "string" ? parsed.flags.suite : undefined;
  const taskRaw = typeof parsed.flags.task === "string" ? parsed.flags.task : undefined;
  const configRaw = typeof parsed.flags.config === "string" ? parsed.flags.config : undefined;
  const configPath = configRaw ? path.resolve(ctx.cwd, configRaw) : resolveShadowConfigPath(repo);

  // Read config to default suite/task when the caller left them unset.
  const configJson = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const suiteId = suiteRaw ?? (configJson.eval_suite_id as string | undefined);
  const taskId = taskRaw ?? (configJson.task_id as string | undefined);
  if (!suiteId || !taskId) {
    return usageError(ctx, "shadow run-local", "config is missing eval_suite_id or task_id and --suite/--task were not supplied");
  }

  try {
    const result = await runLocalShadow({
      pilotRoot,
      repoSlug: repo.split("/")[1]!,
      githubFullName: repo,
      sourceRepoRoot: ctx.cwd,
      engagementId: id,
      issueNumber,
      suiteId,
      taskId,
      configPath,
    });
    void result;
    ctx.out.write(
      `run_id: ${result.runId}\n` +
        `evidence_origin: ${result.evidenceOrigin}\n` +
        `classification: ${result.classification}\n` +
        `repository: ${result.repository.githubFullName}\n` +
        `issue: ${result.issue.number}\n` +
        `commit: ${result.repository.commitSha}\n` +
        `engagement: ${result.engagement.id}\n` +
        `suite: ${result.engagement.suite}\n` +
        `task: ${result.engagement.task}\n` +
        `readiness: ${result.readiness}\n` +
        `runtime_ms: ${result.runtimeMs}\n` +
        `cost_status: ${result.costStatus}\n` +
        `cost_usd: ${result.costUsd}\n` +
        `evidence_packet: ${result.evidencePacketPath}\n` +
        `summary: ${result.summaryPath}\n` +
        `metrics: ${result.metricsStatus}\n`,
    );
    return 0;
  } catch (error) {
    ctx.err.write(`agentify: engage shadow run-local: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function shadowStatusLocalCommand(argv: readonly string[], ctx: EngageCommandContext): Promise<number> {
  const parsed = parseShadowFlags(argv);
  if (parsed.errors.length) return usageError(ctx, "shadow status-local", parsed.errors[0]!);
  if (parsed.positionals.length) return usageError(ctx, "shadow status-local", `unexpected argument: ${parsed.positionals[0]}`);
  if (typeof parsed.flags.id !== "string") return usageError(ctx, "shadow status-local", "--id is required");
  if (typeof parsed.flags["pilot-root"] !== "string") return usageError(ctx, "shadow status-local", "--pilot-root is required");
  const id = parsed.flags.id as string;
  const pilotRoot = parsed.flags["pilot-root"] as string;
  const repoRaw = typeof parsed.flags.repo === "string" ? parsed.flags.repo : undefined;
  if (repoRaw && !/^[^/]+\/[^/]+$/.test(repoRaw)) return usageError(ctx, "shadow status-local", `--repo must be of the form owner/name (received '${repoRaw}')`);
  const paths = resolveWorkspacePaths({
    pilotRoot,
    repoSlug: repoRaw ? repoRaw.split("/")[1]! : id,
    githubFullName: repoRaw ?? `local/${id}`,
    sourceRepoRoot: ctx.cwd,
    sourceCommitSha: "0000000000000000000000000000000000000000",
  });
  if (!fs.existsSync(paths.workspaceRoot)) {
    ctx.out.write(`Engagement: ${id}\nNo local workspace yet at ${paths.workspaceRoot}.\n`);
    return 0;
  }
  const shadowDir = paths.shadowEvidenceRoot;
  const runs = fs.existsSync(shadowDir) ? fs.readdirSync(shadowDir).filter((d) => fs.statSync(path.join(shadowDir, d)).isDirectory()) : [];
  const lockFile = fs.existsSync(path.join(paths.lockRoot)) ? fs.readdirSync(path.join(paths.lockRoot)).filter((f) => f.endsWith(".lock")) : [];
  let lockInfo = "";
  for (const file of lockFile) {
    const lf = path.join(paths.lockRoot, file);
    const data = readLock(lf);
    if (data) lockInfo += `lock ${file}: pid=${data.pid} started=${data.startedAt} host=${data.host}\n`;
    else lockInfo += `lock ${file}: (unreadable)\n`;
  }
  ctx.out.write(
    `Engagement: ${id}\n` +
      `Workspace: ${paths.workspaceRoot}\n` +
      `Local shadow runs on disk: ${runs.length}\n` +
      (runs.length ? runs.map((r) => `  - ${r}`).join("\n") + "\n" : "") +
      (lockInfo || "No active local locks.\n"),
  );
  if (parsed.flags.yes) {
    // Surface any stale locks so the operator can clean them.
    for (const file of lockFile) {
      const lf = path.join(paths.lockRoot, file);
      const outcome = removeIfStale(lf);
      if (outcome.removed) ctx.out.write(`removed stale lock ${file}: ${outcome.reason}\n`);
      else ctx.out.write(`kept lock ${file}: ${outcome.reason}\n`);
    }
  }
  return 0;
}

async function shadowCommand(argv: readonly string[], ctx: EngageCommandContext): Promise<number> {
  const action = argv[0];
  if (!action || action === "help") {
    printShadowHelp(ctx.out);
    return action ? 0 : usageError(ctx, "shadow", "missing action. Usage: agentify engage shadow <run-local|status-local>");
  }
  if (action === "run-local") return shadowRunLocalCommand(argv.slice(1), ctx);
  if (action === "status-local") return shadowStatusLocalCommand(argv.slice(1), ctx);
  return usageError(ctx, "shadow", `unknown action '${action}'. Valid: run-local, status-local`);
}

function printShadowHelp(out: NodeJS.WritableStream): void {
  out.write(
    "Usage: agentify engage shadow <run-local|status-local> [options]\n\n" +
      "  agentify engage shadow run-local --id <id> --issue <n> --repo <owner/name>\n" +
      "       [--suite <id>] [--task <id>] [--pilot-root <abs>]\n" +
      "       [--config <path>] [--yes] [--non-interactive]\n" +
      "    Run a read-only local shadow analysis. Persists evidence to the\n" +
      "    private pilot workspace beneath <pilot-root>. Never implements.\n" +
      "  agentify engage shadow status-local --id <id>\n" +
      "       --pilot-root <abs> [--repo <owner/name>] [--yes]\n" +
      "    Inspect local shadow runs and locks. With --yes, also remove\n" +
      "    stale locks whose owning process is no longer alive.\n\n" +
      "Examples:\n  agentify engage shadow run-local --id pilot-wave-1-agentify --issue 127 --repo anirudhsengar/agentify --pilot-root ~/Projects/agentify-pilot-data/pilot-wave-1 --yes\n",
  );
}

// Suppress lint warning for unused helper (used only by status-local above).
void lockPathFor;
export async function engageCommand(argv: readonly string[], ctx: EngageCommandContext): Promise<number> {
  const action = argv[0];
  if (!action || action === "help") { printEngageHelp(ctx.out); return action ? 0 : usageError(ctx, "", "missing action. Usage: agentify engage <init|status|validate|report|promotion|metrics|shadow>"); }
  try {
    if (action === "init") return await initCommand(argv.slice(1), ctx);
    if (action === "status") return await statusCommand(argv.slice(1), ctx);
    if (action === "validate") return await validateCommand(argv.slice(1), ctx);
    if (action === "report") return await reportCommand(argv.slice(1), ctx);
    if (action === "promotion") return await promotionCommand(argv.slice(1), ctx);
    if (action === "metrics") return await metricsCommand(argv.slice(1), ctx);
    if (action === "shadow") return await shadowCommand(argv.slice(1), ctx);
    return usageError(ctx, "", `unknown action '${action}'. Valid: init, status, validate, report, promotion, metrics, shadow`);
  } catch (error) { ctx.err.write(`agentify: engage ${action}: ${error instanceof Error ? error.message : String(error)}\n`); return 1; }
}
export function printEngageHelp(out: NodeJS.WritableStream): void {
  out.write("Usage: agentify engage <init|status|validate|report|promotion|metrics|shadow> [options]\n\n");
  out.write("  agentify engage init [--id <id>] [--input <json>] [--yes]\n");
  out.write("  agentify engage status [--id <id>]\n  agentify engage validate [--id <id>]\n");
  out.write("  agentify engage report [--id <id>] [--stdout]\n\n");
  out.write("  agentify engage promotion <status|evaluate|approve|revoke> [options]\n\n");
  out.write("  agentify engage metrics <status|record-baseline|record-review|record-adoption|report> [--id <id>] [--input <json>] [--yes] [--stdout]\n\n");
  out.write("  agentify engage shadow <run-local|status-local> [options]\n\n");
  out.write("Examples:\n  agentify engage init --input engagement.json --yes\n  agentify engage status --id invoice-review\n");
}
