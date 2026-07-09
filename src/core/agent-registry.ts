// Coding-agent registry — the single source of truth for which coding agents
// agentify can target and where each one expects to find its skills on disk.
//
// Modeled after vercel-labs/skills `src/agents.ts` (the open agent-skills
// ecosystem). When the upstream registry changes, mirror the update here so
// the picker surfaces new agents to users. Only the project-relative
// `skillsDir` matters to agentify — global install dirs and detection
// helpers are intentionally out of scope: agentify always installs into the
// target repo, never the user's home directory.
//
// The three existing exporters (Codex / Claude / Pi) live in
// `artifact-exporters.ts` and are dispatched through `exportTarget`.
// Every other agent is handled by the generic `exportSkillPackToDir` writer
// in `artifact-exporters.ts`, which copies `packaged/skills/<name>` into the
// agent's `skillsDir`. Premium-target features (`.codex/agents/*.toml`,
// `.claude/agents/*.md`, `CLAUDE.md`) only apply to the three exporters.

import type { AgentifyTarget } from "./types.ts";

export type AgentId =
  | "aider-desk"
  | "amp"
  | "antigravity"
  | "antigravity-cli"
  | "astrbot"
  | "autohand-code"
  | "augment"
  | "bob"
  | "claude-code"
  | "openclaw"
  | "cline"
  | "codearts-agent"
  | "codebuddy"
  | "codemaker"
  | "codestudio"
  | "codex"
  | "command-code"
  | "continue"
  | "cortex"
  | "crush"
  | "cursor"
  | "deepagents"
  | "devin"
  | "dexto"
  | "droid"
  | "eve"
  | "firebender"
  | "forgecode"
  | "gemini-cli"
  | "github-copilot"
  | "goose"
  | "hermes-agent"
  | "inference-sh"
  | "iflow-cli"
  | "jazz"
  | "junie"
  | "kilo"
  | "kimi-code-cli"
  | "kiro-cli"
  | "kode"
  | "lingma"
  | "loaf"
  | "mcpjam"
  | "mistral-vibe"
  | "moxby"
  | "mux"
  | "neovate"
  | "opencode"
  | "openhands"
  | "ona"
  | "pi"
  | "qoder"
  | "qoder-cn"
  | "qwen-code"
  | "replit"
  | "reasonix"
  | "roo"
  | "rovodev"
  | "tabnine-cli"
  | "terramind"
  | "tinycloud"
  | "trae"
  | "trae-cn"
  | "warp"
  | "windsurf"
  | "zed"
  | "zencoder"
  | "zenflow"
  | "pochi"
  | "promptscript"
  | "adal";

/**
 * One entry per supported coding agent.
 *
 * - `skillsDir` is the project-relative directory the agent reads skills
 *   from. Universal agents share `.agents/skills`; agent-specific agents
 *   have their own (`.claude/skills`, `.pi/skills`, `.cursor/skills`, etc.).
 * - `exportTarget` is non-null only for the three premium targets whose
 *   full exporters live in `artifact-exporters.ts`. Other agents rely on
 *   the generic skill-pack writer and get the skill pack only — no
 *   feature-agent exports, no `CLAUDE.md`.
 */
export interface AgentConfig {
  id: AgentId;
  label: string;
  /** Project-relative directory (relative to the target repo root). */
  skillsDir: string;
  /** Non-null only for the three premium targets with full exporters. */
  exportTarget: AgentifyTarget | null;
}

/**
 * The full registry. Order matters for the picker UX — premium targets
 * (Claude Code, Codex, Pi) appear first so they're the visible default
 * pre-selection. Universal agents follow, then agent-specific agents in
 * alphabetical order. Each agent appears exactly once.
 */
export const AGENT_REGISTRY: ReadonlyArray<AgentConfig> = [
  // --- Premium targets (existing exporters in artifact-exporters.ts) ---
  { id: "claude-code", label: "Claude Code", skillsDir: ".claude/skills", exportTarget: "claude" },
  { id: "codex", label: "Codex", skillsDir: ".agents/skills", exportTarget: "codex" },
  { id: "pi", label: "Pi", skillsDir: ".pi/skills", exportTarget: "pi" },

  // --- Universal agents (share .agents/skills; skill pack written once) ---
  { id: "amp", label: "Amp", skillsDir: ".agents/skills", exportTarget: null },
  { id: "antigravity", label: "Antigravity", skillsDir: ".agents/skills", exportTarget: null },
  { id: "antigravity-cli", label: "Antigravity CLI", skillsDir: ".agents/skills", exportTarget: null },
  { id: "cline", label: "Cline", skillsDir: ".agents/skills", exportTarget: null },
  { id: "cursor", label: "Cursor", skillsDir: ".agents/skills", exportTarget: null },
  { id: "deepagents", label: "Deep Agents", skillsDir: ".agents/skills", exportTarget: null },
  { id: "dexto", label: "Dexto", skillsDir: ".agents/skills", exportTarget: null },
  { id: "firebender", label: "Firebender", skillsDir: ".agents/skills", exportTarget: null },
  { id: "gemini-cli", label: "Gemini CLI", skillsDir: ".agents/skills", exportTarget: null },
  { id: "github-copilot", label: "GitHub Copilot", skillsDir: ".agents/skills", exportTarget: null },
  { id: "kimi-code-cli", label: "Kimi Code CLI", skillsDir: ".agents/skills", exportTarget: null },
  { id: "loaf", label: "Loaf", skillsDir: ".agents/skills", exportTarget: null },
  { id: "opencode", label: "OpenCode", skillsDir: ".agents/skills", exportTarget: null },
  { id: "promptscript", label: "PromptScript", skillsDir: ".agents/skills", exportTarget: null },
  { id: "replit", label: "Replit", skillsDir: ".agents/skills", exportTarget: null },
  { id: "warp", label: "Warp", skillsDir: ".agents/skills", exportTarget: null },
  { id: "zed", label: "Zed", skillsDir: ".agents/skills", exportTarget: null },

  // --- Agent-specific directories (one skillsDir per agent) ---
  { id: "adal", label: "AdaL", skillsDir: ".adal/skills", exportTarget: null },
  { id: "aider-desk", label: "AiderDesk", skillsDir: ".aider-desk/skills", exportTarget: null },
  { id: "astrbot", label: "AstrBot", skillsDir: "data/skills", exportTarget: null },
  { id: "augment", label: "Augment", skillsDir: ".augment/skills", exportTarget: null },
  { id: "autohand-code", label: "Autohand Code CLI", skillsDir: ".autohand/skills", exportTarget: null },
  { id: "bob", label: "IBM Bob", skillsDir: ".bob/skills", exportTarget: null },
  { id: "codearts-agent", label: "CodeArts Agent", skillsDir: ".codeartsdoer/skills", exportTarget: null },
  { id: "codebuddy", label: "CodeBuddy", skillsDir: ".codebuddy/skills", exportTarget: null },
  { id: "codemaker", label: "Codemaker", skillsDir: ".codemaker/skills", exportTarget: null },
  { id: "codestudio", label: "Code Studio", skillsDir: ".codestudio/skills", exportTarget: null },
  { id: "command-code", label: "Command Code", skillsDir: ".commandcode/skills", exportTarget: null },
  { id: "continue", label: "Continue", skillsDir: ".continue/skills", exportTarget: null },
  { id: "cortex", label: "Cortex Code", skillsDir: ".cortex/skills", exportTarget: null },
  { id: "crush", label: "Crush", skillsDir: ".crush/skills", exportTarget: null },
  { id: "devin", label: "Devin for Terminal", skillsDir: ".devin/skills", exportTarget: null },
  { id: "droid", label: "Droid", skillsDir: ".factory/skills", exportTarget: null },
  { id: "eve", label: "Eve", skillsDir: "agent/skills", exportTarget: null },
  { id: "forgecode", label: "ForgeCode", skillsDir: ".forge/skills", exportTarget: null },
  { id: "goose", label: "Goose", skillsDir: ".goose/skills", exportTarget: null },
  { id: "hermes-agent", label: "Hermes Agent", skillsDir: ".hermes/skills", exportTarget: null },
  { id: "iflow-cli", label: "iFlow CLI", skillsDir: ".iflow/skills", exportTarget: null },
  { id: "inference-sh", label: "inference.sh", skillsDir: ".inferencesh/skills", exportTarget: null },
  { id: "jazz", label: "Jazz", skillsDir: ".jazz/skills", exportTarget: null },
  { id: "junie", label: "Junie", skillsDir: ".junie/skills", exportTarget: null },
  { id: "kilo", label: "Kilo Code", skillsDir: ".kilocode/skills", exportTarget: null },
  { id: "kiro-cli", label: "Kiro CLI", skillsDir: ".kiro/skills", exportTarget: null },
  { id: "kode", label: "Kode", skillsDir: ".kode/skills", exportTarget: null },
  { id: "lingma", label: "Lingma", skillsDir: ".lingma/skills", exportTarget: null },
  { id: "mcpjam", label: "MCPJam", skillsDir: ".mcpjam/skills", exportTarget: null },
  { id: "mistral-vibe", label: "Mistral Vibe", skillsDir: ".vibe/skills", exportTarget: null },
  { id: "moxby", label: "Moxby", skillsDir: ".moxby/skills", exportTarget: null },
  { id: "mux", label: "Mux", skillsDir: ".mux/skills", exportTarget: null },
  { id: "neovate", label: "Neovate", skillsDir: ".neovate/skills", exportTarget: null },
  { id: "ona", label: "Ona", skillsDir: ".ona/skills", exportTarget: null },
  { id: "openhands", label: "OpenHands", skillsDir: ".openhands/skills", exportTarget: null },
  { id: "openclaw", label: "OpenClaw", skillsDir: "skills", exportTarget: null },
  { id: "pochi", label: "Pochi", skillsDir: ".pochi/skills", exportTarget: null },
  { id: "qoder", label: "Qoder", skillsDir: ".qoder/skills", exportTarget: null },
  { id: "qoder-cn", label: "Qoder CN", skillsDir: ".qoder/skills", exportTarget: null },
  { id: "qwen-code", label: "Qwen Code", skillsDir: ".qwen/skills", exportTarget: null },
  { id: "reasonix", label: "Reasonix", skillsDir: ".reasonix/skills", exportTarget: null },
  { id: "roo", label: "Roo Code", skillsDir: ".roo/skills", exportTarget: null },
  { id: "rovodev", label: "Rovo Dev", skillsDir: ".rovodev/skills", exportTarget: null },
  { id: "tabnine-cli", label: "Tabnine CLI", skillsDir: ".tabnine/agent/skills", exportTarget: null },
  { id: "terramind", label: "Terramind", skillsDir: ".terramind/skills", exportTarget: null },
  { id: "tinycloud", label: "Tinycloud", skillsDir: ".tinycloud/skills", exportTarget: null },
  { id: "trae", label: "Trae", skillsDir: ".trae/skills", exportTarget: null },
  { id: "trae-cn", label: "Trae CN", skillsDir: ".trae/skills", exportTarget: null },
  { id: "windsurf", label: "Windsurf", skillsDir: ".windsurf/skills", exportTarget: null },
  { id: "zencoder", label: "Zencoder", skillsDir: ".zencoder/skills", exportTarget: null },
  { id: "zenflow", label: "Zenflow", skillsDir: ".zencoder/skills", exportTarget: null },
];

const AGENT_BY_ID: ReadonlyMap<AgentId, AgentConfig> = new Map(
  AGENT_REGISTRY.map((agent) => [agent.id, agent]),
);

/**
 * Type guard: true iff `value` is a known agent ID. The registry is the
 * runtime source of truth — any string passing this guard is guaranteed to
 * have an entry in `AGENT_REGISTRY`.
 */
export function isKnownAgent(value: string): value is AgentId {
  return AGENT_BY_ID.has(value as AgentId);
}

/** Look up an agent config by ID. Returns undefined for unknown IDs. */
export function getAgentById(id: AgentId): AgentConfig | undefined {
  return AGENT_BY_ID.get(id);
}

/**
 * Returns the unique project-relative skill directories for a list of
 * selected agents, preserving first-occurrence order. Universal agents
 * that share `.agents/skills` (Codex, Cursor, OpenCode, …) collapse to a
 * single entry — the skill pack is written once, not N times.
 */
export function getUniqueSkillsDirs(ids: ReadonlyArray<AgentId>): ReadonlyArray<string> {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    const agent = AGENT_BY_ID.get(id);
    if (!agent) continue;
    if (seen.has(agent.skillsDir)) continue;
    seen.add(agent.skillsDir);
    result.push(agent.skillsDir);
  }
  return result;
}

/**
 * Returns the subset of `AgentifyTarget` values that the selected agents
 * cover. De-duplicates and preserves first-occurrence order. Agents without
 * an `exportTarget` (the generic skill-pack-only agents) are filtered out.
 */
export function getPremiumTargets(ids: ReadonlyArray<AgentId>): ReadonlyArray<AgentifyTarget> {
  const seen = new Set<AgentifyTarget>();
  const result: AgentifyTarget[] = [];
  for (const id of ids) {
    const agent = AGENT_BY_ID.get(id);
    if (!agent || agent.exportTarget === null) continue;
    if (seen.has(agent.exportTarget)) continue;
    seen.add(agent.exportTarget);
    result.push(agent.exportTarget);
  }
  return result;
}

/**
 * The IDs of the three premium targets. Used as the picker's default
 * pre-selection and as the non-interactive fallback when stdin is not a
 * TTY.
 */
export const DEFAULT_AGENT_IDS: ReadonlyArray<AgentId> = ["claude-code", "codex", "pi"];
