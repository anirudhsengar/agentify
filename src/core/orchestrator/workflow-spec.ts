// workflow-spec.ts — the schema for orchestrator developer workflows.
//
// A `WorkflowSpec` is the unit of composition for orchestrator workflows.
// It is a DAG of steps, each dispatching to one of the existing
// orchestrator primitives (subagent / aiw / compose / branch). The
// composer (`composer.ts`) walks the DAG deterministically; an LLM
// is *only* in the loop when a step's handler is one.
//
// The schema is the single source of truth: file-based specs
// (`.pi/workflows/*.json`), `run_workflow` tool input, and
// `compose_workflow` tool input all parse against the same TypeBox
// schemas. Invalid specs fail loudly at the seam — not at runtime.
//
// Per the lessons, workflows model the orchestrator/leads/workers
// pattern with the constraint that the orchestrator is the only
// spawner. Conditional orchestration (`when` clauses), parallelism
// (`parallel_group`), and retries (`retry`) are first-class fields.
//
// Storage format: JSON files (intentional — no new deps). The plan
// originally said YAML; JSON is a strict subset of YAML and avoids
// pulling a YAML parser into the runtime. Users with YAML habits
// can write a 1-line JSON equivalent for any workflow we ship.
//
// Recursive `steps` (for compose/branch) are NOT modeled in TypeBox
// recursion (TypeBox 1.2.9 has no ergonomic recursive helper).
// Instead, the schema accepts `steps` as `Type.Any()` and the
// structural checker (`checkStructural`) recurses manually. This
// matches the existing codebase's "validate structure imperatively"
// pattern (see `checkStructural` in `subagent-registry.ts`).

import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const WorkflowHandlerSchema = StringEnum(
  ["subagent", "aiw", "compose", "branch"] as const,
);
export type WorkflowHandler = Static<typeof WorkflowHandlerSchema>;

export const WorkflowStepStatusSchema = StringEnum(
  [
    "pending",
    "running",
    "completed",
    "failed",
    "skipped",
    "aborted",
    "paused_for_domain_fix",
  ] as const,
);
export type WorkflowStepStatus = Static<typeof WorkflowStepStatusSchema>;

export const WorkflowRunStatusSchema = StringEnum(
  [
    "queued",
    "running",
    "completed",
    "failed",
    "aborted",
    "paused_for_domain_fix",
  ] as const,
);
export type WorkflowRunStatus = Static<typeof WorkflowRunStatusSchema>;

// ---------------------------------------------------------------------------
// Step record schema (one row in a workflow run's per-step output)
// ---------------------------------------------------------------------------

export const WorkflowStepResultSchema = Type.Object({
  step_id: Type.String(),
  handler: WorkflowHandlerSchema,
  status: WorkflowStepStatusSchema,
  started_at: Type.Union([Type.String(), Type.Null()]),
  ended_at: Type.Union([Type.String(), Type.Null()]),
  attempts: Type.Number(),
  cost_usd: Type.Number(),
  /** Sub-agent ids spawned by this step (subagent handler). */
  agent_ids: Type.Array(Type.String()),
  /** AIW ids spawned by this step (aiw handler). */
  aiw_ids: Type.Array(Type.String()),
  /** When handler = subagent or aiw: the *output* of the leaf. */
  output: Type.Optional(
    Type.Object({
      result_text: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      aiw_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      verdict: Type.Optional(Type.Any()),
    }, { additionalProperties: false }),
  ),
  /** Fan-out outputs: keyed by the input value that produced them. */
  fanout_outputs: Type.Optional(
    Type.Record(Type.String(), Type.Any()),
  ),
  error: Type.Optional(
    Type.Object({
      message: Type.String(),
      step: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
  ),
  /** Domain lock issues encountered (non-fatal until max retries). */
  domain_lock_issues: Type.Optional(
    Type.Array(
      Type.Object({
        tool_name: Type.String(),
        path: Type.String(),
      }, { additionalProperties: false }),
    ),
  ),
}, { additionalProperties: false });

export type WorkflowStepResult = Static<typeof WorkflowStepResultSchema>;

// ---------------------------------------------------------------------------
// WorkflowStep (non-recursive at the TypeBox layer; recurse manually)
// ---------------------------------------------------------------------------

export const WorkflowStepSchema = Type.Object({
  id: Type.String({
    description:
      "Unique id within the spec. Referenced from `depends_on`, `parallel_group`, and `when` clauses.",
  }),
  description: Type.Optional(
    Type.String({ description: "Human-readable description; shown in logs." }),
  ),
  when: Type.Optional(
    Type.String({
      description:
        "JS-like expression over { agents, aiws, last_result, inputs, attempt }. Evaluated by the composer between steps; falsy → step is skipped.",
    }),
  ),
  parallel_group: Type.Optional(
    Type.String({
      description:
        "Steps sharing a group run in parallel (after their deps; the composer partitions the eligible set by group).",
    }),
  ),
  depends_on: Type.Optional(
    Type.Array(Type.String(), {
      description: "Step ids that must complete before this step runs.",
    }),
  ),
  retry: Type.Optional(
    Type.Object({
      max_attempts: Type.Number({ minimum: 1, maximum: 10, default: 3 }),
      on_result: Type.Optional(
        Type.String({
          description:
            "Expression that, when truthy, triggers a retry. e.g. `last_result.verdict.success === false`.",
        }),
      ),
      backoff_ms: Type.Optional(
        Type.Number({ minimum: 0, maximum: 60_000, default: 1000 }),
      ),
    }, { additionalProperties: false }),
  ),
  max_cost_usd: Type.Optional(
    Type.Number({ minimum: 0, description: "If exceeded, step is marked failed." }),
  ),
  handler: WorkflowHandlerSchema,

  // handler: subagent
  subagent_template: Type.Optional(Type.String()),
  user_prompt: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  tools: Type.Optional(Type.Array(Type.String())),
  domain: Type.Optional(Type.Array(Type.String())),

  // handler: aiw
  workflow_type: Type.Optional(
    StringEnum(
      [
        "plan_build",
        "plan_build_review",
        "plan_build_review_fix",
        "plan_build_review_ship",
      ] as const,
    ),
  ),
  prompt: Type.Optional(Type.String()),
  change_type: Type.Optional(
    StringEnum(["chore", "bug", "feature", "unknown"] as const),
  ),
  resumption_of: Type.Optional(
    Type.String({ description: "Aiw id of a prior AIW to resume (via runner.resume)." }),
  ),

  // handler: compose / branch — recursed manually (see checkStructural).
  steps: Type.Optional(Type.Array(Type.Any(), {
    description: "Nested steps for compose/branch handlers (validated recursively).",
  })),

  // fan-out (subagent / aiw)
  fanout: Type.Optional(
    Type.Array(
      Type.Object({
        input: Type.String({ description: "Path inside `inputs` (dot notation)." }),
        template: Type.Optional(Type.String()),
      }, { additionalProperties: false }),
    ),
  ),
}, { additionalProperties: false });

export type WorkflowStep = Static<typeof WorkflowStepSchema>;

// ---------------------------------------------------------------------------
// WorkflowSpec (top-level)
// ---------------------------------------------------------------------------

const INPUT_TYPES = StringEnum(
  ["string", "number", "boolean", "string-list", "object"] as const,
);

export const WorkflowInputSchema = Type.Object({
  type: INPUT_TYPES,
  description: Type.Optional(Type.String()),
  default: Type.Optional(Type.Union([
    Type.String(), Type.Number(), Type.Boolean(),
    Type.Array(Type.String()),
  ])),
  min: Type.Optional(Type.Number()),
  max: Type.Optional(Type.Number()),
  values: Type.Optional(Type.Array(Type.String())),
}, { additionalProperties: false });

export type WorkflowInput = Static<typeof WorkflowInputSchema>;

export const WorkflowSpecSchema = Type.Object({
  name: Type.String({
    description:
      "Unique name within the registry (e.g. 'plan_build_review_fix_loop'). Used by run_workflow tool and CLI.",
  }),
  description: Type.String({ description: "What the workflow does; surfaced in the orchestrator prompt." }),
  inputs: Type.Optional(
    Type.Record(Type.String(), WorkflowInputSchema, {
      description: "Declared inputs. `prompt` is special — most workflows take a `prompt` as the user-supplied request.",
    }),
  ),
  steps: Type.Array(Type.Any(), { minItems: 1, description: "Top-level steps (validated recursively)." }),
  parallelism: Type.Optional(
    StringEnum(["sequential", "parallel_when_possible"] as const, { default: "sequential" }),
  ),
  max_runtime_minutes: Type.Optional(
    Type.Number({ minimum: 1, maximum: 24 * 60 }),
  ),
  tags: Type.Optional(Type.Array(Type.String())),
}, { additionalProperties: false });

export type WorkflowSpec = Static<typeof WorkflowSpecSchema>;

// ---------------------------------------------------------------------------
// WorkflowRun state (the runtime mirror of a spec execution)
// ---------------------------------------------------------------------------

export const WorkflowRunStateSchema = Type.Object({
  schema_version: StringEnum(["1"] as const),
  workflow_run_id: Type.String({ description: "8-char unique id; default = auto-generated." }),
  workflow_name: Type.String(),
  spec_name: Type.String(),
  inputs: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Array(Type.String())])),
  resolved_spec: Type.Any({ description: "Spec with inputs substituted and `when` clauses recorded." }),
  status: WorkflowRunStatusSchema,
  started_at: Type.String(),
  ended_at: Type.Union([Type.String(), Type.Null()]),
  cost_usd: Type.Number(),
  attempts: Type.Number(),
  /** Step results keyed by id. */
  steps: Type.Record(Type.String(), WorkflowStepResultSchema),
  error: Type.Union([Type.String(), Type.Null()]),
  paused_reason: Type.Union([Type.String(), Type.Null()]),
  /** Source: which entry point produced this run. */
  source: Type.Union([
    StringEnum(["orchestrator:tool", "cli:orchestrator", "test"] as const),
    Type.String(),
  ]),
}, { additionalProperties: false });

export type WorkflowRunState = Static<typeof WorkflowRunStateSchema>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface SpecValidationResult {
  ok: boolean;
  value?: WorkflowSpec;
  errors: string[];
}

function stringifyError(e: unknown): string {
  if (!e) return "unknown error";
  if (typeof e === "string") return e;
  if (typeof e === "object" && e !== null) {
    const obj = e as Record<string, unknown>;
    const path = typeof obj.path === "string" ? `/${obj.path.replace(/^\//, "")}` : "";
    const message = (obj.message as string | undefined) ?? JSON.stringify(obj);
    return `${message}${path ? ` at ${path}` : ""}`;
  }
  return String(e);
}

export function validateWorkflowSpec(raw: unknown): SpecValidationResult {
  // Spec shape (non-recursive at this layer).
  if (!Value.Check(WorkflowSpecSchema, raw)) {
    const errors = [...Value.Errors(WorkflowSpecSchema, raw)].map(stringifyError);
    return { ok: false, errors };
  }
  const spec = raw as WorkflowSpec;

  // Recursive structural check.
  const structural = checkWorkflowStructural(spec);
  if (structural.errors.length > 0) {
    return { ok: false, errors: structural.errors };
  }
  return { ok: true, value: spec, errors: [] };
}

/**
 * Structural checks (recursive):
 *   1. Step ids unique at *every* depth.
 *   2. depends_on references valid step ids at the *same* depth.
 *   3. No cycles in depends_on.
 *   4. parallel_group references valid step ids (within same group).
 *   5. Handler-specific payload present.
 *   6. Nested `steps` (compose / branch) re-validate per-level.
 */
export function checkWorkflowStructural(spec: WorkflowSpec): { errors: string[]; ok: boolean } {
  const errors: string[] = [];
  collectStepErrors(spec.steps, [], errors);
  return { errors, ok: errors.length === 0 };
}

const VALID_HANDLERS = new Set<string>(["subagent", "aiw", "compose", "branch"]);

function collectStepErrors(
  steps: unknown,
  trail: string[],
  out: string[],
): void {
  if (!Array.isArray(steps)) {
    out.push(`steps must be an array (got ${typeof steps})${trail.length ? ` at ${trail.join(".")}` : ""}`);
    return;
  }
  const idsInGroup = new Set<string>();
  for (const raw of steps) {
    if (!raw || typeof raw !== "object") {
      out.push(`step must be an object at ${trail.join(".") || "root"}`);
      continue;
    }
    const step = raw as WorkflowStep;
    if (typeof step.id !== "string" || step.id.length === 0) {
      out.push(`step missing id at ${trail.join(".") || "root"}`);
      continue;
    }
    const pathHere = [...trail, step.id];
    if (idsInGroup.has(step.id)) {
      out.push(`duplicate step id '${step.id}' at ${trail.join(".") || "root"}`);
    }
    idsInGroup.add(step.id);

    // Validate handler (TypeBox enum isn't applied when steps is Type.Any).
    if (typeof step.handler !== "string" || !VALID_HANDLERS.has(step.handler)) {
      out.push(`step ${pathHere.join(".")}: invalid handler '${step.handler as string}' (must be subagent|aiw|compose|branch)`);
      continue;
    }

    // handler-specific required fields
    const handler = step.handler;
    if (handler === "subagent") {
      if (!step.subagent_template && !step.user_prompt) {
        out.push(`step ${pathHere.join(".")}: subagent handler requires subagent_template OR user_prompt`);
      }
    } else if (handler === "aiw") {
      if (!step.workflow_type || !step.prompt) {
        out.push(`step ${pathHere.join(".")}: aiw handler requires workflow_type and prompt`);
      }
    } else if (handler === "compose" || handler === "branch") {
      if (!step.steps || step.steps.length === 0) {
        out.push(`step ${pathHere.join(".")}: ${handler} handler requires non-empty steps`);
      } else {
        // Recurse, validating nested step ids in their own scope.
        collectStepErrors(step.steps, pathHere, out);
        // depends_on at this level must reference this level's ids.
        // (Cross-level deps are not allowed.)
        const localIds = new Set<string>();
        for (const s of step.steps as WorkflowStep[]) localIds.add(s.id);
        for (const s of step.steps as WorkflowStep[]) {
          for (const dep of s.depends_on ?? []) {
            if (!localIds.has(dep)) {
              out.push(`step ${[...pathHere, s.id].join(".")} depends_on unknown sibling '${dep}'`);
            }
          }
        }
      }
    }

    // depends_on at the same level
    for (const dep of step.depends_on ?? []) {
      if (!idsInGroup.has(dep)) {
        out.push(`step ${pathHere.join(".")} depends_on unknown sibling '${dep}'`);
      }
    }

    // parallel_group consistency
    if (step.parallel_group && step.depends_on) {
      for (const dep of step.depends_on) {
        // A step cannot share a parallel_group with any of its deps.
        const depInGroup = (steps as WorkflowStep[]).find(
          (s) => s.id === dep && s.parallel_group === step.parallel_group,
        );
        if (depInGroup) {
          out.push(`parallel_group '${step.parallel_group}' at ${pathHere.join(".")}: races dep '${dep}'`);
        }
      }
    }
  }

  // Cycle detection at this level (DFS on depends_on).
  const adj = new Map<string, string[]>();
  for (const s of steps as WorkflowStep[]) adj.set(s.id, s.depends_on ?? []);
  const color = new Map<string, number>();
  for (const id of idsInGroup) color.set(id, 0); // 0 = white
  function dfs(node: string, path: string[]): void {
    if (color.get(node) === 1) {
      out.push(`cycle in depends_on: ${[...path, node].join(" -> ")}`);
      return;
    }
    if (color.get(node) === 2) return;
    color.set(node, 1);
    const neighbors = adj.get(node) ?? [];
    for (const n of neighbors) {
      // Only follow deps within this level.
      if (idsInGroup.has(n)) dfs(n, [...path, node]);
    }
    color.set(node, 2);
  }
  for (const id of idsInGroup) if (color.get(id) === 0) dfs(id, []);
}

// ---------------------------------------------------------------------------
// Inputs coercion + validation against the declared schema
// ---------------------------------------------------------------------------

export interface InputsValidationResult {
  ok: boolean;
  errors: string[];
  coerced: Record<string, string | number | boolean | string[]>;
}

/**
 * Coerce + validate caller-supplied `inputs` against the spec's
 * declared `inputs`. Returns a normalized map of strings/numbers/
 * booleans/string-lists. Defaults are applied for missing keys.
 */
export function validateInputs(
  spec: WorkflowSpec,
  raw: Record<string, unknown> = {},
): InputsValidationResult {
  const errors: string[] = [];
  const out: Record<string, string | number | boolean | string[]> = {};

  const declared = spec.inputs ?? {};
  for (const [k, decl] of Object.entries(declared)) {
    let v = raw[k];
    if (v === undefined || v === null) {
      if (decl.default !== undefined) {
        v = decl.default;
      } else {
        errors.push(`inputs.${k} is required (no default)`);
        continue;
      }
    }
    switch (decl.type) {
      case "string":
        if (typeof v !== "string") {
          errors.push(`inputs.${k} must be a string (got ${typeof v})`);
        } else {
          out[k] = v;
        }
        break;
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v)) {
          errors.push(`inputs.${k} must be a finite number (got ${typeof v})`);
        } else if (decl.min !== undefined && v < decl.min) {
          errors.push(`inputs.${k} must be >= ${decl.min} (got ${v})`);
        } else if (decl.max !== undefined && v > decl.max) {
          errors.push(`inputs.${k} must be <= ${decl.max} (got ${v})`);
        } else {
          out[k] = v;
        }
        break;
      case "boolean":
        if (typeof v !== "boolean") {
          errors.push(`inputs.${k} must be a boolean (got ${typeof v})`);
        } else {
          out[k] = v;
        }
        break;
      case "string-list":
        if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
          errors.push(`inputs.${k} must be a string[]`);
        } else {
          out[k] = v as string[];
        }
        break;
      case "object":
        out[k] = JSON.stringify(v);
        break;
    }
  }

  return { ok: errors.length === 0, errors, coerced: out };
}

// ---------------------------------------------------------------------------
// Default spec name + ergonomic constants
// ---------------------------------------------------------------------------

/** A trivial smoke workflow used by tests and CLI smoke. */
export function defaultSmokeSpec(): WorkflowSpec {
  return {
    name: "smoke",
    description: "A minimal smoke workflow for tests. Spawns one subagent.",
    inputs: {},
    parallelism: "sequential",
    steps: [
      {
        id: "hello",
        handler: "subagent",
        user_prompt: "say hi",
      },
    ],
  };
}
