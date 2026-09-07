import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const source = process.cwd();
const { main, readEvidenceFile } = await import(pathToFileURL(path.join(source, 'scripts/live-installation.mjs')).href);
const root = process.env.LIVE_WORK_DIR;
assert.ok(root && path.isAbsolute(root));
const target = path.join(root, 'target');
const logDirectory = path.join(root, 'home/.agentify/logs/agentify');
const started = Date.now();
let responseObserved = false;
let checkpointObserved = false;
let interruptedAt = null;
let deadlineInterrupted = false;
let manifestPresentAtInterrupt = false;
let transientLogReads = 0;

function interrupt(deadline = false) {
  if (interruptedAt !== null) return;
  deadlineInterrupted = deadline;
  interruptedAt = Date.now();
  manifestPresentAtInterrupt = fs.existsSync(path.join(target, '.agentify/manifest.json'));
  // The production harness forwards this actual OS signal to the installed
  // CLI's process group and preserves its exit/terminal/rollback evidence.
  process.kill(process.pid, 'SIGINT');
}

const interval = setInterval(() => {
  if (interruptedAt !== null || !fs.existsSync(logDirectory)) return;
  try {
  for (const name of fs.readdirSync(logDirectory)) {
    if (!name.endsWith('.jsonl')) continue;
    const text = readEvidenceFile(path.join(logDirectory, name), 8 * 1024 * 1024).bytes.toString('utf8');
    const lines = text.split('\n');
    lines.pop(); // A concurrently written partial record is not evidence.
    for (const line of lines) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      const event = payload?.event;
      if (event?.type === 'message_end' && event.message?.role === 'assistant'
        && event.message.stopReason !== 'error' && event.message.usage?.output > 0) responseObserved = true;
      if (event?.type === 'tool_execution_end' && event.toolName === 'write_map_delta'
        && event.isError === false && event.result?.isError !== true) checkpointObserved = true;
    }
  }
  } catch (error) {
    if (error.code !== 'ENOENT' && !String(error.message).includes('evidence changed during descriptor read')) throw error;
    transientLogReads += 1;
    return;
  }
  if (responseObserved && checkpointObserved) interrupt();
}, 100);
const deadline = setTimeout(() => interrupt(true), 180_000);
try {
  await main(['run']);
} finally {
  clearTimeout(interval);
  clearTimeout(deadline);
}

const report = JSON.parse(readEvidenceFile(path.join(root, 'evidence/report.json')).bytes.toString('utf8'));
const stateRoot = path.join(target, '.agentify');
const retained = fs.existsSync(stateRoot) ? fs.readdirSync(stateRoot, { recursive: true }).sort() : [];
const terminal = report.terminal_events;
const usage = report.audit_budget?.usage ?? terminal[0]?.aggregate_usage;
const mapFile = path.join(stateRoot, 'runtime/audit/codebase_map.json');
const map = fs.existsSync(mapFile) ? JSON.parse(readEvidenceFile(mapFile).bytes.toString('utf8')) : null;
const checks = {
  actual_response: responseObserved,
  validated_checkpoint: checkpointObserved,
  deliberate_signal: interruptedAt !== null && !deadlineInterrupted,
  prior_managed_manifest: manifestPresentAtInterrupt,
  one_aborted_terminal: terminal.length === 1 && terminal[0].status === 'aborted' && terminal[0].exit_code === 130,
  signal_exit: report.exit_code === 130 && report.signal === null && report.interruption === 'workflow cancellation',
  prompt_rollback: interruptedAt !== null && Date.now() - interruptedAt < 10_000,
  no_installation_credit: report.passed === false && report.specialist_count === 0,
  original_source_unchanged: report.changed_original_paths.length === 0,
  diagnostic_only: JSON.stringify(retained) === JSON.stringify(['runtime', 'runtime/audit', 'runtime/audit/codebase_map.json']),
  requests_accounted: usage?.model_calls > 0 && usage?.unreserved_calls === 0,
  checkpoint_accounting_preserved: map?.audit_budget_checkpoint?.usage.model_calls === usage?.model_calls,
  unanswered_reserved: usage?.unreported_calls === 0
    || usage?.reserved_input_tokens > 0 && usage?.reserved_output_tokens > 0 && usage?.reserved_cost_usd > 0,
};
const result = {
  candidate_sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(),
  package_sha256: report.package_sha256,
  model: 'minimax/MiniMax-M3',
  target: report.target,
  installed_cli_cancellation: true,
  fresh_installation_credit: false,
  production_budget_overrides: false,
  elapsed_ms: Date.now() - started,
  cancellation_ms: interruptedAt === null ? null : Date.now() - interruptedAt,
  transient_log_reads: transientLogReads,
  accounting_source: report.audit_budget?.usage ? 'audit_budget' : 'terminal_aggregate_usage',
  usage,
  retained_agentify_paths: retained,
  checks,
  passed: Object.values(checks).every(Boolean),
  provider_invoice_reconciled: false,
};
fs.writeFileSync(path.join(root, 'evidence/cli-cancellation.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
assert.ok(result.passed, 'installed CLI cancellation or rollback gate failed');
// The installed CLI's expected exit 130 remains in report.json; this separate
// qualification succeeds only after independently checking every invariant.
process.exitCode = 0;
