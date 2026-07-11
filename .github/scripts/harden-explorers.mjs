import * as fs from "node:fs";

const file = "src/core/audit/spawn-explorer-tool.ts";
let source = fs.readFileSync(file, "utf-8");

function replace(before, after) {
  if (!source.includes(before)) throw new Error(`missing explorer patch marker: ${before.slice(0, 100)}`);
  source = source.replace(before, after);
}

replace(
  `import { makeDefenseHook } from "./defense-hook.ts";`,
  `import { makeDefenseHook } from "./defense-hook.ts";
import {
    createReadOnlyExecutionPolicy,
    READ_ONLY_TOOLS,
} from "../security/execution-policy.ts";`,
);

replace(
  `    pitfalls: { reads: 5, bash: 2, steps: 10 },
    validation: { reads: 10, bash: 2, steps: 15 },
    gap_filler: { reads: 8, bash: 2, steps: 12 },`,
  `    pitfalls: { reads: 5, bash: 0, steps: 10 },
    validation: { reads: 10, bash: 0, steps: 15 },
    gap_filler: { reads: 8, bash: 0, steps: 12 },`,
);

replace(
  `                "Override the tool list for the sub-agent. Defaults are " +
                "mode-specific (most fixed modes are read-only; pitfalls, " +
                "validation, and gap_filler get \`bash\`). For \`custom\` " +
                "mode, the default is \`[\"read\", \"grep\", \"find\", \"ls\"]\`. " +
                "If you need \`bash\` for a custom sub-agent, include it here.",`,
  `                "Optional read-only tool subset for the sub-agent. Allowed values are " +
                "read, grep, find, and ls. Shell and mutation tools are rejected.",`,
);

replace(
  `        if (!insideCwd && !params.allow_external_paths) {`,
  `        if (!insideCwd) {`,
);

replace(
  `                            \`If you really need to read outside ctx.cwd, set allow_external_paths: true \` +
                            \`(this is logged as a security event).\`,`,
  `                            "Explorer sessions are permanently confined to the repository.",`,
);

replace(
  `        // Log external path access (Phase 2.6).
        if (params.allow_external_paths) {
            try {
                // Best-effort: log to the agentify log if available.
                // The actual write happens via ctx.log if exposed; we
                // emit a no-op here that the defense hook handler can pick
                // up. The audit trail is in the JSONL log via the
                // subagent_spawned event's details.
            } catch {
                // ignore
            }
        }

`,
  ``,
);

replace(
  `        const stepDefaults = MODE_STEP_DEFAULTS[mode] ?? { reads: 10, bash: 2, steps: 15 };`,
  `        const stepDefaults = MODE_STEP_DEFAULTS[mode] ?? { reads: 10, bash: 0, steps: 15 };`,
);

replace(
  `        try {
            // Build a clean resource loader for the sub-agent:
            // - no project context files (AGENTS.md, CLAUDE.md)
            // - no project extensions (the defense hook, etc. would
            //   interfere with the sub-agent's read-only purpose)
            // - no skills, prompt templates, themes
            // - the system prompt is fully replaced with the
            //   dimension-specific prompt (or the parent's custom
            //   prompt for custom mode).
            const resourceLoader = new DefaultResourceLoader({
                cwd: ctx.cwd,
                agentDir: toolOptions.agentDir,
                noContextFiles: true,
                noExtensions: true,
                noSkills: true,
                noPromptTemplates: true,
                noThemes: true,
                systemPrompt: subagentSystemPrompt,
                // Explorer sub-agents read (and, for some modes, run
                // bash against) untrusted repository content. Attach the
                // same defense hook the parent session uses: bash
                // blacklist, zero-access paths, credential-store block,
                // and a repository jail on writes. Without this the
                // sub-agent would run bash with no blacklist at all.
                extensionFactories: [
                    (pi) => {
                        pi.on("tool_call", makeDefenseHook({ repoJail: true }));
                    },
                ],
            });
            await resourceLoader.reload();

            // Tool selection. The pitfalls, validation, and gap_filler
            // fixed modes need bash (for git log, test runs, etc.).
            // For custom mode, the builder specifies the tool list
            // explicitly via the \`tools\` parameter; if not provided,
            // default to read-only.
            const defaultToolsForMode: ReadonlyArray<string> = (() => {
                if (mode === "pitfalls" || mode === "validation" || mode === "gap_filler") {
                    return ["read", "grep", "find", "ls", "bash"];
                }
                if (mode === "custom") {
                    return ["read", "grep", "find", "ls"];
                }
                return ["read", "grep", "find", "ls"];
            })();
            const toolsForMode: ReadonlyArray<string> = params.tools ?? defaultToolsForMode;`,
  `        try {
            const toolsForMode: ReadonlyArray<string> = params.tools ?? READ_ONLY_TOOLS;
            const readOnlySet = new Set<string>(READ_ONLY_TOOLS);
            const unsupportedTools = toolsForMode.filter((tool) => !readOnlySet.has(tool));
            if (unsupportedTools.length > 0) {
                throw new Error(
                    \`explorer sessions are read-only; unsupported tools: \${unsupportedTools.join(", ")}\`,
                );
            }
            const executionPolicy = createReadOnlyExecutionPolicy({
                cwd: ctx.cwd,
                mode: "audit-readonly",
                tools: toolsForMode,
            });

            // Build a clean resource loader for the sub-agent with the same
            // explicit read-only boundary used by the parent audit.
            const resourceLoader = new DefaultResourceLoader({
                cwd: ctx.cwd,
                agentDir: toolOptions.agentDir,
                noContextFiles: true,
                noExtensions: true,
                noSkills: true,
                noPromptTemplates: true,
                noThemes: true,
                systemPrompt: subagentSystemPrompt,
                extensionFactories: [
                    (pi) => {
                        pi.on("tool_call", makeDefenseHook({ executionPolicy }));
                    },
                ],
            });
            await resourceLoader.reload();`,
);

fs.writeFileSync(file, source);
console.log("explorer sessions hardened");
