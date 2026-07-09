import { AGENTIFY_MANAGED_MARKERS, addMarkdownManagedMarker } from "../artifact-exporters.ts";
import {
  AGENTS_MD_MAX_LINES,
  type ArtifactIntents,
  type CodebaseMap,
  type FeatureAgentIntent,
} from "../audit/schema.ts";
import { validateWorkflowSpec, type WorkflowSpec } from "../orchestrator/workflow-spec.ts";

type ExpertDomainIntent = NonNullable<CodebaseMap["grade7_evidence"]>["expert_domains"][number];
type LegacyExpertIntent = ArtifactIntents["experts"][number];
type SkillCandidateIntent = NonNullable<CodebaseMap["grade3_evidence"]>["skill_candidates"][number];
type CustomToolCandidateIntent = NonNullable<CodebaseMap["grade3_evidence"]>["custom_tool_candidates"][number];
type PerAreaTemplateCandidateIntent = NonNullable<CodebaseMap["meta"]["lifecycle"]["per_area_template_candidates"]>[number];

export type ManagedArtifactKind =
  | "audit"
  | "harness_export"
  | "scaffold"
  | "state"
  | "prompt"
  | "skill"
  | "extension"
  | "expert"
  | "workflow";

export interface RenderedArtifact {
  relativePath: string;
  content: string;
  marker: string;
  kind: ManagedArtifactKind;
  required: boolean;
  source: string;
}

export interface RenderArtifactsResult {
  artifacts: RenderedArtifact[];
  errors: string[];
}

const KEBAB_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROMPT_NAME = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;
const SHELL_SYNTAX = /[;&|<>`$]/;

const REQUIRED_ALWAYS_ON_DOCS = new Set(["specs/README.md", "ai_docs/README.md"]);

function normalizePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function isSafeRelativePath(relativePath: string): boolean {
  const normalized = normalizePath(relativePath);
  return normalized.length > 0
    && SAFE_RELATIVE_PATH.test(normalized)
    && !normalized.split("/").some((part) => part === "" || part === ".");
}

function isKebabName(name: string): boolean {
  return KEBAB_NAME.test(name);
}

function isPromptName(name: string): boolean {
  return PROMPT_NAME.test(name);
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  const withoutTrailingNewline = content.endsWith("\n")
    ? content.slice(0, -1)
    : content;
  return withoutTrailingNewline.split("\n").length;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function nonEmptyCommand(command: string | null | undefined): string | null {
  const trimmed = command?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function uniqueCommands(commands: string[]): string[] {
  return [...new Set(commands.map((command) => command.trim()).filter((command) => command.length > 0))];
}

function repositoryValidationCommands(map: CodebaseMap): string[] {
  return uniqueCommands([
    map.validation_surface.typecheck_command,
    map.validation_surface.lint_command,
    map.validation_surface.test_command,
    map.validation_surface.e2e_command,
  ].map(nonEmptyCommand).filter((command): command is string => command !== null));
}

function changeTypeValidationEntries(map: CodebaseMap): Array<{ changeType: string; mandatory: string[] }> {
  return Object.entries(map.validation_surface.per_change_type).map(([changeType, commands]) => ({
    changeType,
    mandatory: uniqueCommands(commands.mandatory),
  }));
}

function changeTypeValidationLines(map: CodebaseMap): string[] {
  return changeTypeValidationEntries(map).map(({ changeType, mandatory }) => {
    const commands = mandatory.map((command) => `\`${command}\``).join(", ") || "none";
    return `- ${changeType}: ${commands}`;
  });
}

function mandatoryChangeTypeCommands(map: CodebaseMap): string[] {
  return uniqueCommands(changeTypeValidationEntries(map).flatMap((entry) => entry.mandatory));
}

function markdownArtifact(params: {
  relativePath: string;
  body: string;
  kind: ManagedArtifactKind;
  required: boolean;
  source: string;
}): RenderedArtifact {
  return {
    relativePath: normalizePath(params.relativePath),
    content: ensureTrailingNewline(addMarkdownManagedMarker(params.body)),
    marker: AGENTIFY_MANAGED_MARKERS.markdown,
    kind: params.kind,
    required: params.required,
    source: params.source,
  };
}

function hashCommentArtifact(params: {
  relativePath: string;
  body: string;
  kind: ManagedArtifactKind;
  required: boolean;
  source: string;
}): RenderedArtifact {
  const marker = AGENTIFY_MANAGED_MARKERS.toml;
  const body = params.body.includes(marker) ? params.body : `${marker}\n${params.body}`;
  return {
    relativePath: normalizePath(params.relativePath),
    content: ensureTrailingNewline(body),
    marker,
    kind: params.kind,
    required: params.required,
    source: params.source,
  };
}

function jsonArtifact(params: {
  relativePath: string;
  value: unknown;
  kind: ManagedArtifactKind;
  required: boolean;
  source: string;
}): RenderedArtifact {
  return {
    relativePath: normalizePath(params.relativePath),
    content: ensureTrailingNewline(JSON.stringify(params.value, null, 2)),
    marker: "sha256",
    kind: params.kind,
    required: params.required,
    source: params.source,
  };
}

function yamlScalar(value: string): string {
  return JSON.stringify(oneLine(value));
}

function yamlStringArray(key: string, values: string[], indent = 0): string[] {
  const prefix = " ".repeat(indent);
  if (values.length === 0) return [`${prefix}${key}: []`];
  return [
    `${prefix}${key}:`,
    ...values.map((value) => `${prefix}  - ${yamlScalar(value)}`),
  ];
}

function renderExpertiseYaml(expert: ExpertDomainIntent): string {
  return [
    `domain: ${yamlScalar(expert.domain)}`,
    `last_updated: ${yamlScalar(expert.last_updated)}`,
    ...yamlStringArray("primary_paths", expert.primary_paths),
    "overview:",
    `  description: ${yamlScalar(expert.rationale)}`,
    ...(
      expert.key_files.length > 0
        ? [
            "  key_files:",
            ...expert.key_files.flatMap((file) => [
            `    - path: ${yamlScalar(file.path)}`,
            `      line_range: [${file.line_range[0]}, ${file.line_range[1]}]`,
            `      purpose: ${yamlScalar(file.purpose)}`,
            ]),
          ]
        : ["  key_files: []"]
    ),
    ...(
      expert.key_types.length > 0
        ? [
            "key_types:",
            ...expert.key_types.flatMap((keyType) => [
            `  - name: ${yamlScalar(keyType.name)}`,
            `    path: ${yamlScalar(keyType.path)}`,
            `    purpose: ${yamlScalar(keyType.purpose)}`,
            ]),
          ]
        : ["key_types: []"]
    ),
    ...(
      expert.patterns.length > 0
        ? [
            "patterns:",
            ...expert.patterns.flatMap((pattern) => [
            `  - name: ${yamlScalar(pattern.name)}`,
            `    description: ${yamlScalar(pattern.description)}`,
            `    example_ref: ${yamlScalar(pattern.example_ref)}`,
            ]),
          ]
        : ["patterns: []"]
    ),
    ...(
      expert.pitfalls.length > 0
        ? [
            "pitfalls:",
            ...expert.pitfalls.flatMap((pitfall) => [
            `  - risk: ${yamlScalar(pitfall.risk)}`,
            `    consequence: ${yamlScalar(pitfall.consequence)}`,
            `    reference: ${yamlScalar(pitfall.reference)}`,
            ]),
          ]
        : ["pitfalls: []"]
    ),
    ...yamlStringArray("conventions", expert.conventions),
    "testing:",
    `  command: ${expert.test_command === null ? "null" : yamlScalar(expert.test_command)}`,
    ...yamlStringArray("test_paths", expert.test_paths, 2),
    ...yamlStringArray("entry_points", expert.entry_points),
    `stability: ${yamlScalar(expert.stability)}`,
    `recurrence: ${yamlScalar(expert.recurrence)}`,
    "",
  ].join("\n");
}

function renderExpertQuestionPrompt(expert: ExpertDomainIntent): string {
  return [
    "---",
    `description: ${expert.domain} expert - answer questions about ${expert.domain}.`,
    'argument-hint: "<question>"',
    "---",
    "",
    `# ${expert.domain} Expert Question`,
    "",
    `Read .pi/prompts/experts/${expert.domain}/expertise.yaml first.`,
    "Answer the user's question from that expertise and cite repository file:line references when available.",
    "If the expertise is stale or insufficient, say what must be re-read before acting.",
    "",
    "Question:",
    "",
    "$ARGUMENTS",
    "",
  ].join("\n");
}

function renderExpertSelfImprovePrompt(expert: ExpertDomainIntent): string {
  return [
    "---",
    `description: ${expert.domain} expert - refresh expertise.yaml after code changes.`,
    "---",
    "",
    `# ${expert.domain} Expert Self-Improve`,
    "",
    `Update .pi/prompts/experts/${expert.domain}/expertise.yaml from the current repository state.`,
    "Preserve stable knowledge, remove stale claims, add newly discovered patterns and pitfalls, and update last_updated to today's ISO timestamp.",
    "Only edit this expert directory unless explicitly asked to change product code.",
    "",
    "Primary paths:",
    "",
    ...expert.primary_paths.map((pathName) => `- ${pathName}`),
    "",
    "Validation:",
    "",
    `- ${expert.test_command ?? "Use the repository validation surface from AGENTS.md."}`,
    "",
  ].join("\n");
}

function expertKnowledgeMarkdown(expert: ExpertDomainIntent): string[] {
  const testCommand = expert.test_command ?? "Use repository validation from AGENTS.md.";
  return [
    "## Relevant expert knowledge",
    "",
    `- Rationale: ${expert.rationale}`,
    ...(
      expert.primary_paths.length > 0
        ? ["- Primary paths:", ...expert.primary_paths.map((pathName) => `  - \`${pathName}\``)]
        : ["- Primary paths: none declared; infer from touched paths and domain name."]
    ),
    ...(
      expert.entry_points.length > 0
        ? ["- Entry points:", ...expert.entry_points.map((pathName) => `  - \`${pathName}\``)]
        : []
    ),
    ...(
      expert.key_files.length > 0
        ? [
            "- Key files:",
            ...expert.key_files.map((file) =>
              `  - \`${file.path}\` lines ${file.line_range[0]}-${file.line_range[1]}: ${file.purpose}`
            ),
          ]
        : []
    ),
    ...(
      expert.key_types.length > 0
        ? [
            "- Key types:",
            ...expert.key_types.map((keyType) =>
              `  - ${keyType.name} (\`${keyType.path}\`): ${keyType.purpose}`
            ),
          ]
        : []
    ),
    ...(
      expert.patterns.length > 0
        ? [
            "- Patterns to preserve:",
            ...expert.patterns.map((pattern) =>
              `  - ${pattern.name}: ${pattern.description} (${pattern.example_ref})`
            ),
          ]
        : []
    ),
    ...(
      expert.pitfalls.length > 0
        ? [
            "- Pitfalls to actively check:",
            ...expert.pitfalls.map((pitfall) =>
              `  - ${pitfall.risk}: ${pitfall.consequence} (${pitfall.reference})`
            ),
          ]
        : []
    ),
    ...(
      expert.conventions.length > 0
        ? ["- Conventions:", ...expert.conventions.map((convention) => `  - ${convention}`)]
        : []
    ),
    "- Validation:",
    `  - ${testCommand}`,
    ...expert.test_paths.map((pathName) => `  - \`${pathName}\``),
    "",
  ];
}

function renderExpertPlanPrompt(expert: ExpertDomainIntent): string {
  return [
    "---",
    `description: ${expert.domain} expert - plan work using domain expertise.`,
    'argument-hint: "<task>"',
    "---",
    "",
    `# ${expert.domain} Expert Plan`,
    "",
    `Read .pi/prompts/experts/${expert.domain}/expertise.yaml and plan the requested task.`,
    "Do not edit files in this mode.",
    "",
    ...expertKnowledgeMarkdown(expert),
    "## Required planning output",
    "",
    "- Task interpretation: restate the requested change in this domain's terms.",
    "- Relevant files and types: cite the exact expertise entries or repository file:line refs that should shape the work.",
    "- Invariants and pitfalls: name the patterns to preserve and the risks the implementation must avoid.",
    "- Validation plan: pick the smallest sufficient command and test paths from the expert knowledge; explain any broader suite needed.",
    "- Staleness check: if the expertise is stale, thin, or contradicted by the repository, name the files that must be re-read before implementation.",
    "",
    "",
    "$ARGUMENTS",
    "",
  ].join("\n");
}

function renderExpertPlanBuildImprovePrompt(expert: ExpertDomainIntent): string {
  return [
    "---",
    `description: ${expert.domain} expert - plan, build, validate, then refresh expertise.`,
    'argument-hint: "<task>"',
    "---",
    "",
    `# ${expert.domain} Expert Plan Build Improve`,
    "",
    `Use .pi/prompts/experts/${expert.domain}/expertise.yaml before planning or editing.`,
    "Before editing, produce the same risk-aware plan required by plan.md and apply these expert constraints to the implementation.",
    "Implement the task at the smallest safe scope, run the relevant validation, then update this expert's expertise.yaml if the work changed durable domain knowledge.",
    "",
    ...expertKnowledgeMarkdown(expert),
    "## Required build loop",
    "",
    "- Plan against the key files, key types, patterns, pitfalls, conventions, and validation above.",
    "- Edit only the smallest necessary domain surface.",
    `- Run \`${expert.test_command ?? "the relevant repository validation from AGENTS.md"}\`.`,
    `- If durable knowledge changes, update \`.pi/prompts/experts/${expert.domain}/expertise.yaml\` before finishing.`,
    "",
    "$ARGUMENTS",
    "",
  ].join("\n");
}

function legacyExpertToDomain(expert: LegacyExpertIntent): ExpertDomainIntent {
  return {
    domain: expert.name,
    rationale: oneLine(expert.body || expert.domain),
    primary_paths: [],
    entry_points: [],
    test_paths: [],
    key_files: [],
    key_types: [],
    patterns: [
      {
        name: "legacy-intent",
        description: oneLine(expert.body || `Expert material for ${expert.domain}.`),
        example_ref: "AGENTS.md:1",
      },
    ],
    pitfalls: [],
    conventions: [],
    stability: "medium",
    recurrence: "medium",
    test_command: null,
    last_updated: new Date(0).toISOString(),
  };
}

function renderExpertDomainArtifacts(expert: ExpertDomainIntent): RenderedArtifact[] {
  const basePath = `.pi/prompts/experts/${expert.domain}`;
  return [
    hashCommentArtifact({
      relativePath: `${basePath}/expertise.yaml`,
      kind: "expert",
      required: false,
      source: "expert-domain-renderer",
      body: renderExpertiseYaml(expert),
    }),
    markdownArtifact({
      relativePath: `${basePath}/question.md`,
      kind: "expert",
      required: false,
      source: "expert-domain-renderer",
      body: renderExpertQuestionPrompt(expert),
    }),
    markdownArtifact({
      relativePath: `${basePath}/self-improve.md`,
      kind: "expert",
      required: false,
      source: "expert-domain-renderer",
      body: renderExpertSelfImprovePrompt(expert),
    }),
    markdownArtifact({
      relativePath: `${basePath}/plan.md`,
      kind: "expert",
      required: false,
      source: "expert-domain-renderer",
      body: renderExpertPlanPrompt(expert),
    }),
    markdownArtifact({
      relativePath: `${basePath}/plan_build_improve.md`,
      kind: "expert",
      required: false,
      source: "expert-domain-renderer",
      body: renderExpertPlanBuildImprovePrompt(expert),
    }),
  ];
}

function renderFallbackAgentGuide(map: CodebaseMap): string {
  const validation = repositoryValidationCommands(map);
  const perChangeValidation = changeTypeValidationLines(map);

  const firstFiles = map.skeleton.first_5_files_for_fresh_agent
    .slice(0, 5)
    .map((entry) => `- \`${entry.path}\` - ${oneLine(entry.why)}`);

  const pitfalls = map.pitfalls
    .slice(0, 5)
    .map((pitfall) => `- \`${pitfall.module}:${pitfall.line_ref}\`: ${oneLine(pitfall.what)} (${oneLine(pitfall.consequence)})`);
  const validationLines = validation.length > 0
    ? validation.map((command) => `- \`${command}\``)
    : [
        "- No validation commands were identified by the audit. Add or document a validation command before trusting automation for risky changes.",
      ];

  return [
    "# AGENTS.md",
    "",
    "Working notes for coding agents. This file is generated from the validated agentify codebase map.",
    "",
    "## Project",
    "",
    `- Type: ${oneLine(map.meta.project_type)}`,
    `- Domain: ${oneLine(map.meta.domain_hypothesis)}`,
    `- Languages: ${map.meta.languages.join(", ") || "unknown"}`,
    "",
    "## First Files",
    "",
    ...firstFiles,
    "",
    "## Validation",
    "",
    ...validationLines,
    "",
    "## Validation By Change Type",
    "",
    ...perChangeValidation,
    "",
    "## Conventions",
    "",
    `- Files: ${oneLine(map.conventions.naming.files)}`,
    `- Functions: ${oneLine(map.conventions.naming.functions)}`,
    `- Errors: ${oneLine(map.conventions.error_handling.raise_vs_return)}`,
    "",
    "## Pitfalls",
    "",
    ...(pitfalls.length > 0 ? pitfalls : ["- No major pitfalls were identified in the audit map."]),
    "",
  ].join("\n");
}

function renderIntentAgentGuide(intents: ArtifactIntents): string {
  const sections = intents.agent_guide.sections.flatMap((section) => [
    `## ${oneLine(section.heading)}`,
    "",
    section.body.trim(),
    "",
  ]);
  return [
    `# ${oneLine(intents.agent_guide.title)}`,
    "",
    ...sections,
  ].join("\n");
}

function renderFallbackSpecs(map: CodebaseMap): string {
  return [
    "# Specs",
    "",
    "Agentify-generated spec guidance from the validated codebase map.",
    "",
    "## Validation By Change Type",
    "",
    ...changeTypeValidationLines(map),
    "",
  ].join("\n");
}

function renderFallbackAiDocs(map: CodebaseMap): string {
  return [
    "# AI Docs",
    "",
    "Agentify-generated always-on context from the validated codebase map.",
    "",
    "## Module Boundaries",
    "",
    ...map.module_graph.edges.slice(0, 20).map((edge) => `- \`${edge.from}\` -> \`${edge.to}\` (${edge.kind})`),
    "",
    "## Security Notes",
    "",
    ...map.security_surface.damage_control_rules.slice(0, 20).map((rule) => `- ${oneLine(rule)}`),
    "",
  ].join("\n");
}

function featureAgentBody(intent: FeatureAgentIntent): string {
  const globs = intent.globs.length > 0
    ? ["globs:", ...intent.globs.map((glob) => `  - ${glob}`)]
    : [];
  return [
    "---",
    `name: ${intent.name}`,
    `description: ${oneLine(intent.description)}`,
    ...globs,
    "---",
    "",
    intent.body.trim(),
    "",
  ].join("\n");
}

function renderFallbackFeatureAgentBody(name: string, map: CodebaseMap): string {
  const matchingFirstFiles = map.skeleton.first_5_files_for_fresh_agent
    .filter((entry) => entry.path.includes(name))
    .slice(0, 5);
  const firstFiles = (matchingFirstFiles.length > 0
    ? matchingFirstFiles
    : map.skeleton.first_5_files_for_fresh_agent.slice(0, 5)
  ).map((entry) => `- \`${entry.path}\` - ${oneLine(entry.why)}`);

  const validation = uniqueCommands([
    ...repositoryValidationCommands(map),
    ...mandatoryChangeTypeCommands(map),
  ]);

  const matchingPitfalls = map.pitfalls
    .filter((pitfall) => pitfall.module.includes(name) || pitfall.what.toLowerCase().includes(name))
    .slice(0, 5);
  const pitfalls = (matchingPitfalls.length > 0 ? matchingPitfalls : map.pitfalls.slice(0, 5))
    .map((pitfall) =>
      `- \`${pitfall.module}:${pitfall.line_ref}\`: ${oneLine(pitfall.what)} Consequence: ${oneLine(pitfall.consequence)}`,
    );

  return [
    "Use the validated codebase map before changing this area.",
    "",
    "## Scope",
    "",
    `- Specialist: ${name}`,
    `- Domain hypothesis: ${oneLine(map.meta.domain_hypothesis)}`,
    `- Primary glob: ${name}`,
    "",
    "## First Files",
    "",
    ...(firstFiles.length > 0 ? firstFiles : ["- Use `AGENTS.md` and `.pi/agentify/codebase_map.json` for orientation."]),
    "",
    "## Validation",
    "",
    ...(validation.length > 0 ? validation.map((command) => `- \`${command}\``) : ["- Use the repository validation surface from `AGENTS.md`."]),
    "",
    "## Pitfalls",
    "",
    ...(pitfalls.length > 0 ? pitfalls : ["- No feature-specific pitfalls were identified in the audit map."]),
    "",
  ].join("\n");
}

function renderFallbackFeatureAgents(map: CodebaseMap): RenderedArtifact[] {
  const domains = map.meta.suggested_subagent_domains ?? [];
  return domains
    .filter(isKebabName)
    .slice(0, 12)
    .map((name) => markdownArtifact({
      relativePath: `.pi/agents/${name}.md`,
      kind: "audit",
      required: false,
      source: "fallback-feature-agent-renderer",
      body: featureAgentBody({
        name,
        description: `Agentify specialist for ${name}.`,
        globs: [name],
        body: renderFallbackFeatureAgentBody(name, map),
      }),
    }));
}

function workflowNameForAgent(agentName: string): string {
  return `${agentName.replace(/-/g, "_")}_plan_build_review_fix`;
}

function renderSpecialistWorkflowSpec(agentName: string, map: CodebaseMap): WorkflowSpec {
  const title = titleCaseName(agentName);
  const validation = uniqueCommands([
    ...repositoryValidationCommands(map),
    ...mandatoryChangeTypeCommands(map),
  ]);

  return {
    name: workflowNameForAgent(agentName),
    description: `Scout with the ${title} specialist, then run the canonical plan-build-review-fix AIW loop.`,
    tags: ["agentify", "specialist", agentName],
    inputs: {
      prompt: {
        type: "string",
        description: `The ${title} work request to plan, build, review, and fix.`,
      },
      change_type: {
        type: "string",
        default: "feature",
        values: ["chore", "bug", "feature"],
      },
    },
    parallelism: "sequential",
    max_runtime_minutes: 120,
    steps: [
      {
        id: "scout",
        description: `Gather ${title} context before implementation.`,
        handler: "subagent",
        subagent_template: agentName,
        domain: [agentName],
        user_prompt: [
          `Scout the ${agentName} area for this request: \${inputs.prompt}`,
          "Return concrete files, invariants, pitfalls, and validation commands.",
          validation.length > 0
            ? `Repository validation surface: ${validation.join("; ")}.`
            : "Use the repository validation surface from AGENTS.md.",
        ].join("\n"),
      },
      {
        id: "implement",
        description: "Run the canonical AIW after specialist reconnaissance.",
        handler: "aiw",
        workflow_type: "plan_build_review_fix",
        prompt: "${inputs.prompt}\n\nSpecialist scout context:\n${agents[scout].result_text}",
        change_type: "${inputs.change_type}",
        depends_on: ["scout"],
      },
    ],
  };
}

function renderedWorkflowAgentNames(map: CodebaseMap, intents: ArtifactIntents | undefined): string[] {
  const names = new Set<string>();
  for (const agent of intents?.feature_agents ?? []) {
    if (isKebabName(agent.name)) names.add(agent.name);
  }
  for (const domain of map.meta.suggested_subagent_domains ?? []) {
    if (isKebabName(domain)) names.add(domain);
  }
  return [...names].slice(0, 12);
}

function renderProjectWorkflowArtifacts(
  map: CodebaseMap,
  intents: ArtifactIntents | undefined,
  errors: string[],
): RenderedArtifact[] {
  const artifacts: RenderedArtifact[] = [];
  for (const agentName of renderedWorkflowAgentNames(map, intents)) {
    const spec = renderSpecialistWorkflowSpec(agentName, map);
    const validation = validateWorkflowSpec(spec);
    if (!validation.ok) {
      errors.push(`invalid generated workflow for ${agentName}: ${validation.errors.join("; ")}`);
      continue;
    }
    artifacts.push(jsonArtifact({
      relativePath: `.pi/workflows/${agentName}-plan-build-review-fix.json`,
      kind: "workflow",
      required: false,
      source: "specialist-workflow-renderer",
      value: spec,
    }));
  }
  return artifacts;
}

function renderAlwaysOnDocs(map: CodebaseMap, intents: ArtifactIntents | undefined): RenderedArtifact[] {
  const artifacts = new Map<string, RenderedArtifact>();
  const add = (artifact: RenderedArtifact): void => {
    artifacts.set(artifact.relativePath, artifact);
  };

  if (intents) {
    for (const doc of intents.always_on_docs) {
      const relativePath = normalizePath(doc.path);
      if (!isSafeRelativePath(relativePath)) continue;
      add(markdownArtifact({
        relativePath,
        kind: "audit",
        required: REQUIRED_ALWAYS_ON_DOCS.has(relativePath),
        source: "always-on-docs-renderer",
        body: [`# ${oneLine(doc.title)}`, "", doc.body.trim(), ""].join("\n"),
      }));
    }
  }

  if (!artifacts.has("specs/README.md")) {
    add(markdownArtifact({
      relativePath: "specs/README.md",
      kind: "audit",
      required: true,
      source: "fallback-specs-renderer",
      body: renderFallbackSpecs(map),
    }));
  }

  if (!artifacts.has("ai_docs/README.md")) {
    add(markdownArtifact({
      relativePath: "ai_docs/README.md",
      kind: "audit",
      required: true,
      source: "fallback-ai-docs-renderer",
      body: renderFallbackAiDocs(map),
    }));
  }

  return [...artifacts.values()];
}

function renderFeedbackLoopArtifacts(map: CodebaseMap, intents: ArtifactIntents | undefined): RenderedArtifact[] {
  const aiDocsEntries = map.meta.documentation.has_ai_docs
    ? ["- `ai_docs/README.md` when repository-wide AI context is useful."]
    : ["- No existing AI docs were detected during bootstrap."];
  const generatedDocEntries = (intents?.always_on_docs ?? [])
    .map((doc) => ({
      path: normalizePath(doc.path),
      title: oneLine(doc.title),
    }))
    .filter((doc) => isSafeRelativePath(doc.path) && !REQUIRED_ALWAYS_ON_DOCS.has(doc.path))
    .slice(0, 20)
    .map((doc) => `- \`${doc.path}\` when the task touches ${doc.title}.`);
  return [
    markdownArtifact({
      relativePath: "app_review/README.md",
      kind: "audit",
      required: false,
      source: "feedback-loop-renderer",
      body: [
        "# App Review",
        "",
        "Stores TestResult and ReviewResult artifacts produced by agentify review and test skills.",
        "Screenshots and visual evidence should live under branch-specific subdirectories.",
        "",
        "## Required Entries",
        "",
        "- TestResult: validation commands, exit status, relevant stdout/stderr tail, and artifacts.",
        "- ReviewResult: verdict, blockers, non-blocking risks, files reviewed, and follow-up recommendation.",
        "- Evidence: screenshots or logs for UI, workflow, or operational changes.",
        "- Traceability: branch, commit, issue/PR link, changed paths, and reviewer/agent identity.",
        "",
      ].join("\n"),
    }),
    markdownArtifact({
      relativePath: "app_docs/README.md",
      kind: "audit",
      required: false,
      source: "feedback-loop-renderer",
      body: [
        "# App Docs",
        "",
        "Stores feature documentation written by the agentify document skill after reviewed changes.",
        "Keep durable application knowledge here and link it from `.pi/conditional_docs.md` when it should be loaded conditionally.",
        "",
        "## Entry Template",
        "",
        "- What changed: durable behavior, domain rule, workflow, or operational fact.",
        "- Why it matters: the failure mode this knowledge prevents.",
        "- When to load: trigger phrases or touched paths for `.pi/conditional_docs.md`.",
        "- Validation: command or review evidence that proved the documented behavior.",
        "",
      ].join("\n"),
    }),
    markdownArtifact({
      relativePath: "app_fix_reports/README.md",
      kind: "audit",
      required: false,
      source: "feedback-loop-renderer",
      body: [
        "# App Fix Reports",
        "",
        "Stores patch reports written by the agentify fix skill.",
        "Each report should explain the blocker fixed, files touched, validation run, and any residual risk.",
        "",
      ].join("\n"),
    }),
    markdownArtifact({
      relativePath: "app_docs/agentic_kpis.md",
      kind: "audit",
      required: false,
      source: "feedback-loop-renderer",
      body: [
        "# Agentic KPIs",
        "",
        "| Date | Branch | Change | Review Result | Fixes | Validation | Notes |",
        "|------|--------|--------|---------------|-------|------------|-------|",
        "",
      ].join("\n"),
    }),
    markdownArtifact({
      relativePath: ".pi/conditional_docs.md",
      kind: "audit",
      required: false,
      source: "feedback-loop-renderer",
      body: [
        "# Conditional Docs",
        "",
        "Load these docs when the task matches the listed condition.",
        "",
        "## Bootstrap Entries",
        "",
        ...aiDocsEntries,
        ...generatedDocEntries,
        "",
        "## Format",
        "",
        "- `path`: repository-relative document path.",
        "- `when`: 2-4 short trigger phrases describing when to load it.",
        "",
      ].join("\n"),
    }),
  ];
}

function renderSkillCandidate(skill: SkillCandidateIntent): RenderedArtifact {
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
    relativePath: `.pi/skills/${skill.name}/SKILL.md`,
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

function renderSkillCandidateArtifacts(map: CodebaseMap, errors: string[]): RenderedArtifact[] {
  const skillCandidates = map.grade3_evidence?.skill_candidates ?? [];
  const existingSkills = new Set(map.meta.documentation.existing_pi_skills ?? []);
  const artifacts: RenderedArtifact[] = [];
  for (const skill of skillCandidates) {
    if (!isKebabName(skill.name)) {
      errors.push(`invalid skill candidate name: ${skill.name}`);
      continue;
    }
    if (existingSkills.has(skill.name)) continue;
    artifacts.push(renderSkillCandidate(skill));
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

function renderCustomToolCandidate(tool: CustomToolCandidateIntent): RenderedArtifact | null {
  const argv = splitShellFreeCommand(tool.existing_command);
  if (!argv || argv.length === 0) return null;
  const [command, ...args] = argv;
  return hashCommentArtifact({
    relativePath: `.pi/extensions/${tool.name}.ts`,
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

function renderCustomToolCandidateArtifacts(map: CodebaseMap, errors: string[]): RenderedArtifact[] {
  const customToolCandidates = map.grade3_evidence?.custom_tool_candidates ?? [];
  const existingExtensionNames = new Set(
    (map.meta.documentation.existing_pi_extensions ?? [])
      .map((entry) => normalizePath(entry).split("/").pop() ?? "")
      .map((entry) => entry.replace(/\.ts$/, "")),
  );
  const artifacts: RenderedArtifact[] = [];
  for (const tool of customToolCandidates) {
    if (!isKebabName(tool.name)) {
      errors.push(`invalid custom tool candidate name: ${tool.name}`);
      continue;
    }
    if (existingExtensionNames.has(tool.name)) continue;
    const artifact = renderCustomToolCandidate(tool);
    if (artifact) artifacts.push(artifact);
  }
  return artifacts;
}

function titleCaseName(value: string): string {
  return value
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function validationLines(map: CodebaseMap): string[] {
  return [
    `- Test: ${nonEmptyCommand(map.validation_surface.test_command) ?? "not configured"}`,
    `- Lint: ${nonEmptyCommand(map.validation_surface.lint_command) ?? "not configured"}`,
    `- Typecheck: ${nonEmptyCommand(map.validation_surface.typecheck_command) ?? "not configured"}`,
    `- E2E: ${nonEmptyCommand(map.validation_surface.e2e_command) ?? "not configured"}`,
  ];
}

function renderIssueTypePrompt(map: CodebaseMap, issueType: string): RenderedArtifact {
  const title = titleCaseName(issueType);
  return markdownArtifact({
    relativePath: `.pi/prompts/${issueType}.md`,
    kind: "prompt",
    required: false,
    source: "lifecycle-prompt-renderer",
    body: [
      "---",
      `description: Write an agentify build spec for ${issueType} work in this repository.`,
      `argument-hint: "<one-sentence ${issueType} task>"`,
      "---",
      "",
      `# ${title}`,
      "",
      "## Goal",
      "",
      `Write a build spec for $ARGUMENTS to \`specs/${issueType}-<slug>.md\`.`,
      "The implementer will run `/implement <spec-path>` after the spec is reviewed.",
      "",
      "## Workflow",
      "",
      "1. Read `specs/README.md` for this repository's spec conventions.",
      "2. Read `.pi/conditional_docs.md` and load matching docs when present.",
      "3. Read `AGENTS.md` for current build, test, and ownership guidance.",
      "4. Inspect the relevant files before naming implementation steps.",
      "5. Write the spec with `## Relevant Files`, `## Steps`, and `## Validation Commands`.",
      "",
      "## Validation Surface",
      "",
      ...validationLines(map),
      "",
      "## Validation By Change Type",
      "",
      ...changeTypeValidationLines(map),
      "",
      "## Instructions",
      "",
      "- MUST end with runnable validation commands.",
      "- MUST cite concrete repository paths in Relevant Files.",
      "- MUST NOT write product code from this prompt.",
      "",
    ].join("\n"),
  });
}

function renderPerAreaPrompt(map: CodebaseMap, candidate: PerAreaTemplateCandidateIntent): RenderedArtifact {
  const title = titleCaseName(candidate.area_name);
  return markdownArtifact({
    relativePath: `.pi/prompts/${candidate.area_name}.md`,
    kind: "prompt",
    required: false,
    source: "per-area-prompt-renderer",
    body: [
      "---",
      `description: ${candidate.area_name}-specific ${candidate.issue_type} template. Use for recurring ${candidate.issue_type} work in the ${candidate.area_name} area.`,
      `argument-hint: "<one-sentence ${candidate.issue_type} task in ${candidate.area_name}>"`,
      "---",
      "",
      `# ${title} (${candidate.issue_type})`,
      "",
      "## Goal",
      "",
      `Write a build spec for $ARGUMENTS using \`.pi/prompts/${candidate.issue_type}.md\` as the base format, enriched with ${candidate.area_name} context.`,
      "",
      "## Area Context",
      "",
      `- Source feature agent: \`${candidate.source_feature_agent}\``,
      `- Rationale: ${oneLine(candidate.rationale)}`,
      "- Trigger phrases:",
      ...candidate.trigger_phrases.map((phrase) => `  - ${oneLine(phrase)}`),
      "",
      "## Workflow",
      "",
      `1. Read \`.pi/prompts/${candidate.issue_type}.md\` for the base spec flow.`,
      `2. Read \`${candidate.source_feature_agent}\` for local conventions, key files, and pitfalls.`,
      "3. Read `AGENTS.md` and `.pi/conditional_docs.md`.",
      "4. Inspect relevant files before naming implementation steps.",
      "5. Write the spec to `specs/<type>-<slug>.md` with area-specific risks and validation.",
      "",
      "## Validation Surface",
      "",
      ...validationLines(map),
      "",
      "## Instructions",
      "",
      "- MUST include area-specific files, conventions, and pitfalls when they affect the task.",
      "- MUST NOT invent files or commands.",
      "- MUST NOT write product code from this prompt.",
      "",
    ].join("\n"),
  });
}

function renderLifecyclePromptArtifacts(map: CodebaseMap, existingPaths: Set<string>, errors: string[]): RenderedArtifact[] {
  const artifacts: RenderedArtifact[] = [];
  for (const issueType of map.meta.lifecycle.issue_types) {
    if (!isPromptName(issueType)) {
      errors.push(`invalid issue type prompt name: ${issueType}`);
      continue;
    }
    const relativePath = `.pi/prompts/${issueType}.md`;
    if (existingPaths.has(relativePath)) continue;
    const artifact = renderIssueTypePrompt(map, issueType);
    artifacts.push(artifact);
    existingPaths.add(artifact.relativePath);
  }

  for (const candidate of (map.meta.lifecycle.per_area_template_candidates ?? []).slice(0, 3)) {
    if (!isKebabName(candidate.area_name)) {
      errors.push(`invalid per-area prompt name: ${candidate.area_name}`);
      continue;
    }
    const relativePath = `.pi/prompts/${candidate.area_name}.md`;
    if (existingPaths.has(relativePath)) continue;
    const artifact = renderPerAreaPrompt(map, candidate);
    artifacts.push(artifact);
    existingPaths.add(artifact.relativePath);
  }
  return artifacts;
}

export function renderBrownfieldArtifacts(map: CodebaseMap): RenderArtifactsResult {
  const artifacts: RenderedArtifact[] = [];
  const errors: string[] = [];
  const intents = map.artifact_intents;

  const agentGuide = intents ? renderIntentAgentGuide(intents) : renderFallbackAgentGuide(map);
  if (countLines(agentGuide) > AGENTS_MD_MAX_LINES) {
    errors.push(`AGENTS.md would be ${countLines(agentGuide)} lines, exceeds the ${AGENTS_MD_MAX_LINES}-line cap`);
  } else {
    artifacts.push(markdownArtifact({
      relativePath: "AGENTS.md",
      kind: "audit",
      required: true,
      source: intents ? "agent-guide-renderer" : "fallback-agent-guide-renderer",
      body: agentGuide,
    }));
  }

  artifacts.push(...renderAlwaysOnDocs(map, intents));
  artifacts.push(...renderFeedbackLoopArtifacts(map, intents));
  artifacts.push(...renderProjectWorkflowArtifacts(map, intents, errors));

  if (intents) {
    for (const agent of intents.feature_agents) {
      if (!isKebabName(agent.name)) {
        errors.push(`invalid feature agent name: ${agent.name}`);
        continue;
      }
      artifacts.push(markdownArtifact({
        relativePath: `.pi/agents/${agent.name}.md`,
        kind: "audit",
        required: false,
        source: "feature-agent-renderer",
        body: featureAgentBody(agent),
      }));
    }

    for (const prompt of intents.prompt_templates) {
      if (!isKebabName(prompt.name)) {
        errors.push(`invalid prompt template name: ${prompt.name}`);
        continue;
      }
      artifacts.push(markdownArtifact({
        relativePath: `.pi/prompts/${prompt.name}.md`,
        kind: "prompt",
        required: false,
        source: "prompt-template-renderer",
        body: [
          "---",
          `description: ${oneLine(prompt.description)}`,
          "type: prompt-template",
          "---",
          "",
          prompt.body.trim(),
          "",
        ].join("\n"),
      }));
    }

    for (const extension of intents.extension_candidates) {
      if (!isKebabName(extension.name)) {
        errors.push(`invalid extension candidate name: ${extension.name}`);
        continue;
      }
      artifacts.push(hashCommentArtifact({
        relativePath: `.pi/extensions/${extension.name}.ts`,
        kind: "extension",
        required: false,
        source: "extension-candidate-renderer",
        body: extension.body.trim(),
      }));
    }
  } else {
    artifacts.push(...renderFallbackFeatureAgents(map));
  }

  artifacts.push(...renderLifecyclePromptArtifacts(
    map,
    new Set(artifacts.map((artifact) => artifact.relativePath)),
    errors,
  ));

  const expertDomains = map.grade7_evidence?.expert_domains
    ?? intents?.experts.map(legacyExpertToDomain)
    ?? [];
  for (const expert of expertDomains) {
    if (!isKebabName(expert.domain)) {
      errors.push(`invalid expert domain: ${expert.domain}`);
      continue;
    }
    artifacts.push(...renderExpertDomainArtifacts(expert));
  }

  artifacts.push(...renderSkillCandidateArtifacts(map, errors));
  artifacts.push(...renderCustomToolCandidateArtifacts(map, errors));

  const unsafe = artifacts
    .map((artifact) => artifact.relativePath)
    .filter((relativePath) => !isSafeRelativePath(relativePath));
  for (const relativePath of unsafe) {
    errors.push(`unsafe rendered artifact path: ${relativePath}`);
  }

  const seen = new Set<string>();
  for (const artifact of artifacts) {
    if (seen.has(artifact.relativePath)) {
      errors.push(`duplicate rendered artifact path: ${artifact.relativePath}`);
    }
    seen.add(artifact.relativePath);
  }

  return { artifacts, errors };
}
