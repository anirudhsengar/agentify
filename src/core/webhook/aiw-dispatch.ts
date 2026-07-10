// aiw-dispatch.ts — bridge from the webhook trigger surface to the
// AIW engine.
//
// When a trigger declares `prompt.aiw_workflow`, the server routes
// the request through this module instead of the single-prompt
// path. The dispatcher:
//
//   1. Generates an aiw_id (16 hex chars).
//   2. Composes a `prompt` string from the trigger's args.
//   3. Enqueues an AIW task on the shared JSONL queue
//      (the same queue the webhook single-prompt worker reads from).
//   4. Returns the task record, identical shape to a single-prompt
//      task — the webhook server's response is unchanged from the
//      caller's perspective.
//
// The webhook worker (or the AIW worker, when it's installed) picks
// the record up. The dispatcher doesn't care which worker is running;
// the queue is the seam.

import {
  enqueueAiwTask,
} from "../aiw/worker.ts";
import { generateAiwId } from "../aiw/state.ts";
import {
  TaskStatus,
  type Trigger,
  type WebhookTaskRecord,
} from "./state.ts";

export interface DispatchAiwArgs {
  trigger: Trigger;
  /** The composed prompt string (args merged from static / query / payload). */
  promptText: string;
  /** Resolved args (what the workflow's userPrompt will reference). */
  args: Record<string, string>;
  configDir: string;
  /** The trigger's cwd override (or the registry's project cwd). */
  cwd: string;
  /** HTTP context for the webhook task record. */
  http: WebhookTaskRecord["http"];
}

export interface DispatchAiwResult {
  record: WebhookTaskRecord;
  workflow: "plan_build" | "plan_build_review" | "plan_build_review_fix" | "plan_build_review_ship";
  aiwId: string;
}

/**
 * Enqueue an AIW task from a webhook request. The trigger's
 * `aiw_workflow` field is required; this function asserts.
 */
export function dispatchAiwTask(args: DispatchAiwArgs): DispatchAiwResult {
  const workflow = args.trigger.prompt.aiw_workflow;
  if (!workflow) {
    throw new Error("dispatchAiwTask called for a trigger without aiw_workflow");
  }
  const aiwId = generateAiwId();
  const record = enqueueAiwTask({
    configDir: args.configDir,
    triggerId: `aiw-${args.trigger.id}`,
    aiwId,
    workflow,
    prompt: args.promptText,
    source: `webhook:${args.trigger.id}`,
    cwd: args.cwd,
    http: args.http,
    tools: args.trigger.prompt.tools ?? [],
  });
  return { record, workflow, aiwId };
}

/**
 * Predicate: does this trigger declare an AIW workflow?
 */
export function triggerRoutesToAiw(trigger: Trigger): boolean {
  return trigger.prompt.aiw_workflow !== undefined
      && trigger.prompt.aiw_workflow !== null;
}