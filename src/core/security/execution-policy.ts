import * as path from "node:path";

export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
export const REPOSITORY_WRITE_TOOLS = [
  ...READ_ONLY_TOOLS,
  "write",
  "edit",
  "write_file",
  "multi_edit",
] as const;

export type ExecutionPolicyMode =
  | "audit-readonly"
  | "review-readonly"
  | "repository-write"
  | "orchestrator";

export type CommandPolicy = "deny" | "development";
export type NetworkPolicy = "deny" | "restricted";

/**
 * Mandatory capability boundary for every model-backed session.
 *
 * Custom tools are registered by trusted application code and are not listed
 * here. `allowedTools` applies to the SDK's built-in tool surface only.
 */
export interface AgentExecutionPolicy {
  mode: ExecutionPolicyMode;
  repositoryRoot: string;
  readableRoots: readonly string[];
  writableRoots: readonly string[];
  allowedTools: readonly string[];
  commandPolicy: CommandPolicy;
  network: NetworkPolicy;
  protectedPaths: readonly string[];
}

function absoluteRoots(roots: readonly string[]): readonly string[] {
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

function normalizePolicy(policy: AgentExecutionPolicy): AgentExecutionPolicy {
  return {
    ...policy,
    repositoryRoot: path.resolve(policy.repositoryRoot),
    readableRoots: absoluteRoots(policy.readableRoots),
    writableRoots: absoluteRoots(policy.writableRoots),
    allowedTools: [...new Set(policy.allowedTools)],
    protectedPaths: absoluteRoots(policy.protectedPaths),
  };
}

export function createReadOnlyExecutionPolicy(params: {
  cwd: string;
  mode?: "audit-readonly" | "review-readonly";
  tools?: readonly string[];
  protectedPaths?: readonly string[];
}): AgentExecutionPolicy {
  const tools = params.tools ?? READ_ONLY_TOOLS;
  const unsupported = tools.filter((tool) => !READ_ONLY_TOOLS.includes(tool as typeof READ_ONLY_TOOLS[number]));
  if (unsupported.length > 0) {
    throw new Error(
      `read-only execution policy cannot grant: ${unsupported.join(", ")}`,
    );
  }
  return normalizePolicy({
    mode: params.mode ?? "review-readonly",
    repositoryRoot: params.cwd,
    readableRoots: [params.cwd],
    writableRoots: [],
    allowedTools: tools,
    commandPolicy: "deny",
    network: "deny",
    protectedPaths: params.protectedPaths ?? [],
  });
}

export function createRepositoryWriteExecutionPolicy(params: {
  cwd: string;
  tools: readonly string[];
  writableRoots?: readonly string[];
  protectedPaths?: readonly string[];
  allowDevelopmentCommands?: boolean;
}): AgentExecutionPolicy {
  const writableRoots = params.writableRoots ?? [params.cwd];
  return normalizePolicy({
    mode: "repository-write",
    repositoryRoot: params.cwd,
    readableRoots: [params.cwd],
    writableRoots,
    allowedTools: params.tools,
    commandPolicy: params.allowDevelopmentCommands ? "development" : "deny",
    network: params.allowDevelopmentCommands ? "restricted" : "deny",
    protectedPaths: params.protectedPaths ?? [],
  });
}

export function createOrchestratorExecutionPolicy(cwd: string): AgentExecutionPolicy {
  return normalizePolicy({
    mode: "orchestrator",
    repositoryRoot: cwd,
    readableRoots: [cwd],
    writableRoots: [],
    allowedTools: [],
    commandPolicy: "deny",
    network: "deny",
    protectedPaths: [],
  });
}

/**
 * Validate the requested tool names at the final runtime boundary.
 * Trusted custom tools are supplied separately and never widen built-in access.
 */
export function assertRequestedToolsAllowed(
  requestedTools: readonly string[],
  policy: AgentExecutionPolicy,
  trustedCustomToolNames: readonly string[] = [],
): void {
  const allowed = new Set(policy.allowedTools);
  const trustedCustom = new Set(trustedCustomToolNames);
  const denied = requestedTools.filter(
    (tool) => !allowed.has(tool) && !trustedCustom.has(tool),
  );
  if (denied.length > 0) {
    throw new Error(
      `execution policy '${policy.mode}' does not allow tools: ${denied.join(", ")}`,
    );
  }
}
