// Interactive picker that asks the user which coding agents they want
// agentify to target. Runs AFTER auth (so the user is already talking to
// agentify) and BEFORE the audit (so the audit writes only to the selected
// targets' directories).
//
// The picker surfaces every entry in `AGENT_REGISTRY` and shows each
// agent's `skillsDir` as a hint so the user can see where the harness will
// look for skills. The premium targets (Claude Code, Codex, Pi) appear at
// the top of the list with their full label, then universal agents,
// then agent-specific agents in alphabetical order.
//
// Per design decision (see ADR 0018), the picker NEVER persists the
// choice — fresh prompt every run. The `--targets <csv>` flag in the CLI
// bypasses the picker entirely.

import { AGENT_REGISTRY, DEFAULT_AGENT_IDS, type AgentId } from "./agent-registry.ts";
import type { AgentifyUi } from "./types.ts";

/**
 * Run the multi-select picker. Returns the user's selected agent IDs in
 * the order they were registered. If the user picks nothing, falls back to
 * the three premium targets so the audit can still run.
 *
 * Non-interactive callers (tests, CI) should pass `options.targets`
 * directly to `runAgentifyApp` instead of going through this function.
 */
export async function promptTargets(ui: AgentifyUi): Promise<ReadonlyArray<AgentId>> {
  const choices = AGENT_REGISTRY.map((agent) => ({
    label: agent.label,
    value: agent.id,
    hint: agent.skillsDir,
  }));
  const selected = await ui.promptMultiSelect(
    "Which coding agent(s) are you targeting?\n" +
      "(Defaults pre-selected: Claude Code, Codex, Pi — enter 'all', 'none', or comma-separated numbers like '1,3,5')",
    choices,
  );
  if (selected.length === 0) {
    ui.info(
      "agentify: no agents selected — falling back to defaults (Claude Code, Codex, Pi).",
    );
    return DEFAULT_AGENT_IDS;
  }
  return selected as ReadonlyArray<AgentId>;
}