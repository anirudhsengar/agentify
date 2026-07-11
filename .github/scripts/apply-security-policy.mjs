import * as fs from "node:fs";

function replace(file, before, after) {
  const source = fs.readFileSync(file, "utf-8");
  if (!source.includes(before)) {
    throw new Error(`patch marker not found in ${file}: ${before.slice(0, 100)}`);
  }
  const next = source.replace(before, after);
  if (next === source) throw new Error(`patch did not change ${file}`);
  fs.writeFileSync(file, next);
}

replace(
  "src/core/run-agentify.ts",
  `import {
  readGreenfieldFormationAt,
  renderGreenfieldArtifacts,
} from "./greenfield-artifacts.ts";`,
  `import {
  readGreenfieldFormationAt,
  renderGreenfieldArtifacts,
} from "./greenfield-artifacts.ts";
import { createReadOnlyExecutionPolicy } from "./security/execution-policy.ts";`,
);

replace(
  "src/core/run-agentify.ts",
  `const BUILDER_TOOL_ALLOWLIST = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "write",
  "edit",
  "write_map",
  "write_map_delta",
  "spawn_explorer",
];`,
  `const BUILDER_TOOL_ALLOWLIST = [
  "read",
  "grep",
  "find",
  "ls",
  "write_map",
  "write_map_delta",
  "spawn_explorer",
];`,
);

replace(
  "src/core/run-agentify.ts",
  `      tools: BUILDER_TOOL_ALLOWLIST,
      repoJail: true,
      protectedPaths,
      customTools: [`,
  `      tools: BUILDER_TOOL_ALLOWLIST,
      executionPolicy: createReadOnlyExecutionPolicy({
        cwd: options.cwd,
        mode: "audit-readonly",
        tools: BUILDER_TOOL_ALLOWLIST.filter((tool) =>
          tool === "read" || tool === "grep" || tool === "find" || tool === "ls"
        ),
        protectedPaths,
      }),
      customTools: [`,
);

replace(
  "src/core/webhook/worker.ts",
  `import type {
  AgentRuntime,
  AgentRuntimeSessionOptions,
  AgentifyConfig,
} from "../types.ts";`,
  `import type {
  AgentRuntime,
  AgentRuntimeSessionOptions,
  AgentifyConfig,
} from "../types.ts";
import {
  createReadOnlyExecutionPolicy,
  READ_ONLY_TOOLS,
} from "../security/execution-policy.ts";`,
);

replace(
  "src/core/webhook/worker.ts",
  `  const config: AgentifyConfig = {
    model: record.prompt.model ?? undefined,
    thinkingLevel: normalizeThinkingLevel(record.prompt.thinking_level),
  };
  return {
    cwd: record.prompt.cwd,`,
  `  const config: AgentifyConfig = {
    model: record.prompt.model ?? undefined,
    thinkingLevel: normalizeThinkingLevel(record.prompt.thinking_level),
  };
  const tools = record.prompt.tools.length > 0
    ? [...record.prompt.tools]
    : [...READ_ONLY_TOOLS];
  const readOnlySet = new Set<string>(READ_ONLY_TOOLS);
  const unsafeTools = tools.filter((tool) => !readOnlySet.has(tool));
  if (unsafeTools.length > 0) {
    throw new Error(
      \`webhook trigger requested unsafe tools: \${unsafeTools.join(", ")}; externally-triggered sessions are read-only\`,
    );
  }
  return {
    cwd: record.prompt.cwd,`,
);

replace(
  "src/core/webhook/worker.ts",
  `    tools: record.prompt.tools,
    additionalSkillPaths: [shippedSkillsDir()],`,
  `    tools,
    executionPolicy: createReadOnlyExecutionPolicy({
      cwd: record.prompt.cwd,
      mode: "review-readonly",
      tools,
    }),
    additionalSkillPaths: [shippedSkillsDir()],`,
);

replace(
  "src/core/aiw/runtime.ts",
  `import { readAiwState, writeAiwState } from "./paths.ts";`,
  `import { readAiwState, writeAiwState } from "./paths.ts";
import {
  createReadOnlyExecutionPolicy,
  createRepositoryWriteExecutionPolicy,
} from "../security/execution-policy.ts";`,
);

replace(
  "src/core/aiw/runtime.ts",
  `  review: ["read", "grep", "find", "ls", "bash"],`,
  `  review: ["read", "grep", "find", "ls"],`,
);

replace(
  "src/core/aiw/runtime.ts",
  `    tools: [...phaseTools],
    additionalSkillPaths: [shippedSkillsDir()],`,
  `    tools: [...phaseTools],
    executionPolicy: phase === "review"
      ? createReadOnlyExecutionPolicy({
          cwd: phaseCwd,
          mode: "review-readonly",
          tools: phaseTools,
        })
      : createRepositoryWriteExecutionPolicy({
          cwd: phaseCwd,
          tools: phaseTools,
          allowDevelopmentCommands: phaseTools.includes("bash"),
        }),
    additionalSkillPaths: [shippedSkillsDir()],`,
);

replace(
  "src/core/orchestrator/host.ts",
  `import { AutoImproveScheduler } from "./auto-improve.ts";`,
  `import { AutoImproveScheduler } from "./auto-improve.ts";
import { createOrchestratorExecutionPolicy } from "../security/execution-policy.ts";`,
);

replace(
  "src/core/orchestrator/host.ts",
  `      tools: [], // cardinal rule: no Pi built-ins.
      customTools: this.tools,`,
  `      tools: [], // cardinal rule: no Pi built-ins.
      executionPolicy: createOrchestratorExecutionPolicy(this.cwd),
      customTools: this.tools,`,
);

replace(
  "src/core/orchestrator/agent-manager.ts",
  `import type { OrchestratorPaths } from "./paths.ts";`,
  `import type { OrchestratorPaths } from "./paths.ts";
import {
  createReadOnlyExecutionPolicy,
  createRepositoryWriteExecutionPolicy,
} from "../security/execution-policy.ts";`,
);

replace(
  "src/core/orchestrator/agent-manager.ts",
  `    const result = await this.opts.runtime.runSession({
      cwd: sessionCwd,`,
  `    const hasWriteTools = state.tools.some((tool) =>
      tool === "write" || tool === "edit" || tool === "write_file" || tool === "multi_edit"
    );
    const executionPolicy = hasWriteTools || state.tools.includes("bash")
      ? createRepositoryWriteExecutionPolicy({
          cwd: sessionCwd,
          tools: state.tools,
          allowDevelopmentCommands: state.tools.includes("bash"),
        })
      : createReadOnlyExecutionPolicy({
          cwd: sessionCwd,
          mode: "review-readonly",
          tools: state.tools,
        });

    const result = await this.opts.runtime.runSession({
      cwd: sessionCwd,`,
);

replace(
  "src/core/orchestrator/agent-manager.ts",
  `      tools: state.tools,
      signal: managed.ac.signal,`,
  `      tools: state.tools,
      executionPolicy,
      signal: managed.ac.signal,`,
);

console.log("security execution-policy call sites patched");
