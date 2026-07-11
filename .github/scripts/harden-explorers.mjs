import * as fs from "node:fs";

const file = "src/core/audit/spawn-explorer-tool.ts";
let source = fs.readFileSync(file, "utf-8");

function replaceOnce(pattern, replacement, label) {
  const next = source.replace(pattern, replacement);
  if (next === source) throw new Error(`explorer patch failed: ${label}`);
  source = next;
}

replaceOnce(
  `import { makeDefenseHook } from "./defense-hook.ts";`,
  `import { makeDefenseHook } from "./defense-hook.ts";\nimport {\n    createReadOnlyExecutionPolicy,\n    READ_ONLY_TOOLS,\n} from "../security/execution-policy.ts";`,
  "policy import",
);
replaceOnce(/pitfalls: \{ reads: 5, bash: 2, steps: 10 \}/, "pitfalls: { reads: 5, bash: 0, steps: 10 }", "pitfalls shell cap");
replaceOnce(/validation: \{ reads: 10, bash: 2, steps: 15 \}/, "validation: { reads: 10, bash: 0, steps: 15 }", "validation shell cap");
replaceOnce(/gap_filler: \{ reads: 8, bash: 2, steps: 12 \}/, "gap_filler: { reads: 8, bash: 0, steps: 12 }", "gap shell cap");
replaceOnce(`if (!insideCwd && !params.allow_external_paths)`, `if (!insideCwd)`, "external path override");
replaceOnce(
  /const stepDefaults = MODE_STEP_DEFAULTS\[mode\] \?\? \{ reads: 10, bash: 2, steps: 15 \};/,
  `const stepDefaults = MODE_STEP_DEFAULTS[mode] ?? { reads: 10, bash: 0, steps: 15 };`,
  "fallback shell cap",
);

replaceOnce(
  `        try {\n            // Build a clean resource loader for the sub-agent:`,
  `        try {\n            const toolsForMode: ReadonlyArray<string> = params.tools ?? READ_ONLY_TOOLS;\n            const readOnlySet = new Set<string>(READ_ONLY_TOOLS);\n            const unsupportedTools = toolsForMode.filter((tool) => !readOnlySet.has(tool));\n            if (unsupportedTools.length > 0) {\n                throw new Error(\n                    \`explorer sessions are read-only; unsupported tools: \${unsupportedTools.join(", ")}\`,\n                );\n            }\n            const executionPolicy = createReadOnlyExecutionPolicy({\n                cwd: ctx.cwd,\n                mode: "audit-readonly",\n                tools: toolsForMode,\n            });\n\n            // Build a clean resource loader for the sub-agent:`,
  "tool validation",
);
replaceOnce(
  `pi.on("tool_call", makeDefenseHook({ repoJail: true }));`,
  `pi.on("tool_call", makeDefenseHook({ executionPolicy }));`,
  "policy hook",
);
replaceOnce(
  /\n            \/\/ Tool selection\.[\s\S]*?const toolsForMode: ReadonlyArray<string> = params\.tools \?\? defaultToolsForMode;\n/,
  "\n",
  "legacy mode tool selection",
);

fs.writeFileSync(file, source);
console.log("explorer hardening patch applied");
