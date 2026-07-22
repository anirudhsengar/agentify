import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadAgentifyConfig } from "../agentify-config.ts";
import { discoverExistingStateDir, resolveStateDir } from "../state-dir.ts";
import type { AgentifyUi } from "../types.ts";
import { createSupportedGraderAdapters } from "./graders.ts";
import { evalRootPath, evalRunPath } from "./paths.ts";
import { renderEvalReport } from "./report.ts";
import { runEvaluation, type ImportedTrialArtifact } from "./runner.ts";
import type { EvalResult } from "./schema/result.ts";
import { EvalResultSchema } from "./schema/result.ts";
import { readValidatedJson, writeTextAtomic } from "./storage.ts";
import { loadAndValidateEvalSuite } from "./validation.ts";

export interface EvalCommandContext { cwd: string; configDir: string; ui: AgentifyUi; out: NodeJS.WritableStream; err: NodeJS.WritableStream; stdinIsTTY?: boolean }
interface Flags { id?: string; suite?: string; runId?: string; input?: string; stdout: boolean; positionals: string[]; errors: string[] }
function parse(argv: readonly string[]): Flags {
  const result: Flags = { stdout: false, positionals: [], errors: [] };
  for (let index = 0; index < argv.length; index += 1) { const token = argv[index]!;
    if (token === "--stdout") result.stdout = true;
    else if (["--id", "--suite", "--run-id", "--input"].includes(token)) { const value = argv[index + 1]; if (!value || value.startsWith("--")) result.errors.push(`${token} requires a value`); else { if (token === "--id") result.id = value; else if (token === "--suite") result.suite = value; else if (token === "--run-id") result.runId = value; else result.input = value; index += 1; } }
    else if (token.startsWith("--")) result.errors.push(`unknown flag ${token}`); else result.positionals.push(token);
  } return result;
}
function stateDir(ctx: EvalCommandContext): string {
  if (!fs.existsSync(path.join(ctx.cwd, ".git"))) throw new Error("eval requires a Git repository");
  const discovered = discoverExistingStateDir(ctx.cwd); if (discovered) return path.join(ctx.cwd, discovered.relativeDir);
  return path.join(ctx.cwd, resolveStateDir(loadAgentifyConfig(ctx.configDir).targets ?? ["claude", "codex", "pi"]).relativeDir);
}
function selectSingle(directory: string, extension: string, supplied: string | undefined, label: string): string {
  if (supplied) return supplied; let entries: string[];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => extension ? entry.isFile() && entry.name.endsWith(extension) : entry.isDirectory()).map((entry) => extension ? entry.name.slice(0, -extension.length) : entry.name).sort(); } catch { entries = []; }
  if (entries.length !== 1) throw new Error(`${entries.length ? `multiple ${label}s exist` : `no ${label}s exist`}; select one with --${label === "engagement" ? "id" : label} <${label}-id>`);
  return entries[0]!;
}
function selection(ctx: EvalCommandContext, flags: Flags): { state: string; engagement: string; suite: string } {
  const state = stateDir(ctx); const engagement = selectSingle(path.join(state, "engagements"), "", flags.id, "engagement");
  const suite = selectSingle(path.join(evalRootPath(state, engagement), "suites"), ".json", flags.suite, "suite"); return { state, engagement, suite };
}
function inputArtifacts(cwd: string, input?: string): ImportedTrialArtifact[] {
  if (!input) return []; const parsed: unknown = JSON.parse(fs.readFileSync(path.resolve(cwd, input), "utf8"));
  if (!Array.isArray(parsed)) throw new Error("eval run input must be a JSON array of imported trial artifacts"); return parsed as ImportedTrialArtifact[];
}
function usage(ctx: EvalCommandContext, action: string, message: string): number { ctx.err.write(`agentify: eval ${action}: ${message}\n`); return 1; }
async function validateAction(flags: Flags, ctx: EvalCommandContext): Promise<number> {
  if (flags.errors.length || flags.positionals.length || flags.runId || flags.input || flags.stdout) return usage(ctx, "validate", flags.errors[0] ?? "unsupported option or argument");
  const selected = selection(ctx, flags); const validated = loadAndValidateEvalSuite(selected.state, selected.engagement, selected.suite);
  ctx.out.write(`Evaluation suite ${validated.suite.suite_id} is valid.\nTasks: ${validated.tasks.length}\nRequired graders: ${validated.suite.required_graders.join(", ")}\nRelease configuration: ${validated.releaseEligibilityWarnings.length ? `not currently sufficient (${validated.releaseEligibilityWarnings.join("; ")})` : "eligible when a complete run passes"}\n`); return 0;
}
async function runAction(flags: Flags, ctx: EvalCommandContext): Promise<number> {
  if (flags.errors.length || flags.positionals.length || flags.stdout) return usage(ctx, "run", flags.errors[0] ?? "unsupported option or argument");
  const selected = selection(ctx, flags); loadAndValidateEvalSuite(selected.state, selected.engagement, selected.suite);
  const runId = flags.runId ?? `run-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
  ctx.out.write(`Evaluating suite ${selected.suite}...\n`);
  const result = runEvaluation({ stateDir: selected.state, engagementId: selected.engagement, suiteId: selected.suite, runId, mode: flags.input ? "imported" : "no-execution", importedArtifacts: inputArtifacts(ctx.cwd, flags.input), graders: createSupportedGraderAdapters() });
  ctx.out.write(`Run ID: ${runId}\nStatus: ${result.status}\nTrial pass rate: ${(result.trial_pass_rate * 100).toFixed(2)}%\nRelease-gate eligible: ${result.release_gate_eligible ? "yes" : "no"}\n`); return result.status === "failed" ? 1 : 0;
}
async function reportAction(flags: Flags, ctx: EvalCommandContext): Promise<number> {
  if (flags.errors.length || flags.positionals.length || flags.input) return usage(ctx, "report", flags.errors[0] ?? "unsupported option or argument");
  const selected = selection(ctx, flags); const runsDir = path.join(evalRootPath(selected.state, selected.engagement), "runs"); const runId = selectSingle(runsDir, "", flags.runId, "run-id");
  const result = readValidatedJson<EvalResult>(path.join(evalRunPath(selected.state, selected.engagement, runId), "summary.json"), EvalResultSchema, "eval result"); const report = renderEvalReport(result);
  const reportPath = path.join(evalRunPath(selected.state, selected.engagement, runId), "report.md"); writeTextAtomic(reportPath, report); ctx.out.write(`Report: ${reportPath}\n`); if (flags.stdout) ctx.out.write(report); return 0;
}
export async function evalCommand(argv: readonly string[], ctx: EvalCommandContext): Promise<number> {
  const action = argv[0]; if (!action || action === "help") { printEvalHelp(ctx.out); return action ? 0 : usage(ctx, "", "missing action. Usage: agentify eval <run|report|validate>"); }
  try { const flags = parse(argv.slice(1)); if (action === "validate") return validateAction(flags, ctx); if (action === "run") return runAction(flags, ctx); if (action === "report") return reportAction(flags, ctx); return usage(ctx, "", `unknown action '${action}'. Valid: run, report, validate`); }
  catch (error) { ctx.err.write(`agentify: eval ${action}: ${error instanceof Error ? error.message : String(error)}\n`); return 1; }
}
export function printEvalHelp(out: NodeJS.WritableStream): void {
  out.write("Usage: agentify eval <run|report|validate> [options]\n\n");
  out.write("  agentify eval validate [--id <engagement-id>] [--suite <suite-id>]\n");
  out.write("  agentify eval run [--id <engagement-id>] [--suite <suite-id>] [--run-id <run-id>] [--input <artifacts.json>]\n");
  out.write("  agentify eval report [--id <engagement-id>] [--suite <suite-id>] [--run-id <run-id>] [--stdout]\n");
  out.write("\nImported artifacts are strict structured evidence; task files cannot supply shell commands.\n");
}
