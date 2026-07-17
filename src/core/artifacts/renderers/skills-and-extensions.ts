import { normalizeArtifactPath } from "../generated-surface.ts";
import type { ArtifactIntents, CodebaseMap } from "../../audit/schema.ts";
import { hashCommentArtifact, isKebabName, markdownArtifact, oneLine } from "./artifact-builders.ts";
import type { RenderContext, RenderedArtifact } from "./types.ts";

const SHELL_SYNTAX = /[;&|<>`$]/;
type SkillCandidateIntent = NonNullable<CodebaseMap["customization_evidence"]>["skill_candidates"][number];
type CustomToolCandidateIntent = NonNullable<CodebaseMap["customization_evidence"]>["custom_tool_candidates"][number];

function renderSkillCandidate(skill: SkillCandidateIntent, context: RenderContext): RenderedArtifact {
  const commandLike = !skill.steps_or_script_path.includes("\n")
    && !skill.steps_or_script_path.trim().startsWith("-");
  const workflow = commandLike
    ? [
        "```bash",
        `${skill.steps_or_script_path.trim()} <args>`,
        "```",
      ]
    : skill.steps_or_script_path
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line, index) => `${index + 1}. ${line.replace(/^[-*]\s*/, "")}`);
  return markdownArtifact({
    relativePath: `${context.stateDir}/skills/${skill.name}/SKILL.md`,
    kind: "skill",
    required: false,
    source: "skill-candidate-renderer",
    body: [
      "---",
      `name: ${skill.name}`,
      `description: ${oneLine(skill.purpose)}`,
      "---",
      "",
      `# ${skill.name}`,
      "",
      "## When To Use",
      "",
      oneLine(skill.purpose),
      "",
      "## Preconditions",
      "",
      "- Read `AGENTS.md` for current validation and ownership rules before running this skill.",
      "- Confirm the script or command exists in the repository and understand any required arguments.",
      "- Do not run against production data or credentials unless the task explicitly authorizes that environment.",
      "",
      "## Workflow",
      "",
      ...workflow,
      "",
      "## Validation",
      "",
      "- Inspect the exit code before deciding success.",
      "- Read the final stdout/stderr lines and treat warnings as possible residual risk.",
      "- If the skill changed repository files or state, run the relevant validation commands from `AGENTS.md`.",
      "",
      "## Output",
      "",
      "Report success or failure clearly. If wrapping a script, inspect its exit code and last output lines before deciding the result.",
      "",
      "## Report",
      "",
      "Include the command run, arguments used, files or state touched, validation performed, and any residual risk.",
      "",
    ].join("\n"),
  });
}

export function renderSkillCandidateArtifacts(map: CodebaseMap, errors: string[], context: RenderContext): RenderedArtifact[] {
  const skillCandidates = map.customization_evidence?.skill_candidates ?? [];
  const existingSkills = new Set(map.meta.documentation.existing_pi_skills ?? []);
  const artifacts: RenderedArtifact[] = [];
  for (const skill of skillCandidates) {
    if (!isKebabName(skill.name)) {
      errors.push(`invalid skill candidate name: ${skill.name}`);
      continue;
    }
    if (existingSkills.has(skill.name)) continue;
    artifacts.push(renderSkillCandidate(skill, context));
  }
  return artifacts;
}

function splitShellFreeCommand(command: string): string[] | null {
  const trimmed = command.trim();
  if (trimmed.length === 0 || SHELL_SYNTAX.test(trimmed)) return null;
  const parts = trimmed.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return parts.map((part) => {
    if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) {
      return part.slice(1, -1);
    }
    return part;
  });
}

function renderCustomToolCandidate(tool: CustomToolCandidateIntent, context: RenderContext): RenderedArtifact | null {
  const argv = splitShellFreeCommand(tool.existing_command);
  if (!argv || argv.length === 0) return null;
  const [command, ...args] = argv;
  return hashCommentArtifact({
    relativePath: `${context.stateDir}/extensions/${tool.name}.ts`,
    kind: "extension",
    required: false,
    source: "custom-tool-candidate-renderer",
    body: [
      "import { execFile } from \"node:child_process\";",
      "import { promisify } from \"node:util\";",
      "import { Type } from \"typebox\";",
      "import type { ExtensionAPI } from \"@earendil-works/pi-coding-agent\";",
      "",
      "const execFileAsync = promisify(execFile);",
      `const TOOL_NAME = ${JSON.stringify(tool.name)};`,
      `const COMMAND = ${JSON.stringify(command)};`,
      `const ARGS = ${JSON.stringify(args)};`,
      "const PARAMS = Type.Object({});",
      "",
      "export default function register(pi: ExtensionAPI): void {",
      "  pi.registerTool({",
      "    name: TOOL_NAME,",
      `    label: ${JSON.stringify(tool.name)},`,
      `    description: ${JSON.stringify(oneLine(tool.purpose))},`,
      "    parameters: PARAMS,",
      "    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {",
      "      try {",
      "        const { stdout, stderr } = await execFileAsync(COMMAND, ARGS, {",
      "          cwd: process.cwd(),",
      "          maxBuffer: 2 * 1024 * 1024,",
      "        });",
      "        const text = [",
      "          `[SUCCESS] ${TOOL_NAME}`,",
      "          stdout ? `stdout:\\n${stdout}` : \"\",",
      "          stderr ? `stderr:\\n${stderr}` : \"\",",
      "        ].filter(Boolean).join(\"\\n\");",
      "        return { content: [{ type: \"text\", text }] };",
      "      } catch (err) {",
      "        const e = err as { stdout?: string; stderr?: string; message?: string };",
      "        const text = [",
      "          `[ERROR] ${TOOL_NAME}`,",
      "          e.stdout ? `stdout:\\n${e.stdout}` : \"\",",
      "          e.stderr ? `stderr:\\n${e.stderr}` : \"\",",
      "          e.message ?? String(err),",
      "        ].filter(Boolean).join(\"\\n\");",
      "        return { content: [{ type: \"text\", text }], isError: true };",
      "      }",
      "    },",
      "  });",
      "}",
      "",
    ].join("\n"),
  });
}

export function renderCustomToolCandidateArtifacts(map: CodebaseMap, errors: string[], context: RenderContext): RenderedArtifact[] {
  const customToolCandidates = map.customization_evidence?.custom_tool_candidates ?? [];
  const existingExtensionNames = new Set(
    (map.meta.documentation.existing_pi_extensions ?? [])
      .map((entry) => normalizeArtifactPath(entry).split("/").pop() ?? "")
      .map((entry) => entry.replace(/\.ts$/, "")),
  );
  const artifacts: RenderedArtifact[] = [];
  for (const tool of customToolCandidates) {
    if (!isKebabName(tool.name)) {
      errors.push(`invalid custom tool candidate name: ${tool.name}`);
      continue;
    }
    if (existingExtensionNames.has(tool.name)) continue;
    const artifact = renderCustomToolCandidate(tool, context);
    if (artifact) artifacts.push(artifact);
  }
  return artifacts;
}

export function renderExtensionCandidateArtifacts(
  intents: ArtifactIntents | undefined,
  errors: string[],
  context: RenderContext,
): RenderedArtifact[] {
  const artifacts: RenderedArtifact[] = [];
  for (const extension of intents?.extension_candidates ?? []) {
    if (extension.name === "no-candidate" || extension.body.trim().toLowerCase() === "none") continue;
    if (!isKebabName(extension.name)) {
      errors.push(`invalid extension candidate name: ${extension.name}`);
      continue;
    }
    artifacts.push(hashCommentArtifact({
      relativePath: `${context.stateDir}/extensions/${extension.name}.ts`,
      kind: "extension",
      required: false,
      source: "extension-candidate-renderer",
      body: extension.body.trim(),
    }));
  }
  return artifacts;
}
