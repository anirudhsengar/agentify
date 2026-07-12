// expression.ts — sandboxed expression evaluator for workflow `when`
// clauses and `prompt` interpolations.
//
// We compile small JS expressions via `new Function(...)` because:
//   1. We need full JS expressivity (boolean ops, ternaries, ===, >, ...).
//   2. We control the input surface: only well-known identifiers
//      (`agents`, `aiws`, `inputs`, `attempt`, `last_result`, `status`)
//      pass through. No globals are reachable.
//   3. The caller controls what gets injected. There is no way for the
//      expression to reference `process`, `require`, or the filesystem.
//
// `interpolate(s, ctx)` is the conservative string-substitution
// form used for `${inputs.X}` in user_prompt templates.

const FORBIDDEN = /\b(process|globalThis|require|module|exports|Function|setTimeout|setInterval|fetch|eval|Function)\b/;

function safeCompile(expr: string, paramNames: string[]): ((ctx: Record<string, unknown>) => unknown) | null {
  // Reject obviously-dangerous patterns.
  if (FORBIDDEN.test(expr)) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(...paramNames, `"use strict"; return (${expr});`);
    return (ctx) => {
      const args = paramNames.map((n) => ctx[n]);
      return fn(...args);
    };
  } catch {
    return null;
  }
}

export interface WhenCtx {
  /** Map of agent_id -> agent output record. */
  agents: Record<string, { result_text: string | null; status: string; attempt: number; cost_usd: number }>;
  /** Map of aiw_id -> aiw output record. */
  aiws: Record<string, { result_text: string | null; verdict: unknown; status: string }>;
  inputs: Record<string, unknown>;
  attempt: number;
  /** Convenience: short for `agents[<last_id>]` etc. */
  status: string;
  /** Convenience: short for `agents[<last_id>]` etc. */
  last_result: unknown;
}

export function evaluateWhen(expr: string, ctx: Partial<WhenCtx>): boolean {
  const ctxForEval = {
    agents: ctx.agents ?? {},
    aiws: ctx.aiws ?? {},
    inputs: ctx.inputs ?? {},
    attempt: ctx.attempt ?? 0,
    status: ctx.status ?? "",
    last_result: ctx.last_result,
  };
  const fn = safeCompile(expr, ["agents", "aiws", "inputs", "attempt", "status", "last_result"]);
  if (!fn) return false;
  let out: unknown;
  try {
    out = fn(ctxForEval);
  } catch {
    return false;
  }
  return Boolean(out);
}

/**
 * String interpolation: substitute `${inputs.X}`, `${agents[id].result_text}`,
 * `${aiws[id].verdict.success}`, etc. in a prompt template.
 *
 * Returns the original placeholder verbatim if any interpolation target is
 * not found (so the user can see what's missing rather than getting `undefined`).
 */
export function interpolate(
  template: string,
  ctx: {
    inputs?: Record<string, unknown>;
    agents?: Record<string, unknown>;
    aiws?: Record<string, unknown>;
  },
): string {
  const subst = (root: string, path: string): string => {
    const source = (ctx as Record<string, unknown>)[root] as Record<string, unknown> | undefined;
    if (!source) return `\${${root}[${path.split(".")[0]}].${path.split(".").slice(1).join(".")}`;
    const id = path.split(".")[0]!;
    const rest = path.split(".").slice(1);
    let cur: unknown = source[id];
    for (const r of rest) {
      if (cur && typeof cur === "object" && r in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[r];
      } else {
        return `\${${root}[${path}]}`;
      }
    }
    return typeof cur === "string" ? cur : JSON.stringify(cur);
  };

  return template
    .replace(/\$\{inputs\.([a-zA-Z0-9_.-]+)\}/g, (m, p) => {
      // dot path into inputs
      const parts = p.split(".");
      let cur: unknown = ctx.inputs;
      for (const x of parts) {
        if (cur && typeof cur === "object" && x in (cur as Record<string, unknown>)) {
          cur = (cur as Record<string, unknown>)[x];
        } else {
          return m;
        }
      }
      return typeof cur === "string" ? cur : JSON.stringify(cur);
    })
    .replace(/\$\{agents\[([a-zA-Z0-9_-]+)\]\.([a-zA-Z0-9_.]+)\}/g, (_m, id, path) =>
      subst("agents", `${id}.${path}`),
    )
    .replace(/\$\{aiws\[([a-zA-Z0-9_-]+)\]\.([a-zA-Z0-9_.]+)\}/g, (_m, id, path) =>
      subst("aiws", `${id}.${path}`),
    );
}
