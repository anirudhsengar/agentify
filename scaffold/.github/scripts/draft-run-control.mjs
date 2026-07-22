#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const round = (value) => Math.round((value + Number.EPSILON) * 1e9) / 1e9;
const nowIso = () => new Date().toISOString();
const readJson = (file, label = "state") => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error(`${label} is missing or corrupt`); } };
const writeAtomic = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const temporary = `${file}.${process.pid}.tmp`; fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temporary, file); };
const positiveInteger = (value, label) => { if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`); return value; };
const safeStep = (value) => { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}$/.test(value)) throw new Error("step name is unsafe"); return value; };

export function initializeDraftRun(config, startedAt = Date.now()) {
  const runtime = positiveInteger(config.maximum_runtime_ms, "maximum_runtime_ms");
  if (!Number.isFinite(config.maximum_cost_usd) || config.maximum_cost_usd < 0) throw new Error("maximum_cost_usd must be non-negative");
  if (!config.pricing_policy || typeof config.pricing_policy.version !== "string" || !Array.isArray(config.pricing_policy.models)) throw new Error("versioned pricing policy is unavailable");
  return { schema_version: "1", budget_usd: config.maximum_cost_usd, reserved_cost_usd: 0, measured_cost_usd: 0, estimated_cost_usd: 0, remaining_budget_usd: config.maximum_cost_usd, cost_measurement_status: "measured", cost_limit_status: "within_limit", pricing_policy_version: config.pricing_policy.version, require_measured_cost: config.require_measured_cost !== false, model_calls: [], runtime: { maximum_runtime_ms: runtime, started_at: new Date(startedAt).toISOString(), deadline_at: new Date(startedAt + runtime).toISOString(), cancellation_requested_at: null, cancellation_completed_at: null, step_active_at_timeout: null, remote_model_cancellation_acknowledged: null, child_processes_terminated: false, process_groups_terminated: false, remote_side_effect_may_remain: false, outer_workflow_timeout_is_emergency_only: true }, publication: { status: "not_started", repository: process.env.GITHUB_REPOSITORY ?? null, branch: null, base_branch: null, engagement_id: config.engagement_id ?? null, issue_number: null, pr_number: null, pr_url: null, error: null }, remote_branches: [] };
}

function pricing(config, provider, model) {
  const row = config.pricing_policy?.models?.find((item) => item?.provider === provider && item?.model === model && item?.effective_version === config.pricing_policy.version);
  if (!row || !Number.isFinite(row.input_usd_per_million) || !Number.isFinite(row.output_usd_per_million) || row.input_usd_per_million < 0 || row.output_usd_per_million < 0) throw new Error(`unknown model pricing for ${provider}/${model}; budget-controlled draft execution fails closed`);
  return row;
}
const tokenCost = (tokens, perMillion) => round(tokens * perMillion / 1_000_000);

export function assertBeforeStep(state, step, at = Date.now()) {
  safeStep(step);
  if (state.runtime.cancellation_requested_at) throw new Error("draft run is cancelled");
  if (at >= Date.parse(state.runtime.deadline_at)) { requestCancellation(state, step, at, true); throw new Error(`draft runtime deadline exceeded before ${step}`); }
  if (state.cost_limit_status !== "within_limit") throw new Error("draft cost policy blocks further model calls");
  return Date.parse(state.runtime.deadline_at) - at;
}

export function reserveModelCall(state, config, input) {
  assertBeforeStep(state, input.step, input.now ?? Date.now());
  const rate = pricing(config, input.provider, input.model);
  const maximumInput = positiveInteger(input.maximum_input_tokens ?? config.maximum_input_tokens, "maximum input tokens");
  const maximumOutput = positiveInteger(input.maximum_output_tokens ?? config.maximum_output_tokens, "maximum output tokens");
  const maximumInputRate = Math.max(rate.input_usd_per_million, Number.isFinite(rate.cached_input_usd_per_million) ? rate.cached_input_usd_per_million : 0, Number.isFinite(rate.cache_write_input_usd_per_million) ? rate.cache_write_input_usd_per_million : 0);
  const reservation = round(tokenCost(maximumInput, maximumInputRate) + tokenCost(maximumOutput, rate.output_usd_per_million));
  if (reservation > state.remaining_budget_usd + 1e-9) { state.cost_limit_status = "rejected"; throw new Error(`model call reservation $${reservation} exceeds remaining draft budget $${state.remaining_budget_usd}`); }
  const call = { call_id: `call-${state.model_calls.length + 1}`, provider: input.provider, model: input.model, input_tokens: null, cached_input_tokens: null, cache_write_input_tokens: null, output_tokens: null, reasoning_tokens: null, total_tokens: null, provider_request_id: null, started_at: new Date(input.now ?? Date.now()).toISOString(), ended_at: null, calculated_cost_usd: null, reserved_cost_usd: reservation, pricing_policy_version: config.pricing_policy.version, usage_status: "unavailable", maximum_input_tokens: maximumInput, maximum_output_tokens: maximumOutput };
  state.model_calls.push(call); state.reserved_cost_usd = round(state.reserved_cost_usd + reservation); state.remaining_budget_usd = round(state.budget_usd - state.measured_cost_usd - state.estimated_cost_usd - state.reserved_cost_usd);
  return call;
}

export function reconcileModelCall(state, config, callId, usage, endedAt = Date.now()) {
  const call = state.model_calls.find((item) => item.call_id === callId); if (!call || call.ended_at) throw new Error("model call reservation is missing or already reconciled");
  const rate = pricing(config, call.provider, call.model); state.reserved_cost_usd = round(state.reserved_cost_usd - call.reserved_cost_usd);
  const measured = Number.isInteger(usage?.input_tokens) && usage.input_tokens >= 0 && Number.isInteger(usage?.output_tokens) && usage.output_tokens >= 0;
  if (measured) {
    const cached = Number.isInteger(usage.cached_input_tokens) && usage.cached_input_tokens >= 0 ? usage.cached_input_tokens : 0;
    const cachedRate = Number.isFinite(rate.cached_input_usd_per_million) ? rate.cached_input_usd_per_million : rate.input_usd_per_million;
    const cacheWrite = Number.isInteger(usage.cache_write_input_tokens) && usage.cache_write_input_tokens >= 0 ? usage.cache_write_input_tokens : 0; const cacheWriteRate = Number.isFinite(rate.cache_write_input_usd_per_million) ? rate.cache_write_input_usd_per_million : rate.input_usd_per_million;
    const cost = round(tokenCost(usage.input_tokens, rate.input_usd_per_million) + tokenCost(cached, cachedRate) + tokenCost(cacheWrite, cacheWriteRate) + tokenCost(usage.output_tokens, rate.output_usd_per_million));
    Object.assign(call, { input_tokens: usage.input_tokens, cached_input_tokens: cached, cache_write_input_tokens: cacheWrite, output_tokens: usage.output_tokens, reasoning_tokens: Number.isInteger(usage.reasoning_tokens) ? usage.reasoning_tokens : null, total_tokens: Number.isInteger(usage.total_tokens) ? usage.total_tokens : usage.input_tokens + cached + cacheWrite + usage.output_tokens, provider_request_id: typeof usage.provider_request_id === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(usage.provider_request_id) ? usage.provider_request_id : null, calculated_cost_usd: cost, usage_status: "measured" }); state.measured_cost_usd = round(state.measured_cost_usd + cost);
  } else { call.calculated_cost_usd = call.reserved_cost_usd; call.usage_status = "estimated"; state.estimated_cost_usd = round(state.estimated_cost_usd + call.reserved_cost_usd); state.cost_measurement_status = "estimated"; if (state.require_measured_cost) state.cost_limit_status = "measurement_required"; }
  call.ended_at = new Date(endedAt).toISOString(); state.remaining_budget_usd = round(Math.max(0, state.budget_usd - state.measured_cost_usd - state.estimated_cost_usd - state.reserved_cost_usd));
  if (state.measured_cost_usd + state.estimated_cost_usd > state.budget_usd + 1e-9) state.cost_limit_status = "overrun";
  return call;
}

export function requestCancellation(state, step, at = Date.now(), remoteMayRemain = false) { if (!state.runtime.cancellation_requested_at) { state.runtime.cancellation_requested_at = new Date(at).toISOString(); state.runtime.step_active_at_timeout = safeStep(step); } state.runtime.remote_side_effect_may_remain ||= remoteMayRemain; }

export async function runDeadlineProcess(stateFile, state, step, command, args, options = {}) {
  const remaining = assertBeforeStep(state, step); writeAtomic(stateFile, state);
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: options.stdio ?? "inherit", detached: process.platform !== "win32" }); let timedOut = false; let forced = false; const localLimit = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : remaining; const deadlineTimeout = remaining <= localLimit;
    const timer = setTimeout(() => { timedOut = true; if (deadlineTimeout) requestCancellation(state, step, Date.now(), options.remoteSideEffect === true); state.runtime.child_processes_terminated = true; if (process.platform !== "win32") { try { process.kill(-child.pid, "SIGTERM"); state.runtime.process_groups_terminated = true; } catch {} } else child.kill("SIGTERM"); writeAtomic(stateFile, state); setTimeout(() => { if (child.exitCode === null) { forced = true; if (process.platform !== "win32") { try { process.kill(-child.pid, "SIGKILL"); } catch {} } else child.kill("SIGKILL"); } }, options.graceMs ?? 5000).unref(); }, Math.min(remaining, localLimit)); timer.unref();
    child.once("error", reject); child.once("exit", (code, signal) => { clearTimeout(timer); if (timedOut) { if (deadlineTimeout) state.runtime.cancellation_completed_at = nowIso(); writeAtomic(stateFile, state); reject(new Error(deadlineTimeout ? `draft runtime deadline cancelled ${step}; signal=${signal ?? "none"}; forced=${forced}` : `process timeout cancelled ${step}`)); } else resolve({ code, signal }); });
  });
}

export { readJson, writeAtomic };

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, stateFile, configFileOrStep, ...rest] = process.argv.slice(2); if (!command || !stateFile) throw new Error("usage: draft-run-control.mjs init|check|run STATE CONFIG_OR_STEP [ARGS]");
  if (command === "init") writeAtomic(stateFile, initializeDraftRun(readJson(configFileOrStep, "draft configuration")));
  else if (command === "check") { const state = readJson(stateFile); assertBeforeStep(state, rest.join(" ") || "workflow step"); writeAtomic(stateFile, state); }
  else if (command === "run") { const separator = rest.indexOf("--"); const argv = separator >= 0 ? rest.slice(separator + 1) : rest; if (!configFileOrStep || argv.length === 0) throw new Error("draft run step or command is missing"); const state = readJson(stateFile); const result = await runDeadlineProcess(stateFile, state, configFileOrStep, argv[0], argv.slice(1), { env: process.env, stdio: "inherit", remoteSideEffect: true }); process.exitCode = result.code ?? 1; }
  else throw new Error(`unknown draft run control command: ${command}`);
}
