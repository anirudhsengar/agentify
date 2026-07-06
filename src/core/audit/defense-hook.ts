// Defense-in-depth hook for standalone agentify sessions.
// Scoped to only fire when an agentify run is active (see state.ts).
//
// Layers:
//
//   Layer A — `bash` tool:
//     1. SHELL_OPERATORS pre-rejection. Catches `&&`, `||`, `;`, `|`,
//        backticks, `$(...)`, `>`, `<` before any other check. This
//        stops `npm test && rm -rf` — the kind of payload that
//        passes a naive whitelist match on `npm test`.
//     2. Pattern blacklist. Recursive deletes, force push, env
//        dumps, curl uploads, dangerous chmods, etc.
//     3. Script-content scanner. When the bash command is
//        `python <file>`, `node <file>`, `bash <file>`, `sh <file>`,
//        the hook reads the first 64 KB of the file and re-runs the
//        bash blacklist against its contents. This closes the
//        "Marquee Break" attack pattern
//        (`write cleanup.py && python cleanup.py`).
//
//   Layer B — path-sensitive read/write tools:
//     Zero-access path guard. The LLM can reach .env / secrets /
//     ~/.ssh / /etc directly via the `read` tool, which never goes
//     through the bash layer. The hook blocks these regardless of
//     how the LLM tries to access them. The path is looked up under
//     multiple parameter names (`path`, `filePath`, `filepath`, etc.;
//     see defense/paths.ts).
//
//   Layer C — `create_agent` tool:
//     *Sub-agents* have NO `create_agent` (defense hook blocks it). This
//     is the depth cap (1 in G1).
//
//   Layer D — `escalate_to_orchestrator` tool (orchestrator workflows):
//     *Allowed* in sub-agent sessions whose parent is the live
//     orchestrator session (depth 1 → 2). Blocked in deeper sessions.
//
//   Layer E — `write` / `edit` / `write_file` / `multi_edit` tools
//     (orchestrator workflows): domain lock check. Reads `parent_session_id`
//     from the active agent's AgentState; if the agent's `domain`
//     is set and the target path doesn't match, the write is blocked.
//     Reads are NOT blocked.
//
// This is the floor for agentify-managed sessions. The audit runs
// in the user's own codebase; deeper restrictions (whitelist mode,
// no-bash mode) are intentionally not exposed — keep the surface
// small for one-shot use.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import {
  BLACKLIST,
  SHELL_OPERATORS_REGEX,
  ZERO_ACCESS_PATH_REGEX,
} from "./defense/blacklist.ts";
import { extractPathFromInputForTool } from "./defense/paths.ts";
import { isAgentifySessionActive } from "./state.ts";

const WRITE_TOOLS = new Set(["write", "edit", "write_file", "multi_edit"]);
const PATH_SENSITIVE_TOOLS = new Set(["read", ...WRITE_TOOLS]);
const ESCALATION_TOOL = "escalate_to_orchestrator";

/** The agentify credential store — never readable/writable by the agent. */
const AGENTIFY_HOME = path.resolve(os.homedir(), ".agentify");

/** Resolve a (possibly relative) path to an absolute, normalized path. */
function toAbsolute(target: string, cwd: string): string {
  return path.isAbsolute(target)
    ? path.normalize(target)
    : path.normalize(path.resolve(cwd, target));
}

/**
 * Resolve `abs` following symlinks on the nearest existing ancestor so
 * a symlink cannot be used to escape a boundary (e.g. a repo file that
 * symlinks to ~/.agentify/auth.json). Non-existent leaves resolve
 * against the realpath of their closest existing parent.
 */
function realResolve(abs: string): string {
  let cur = abs;
  const tail: string[] = [];
  while (cur !== path.dirname(cur)) {
    if (fs.existsSync(cur)) {
      try {
        return path.join(fs.realpathSync(cur), ...tail.reverse());
      } catch {
        return abs;
      }
    }
    tail.push(path.basename(cur));
    cur = path.dirname(cur);
  }
  return abs;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const SCRIPT_CONTENT_SCAN_BYTES = 64 * 1024;
const SCRIPT_RUNNERS = /\b(python|python3|node|bash|sh|zsh|perl|ruby)\b/;

function resolveScriptPath(token: string, cwd: string): string {
  if (path.isAbsolute(token)) return path.normalize(token);
  return path.normalize(path.join(cwd, token));
}

function scanScriptContent(scriptPath: string, cwd: string): string | null {
  // Read the first 64 KB of the script and re-run the bash blacklist
  // against its contents. Returns the matching label, or null.
  let absolute = scriptPath;
  if (!path.isAbsolute(scriptPath)) {
    absolute = path.normalize(path.join(cwd, scriptPath));
  }
  if (!absolute.startsWith(cwd)) {
    // External script — don't read it; the bash layer alone applies.
    return null;
  }
  let content: string;
  try {
    const fd = fs.openSync(absolute, "r");
    try {
      const buf = Buffer.alloc(SCRIPT_CONTENT_SCAN_BYTES);
      const bytesRead = fs.readSync(fd, buf, 0, SCRIPT_CONTENT_SCAN_BYTES, 0);
      content = buf.slice(0, bytesRead).toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  for (const { pattern, label } of BLACKLIST) {
    if (pattern.test(content)) {
      return label;
    }
  }
  return null;
}

function extractScriptFromBash(command: string, cwd: string): { runner: string; scriptPath: string } | null {
  // Match "<runner> <script-path>" forms. We look for the runner
  // token followed by a path-like argument. The bash layer still
  // applies for the rest of the command.
  const m = command.match(SCRIPT_RUNNERS);
  if (!m) return null;
  const runner = m[1];
  // Find the next path-like argument.
  const after = command.slice(m.index! + runner.length).trim();
  const tokens = after.split(/\s+/);
  for (const tok of tokens) {
    if (tok.length === 0) continue;
    if (tok.startsWith("-")) continue;
    if (tok === "&&" || tok === "||" || tok === "|" || tok === ";") continue;
    // Strip surrounding quotes.
    const cleaned = tok.replace(/^['"]|['"]$/g, "");
    if (cleaned.length === 0) continue;
    // Skip URLs (handled by other patterns).
    if (/^https?:\/\//.test(cleaned)) continue;
    return { runner, scriptPath: resolveScriptPath(cleaned, cwd) };
  }
  return null;
}

function matchesDomainPattern(rel: string, pattern: string): boolean {
  // Glob-ish match supporting `**`, `*`, `?`. Avoids minimatch dep.
  // Examples:
  //   pattern: "docs/**"  matches "docs/a/b.md"
  //   pattern: "*.go"     matches "main.go"
  //   pattern: "src/*"    matches "src/x" only (not "src/x/y").
  //   pattern: "/abs/path/**" matches "/abs/path/foo" (absolute
  //     patterns are valid for domain-locking paths under cwd).
  //
  // Step 1: replace glob meta-chars with placeholders that survive
  // regex escaping.
  const PDSTAR = "\x00PDSTAR\x00";
  const PSTAR = "\x00PSTAR\x00";
  const PQMARK = "\x00PQMARK\x00";
  const tokenized = pattern
    .replace(/\*\*/g, PDSTAR)
    .replace(/\*/g, PSTAR)
    .replace(/\?/g, PQMARK);
  // Step 2: escape regex special chars (including `/`).
  const escaped = tokenized.replace(/[.+^${}()|[\]\\/]/g, "\\$&");
  // Step 3: convert placeholders to regex.
  const regex = escaped
    .replace(new RegExp(PDSTAR, "g"), ".*")
    .replace(new RegExp(PSTAR, "g"), "[^/]*")
    .replace(new RegExp(PQMARK, "g"), "[^/]");
  return new RegExp("^" + regex + "$").test(rel);
}

function pathRelativeToCwd(targetPath: string, cwd: string): string {
  const abs = path.isAbsolute(targetPath) ? path.normalize(targetPath) : path.normalize(path.join(cwd, targetPath));
  if (abs.startsWith(cwd + path.sep) || abs === cwd) {
    return path.relative(cwd, abs);
  }
  return abs;
}

export interface DefenseHookOptions {
  /** Orchestrator sub-agent domain globs (Layer E). null = no lock. */
  agentDomain?: string[] | null;
  /**
   * When true, `write`/`edit` targets must resolve inside the session's
   * working directory (repository jail). Used for the builder,
   * greenfield, and explorer sessions so the agent cannot write outside
   * the repo it is auditing.
   */
  repoJail?: boolean;
  /**
   * Absolute paths of pre-existing, user-owned (unmanaged) files that
   * the agent must not overwrite mid-session. Populated from the
   * pre-run ownership snapshot.
   */
  protectedPaths?: readonly string[];
}

export function makeDefenseHook(opts: DefenseHookOptions = {}): (event: ToolCallEvent) => Promise<ToolCallEventResult | undefined> {
  const agentDomain = opts.agentDomain ?? null;
  const repoJail = opts.repoJail ?? false;
  const protectedSet = new Set(
    (opts.protectedPaths ?? []).map((p) => path.normalize(p)),
  );
  return async (event) => {
    if (!isAgentifySessionActive() && agentDomain === null && !repoJail) {
      return undefined;
    }

    const cwd = (event as { cwd?: string }).cwd ?? process.cwd();

    if (event.toolName === "bash") {
      const command = (event.input as { command?: string } | undefined)?.command ?? "";
      // 1. Compound-operator pre-rejection.
      if (SHELL_OPERATORS_REGEX.test(command)) {
        return { block: true, reason: "defense: compound bash command rejected" };
      }
      // 2. Blacklist.
      for (const { pattern, label } of BLACKLIST) {
        if (pattern.test(command)) {
          return { block: true, reason: `defense blacklist: ${label}` };
        }
      }
      // 3. Script-content scanner. When the command is
      //    `<runner> <file>`, read the file and re-scan.
      const script = extractScriptFromBash(command, cwd);
      if (script) {
        const matchedLabel = scanScriptContent(script.scriptPath, cwd);
        if (matchedLabel) {
          return {
            block: true,
            reason: `defense script-content: ${script.scriptPath} contains ${matchedLabel}`,
          };
        }
      }
      return undefined;
    }

    // Layer B — read/write/edit: zero-access path guard, credential-store
    // protection, repository jail, and user-owned file protection.
    if (PATH_SENSITIVE_TOOLS.has(event.toolName)) {
      const pathValue = extractPathFromInputForTool(event.toolName, event.input);
      if (pathValue.length > 0) {
        // 1. Pattern-based zero-access (secrets, ssh keys, /etc, ...).
        if (ZERO_ACCESS_PATH_REGEX.test(pathValue)) {
          return {
            block: true,
            reason: `defense zero-access: ${event.toolName} on '${pathValue}' blocked`,
          };
        }
        const abs = toAbsolute(pathValue, cwd);
        const real = realResolve(abs);
        // 2. The agentify credential store is off-limits (read too),
        //    resolved through symlinks so a repo symlink can't escape.
        if (isInside(real, AGENTIFY_HOME) || isInside(abs, AGENTIFY_HOME)) {
          return {
            block: true,
            reason: `defense zero-access: ${event.toolName} on the agentify credential store is blocked`,
          };
        }
        if (WRITE_TOOLS.has(event.toolName)) {
          // 3. User-owned file protection: never clobber a pre-existing
          //    unmanaged file captured in the ownership snapshot.
          if (protectedSet.has(abs) || protectedSet.has(real)) {
            return {
              block: true,
              reason: `defense: '${pathValue}' is a user-owned file; agentify will not overwrite it`,
            };
          }
          // 4. Repository jail: writes must stay inside the repo.
          if (repoJail) {
            const realCwd = realResolve(toAbsolute(cwd, cwd));
            if (!isInside(real, realCwd)) {
              return {
                block: true,
                reason: `defense repo-jail: ${event.toolName} on '${pathValue}' resolves outside the repository`,
              };
            }
          }
        }
      }
    }

    // Layer C — create_agent: depth cap.
    if (event.toolName === "create_agent") {
      // Only the orchestrator host constructs a session with
      // create_agent in its allowlist (sub-agent sessions never
      // see it — sub-agents have it filtered out at construction
      // time). If this hook fires on a non-orchestrator session,
      // it's a depth>=2 attempt: block.
      const activeTools = (event as { activeTools?: readonly string[] }).activeTools ?? [];
      if (!activeTools.includes("create_agent")) {
        return {
          block: true,
          reason: "defense depth-cap: create_agent is reserved for the orchestrator session",
        };
      }
    }

    // Layer D — escalate_to_orchestrator: only allowed in sub-agent
    // sessions whose parent is the live orchestrator. The active
    // session's `parent_session_id` is exposed via ctx; the hook
    // receives the call site (event.ctx) for it. We treat the
    // presence of `escalate_to_orchestrator` in the session's
    // active tools as the gate. (Sub-agent sessions inherit the
    // tools via AgentManager; orchestrator sessions do NOT have it.)
    if (event.toolName === ESCALATION_TOOL) {
      const activeTools = (event as { activeTools?: readonly string[] }).activeTools ?? [];
      if (!activeTools.includes(ESCALATION_TOOL)) {
        return {
          block: true,
          reason: "defense depth-cap: escalate_to_orchestrator is reserved for orchestrator-spawned sub-agents",
        };
      }
    }

    // Layer E — write/edit/write_file/multi_edit: domain lock.
    // The hook closure carries the agent's domain globs (passed
    // by the orchestrator's AgentManager when spawning sub-agents
    // via the PiSdkRuntime). null = no constraint (G1 backward
    // compat). [] = read-only. [pattern, ...] = allowed globs.
    if (WRITE_TOOLS.has(event.toolName) && agentDomain !== null) {
      const targetPath = extractPathFromInputForTool(event.toolName, event.input);
      if (targetPath.length > 0) {
        if (agentDomain.length === 0) {
          return { block: true, reason: "defense domain-lock: agent is read-only" };
        }
        const rel = pathRelativeToCwd(targetPath, cwd);
        const ok = agentDomain.some((p) => matchesDomainPattern(rel, p));
        if (!ok) {
          return {
            block: true,
            reason: `defense domain-lock: '${rel}' is outside the agent's domain: ${agentDomain.join(", ")}`,
          };
        }
      }
    }

    return undefined;
  };
}
