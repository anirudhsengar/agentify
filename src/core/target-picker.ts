// Interactive picker that asks the user which skills directories
// agentify should populate. Runs AFTER auth (so the user is already
// talking to agentify) and BEFORE the audit (so the audit writes only
// to the selected targets' directories).
//
// UX design (revised for the 0.2.x release):
//
//   * The agent registry is grouped by `skillsDir` rather than shown
//     per-agent. The registry currently exposes ~70 AgentIds across
//     ~51 unique project-relative skills directories — every universal
//     agent (Amp, Cursor, OpenCode, Windsurf, …) and Codex itself all
//     read from `.agents/skills`, so listing them individually just
//     repeated the same directory 18 times. Grouping by directory
//     collapses the picker to ~51 entries with no loss of fidelity:
//     the skill pack is written once per skillsDir (see
//     `getUniqueSkillsDirs`), and the premium exporters fire
//     automatically when the directory is read by a premium target.
//
//   * The picker returns the SELECTED SKILL DIRECTORIES, not AgentIds.
//     Conversion to (premium targets, additional agent IDs) happens
//     at the call site (`agentify-app.ts:resolveTargets`). Each
//     selected directory is mapped to:
//       - the premium target that reads from it (Codex / Claude / Pi),
//         if any — fires the full premium exporter for that agent;
//       - otherwise the first non-premium AgentId that reads from it
//         — registers the directory for the generic skill-pack writer.
//
//   * The picker is rendered by a custom checkbox implementation in
//     `ui/checkbox-picker.ts`, NOT by `clack.multiselect` or
//     `clack.groupMultiselect`. clack's diff-based frame renderer
//     can leave visual artefacts (stacked frames) when the per-frame
//     line count shifts between renders, which is unacceptable for
//     a list of this size.
//
//   * The three premium skills directories (.claude/skills,
//     .agents/skills, .pi/skills) are pre-selected so the common case
//     is a single Enter. The cursor is parked on .claude/skills.
//
//   * `--targets <csv>` on the CLI bypasses the picker entirely; the
//     flag continues to accept AgentIds (unchanged from prior releases)
//     and `resolveTargets` filters them through `isKnownAgent`.
//
//   * Per design decision, the picker NEVER persists the choice — fresh
//     prompt every run.

import {
  AGENT_REGISTRY,
  type AgentId,
} from "./agent-registry.ts";
import type { AgentifyUi } from "./types.ts";

interface DirChoice {
  label: string;
  value: string;
  hint: string;
}

/**
 * Group the registry by `skillsDir` and produce one picker option per
 * unique directory. Options are sorted by "popularity" (count of
 * agents per directory, descending) so the entries the user is most
 * likely to want stay near the top of the picker.
 */
function buildSkillsDirChoices(): ReadonlyArray<DirChoice> {
  // Aggregate AgentIds per skillsDir.
  const byDir = new Map<
    string,
    Array<{ id: AgentId; label: string; isPremium: boolean }>
  >();
  for (const agent of AGENT_REGISTRY) {
    const entry = {
      id: agent.id,
      label: agent.label,
      isPremium: agent.exportTarget !== null,
    };
    const list = byDir.get(agent.skillsDir);
    if (list) {
      list.push(entry);
    } else {
      byDir.set(agent.skillsDir, [entry]);
    }
  }

  // Sort directories: most-popular first, alphabetical within ties.
  const sortedDirs = Array.from(byDir.entries()).sort((a, b) => {
    const countDelta = b[1].length - a[1].length;
    if (countDelta !== 0) return countDelta;
    return a[0].localeCompare(b[0]);
  });

  return sortedDirs.map(([skillsDir, agents]) => {
    const names = agents.map((agent) => agent.label);
    const hint =
      names.length <= 4
        ? names.join(", ")
        : `${names.slice(0, 3).join(", ")}, +${names.length - 3} more`;
    return {
      label: skillsDir,
      value: skillsDir,
      hint,
    };
  });
}

/**
 * Run the checkbox picker. Returns the user-selected skills
 * directories in registry-popularity order. If the user picks
 * nothing, falls back to the three premium skills directories so the
 * audit can still run.
 *
 * Non-interactive callers (tests, CI) should pass `options.targets`
 * directly to `runAgentifyApp` instead of going through this function.
 */
export async function promptTargets(
  ui: AgentifyUi,
): Promise<ReadonlyArray<string>> {
  const choices = buildSkillsDirChoices();

  const message = "Which skills directories should agentify populate?";

  const selected = await ui.promptCheckboxList(message, choices, {
    initialValues: [".claude/skills", ".agents/skills", ".pi/skills"],
    cursorAt: ".claude/skills",
  });

  if (selected.length === 0) {
    ui.info(
      "agentify: no skills directories selected — falling back to defaults (.claude/skills, .agents/skills, .pi/skills).",
    );
    return [".claude/skills", ".agents/skills", ".pi/skills"];
  }

  // Filter to known skillsDirs (defensive — the UI may surface
  // user-typed values in the future) and preserve registry order so
  // downstream consumers see a stable sequence.
  const knownDirs = new Set<string>(
    AGENT_REGISTRY.map((agent) => agent.skillsDir),
  );
  const filtered = selected.filter((dir: string): dir is string => knownDirs.has(dir));
  if (filtered.length === 0) {
    ui.info(
      "agentify: no recognized skills directories selected — falling back to defaults (.claude/skills, .agents/skills, .pi/skills).",
    );
    return [".claude/skills", ".agents/skills", ".pi/skills"];
  }
  return filtered;
}

/**
 * Convert a list of selected skills directories into the
 * (premium targets, additional agent IDs) shape consumed by
 * `runAgentifyApp`. Each selected directory is mapped to:
 *
 *   - the premium target that reads from it (Codex / Claude / Pi),
 *     if any — fires the full premium exporter for that agent;
 *   - otherwise the first AgentId that reads from it — registers
 *     the directory for the generic skill-pack writer. Multiple
 *     non-premium agents reading from the same directory collapse
 *     to a single entry (the skill pack is written once per dir,
 *     so listing each agent would be redundant).
 *
 * This keeps the rest of the pipeline agnostic to whether the user
 * picked directories (interactive) or AgentIds (CLI flag).
 */
export function resolveSkillsDirsToAgents(
  dirs: ReadonlyArray<string>,
): { targets: ReadonlyArray<string>; additionalAgents: ReadonlyArray<string> } {
  const targets: string[] = [];
  const additionalAgents: string[] = [];
  const seenDirs = new Set<string>();

  for (const agent of AGENT_REGISTRY) {
    if (!dirs.includes(agent.skillsDir)) continue;
    if (seenDirs.has(agent.skillsDir)) continue;
    seenDirs.add(agent.skillsDir);
    if (agent.exportTarget !== null) {
      targets.push(agent.exportTarget);
    } else {
      additionalAgents.push(agent.id);
    }
  }

  return { targets, additionalAgents };
}
