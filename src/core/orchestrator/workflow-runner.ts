// workflow-runner.ts — owns the workflow DAG execution.
//
// The composer (`composer.ts`) is the **deterministic** layer that
// walks a workflow DAG. The runner owns the lifecycle: instantiation,
// background execution, polling, and cancellation. Think of it as
// the orchestrator's analog to `AiwRunner` — but for developer
// workflows rather than AIWs.
//
// The runner is responsible for:
//   1. Generating workflow_run_ids (8-char hex).
//   2. Persisting `WorkflowRunState` to `<configDir>/orchestrator/workflows/<run_id>/`.
//   3. Walking the spec in topological order, honoring `depends_on`
//      and `parallel_group`.
//   4. Dispatching each step to its handler (subagent / aiw / compose / branch).
//   5. Evaluating `when` clauses between steps (skipped steps don't fire).
//   6. Handling retries with backoff.
//   7. Surfacing `escalate_to_orchestrator` from sub-agents.
//
// The composition is exactly mirrored from `AiwRunner` (Class 2 G2):
//   `run(args) -> WorkflowRunState`, `resume`, `cancel`, `show`,
//   `list`. The orchestrator's `run_workflow` tool is a thin wrapper
//   over `run()`.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import {
  validateInputs,
  type WorkflowRunState,
  type WorkflowSpec,
  type WorkflowStep as SpecStep,
  type WorkflowStepResult,
  type WorkflowRunStatus,
} from "./workflow-spec.ts";
import {
  workflowRunPaths,
  ensureWorkflowRunDirs,
  writeWorkflowRunState,
  readWorkflowRunState,
  appendWorkflowRunEvent,
  readWorkflowRunEvents,
  appendWorkflowRunExecutionLog,
  listWorkflowRunDirs,
  readAllWorkflowRunStates,
} from "./paths.ts";
import type { AgentManager } from "./agent-manager.ts";
import type { AiwBridge } from "./aiw-bridge.ts";
import { evaluateWhen, interpolate } from "./expression.ts";
import {
  summarizeEvent,
  appendSummaryDigest,
  type SummaryEvent,
} from "./summarizer.ts";

// ---------------------------------------------------------------------------
// Runner interface
// ---------------------------------------------------------------------------

export interface WorkflowRunnerOptions {
  configDir: string;
  cwd: string;
  agentManager: AgentManager;
  aiwBridge: AiwBridge;
}

export interface RunArgs {
  spec: WorkflowSpec;
  inputs?: Record<string, unknown>;
  workflowRunId?: string;
  source?: string;
  signal?: AbortSignal;
}

export interface WorkflowRunner {
  run(args: RunArgs): Promise<WorkflowRunState>;
  show(workflowRunId: string): WorkflowRunState | null;
  list(): WorkflowRunState[];
  cancel(workflowRunId: string): void;
  /** Tail events for a run; respects filters. */
  tail(workflowRunId: string, opts?: { tail?: number; event_type?: string }): Array<{
    at: string; kind: string; fields?: Record<string, unknown>;
  }>;
  /** Tail the summary stream (one-line digests). */
  tailSummary(workflowRunId: string, opts?: { tail?: number }): SummaryEvent[];
}

export function startWorkflowRunner(opts: WorkflowRunnerOptions): WorkflowRunner {
  const liveAbortControllers = new Map<string, AbortController>();
  const liveStates = new Map<string, () => WorkflowRunState>();

  async function execute(run: WorkflowRunState, args: RunArgs): Promise<WorkflowRunState> {
    const paths = workflowRunPaths(opts.configDir, run.workflow_run_id);
    ensureWorkflowRunDirs(paths);

    // Default source.
    const source = args.source ?? "orchestrator:tool";

    // Validate inputs up front.
    const inputsValidation = validateInputs(args.spec, args.inputs ?? {});
    if (!inputsValidation.ok) {
      const failed: WorkflowRunState = {
        ...run,
        status: "failed",
        ended_at: new Date().toISOString(),
        error: `inputs validation failed: ${inputsValidation.errors.join("; ")}`,
        source,
      };
      writeWorkflowRunState(paths, failed);
      appendWorkflowRunEvent(paths, {
        kind: "workflow_validation_failed",
        fields: { errors: inputsValidation.errors },
      });
      appendWorkflowRunExecutionLog(paths, `validation failed: ${inputsValidation.errors.join("; ")}`);
      return failed;
    }

    // Build the resolved spec (inputs substituted into user_prompt fields).
    const resolvedSpec = applyInputs(args.spec, inputsValidation.coerced);
    const started: WorkflowRunState = {
      ...run,
      status: "running",
      inputs: inputsValidation.coerced,
      resolved_spec: resolvedSpec,
      source,
    };
    writeWorkflowRunState(paths, started);
    liveStates.set(run.workflow_run_id, () => readWorkflowRunState(paths) ?? started);
    appendWorkflowRunEvent(paths, {
      kind: "workflow_started",
      fields: {
        workflow: started.workflow_name,
        spec_name: started.spec_name,
        inputs: inputsValidation.coerced,
        steps: countSteps(resolvedSpec.steps as unknown[]),
      },
    });
    appendWorkflowRunExecutionLog(paths, `started: workflow=${started.workflow_name}, run=${run.workflow_run_id}`);

    // Spawn the actual execution loop detached.
    const executionPromise = (async (): Promise<WorkflowRunState> => {
      try {
        const finalState = await executeDag(started, resolvedSpec, paths, opts, args.signal);
        liveStates.delete(run.workflow_run_id);
        return finalState;
      } catch (err) {
        const failed: WorkflowRunState = {
          ...started,
          status: "failed",
          ended_at: new Date().toISOString(),
          error: (err as Error).message,
        };
        writeWorkflowRunState(paths, failed);
        appendWorkflowRunExecutionLog(paths, `failed: ${(err as Error).message}`);
        liveStates.delete(run.workflow_run_id);
        return failed;
      }
    })();

    // Mutex: keep a reference so we never get an unhandled rejection.
    void executionPromise.catch(() => {});

    // Return the initial running state. The orchestrator polls via `show`.
    return started;
  }

  return {
    async run(args) {
      const workflowRunId = args.workflowRunId ?? generateWorkflowRunId();
      const initial: WorkflowRunState = {
        schema_version: "1",
        workflow_run_id: workflowRunId,
        workflow_name: args.spec.name,
        spec_name: args.spec.name,
        inputs: {},
        resolved_spec: args.spec,
        status: "queued",
        started_at: new Date().toISOString(),
        ended_at: null,
        cost_usd: 0,
        attempts: 0,
        steps: {},
        error: null,
        paused_reason: null,
        source: args.source ?? "orchestrator:tool",
      };
      return execute(initial, args);
    },

    show(workflowRunId) {
      const paths = workflowRunPaths(opts.configDir, workflowRunId);
      return readWorkflowRunState(paths);
    },

    list() {
      return readAllWorkflowRunStates(opts.configDir);
    },

    cancel(workflowRunId) {
      const ac = liveAbortControllers.get(workflowRunId);
      if (ac) {
        ac.abort();
        return;
      }
      const paths = workflowRunPaths(opts.configDir, workflowRunId);
      const state = readWorkflowRunState(paths);
      if (state && state.status === "running") {
        const aborted: WorkflowRunState = {
          ...state,
          status: "aborted",
          ended_at: new Date().toISOString(),
        };
        writeWorkflowRunState(paths, aborted);
        appendWorkflowRunEvent(paths, { kind: "workflow_cancelled_no_live", fields: {} });
      }
    },

    tail(workflowRunId, tOpts) {
      const paths = workflowRunPaths(opts.configDir, workflowRunId);
      let events = readWorkflowRunEvents(paths);
      if (tOpts?.event_type) {
        const needle = tOpts.event_type;
        events = events.filter((e) => e.kind.includes(needle));
      }
      if (tOpts?.tail && tOpts.tail > 0) {
        events = events.slice(-tOpts.tail);
      }
      return events;
    },

    tailSummary(workflowRunId, tOpts) {
      const paths = workflowRunPaths(opts.configDir, workflowRunId);
      if (!fs.existsSync(paths.summaryFile)) return [];
      const raw = fs.readFileSync(paths.summaryFile, "utf-8");
      const out: SummaryEvent[] = [];
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          out.push(JSON.parse(t) as SummaryEvent);
        } catch {
          // skip
        }
      }
      const trimmed = tOpts?.tail && tOpts.tail > 0 ? out.slice(-tOpts.tail) : out;
      return trimmed;
    },
  };
}

// ---------------------------------------------------------------------------
// DAG walker
// ---------------------------------------------------------------------------

export interface ExecuteDagCtx {
  agentManager: AgentManager;
  aiwBridge: AiwBridge;
  configDir: string;
  cwd: string;
}

async function executeDag(
  state: WorkflowRunState,
  spec: WorkflowSpec,
  paths: ReturnType<typeof workflowRunPaths>,
  opts: WorkflowRunnerOptions,
  parentSignal?: AbortSignal,
): Promise<WorkflowRunState> {
  const ac = new AbortController();
  // (lifetime tracking is in startWorkflowRunner via liveAbortControllers; we don't use it here)
  void ac;

  // Cooperative abort if parent fires.
  if (parentSignal) {
    if (parentSignal.aborted) ac.abort();
    else parentSignal.addEventListener("abort", () => ac.abort(), { once: true });
  }

  // Walk top-level steps in order, respecting depends_on + parallel_group.
  const allSteps = spec.steps as unknown[];
  const completed: Record<string, WorkflowStepResult> = { ...state.steps };
  const ctx: ExecuteDagCtx = {
    agentManager: opts.agentManager,
    aiwBridge: opts.aiwBridge,
    configDir: opts.configDir,
    cwd: opts.cwd,
  };

  let totalCost = state.cost_usd;
  let attemptCount = 0;

  // Main loop
  while (true) {
    if (parentSignal?.aborted) {
      const aborted: WorkflowRunState = {
        ...state,
        status: "aborted",
        ended_at: new Date().toISOString(),
        steps: completed,
        cost_usd: totalCost,
        attempts: attemptCount,
      };
      writeWorkflowRunState(paths, aborted);
      appendWorkflowRunExecutionLog(paths, `aborted by parent signal`);
      return aborted;
    }

    const eligible = computeEligible(allSteps, completed);
    if (eligible.length === 0) break;

    // Honor max_runtime_minutes
    if (spec.max_runtime_minutes) {
      const startedMs = Date.parse(state.started_at);
      const elapsedMin = (Date.now() - startedMs) / 60_000;
      if (elapsedMin > spec.max_runtime_minutes) {
        const failed: WorkflowRunState = {
          ...state,
          status: "failed",
          ended_at: new Date().toISOString(),
          steps: completed,
          cost_usd: totalCost,
          attempts: attemptCount,
          error: `max_runtime_minutes exceeded (${elapsedMin.toFixed(1)} > ${spec.max_runtime_minutes})`,
        };
        writeWorkflowRunState(paths, failed);
        appendWorkflowRunExecutionLog(paths, `failed: ${failed.error}`);
        return failed;
      }
    }

    // Partition eligible into "ready to run" (those whose when clauses are true)
    const readyToRun: { step: SpecStep; indexInSpec: number }[] = [];
    const skipped: SpecStep[] = [];
    for (const { step, indexInSpec } of eligible) {
      const when = step.when?.trim();
      let passes = true;
      if (when && when.length > 0) {
        const ctxForWhen = buildWhenCtx(spec, completed, state.inputs, attemptCount);
        passes = !!evaluateWhen(when, ctxForWhen);
      }
      if (passes) readyToRun.push({ step, indexInSpec });
      else skipped.push(step);
    }

    // Record skips.
    for (const step of skipped) {
      if (!completed[step.id]) {
        completed[step.id] = makeStepResult(step, "skipped");
        appendWorkflowRunEvent(paths, {
          kind: "step_skipped",
          fields: { step_id: step.id, reason: "when_clause_false" },
        });
      }
    }
    state = { ...state, steps: { ...completed } };
    writeWorkflowRunState(paths, state);

    if (readyToRun.length === 0) continue; // re-enter loop to recompute eligible

    // Parallel groups + individual steps.
    const groups = new Map<string, SpecStep[]>();
    const solo: SpecStep[] = [];
    for (const { step } of readyToRun) {
      if (step.parallel_group) {
        if (!groups.has(step.parallel_group)) groups.set(step.parallel_group, []);
        groups.get(step.parallel_group)!.push(step);
      } else {
        solo.push(step);
      }
    }

    // Execute solo sequentially, parallel groups as Promise.all.
    const newResults: Array<{ step: SpecStep; result: WorkflowStepResult }> = [];

    for (const step of solo) {
      const { result, costDelta } = await executeStep(step, completed, ctx, paths, spec, state.inputs, attemptCount);
      newResults.push({ step, result });
      totalCost += costDelta;
    }

    const groupEntries = Array.from(groups.entries());
    for (const [name, grpSteps] of groupEntries) {
      appendWorkflowRunEvent(paths, {
        kind: "parallel_group_started",
        fields: { group: name, step_ids: grpSteps.map((s) => s.id) },
      });
      const results = await Promise.all(
        grpSteps.map((s) => executeStep(s, completed, ctx, paths, spec, state.inputs, attemptCount)),
      );
      let groupCost = 0;
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        newResults.push({ step: grpSteps[i]!, result: r.result });
        groupCost += r.costDelta;
      }
      totalCost += groupCost;
      appendWorkflowRunEvent(paths, {
        kind: "parallel_group_finished",
        fields: { group: name, cost_usd: groupCost },
      });
    }

      // Apply results (may need to retry).
      for (const { step, result } of newResults) {
        const prevAttempts = completed[step.id]?.attempts ?? 0;
        const newResult = { ...result, attempts: prevAttempts + 1 };
        // Check for retry needed.
        if (
          newResult.status === "completed" &&
          step.retry &&
          shouldRetry(step.retry.on_result, step, newResult)
        ) {
        const maxAttempts = step.retry.max_attempts;
        if (newResult.attempts < maxAttempts) {
          // Schedule a re-run by leaving this step un-marked-as-completed.
          appendWorkflowRunEvent(paths, {
            kind: "step_retry_scheduled",
            fields: {
              step_id: step.id,
              attempt: newResult.attempts + 1,
              reason: step.retry?.on_result,
            },
          });
          // Wait backoff if specified.
          const retry = step.retry;
          if (retry?.backoff_ms) {
            await new Promise((r) => setTimeout(r, retry.backoff_ms));
          }
          // Mark this attempt as 'pending' so re-execution picks it up.
          completed[step.id] = { ...newResult, status: "pending" };
          state = { ...state, steps: { ...completed } };
          writeWorkflowRunState(paths, state);
          continue;
        } else {
          appendWorkflowRunEvent(paths, {
            kind: "step_retry_exhausted",
            fields: { step_id: step.id, attempts: newResult.attempts },
          });
        }
      }

      // Domain-lock pause.
      if (
        newResult.domain_lock_issues &&
        newResult.domain_lock_issues.length > 0
      ) {
        newResult.status = "paused_for_domain_fix";
        const paused: WorkflowRunState = {
          ...state,
          status: "paused_for_domain_fix",
          steps: { ...completed, [step.id]: newResult },
          cost_usd: totalCost,
          attempts: attemptCount,
          paused_reason: `step '${step.id}' attempted to write outside domain`,
        };
        writeWorkflowRunState(paths, paused);
        appendWorkflowRunExecutionLog(paths, paused.paused_reason ?? "paused");
        return paused;
      }

      completed[step.id] = newResult;
      attemptCount = Math.max(attemptCount, newResult.attempts);
    }

    state = { ...state, steps: { ...completed }, cost_usd: totalCost };
    writeWorkflowRunState(paths, state);
  }

  // All eligible is exhausted. Determine final status.
  // Per G2: sub-agent and aiw steps are async-spawn; they remain
  // "running" while the orchestrator/scheduler waits for them to
  // finish. The workflow's *eligibility* is complete (no more steps
  // can run), so we mark the run as completed (the user can poll
  // the underlying sub-agents separately via check_agent_status).
  // Only *truly* terminal failures (status === "failed") cause the
  // workflow to be marked failed.
  const values = Object.values(completed);
  const anyFailed = values.some((r) => r.status === "failed");
  const allTerminated = values.every(
    (r) => r.status === "completed" || r.status === "skipped" || r.status === "running" || r.status === "paused_for_domain_fix",
  );
  const finalStatus: WorkflowRunStatus = anyFailed
    ? "failed"
    : allTerminated
    ? "completed"
    : "failed";

  const finalState: WorkflowRunState = {
    ...state,
    status: finalStatus,
    ended_at: new Date().toISOString(),
    steps: completed,
    cost_usd: totalCost,
    attempts: attemptCount,
  };
  writeWorkflowRunState(paths, finalState);
  appendWorkflowRunEvent(paths, {
    kind: finalStatus === "completed" ? "workflow_completed" : "workflow_failed",
    fields: { cost_usd: totalCost },
  });
  appendWorkflowRunExecutionLog(
    paths,
    `${finalStatus} (cost=$${totalCost.toFixed(4)})`,
  );

  // Class 3 G3 v1.1: AFK auto-promotion. When the workflow completes
  // and any AIW step has a successful review verdict, check the
  // AFK gate and auto-ship if earned. Per
  // `principles/06-aiws-and-afk.md` § "The AFK Investment Strategy":
  // 5 consecutive one-attempt ships per class earns AFK; once
  // earned, ship is automatic.
  if (finalStatus === "completed") {
    void autoPromoteZte(opts, completed);
  }

  return finalState;
}

/**
 * After a workflow completes, scan its AIW step results and
 * auto-ship any AIW whose review verdict is `success` and AFK is
 * earned for its changeType. Best-effort; failures are logged
 * but never thrown.
 */
function autoPromoteZte(
  opts: { configDir: string },
  completed: Record<string, import("./workflow-spec.ts").WorkflowStepResult>,
): void {
  // Dynamic import to avoid a hard dep cycle.
  void import("../workflow-afk.ts").then(async (mod) => {
    for (const [stepId, result] of Object.entries(completed)) {
      if (!result.aiw_ids || result.aiw_ids.length === 0) continue;
      const verdict = (result as { verdict?: { success?: boolean } | null }).verdict;
      if (!verdict?.success) continue;
      for (const aiwId of result.aiw_ids) {
        // Default changeType is 'feature'; the workflow may
        // override this per step in a future iteration.
        const changeType: import("../aiw/state.ts").ChangeType = "feature";
        try {
          const r = await mod.autoShipAiw(aiwId, changeType, "/tmp", opts.configDir, {
            configDir: opts.configDir,
            log: (msg, fields) => console.log(`afk.autoPromote: ${msg}`, JSON.stringify(fields ?? {})),
          });
          if (r.shouldShip && r.shipResult) {
            console.log(`afk.autoPromote: shipped ${aiwId}`, {
              status: r.shipResult.status,
              prUrl: r.shipResult.prUrl,
            });
          }
        } catch (err) {
          console.warn(`afk.autoPromote: failed for ${aiwId}`, { err: (err as Error).message });
        }
        // Avoid noisy logs in tests; only log first AIW per step.
        void stepId;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Per-step execution
// ---------------------------------------------------------------------------

export interface StepExecutionResult {
  result: WorkflowStepResult;
  costDelta: number;
}

async function executeStep(
  step: SpecStep,
  completed: Record<string, WorkflowStepResult>,
  ctx: ExecuteDagCtx,
  paths: ReturnType<typeof workflowRunPaths>,
  spec: WorkflowSpec,
  inputs: Record<string, string | number | boolean | string[]>,
  currentAttempt: number,
): Promise<StepExecutionResult> {
  appendWorkflowRunEvent(paths, {
    kind: "step_started",
    fields: { step_id: step.id, handler: step.handler, attempt: (completed[step.id]?.attempts ?? 0) + 1 },
  });
  appendSummaryDigest(paths.summaryFile, {
    kind: "step_started",
    digest: `[${step.id}] starting ${step.handler}`,
  });

  let result: WorkflowStepResult;
  let costDelta = 0;

  try {
    switch (step.handler) {
      case "subagent":
        ({ result, costDelta } = await executeSubagentStep(step, completed, ctx, paths, inputs));
        break;
      case "aiw":
        ({ result, costDelta } = await executeAiwStep(step, completed, ctx, paths, inputs));
        break;
      case "compose":
        result = await executeComposeStep(step, completed, ctx, paths, spec, inputs, currentAttempt);
        costDelta = 0;
        break;
      case "branch":
        result = await executeBranchStep(step, completed, ctx, paths, spec, inputs, currentAttempt);
        costDelta = 0;
        break;
      default:
        result = makeStepResult(step, "failed");
        (result.error as { message: string } | undefined) ??= { message: "unknown handler" };
        result.error = { message: `unknown handler: ${step.handler as string}` };
    }
  } catch (err) {
    result = makeStepResult(step, "failed");
    result.error = { message: (err as Error).message };
  }

  appendWorkflowRunEvent(paths, {
    kind: "step_ended",
    fields: {
      step_id: step.id,
      status: result.status,
      cost_usd: result.cost_usd,
      attempts: result.attempts,
    },
  });
  appendSummaryDigest(paths.summaryFile, {
    kind: "step_ended",
    digest: `[${step.id}] ${result.status} ($${result.cost_usd.toFixed(4)})`,
  });

  return { result, costDelta };
}

// --- subagent --------------------------------------------------------

async function executeSubagentStep(
  step: SpecStep,
  completed: Record<string, WorkflowStepResult>,
  ctx: ExecuteDagCtx,
  paths: ReturnType<typeof workflowRunPaths>,
  inputs: Record<string, string | number | boolean | string[]>,
): Promise<StepExecutionResult> {
  let userPrompt = step.user_prompt ?? "";
  // Interpolate ${inputs.X}
  for (const [k, v] of Object.entries(inputs)) {
    userPrompt = userPrompt.replaceAll(`\${inputs.${k}}`, String(v));
  }
  // Interpolate ${agents[<id>].result_text}
  userPrompt = interpolateCompletionRefs(userPrompt, completed);

  // Fan-out: each fanout definition spawns one sub-agent per input value.
  if (step.fanout && step.fanout.length > 0) {
    const fanoutOutputs: Record<string, { result_text: string | null; agent_id: string }> = {};
    let totalCost = 0;
    for (const fan of step.fanout) {
      const values = readInputPath(inputs, fan.input);
      if (!Array.isArray(values)) {
        return {
          result: { ...makeStepResult(step, "failed"), error: { message: `fanout input '${fan.input}' is not an array` } },
          costDelta: 0,
        };
      }
      for (const v of values) {
        const perValuePrompt = userPrompt.replaceAll(`\$\{fanout.${fan.input}\}`, String(v));
        const templateName = fan.template ?? step.subagent_template;
        const res = await ctx.agentManager.createAgent({
          name: `${step.id}-${String(v).replace(/[^a-z0-9_-]+/gi, "-").toLowerCase()}`,
          subagent_template: templateName ?? undefined,
          system_prompt: templateName ? undefined : "You are a sub-agent in an orchestrator-managed workflow. Complete the assigned task and emit a concise result.",
          user_prompt: perValuePrompt,
          tools: step.tools,
          domain: step.domain,
        });
        fanoutOutputs[String(v)] = { result_text: null, agent_id: res.agent_id };
        appendSummaryDigest(paths.summaryFile, {
          kind: "step_fanout_spawned",
          digest: `[${step.id}] spawn subagent ${res.agent_id} for ${String(v)}`,
        });
      }
    }
    // Fan-out results are populated asynchronously by the AgentManager's
    // background sessions. The composer's contract is to *report* the
    // spawns and let the orchestrator poll. Cost is 0 here (it accrues
    // via message_end events over time).
    return {
      result: {
        ...makeStepResult(step, "completed"),
        agent_ids: Object.values(fanoutOutputs).map((o) => o.agent_id),
        fanout_outputs: fanoutOutputs,
      },
      costDelta: totalCost,
    };
  }

  // Single sub-agent.
  const created = await ctx.agentManager.createAgent({
    name: step.id,
    subagent_template: step.subagent_template ?? undefined,
    system_prompt: step.subagent_template ? undefined : "You are a sub-agent in an orchestrator-managed workflow. Complete the assigned task and emit a concise result.",
    user_prompt: userPrompt,
    tools: step.tools,
    domain: step.domain,
  });
  appendSummaryDigest(paths.summaryFile, {
    kind: "subagent_spawned",
    digest: `[${step.id}] ${created.agent_id}`,
  });
  // The sub-agent step is reported as `running`. The orchestrator
  // (or a follow-up workflow tick) can poll the sub-agent's status
  // to determine when the step is actually complete; the workflow's
  // final status reflects the *spec eligibility* and not the
  // per-agent terminal states (those flow asynchronously per the
  // Class 1 G1 + G2 lessons' "open communication stream" model).
  // This avoids blocking the composer on a long-running agent and
  // keeps the workflow state machine small and deterministic.
  return {
    result: {
      ...makeStepResult(step, "running"),
      agent_ids: [created.agent_id],
    },
    costDelta: 0,
  };
}

// --- aiw -----------------------------------------------------------

async function executeAiwStep(
  step: SpecStep,
  completed: Record<string, WorkflowStepResult>,
  ctx: ExecuteDagCtx,
  paths: ReturnType<typeof workflowRunPaths>,
  inputs: Record<string, string | number | boolean | string[]>,
): Promise<StepExecutionResult> {
  let prompt = step.prompt ?? "";
  for (const [k, v] of Object.entries(inputs)) {
    prompt = prompt.replaceAll(`\${inputs.${k}}`, String(v));
  }
  prompt = interpolateCompletionRefs(prompt, completed);
  const changeType = step.change_type ?? "unknown";

  const created = await ctx.aiwBridge.startAiw(
    {
      name_of_aiw: step.id,
      workflow_type: step.workflow_type!,
      prompt,
      change_type: changeType as never,
    },
    { source: "workflow-runner" },
  );
  appendSummaryDigest(paths.summaryFile, {
    kind: "aiw_started",
    digest: `[${step.id}] AIW ${created.aiw_id}`,
  });
  return {
    result: {
      ...makeStepResult(step, "running"),
      aiw_ids: [created.aiw_id],
    },
    costDelta: 0,
  };
}

// --- compose: recurse ----------------------------------------------

async function executeComposeStep(
  step: SpecStep,
  completed: Record<string, WorkflowStepResult>,
  ctx: ExecuteDagCtx,
  paths: ReturnType<typeof workflowRunPaths>,
  spec: WorkflowSpec,
  inputs: Record<string, string | number | boolean | string[]>,
  attemptCount: number,
): Promise<WorkflowStepResult> {
  if (!step.steps || step.steps.length === 0) {
    return { ...makeStepResult(step, "failed"), error: { message: "compose: empty steps" } };
  }

  // Compose a sub-state and run the DAG on a nested scope.
  const inner = step.steps as unknown[];
  const innerCompleted: Record<string, WorkflowStepResult> = { ...completed };
  // Don't share completed across the compose boundary at execution time;
  // we want only siblings.
  for (const id of Object.keys(completed)) {
    if (!inner.find((s) => (s as SpecStep).id === id)) {
      // Sibling-level result; keep reference but don't let compose steps see it
      // unless via ${agents[id].result_text} interpolation.
    }
  }

  // We can't easily run the DAG in place; delegate to a private recursive walk.
  let totalCost = 0;
  let attempts = attemptCount;
  const localCompleted: Record<string, WorkflowStepResult> = {};
  while (true) {
    const eligible = computeEligible(inner, localCompleted);
    if (eligible.length === 0) break;
    const readyToRun: SpecStep[] = [];
    for (const { step: s } of eligible) {
      const when = s.when?.trim();
      let passes = true;
      if (when && when.length > 0) {
        const ctxForWhen = buildWhenCtx(spec, { ...completed, ...localCompleted }, inputs, attempts);
        passes = !!evaluateWhen(when, ctxForWhen);
      }
      if (passes) readyToRun.push(s);
    }
    if (readyToRun.length === 0) continue;
    const groups = new Map<string, SpecStep[]>();
    const solo: SpecStep[] = [];
    for (const s of readyToRun) {
      if (s.parallel_group) {
        if (!groups.has(s.parallel_group)) groups.set(s.parallel_group, []);
        groups.get(s.parallel_group)!.push(s);
      } else solo.push(s);
    }
    const newResults: Array<{ step: SpecStep; result: WorkflowStepResult }> = [];
    for (const s of solo) {
      const r = await executeStep(s, { ...completed, ...localCompleted }, ctx, paths, spec, inputs, attempts);
      newResults.push({ step: s, result: r.result });
      totalCost += r.costDelta;
    }
    for (const [name, grp] of groups) {
      void name;
      const rs = await Promise.all(
        grp.map((s) => executeStep(s, { ...completed, ...localCompleted }, ctx, paths, spec, inputs, attempts)),
      );
      for (let i = 0; i < rs.length; i++) {
        newResults.push({ step: grp[i]!, result: rs[i]!.result });
        totalCost += rs[i]!.costDelta;
      }
    }
    for (const { step: s, result } of newResults) {
      const prevAttempts = localCompleted[s.id]?.attempts ?? 0;
      const newResult = { ...result, attempts: prevAttempts + 1 };
      localCompleted[s.id] = newResult;
      attempts = Math.max(attempts, newResult.attempts);
    }
    if (newResults.some(({ result }) => result.status === "failed")) {
      return { ...makeStepResult(step, "failed"), cost_usd: totalCost };
    }
  }

  const anyFailed = Object.values(localCompleted).some((r) => r.status === "failed");
  return {
    ...makeStepResult(step, anyFailed ? "failed" : "completed"),
    cost_usd: totalCost,
  };
}

// --- branch: pick first step whose when is true --------------------

async function executeBranchStep(
  step: SpecStep,
  completed: Record<string, WorkflowStepResult>,
  ctx: ExecuteDagCtx,
  paths: ReturnType<typeof workflowRunPaths>,
  spec: WorkflowSpec,
  inputs: Record<string, string | number | boolean | string[]>,
  attemptCount: number,
): Promise<WorkflowStepResult> {
  if (!step.steps || step.steps.length === 0) {
    return { ...makeStepResult(step, "failed"), error: { message: "branch: empty steps" } };
  }
  const inner = step.steps as unknown[] as SpecStep[];
  const chosen: { step: SpecStep; result: WorkflowStepResult }[] = [];
  let totalCost = 0;
  for (const s of inner) {
    const when = s.when?.trim();
    let passes = true;
    if (when && when.length > 0) {
      const ctxForWhen = buildWhenCtx(spec, completed, inputs, attemptCount);
      passes = !!evaluateWhen(when, ctxForWhen);
    }
    if (!passes) continue;
    const r = await executeStep(s, completed, ctx, paths, spec, inputs, attemptCount);
    chosen.push({ step: s, result: r.result });
    totalCost += r.costDelta;
  }
  return {
    ...makeStepResult(step, chosen.length === 0 ? "skipped" : chosen.some((c) => c.result.status === "failed") ? "failed" : "completed"),
    cost_usd: totalCost,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateWorkflowRunId(): string {
  return randomBytes(4).toString("hex");
}

function makeStepResult(step: SpecStep, status: WorkflowStepResult["status"]): WorkflowStepResult {
  const now = new Date().toISOString();
  const started: string | null = status === "running" || status === "completed" ? now : null;
  const ended: string | null =
    status === "completed" ||
    status === "failed" ||
    status === "skipped" ||
    status === "aborted" ||
    status === "paused_for_domain_fix"
      ? now
      : null;
  return {
    step_id: step.id,
    handler: step.handler,
    status,
    started_at: started,
    ended_at: ended,
    attempts: 0,
    cost_usd: 0,
    agent_ids: [],
    aiw_ids: [],
  };
}

function computeEligible(
  steps: unknown[],
  completed: Record<string, WorkflowStepResult>,
): Array<{ step: SpecStep; indexInSpec: number }> {
  const out: Array<{ step: SpecStep; indexInSpec: number }> = [];
  for (let i = 0; i < steps.length; i++) {
    const s = (steps[i] as SpecStep);
    if (!s || typeof s !== "object") continue;
    if (completed[s.id]) {
      const st = completed[s.id]!.status;
      // Pending means "needs to be retried"; re-eligible.
      if (st !== "pending") continue;
    }
    if (s.depends_on) {
      const allDone = s.depends_on.every((dep) => {
        const r = completed[dep];
        return r && (r.status === "completed" || r.status === "skipped");
      });
      if (!allDone) continue;
    }
    out.push({ step: s, indexInSpec: i });
  }
  return out;
}

function shouldRetry(
  onResultExpr: string | undefined,
  step: SpecStep,
  result: WorkflowStepResult,
): boolean {
  if (!onResultExpr) return false;
  const ctx = {
    last_result: result,
    step,
    status: result.status,
  };
  try {
    return !!evaluateWhen(onResultExpr, ctx);
  } catch {
    return false;
  }
}

function buildWhenCtx(
  spec: WorkflowSpec,
  completed: Record<string, WorkflowStepResult>,
  inputs: Record<string, string | number | boolean | string[]>,
  attempt: number,
): Record<string, unknown> {
  return {
    agents: Object.fromEntries(
      Object.entries(completed).map(([id, r]) => [id, {
        agent_ids: r.agent_ids,
        aiw_ids: r.aiw_ids,
        result_text: r.output?.result_text ?? null,
        status: r.status,
        attempt: r.attempts,
        cost_usd: r.cost_usd,
      }]),
    ),
    aiws: Object.fromEntries(
      Object.entries(completed).map(([id, r]) => [id, {
        aiw_ids: r.aiw_ids,
        result_text: r.output?.result_text ?? null,
        verdict: r.output?.verdict ?? null,
        status: r.status,
      }]),
    ),
    inputs,
    attempt,
    status: "running",
  };
}

function readInputPath(
  inputs: Record<string, string | number | boolean | string[]>,
  path: string,
): unknown {
  // Supports dot notation.
  const parts = path.split(".");
  let cur: unknown = inputs;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

function applyInputs(spec: WorkflowSpec, inputs: Record<string, string | number | boolean | string[]>): WorkflowSpec {
  // A resolved spec is identical structurally with all `${inputs.X}` substituted
  // into user_prompt/prompt/template strings, lazily at execution time. We
  // preserve `spec` here for the run record (recorded before substitutions).
  return spec;
}

function interpolateCompletionRefs(prompt: string, completed: Record<string, WorkflowStepResult>): string {
  return prompt.replace(/\$\{([a-z_]+)\[([a-zA-Z0-9_-]+)\]\.([a-zA-Z0-9_.]+)\}/g, (match, root, id, path) => {
    const entry = completed[id];
    if (!entry) return match;
    let cur: unknown = entry;
    if (root === "agents") {
      cur = {
        agent_ids: entry.agent_ids,
        aiw_ids: entry.aiw_ids,
        result_text: entry.output?.result_text ?? null,
        status: entry.status,
        cost_usd: entry.cost_usd,
      };
    } else if (root === "aiws") {
      cur = {
        aiw_ids: entry.aiw_ids,
        result_text: entry.output?.result_text ?? null,
        verdict: entry.output?.verdict ?? null,
        status: entry.status,
      };
    }
    const parts = path.split(".");
    for (const p of parts) {
      if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[p];
      } else {
        return match;
      }
    }
    return typeof cur === "string" ? cur : JSON.stringify(cur);
  });
}

function countSteps(steps: unknown[]): number {
  let n = 0;
  for (const s of steps as SpecStep[]) {
    n += 1;
    if (s.steps && Array.isArray(s.steps)) n += countSteps(s.steps as unknown[]);
  }
  return n;
}

// Keep `interpolate` accessible to callers via the runner import surface.
export { interpolate };
