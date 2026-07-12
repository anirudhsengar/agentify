import type { ArtifactIntents, CodebaseMap } from "../../audit/schema.ts";
import { hashCommentArtifact, isKebabName, markdownArtifact, oneLine, yamlScalar, yamlStringArray } from "./artifact-builders.ts";
import type { RenderedArtifact } from "./types.ts";

type ExpertDomainIntent = NonNullable<CodebaseMap["expert_evidence"]>["expert_domains"][number];
type LegacyExpertIntent = ArtifactIntents["experts"][number];

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

export function renderExpertArtifacts(
  map: CodebaseMap,
  intents: ArtifactIntents | undefined,
  errors: string[],
): RenderedArtifact[] {
  const artifacts: RenderedArtifact[] = [];
  const expertDomains = map.expert_evidence?.expert_domains
    ?? intents?.experts.map(legacyExpertToDomain)
    ?? [];
  for (const expert of expertDomains) {
    if (!isKebabName(expert.domain)) {
      errors.push(`invalid expert domain: ${expert.domain}`);
      continue;
    }
    artifacts.push(...renderExpertDomainArtifacts(expert));
  }
  return artifacts;
}
