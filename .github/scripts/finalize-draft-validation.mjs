#!/usr/bin/env node
// agentify:managed
import * as fs from "node:fs";
import { assertBeforeStep, readJson } from "./draft-run-control.mjs";
const [stateArg, validationArg] = process.argv.slice(2); if (!stateArg || !validationArg) throw new Error("usage: finalize-draft-validation.mjs DRAFT_RUN_STATE VALIDATION");
const state = readJson(stateArg, "draft run state"); const validation = readJson(validationArg, "draft validation"); let deadlineOk = true;
try { assertBeforeStep(state, "evidence generation"); } catch { deadlineOk = false; }
const measuredOk = !state.require_measured_cost || state.cost_measurement_status === "measured"; const costOk = measuredOk && state.cost_limit_status === "within_limit" && state.measured_cost_usd + state.estimated_cost_usd + state.reserved_cost_usd <= state.budget_usd + 1e-9;
validation.budget_usd = state.budget_usd; validation.reserved_cost_usd = state.reserved_cost_usd; validation.measured_cost_usd = state.measured_cost_usd; validation.estimated_cost_usd = state.estimated_cost_usd; validation.remaining_budget_usd = state.remaining_budget_usd; validation.cost_measurement_status = state.cost_measurement_status; validation.cost_limit_status = state.cost_limit_status; validation.pricing_policy_version = state.pricing_policy_version; validation.model_calls = state.model_calls; validation.runtime_ms = Math.max(0, Date.now() - Date.parse(state.runtime.started_at)); validation.runtime = state.runtime; validation.diff_policy.cost = costOk; validation.diff_policy.runtime = deadlineOk; validation.passed = validation.passed && costOk && deadlineOk; validation.publication_allowed = validation.publication_allowed && costOk && deadlineOk; if (!costOk || !deadlineOk) validation.failed_draft_policy_used = false;
fs.writeFileSync(validationArg, `${JSON.stringify(validation, null, 2)}\n`, { mode: 0o600 }); if (!validation.publication_allowed) process.exitCode = 1;
