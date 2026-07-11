// Defense-in-depth hook for all model-backed agentify sessions.
//
// An explicit execution policy is the primary boundary. The historical
// blacklist remains a secondary safeguard for development sessions that are
// deliberately granted shell access.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { AgentExecutionPolicy } from "../security/execution-policy.ts";
import {
  BLACKLIST,
  SHELL_OPERATORS_REGEX,
  ZERO_ACCESS_PATH_REGEX,
} from "./defense/blacklist.ts";
import { extractPathFromInputForTool } from "./defense/paths.ts";
import { isAgentifySessionActive } from "./state.ts";

const WRITE_TOOLS = new Set(["write", "edit", "write_file", "multi_edit"]);
const PATH_SENSITIVE_TOOLS = new Set(["read", "grep", "find", "ls", ...WRITE_TOOLS]);
const ESCALATION_TOOL = "escalate_to_orchestrator";
const AGENTIFY_HOME = path.resolve(os.homedir(), ".agentify");
const SCRIPT_CONTENT_SCAN_BYTES = 64 * 1024;
const SCRIPT_RUNNERS = /\b(python|python3|node|bash|sh|zsh|perl|ruby)\b/;
const BASH_FILE_MUTATION = /^\s*(?:rm|rmdir|mv|cp|install|touch|truncate|tee)\b|\bsed\s+-i\b|\bperl\s+-pi\b/;
const BASH_AGENTIFY_CREDENTIAL = /(?:~\/|\$HOME\/|\/[^\s]+\/)?\.agentify\/(?:auth|config)\.json\b/;

function toAbsolute(target: string, cwd: string): string {
  return path.isAbsolute(target)
    ? path.normalize(target)
    : path.normalize(path.resolve(cwd, target));
}

/** Resolve symlinks through the nearest existing ancestor. */
function realResolve(abs: string): string {
  let current = abs;
  const tail: string[] = [];
  while (current !== path.dirname(current)) {
    if (fs.existsSync(current)) {
      try {
        return path.join(fs.realpathSync(current), ...tail.reverse());
      } catch {
        return abs;
      }
    }
    tail.push(path.basename(current));
    current = path.dirname(current);
  }
  return abs;
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isInsideAny(target: string, roots: readonly string[]): boolean {
  return roots.some((root) => isInside(target, realResolve(path.resolve(root))));
}

function resolveScriptPath(token: string, cwd: string): string {
  return path.isAbsolute(token) ? path.normalize(token) : path.normalize(path.join(cwd, token));
}

function scanScriptContent(scriptPath: string, cwd: string): string | null {
  const absolute = path.isAbsolute(scriptPath)
    ? path.normalize(scriptPath)
    : path.normalize(path.join(cwd, scriptPath));
  if (!isInside(realResolve(absolute), realResolve(cwd))) return "script outside repository";

  let content: string;
  try {
    const fd = fs.openSync(absolute, "r");
    try {
      const buffer = Buffer.alloc(SCRIPT_CONTENT_SCAN_BYTES);
      const bytesRead = fs.readSync(fd, buffer, 0, SCRIPT_CONTENT_SCAN_BYTES, 0);
      content = buffer.slice(0, bytesRead).toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  for (const { pattern, label } of BLACKLIST) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) return label;
  }
  return null;
}

function extractScriptFromBash(command: string, cwd: string): { scriptPath: string } | null {
  const match = command.match(SCRIPT_RUNNERS);
  if (!match || match.index === undefined) return null;
  const runner = match[1] ?? "";
  const after = command.slice(match.index + runner.length).trim();
  for (const token of after.split(/\s+/)) {
    if (!token || token.startsWith("-") || token === "&&" || token === "||" || token === "|" || token === ";") continue;
    const cleaned = token.replace(/^['"]|['"]$/g, "");
    if (!cleaned || /^https?:\/\//.test(cleaned)) continue;
    return { scriptPath: resolveScriptPath(cleaned, cwd) };
  }
  return null;
}

function matchesDomainPattern(relativePath: string, pattern: string): boolean {
  const doubleStar = "\x00DSTAR\x00";
  const star = "\x00STAR\x00";
  const question = "\x00QUESTION\x00";
  const tokenized = pattern
    .replace(/\*\*/g, doubleStar)
    .replace(/\*/g, star)
    .replace(/\?/g, question);
  const escaped = tokenized.replace(/[.+^${}()|[\]\\/]/g, "\\$&");
  const regex = escaped
    .replace(new RegExp(doubleStar, "g"), ".*")
    .replace(new RegExp(star, "g"), "[^/]*")
    .replace(new RegExp(question, "g"), "[^/]");
  return new RegExp(`^${regex}$`).test(relativePath);
}

function pathRelativeToCwd(targetPath: string, cwd: string): string {
  const absolute = path.isAbsolute(targetPath)
    ? path.normalize(targetPath)
    : path.normalize(path.join(cwd, targetPath));
  return isInside(absolute, cwd) ? path.relative(cwd, absolute).split(path.sep).join("/") : absolute;
}

export interface DefenseHookOptions {
  executionPolicy?: AgentExecutionPolicy;
  /** Additional write-domain restriction for orchestrator sub-agents. */
  agentDomain?: string[] | null;
  /** @deprecated Legacy compatibility; executionPolicy is authoritative. */
  repoJail?: boolean;
  /** @deprecated Legacy compatibility; executionPolicy is authoritative. */
  protectedPaths?: readonly string[];
}

export function makeDefenseHook(
  options: DefenseHookOptions = {},
): (event: ToolCallEvent) => Promise<ToolCallEventResult | undefined> {
  const policy = options.executionPolicy;
  const agentDomain = options.agentDomain ?? null;
  const repoJail = options.repoJail ?? false;
  const protectedSet = new Set(
    [...(policy?.protectedPaths ?? []), ...(options.protectedPaths ?? [])]
      .map((entry) => path.normalize(path.resolve(entry))),
  );

  return async (event) => {
    if (!policy && !isAgentifySessionActive() && agentDomain === null && !repoJail) {
      return undefined;
    }

    const cwd = path.resolve((event as { cwd?: string }).cwd ?? process.cwd());

    if (event.toolName === "bash") {
      const command = (event.input as { command?: string } | undefined)?.command ?? "";
      if (policy?.commandPolicy === "deny") {
        return { block: true, reason: `execution policy '${policy.mode}' denies shell commands` };
      }
      if (BASH_AGENTIFY_CREDENTIAL.test(command)) {
        return { block: true, reason: "defense zero-access: Agentify credential store" };
      }
      if ((policy?.mode === "audit-readonly" || policy?.mode === "review-readonly" || (!policy && repoJail))
        && BASH_FILE_MUTATION.test(command)) {
        return { block: true, reason: "defense: shell-based file mutation is not allowed" };
      }
      if (SHELL_OPERATORS_REGEX.test(command)) {
        return { block: true, reason: "defense: compound bash command rejected" };
      }
      for (const { pattern, label } of BLACKLIST) {
        pattern.lastIndex = 0;
        if (pattern.test(command)) {
          return { block: true, reason: `defense blacklist: ${label}` };
        }
      }
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

    if (PATH_SENSITIVE_TOOLS.has(event.toolName)) {
      const pathValue = extractPathFromInputForTool(event.toolName, event.input);
      if (pathValue.length > 0) {
        if (ZERO_ACCESS_PATH_REGEX.test(pathValue)) {
          return {
            block: true,
            reason: `defense zero-access: ${event.toolName} on '${pathValue}' blocked`,
          };
        }

        const absolute = toAbsolute(pathValue, cwd);
        const real = realResolve(absolute);
        if (isInside(real, AGENTIFY_HOME) || isInside(absolute, AGENTIFY_HOME)) {
          return {
            block: true,
            reason: `defense zero-access: ${event.toolName} on the Agentify credential store is blocked`,
          };
        }

        if (policy) {
          const roots = WRITE_TOOLS.has(event.toolName)
            ? policy.writableRoots
            : policy.readableRoots;
          if (!isInsideAny(real, roots) && !isInsideAny(absolute, roots)) {
            return {
              block: true,
              reason: `execution policy '${policy.mode}' denies ${event.toolName} on '${pathValue}'`,
            };
          }
        }

        if (WRITE_TOOLS.has(event.toolName)) {
          if (protectedSet.has(absolute) || protectedSet.has(real)) {
            return {
              block: true,
              reason: `defense: '${pathValue}' is a user-owned file; agentify will not overwrite it`,
            };
          }
          if (!policy && repoJail && !isInside(real, realResolve(cwd))) {
            return {
              block: true,
              reason: `defense repo-jail: ${event.toolName} on '${pathValue}' resolves outside the repository`,
            };
          }
        }
      }
    }

    if (event.toolName === "create_agent") {
      const activeTools = (event as { activeTools?: readonly string[] }).activeTools ?? [];
      if (!activeTools.includes("create_agent")) {
        return {
          block: true,
          reason: "defense depth-cap: create_agent is reserved for the orchestrator session",
        };
      }
    }

    if (event.toolName === ESCALATION_TOOL) {
      const activeTools = (event as { activeTools?: readonly string[] }).activeTools ?? [];
      if (!activeTools.includes(ESCALATION_TOOL)) {
        return {
          block: true,
          reason: "defense depth-cap: escalate_to_orchestrator is reserved for orchestrator-spawned sub-agents",
        };
      }
    }

    if (WRITE_TOOLS.has(event.toolName) && agentDomain !== null) {
      const targetPath = extractPathFromInputForTool(event.toolName, event.input);
      if (targetPath.length > 0) {
        if (agentDomain.length === 0) {
          return { block: true, reason: "defense domain-lock: agent is read-only" };
        }
        const relative = pathRelativeToCwd(targetPath, cwd);
        if (!agentDomain.some((pattern) => matchesDomainPattern(relative, pattern))) {
          return {
            block: true,
            reason: `defense domain-lock: '${relative}' is outside the agent's domain: ${agentDomain.join(", ")}`,
          };
        }
      }
    }

    return undefined;
  };
}
