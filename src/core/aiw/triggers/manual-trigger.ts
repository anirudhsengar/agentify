// triggers/manual-trigger.ts — synchronous wrapper around the AIW runner.
//
// The trigger runs synchronously: it spawns the AIW runner, blocks
// until the workflow completes, and prints a summary. It is library
// code, not a CLI command — the public `agentify` entrypoint rejects
// subcommands.

import { startAiwRunner, totals, durationMs } from "../index.ts";
import type { ChangeType, WorkflowName } from "../state.ts";
import { defaultConfigDir } from "../../agentify-config.ts";
import { PiSdkRuntime } from "../../pi-sdk-runtime.ts";

export interface ManualTriggerOptions {
  cwd: string;
  workflow: WorkflowName;
  prompt: string;
  model?: string | null;
  thinkingLevel?: string | null;
  modelRole?: "primary" | "explorer" | "lite" | null;
  aiwId?: string;
  noWorktree?: boolean;
  changeType?: ChangeType;
  force?: boolean;
  runtime?: import("../../../core/types.ts").AgentRuntime;
  logger?: (msg: string) => void;
}

export async function runManualTrigger(options: ManualTriggerOptions): Promise<void> {
  const configDir = defaultConfigDir();
  const log = options.logger ?? ((m: string) => process.stdout.write(`${m}\n`));

  const runner = startAiwRunner({
    configDir,
    cwd: options.cwd,
    runtime: options.runtime ?? new PiSdkRuntime(),
    noWorktree: options.noWorktree,
    logger: (paths) => ({
      info: (m, f) => log(`[info] ${m}${f ? " " + JSON.stringify(f) : ""}`),
      warn: (m, f) => log(`[warn] ${m}${f ? " " + JSON.stringify(f) : ""}`),
      error: (m, f) => log(`[error] ${m}${f ? " " + JSON.stringify(f) : ""}`),
    }),
  });

  log(`AIW starting — workflow=${options.workflow} cwd=${options.cwd}`);
  const finalState = await runner.run({
    workflow: options.workflow,
    prompt: options.prompt,
    aiwId: options.aiwId,
    workingDir: options.cwd,
    model: options.model ?? null,
    thinkingLevel: options.thinkingLevel ?? null,
    modelRole: options.modelRole ?? null,
    source: "cli:manual",
    changeType: options.changeType,
    force: options.force,
  });

  const t = totals(finalState);
  const ms = durationMs(finalState);
  log("");
  log(`AIW ${finalState.aiw_id} ${finalState.status.toUpperCase()}`);
  log(`  workflow:     ${finalState.workflow}`);
  log(`  branch:       ${finalState.branch_name}`);
  log(`  worktree:     ${finalState.worktree_path}`);
  log(`  ports:        backend=${finalState.backend_port} frontend=${finalState.frontend_port}`);
  log(`  duration:     ${ms !== null ? `${(ms / 1000).toFixed(1)}s` : "?"}`);
  log(`  cost:         $${t.costUsd.toFixed(4)}`);
  log(`  turns:        ${t.turns}`);
  log(`  attempts:     ${finalState.attempts}`);
  for (const phase of finalState.phases) {
    log(`  phase ${phase.phase.padEnd(8)} ${phase.status.padEnd(8)} ${phase.turns} turns`);
  }
  if (finalState.implement_result_path) {
    log(`  impl_result:  ${finalState.implement_result_path}`);
  }
  if (finalState.review_result_path) {
    log(`  review:       ${finalState.review_result_path}`);
  }
  if (finalState.error_message) {
    log(`  error:        ${finalState.error_message}`);
    log(`  step:         ${finalState.error_step ?? "?"}`);
    process.exitCode = 1;
  }
}