import * as fs from "node:fs";
import * as path from "node:path";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function assertEvalId(value: string, label: string): void {
  if (!SAFE_ID.test(value) || value === "." || value === ".." || decodeURIComponent(value) !== value) throw new Error(`invalid ${label}: ${value}`);
}
function safePath(root: string, ...parts: string[]): string {
  const resolvedRoot = path.resolve(root);
  const result = path.resolve(resolvedRoot, ...parts);
  if (path.relative(resolvedRoot, result).startsWith("..")) throw new Error("eval path escapes state directory");
  const relativeParts = path.relative(resolvedRoot, result).split(path.sep).filter(Boolean);
  for (let index = 0; index <= relativeParts.length; index += 1) {
    const cursor = path.join(resolvedRoot, ...relativeParts.slice(0, index));
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`eval path cannot contain symlinks: ${cursor}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return result;
}
export function evalRootPath(stateDir: string, engagementId: string): string { assertEvalId(engagementId, "engagement ID"); return safePath(stateDir, "engagements", engagementId, "evals"); }
export function evalSuitePath(stateDir: string, engagementId: string, suiteId: string): string { assertEvalId(suiteId, "suite ID"); return safePath(evalRootPath(stateDir, engagementId), "suites", `${suiteId}.json`); }
export function evalTaskPath(stateDir: string, engagementId: string, taskId: string): string { assertEvalId(taskId, "task ID"); return safePath(evalRootPath(stateDir, engagementId), "tasks", `${taskId}.json`); }
export function evalRunPath(stateDir: string, engagementId: string, runId: string): string { assertEvalId(runId, "run ID"); return safePath(evalRootPath(stateDir, engagementId), "runs", runId); }
