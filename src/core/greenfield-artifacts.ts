import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  AGENTIFY_MANAGED_MARKERS,
  addMarkdownManagedMarker,
} from "./artifact-exporters.ts";
import { LEGACY_PI_STATE_RELATIVE_DIR } from "./state-dir.ts";
import type { ManagedArtifactKind, RenderedArtifact } from "./artifacts/renderers.ts";

/** Posix-style relative path of the greenfield formation file under
 *  the supplied agentify state dir (ADR 0020). */
export function greenfieldFormationRelativePath(stateDir: string): string {
  return path.join(stateDir, "greenfield-formation.json");
}

/** @deprecated Use `greenfieldFormationRelativePath(stateDir)`.
 *  Always resolves to the legacy `.pi/agentify/` path. */
export const GREENFIELD_FORMATION_RELATIVE_PATH = path.join(
  LEGACY_PI_STATE_RELATIVE_DIR,
  "greenfield-formation.json",
);

const GreenfieldUnitStatusSchema = StringEnum([
  "undrilled",
  "split",
  "prd-ready",
  "planned",
  "queued",
  "implementing",
  "implemented",
  "blocked",
] as const, {
  description: "Workflow status for a greenfield Goal or Sub-goal.",
});

const GreenfieldUnitModeSchema = StringEnum([
  "Sequential",
  "Parallel after Goal N",
] as const, {
  description: "Execution mode for a greenfield Goal.",
});

const GreenfieldChangeTypeSchema = StringEnum([
  "chore",
  "bug",
  "feature",
  "refactor",
  "security",
  "docs",
  "test",
  "perf",
  "chore_deps",
] as const, {
  description: "Spec change type. Used to build specs/<type>-<slug>.md.",
});

const GreenfieldFormationStopSchema = StringEnum([
  "goals",
  "prd",
  "plan",
  "issue_slices",
  "spec",
] as const, {
  description:
    "The user-approved milestone this formation payload stops at. The renderer rejects artifacts beyond this gate.",
});

const SlugString = Type.String({
  description: "kebab-case slug used in a generated artifact path.",
  pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
  minLength: 1,
  maxLength: 80,
});

const TextBlock = Type.String({
  description: "Substantive markdown-safe prose. Do not use placeholders.",
  minLength: 20,
  maxLength: 4000,
});

const ShortText = Type.String({
  description: "Short, concrete text. Do not use placeholders.",
  minLength: 3,
  maxLength: 300,
});

const GreenfieldDomainTermSchema = Type.Object({
  name: ShortText,
  meaning: TextBlock,
}, {
  description: "Domain vocabulary term captured during greenfield formation.",
});

const GreenfieldGoalSchema = Type.Object({
  title: ShortText,
  status: Type.Optional(GreenfieldUnitStatusSchema),
  mode: Type.Optional(GreenfieldUnitModeSchema),
  objective: TextBlock,
  sub_goals: Type.Array(TextBlock, {
    description: "Known sub-goal bullets. These are descriptive until split into child goal files.",
    minItems: 1,
    maxItems: 12,
  }),
  required_artifacts: Type.Array(TextBlock, {
    description: "Artifacts this unit must produce.",
    minItems: 1,
    maxItems: 12,
  }),
  dependencies: Type.Array(TextBlock, {
    description: "Other units or decisions this goal is blocked by. Use 'None.' when unblocked.",
    minItems: 1,
    maxItems: 12,
  }),
  definition_of_done: Type.Array(TextBlock, {
    description: "Observable conditions proving the goal is complete.",
    minItems: 1,
    maxItems: 12,
  }),
  spawned: Type.Array(ShortText, {
    description: "Artifacts spawned by this unit, or 'None yet.'",
    minItems: 1,
    maxItems: 16,
  }),
  next_action: TextBlock,
}, {
  description: "One top-level Goal in GOALS.md.",
});

const GreenfieldPhaseSchema = Type.Object({
  title: ShortText,
  goals: Type.Array(GreenfieldGoalSchema, {
    description: "Top-level goals in this phase.",
    minItems: 1,
    maxItems: 12,
  }),
}, {
  description: "A GOALS.md phase.",
});

const GreenfieldPrdSchema = Type.Object({
  slug: SlugString,
  title: ShortText,
  problem_statement: TextBlock,
  solution: TextBlock,
  user_stories: Type.Array(TextBlock, {
    description: "User stories in 'As an actor...' style.",
    minItems: 1,
    maxItems: 30,
  }),
  implementation_decisions: Type.Array(TextBlock, {
    description: "Implementation decisions captured before planning.",
    minItems: 1,
    maxItems: 30,
  }),
  testing_decisions: Type.Array(TextBlock, {
    description: "Testing decisions captured before planning.",
    minItems: 1,
    maxItems: 20,
  }),
  out_of_scope: Type.Array(TextBlock, {
    description: "Explicitly excluded work.",
    minItems: 1,
    maxItems: 20,
  }),
  further_notes: Type.Optional(Type.Array(TextBlock, {
    description: "Additional notes that help later planning.",
    minItems: 1,
    maxItems: 20,
  })),
}, {
  description: "A deterministic docs/prds/<slug>.md artifact.",
});

const GreenfieldPlanStepSchema = Type.Object({
  slice: TextBlock,
  rationale: TextBlock,
}, {
  description: "One ordered implementation slice and why it belongs there.",
});

const GreenfieldPlanSchema = Type.Object({
  slug: SlugString,
  title: ShortText,
  prd: ShortText,
  ordering: Type.Array(GreenfieldPlanStepSchema, {
    description: "Ordered implementation slices.",
    minItems: 1,
    maxItems: 30,
  }),
  open_risks: Type.Array(TextBlock, {
    description: "Risks to re-confirm before implementation.",
    minItems: 1,
    maxItems: 20,
  }),
}, {
  description: "A deterministic docs/plans/<slug>.md artifact.",
});

const GreenfieldIssueSchema = Type.Object({
  slug: SlugString,
  title: ShortText,
  parent: Type.Optional(ShortText),
  what_to_build: TextBlock,
  acceptance_criteria: Type.Array(TextBlock, {
    description: "Checkbox-ready criteria for the implementation slice.",
    minItems: 1,
    maxItems: 20,
  }),
  blocked_by: Type.Array(TextBlock, {
    description: "Blocking issue references, or 'None - can start immediately.'",
    minItems: 1,
    maxItems: 12,
  }),
}, {
  description: "A deterministic docs/issues/<slug>.md artifact.",
});

const GreenfieldRelevantFileSchema = Type.Object({
  path: ShortText,
  purpose: TextBlock,
}, {
  description: "File path and why the implementer should inspect or modify it.",
});

const GreenfieldSpecSchema = Type.Object({
  slug: SlugString,
  title: ShortText,
  change_type: GreenfieldChangeTypeSchema,
  relevant_files: Type.Array(GreenfieldRelevantFileSchema, {
    description: "Relevant files for the implementer.",
    minItems: 1,
    maxItems: 30,
  }),
  steps: Type.Array(TextBlock, {
    description: "Atomic ordered implementation steps.",
    minItems: 1,
    maxItems: 30,
  }),
  validation_commands: Type.Array(ShortText, {
    description: "Runnable commands that prove this spec is done.",
    minItems: 1,
    maxItems: 12,
  }),
}, {
  description: "A deterministic specs/<change_type>-<slug>.md artifact.",
});

export const GreenfieldFormationSchema = Type.Object({
  schema_version: Type.Literal("1", {
    description: "Version of the greenfield formation payload.",
  }),
  stop_at: GreenfieldFormationStopSchema,
  project_name: ShortText,
  context: Type.Object({
    summary: TextBlock,
    domain_terms: Type.Array(GreenfieldDomainTermSchema, {
      description: "Project-specific domain vocabulary.",
      minItems: 1,
      maxItems: 30,
    }),
  }, {
    description: "Durable project context for CONTEXT.md.",
  }),
  final_system_goal: TextBlock,
  phases: Type.Array(GreenfieldPhaseSchema, {
    description: "Top-level phased goal map for GOALS.md.",
    minItems: 1,
    maxItems: 12,
  }),
  prds: Type.Optional(Type.Array(GreenfieldPrdSchema, {
    description: "PRDs to render under docs/prds/.",
    minItems: 0,
    maxItems: 20,
  })),
  plans: Type.Optional(Type.Array(GreenfieldPlanSchema, {
    description: "Plans to render under docs/plans/.",
    minItems: 0,
    maxItems: 20,
  })),
  issues: Type.Optional(Type.Array(GreenfieldIssueSchema, {
    description: "Executable issue slices to render under docs/issues/.",
    minItems: 0,
    maxItems: 50,
  })),
  specs: Type.Optional(Type.Array(GreenfieldSpecSchema, {
    description: "Build specs to render under specs/.",
    minItems: 0,
    maxItems: 50,
  })),
}, {
  description:
    "Structured greenfield formation payload. agentify renders the markdown artifacts deterministically from this data.",
});

export type GreenfieldFormation = Static<typeof GreenfieldFormationSchema>;
type GreenfieldFormationStop = GreenfieldFormation["stop_at"];
type GreenfieldPrd = NonNullable<GreenfieldFormation["prds"]>[number];
type GreenfieldPlan = NonNullable<GreenfieldFormation["plans"]>[number];
type GreenfieldIssue = NonNullable<GreenfieldFormation["issues"]>[number];
type GreenfieldSpec = NonNullable<GreenfieldFormation["specs"]>[number];

export interface RenderGreenfieldArtifactsResult {
  artifacts: RenderedArtifact[];
  errors: string[];
}

const MARKDOWN_KIND: ManagedArtifactKind = "audit";

function normalizePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function markdownArtifact(relativePath: string, body: string, required: boolean): RenderedArtifact {
  return {
    relativePath: normalizePath(relativePath),
    content: ensureTrailingNewline(addMarkdownManagedMarker(body)),
    marker: AGENTIFY_MANAGED_MARKERS.markdown,
    kind: MARKDOWN_KIND,
    required,
    source: "greenfield-formation-renderer",
  };
}

function bulletList(items: readonly string[]): string[] {
  return items.map((item) => `- ${oneLine(item)}`);
}

function numberedList(items: readonly string[]): string[] {
  return items.map((item, index) => `${index + 1}. ${oneLine(item)}`);
}

function renderContext(formation: GreenfieldFormation): RenderedArtifact {
  return markdownArtifact("CONTEXT.md", [
    `# ${oneLine(formation.project_name)} Context`,
    "",
    formation.context.summary.trim(),
    "",
    "## Domain Terms",
    "",
    ...formation.context.domain_terms.flatMap((term) => [
      `- **${oneLine(term.name)}:** ${oneLine(term.meaning)}`,
    ]),
    "",
  ].join("\n"), true);
}

function renderGoals(formation: GreenfieldFormation): RenderedArtifact {
  const lines = [
    `# ${oneLine(formation.project_name)} - Goals`,
    "",
    "## Final system goal",
    "",
    formation.final_system_goal.trim(),
    "",
  ];
  let goalNumber = 1;
  formation.phases.forEach((phase, phaseIndex) => {
    lines.push(`# Phase ${phaseIndex + 1} - ${oneLine(phase.title)}`, "");
    for (const goal of phase.goals) {
      lines.push(
        `## Goal ${goalNumber}: ${oneLine(goal.title)}`,
        "",
        `**Status:** ${goal.status ?? "undrilled"}`,
        `**Mode:** ${goal.mode ?? "Sequential"}`,
        "",
        "### Objective",
        "",
        goal.objective.trim(),
        "",
        "### Sub-goals",
        "",
        ...bulletList(goal.sub_goals),
        "",
        "### Required artifacts",
        "",
        ...bulletList(goal.required_artifacts),
        "",
        "### Dependencies",
        "",
        ...bulletList(goal.dependencies),
        "",
        "### Definition of done",
        "",
        ...bulletList(goal.definition_of_done),
        "",
        "### Spawned",
        "",
        ...bulletList(goal.spawned),
        "",
        "### Next action",
        "",
        goal.next_action.trim(),
        "",
      );
      goalNumber += 1;
    }
  });
  return markdownArtifact("GOALS.md", lines.join("\n"), true);
}

function renderPrd(prd: GreenfieldPrd): RenderedArtifact {
  return markdownArtifact(`docs/prds/${prd.slug}.md`, [
    `# ${oneLine(prd.title)}`,
    "",
    "## Problem Statement",
    "",
    prd.problem_statement.trim(),
    "",
    "## Solution",
    "",
    prd.solution.trim(),
    "",
    "## User Stories",
    "",
    ...numberedList(prd.user_stories),
    "",
    "## Implementation Decisions",
    "",
    ...bulletList(prd.implementation_decisions),
    "",
    "## Testing Decisions",
    "",
    ...bulletList(prd.testing_decisions),
    "",
    "## Out of Scope",
    "",
    ...bulletList(prd.out_of_scope),
    "",
    "## Further Notes",
    "",
    ...(prd.further_notes && prd.further_notes.length > 0
      ? bulletList(prd.further_notes)
      : ["- No additional notes."]
    ),
    "",
  ].join("\n"), false);
}

function renderPlan(plan: GreenfieldPlan): RenderedArtifact {
  return markdownArtifact(`docs/plans/${plan.slug}.md`, [
    `# ${oneLine(plan.title)}`,
    "",
    "## PRD",
    "",
    oneLine(plan.prd),
    "",
    "## Ordering",
    "",
    ...plan.ordering.map((step, index) => (
      `${index + 1}. ${oneLine(step.slice)} - ${oneLine(step.rationale)}`
    )),
    "",
    "## Open risks",
    "",
    ...bulletList(plan.open_risks),
    "",
  ].join("\n"), false);
}

function renderIssue(issue: GreenfieldIssue): RenderedArtifact {
  return markdownArtifact(`docs/issues/${issue.slug}.md`, [
    `# ${oneLine(issue.title)}`,
    "",
    ...(issue.parent ? ["## Parent", "", oneLine(issue.parent), ""] : []),
    "## What to build",
    "",
    issue.what_to_build.trim(),
    "",
    "## Acceptance criteria",
    "",
    ...issue.acceptance_criteria.map((criterion) => `- [ ] ${oneLine(criterion)}`),
    "",
    "## Blocked by",
    "",
    ...bulletList(issue.blocked_by),
    "",
  ].join("\n"), false);
}

function renderSpec(spec: GreenfieldSpec): RenderedArtifact {
  return markdownArtifact(`specs/${spec.change_type}-${spec.slug}.md`, [
    `# ${oneLine(spec.title)}`,
    "",
    "## Relevant Files",
    "",
    ...spec.relevant_files.map((file) => `- \`${oneLine(file.path)}\` - ${oneLine(file.purpose)}`),
    "",
    "## Steps",
    "",
    ...numberedList(spec.steps),
    "",
    "## Validation Commands",
    "",
    ...spec.validation_commands.map((command) => `- \`${oneLine(command)}\``),
    "",
  ].join("\n"), false);
}

function findDuplicatePaths(artifacts: readonly RenderedArtifact[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const artifact of artifacts) {
    if (seen.has(artifact.relativePath)) duplicates.add(artifact.relativePath);
    seen.add(artifact.relativePath);
  }
  return [...duplicates].sort();
}

const FORMATION_STAGE_RULES: Record<GreenfieldFormationStop, {
  requires: Array<"prds" | "plans" | "issues" | "specs">;
  forbids: Array<"prds" | "plans" | "issues" | "specs">;
}> = {
  goals: {
    requires: [],
    forbids: ["prds", "plans", "issues", "specs"],
  },
  prd: {
    requires: ["prds"],
    forbids: ["plans", "issues", "specs"],
  },
  plan: {
    requires: ["prds", "plans"],
    forbids: ["issues", "specs"],
  },
  issue_slices: {
    requires: ["prds", "plans", "issues"],
    forbids: ["specs"],
  },
  spec: {
    requires: ["prds", "plans", "issues", "specs"],
    forbids: [],
  },
};

function artifactCount(
  formation: GreenfieldFormation,
  key: "prds" | "plans" | "issues" | "specs",
): number {
  return formation[key]?.length ?? 0;
}

function validateFormationGate(formation: GreenfieldFormation): string[] {
  const rules = FORMATION_STAGE_RULES[formation.stop_at];
  const errors: string[] = [];
  for (const key of rules.requires) {
    if (artifactCount(formation, key) === 0) {
      errors.push(`greenfield formation stop_at=${formation.stop_at} requires at least one ${key} artifact`);
    }
  }
  for (const key of rules.forbids) {
    const count = artifactCount(formation, key);
    if (count > 0) {
      errors.push(
        `greenfield formation stop_at=${formation.stop_at} cannot include ${key}; ` +
          "stop at the approved milestone and resume later after user approval",
      );
    }
  }
  return errors;
}

export function renderGreenfieldArtifacts(
  formation: GreenfieldFormation,
  options?: { stateDir?: string },
): RenderGreenfieldArtifactsResult {
  const gateErrors = validateFormationGate(formation);
  if (gateErrors.length > 0) {
    return { artifacts: [], errors: gateErrors };
  }
  const artifacts = [
    renderContext(formation),
    renderGoals(formation),
    ...(formation.prds ?? []).map(renderPrd),
    ...(formation.plans ?? []).map(renderPlan),
    ...(formation.issues ?? []).map(renderIssue),
    ...(formation.specs ?? []).map(renderSpec),
  ];
  const duplicatePaths = findDuplicatePaths(artifacts);
  const errors = duplicatePaths.map((relativePath) => (
    `greenfield formation renders duplicate artifact path: ${relativePath}`
  ));
  return { artifacts: errors.length === 0 ? artifacts : [], errors };
}

export function writeGreenfieldFormation(cwd: string, formation: GreenfieldFormation): void {
  const filePath = path.join(cwd, GREENFIELD_FORMATION_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(formation, null, 2)}\n`, { mode: 0o644 });
}

export function readGreenfieldFormation(cwd: string): GreenfieldFormation | null {
  const filePath = path.join(cwd, GREENFIELD_FORMATION_RELATIVE_PATH);
  if (!fs.existsSync(filePath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
  return Value.Check(GreenfieldFormationSchema, parsed) ? (parsed as GreenfieldFormation) : null;
}

/**
 * Write the greenfield formation payload at
 * `<stateDir>/greenfield-formation.json` (ADR 0020). New audit
 * code should call this when the audit is wired to a
 * provider-scoped state dir.
 */
export function writeGreenfieldFormationAt(
  cwd: string,
  formation: GreenfieldFormation,
  stateDir: string,
): void {
  const filePath = path.join(cwd, stateDir, "greenfield-formation.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(formation, null, 2)}\n`, { mode: 0o644 });
}

/**
 * Read the greenfield formation payload at
 * `<stateDir>/greenfield-formation.json` (ADR 0020). Returns null
 * when the file is missing or fails schema validation.
 */
export function readGreenfieldFormationAt(
  cwd: string,
  stateDir: string,
): GreenfieldFormation | null {
  // Try the resolved state dir first, then fall back to the
  // legacy `.pi/agentify/` path for backward compat with formations
  // written by older runs and test fakes that don't know about
  // the resolved state dir.
  const candidates = [
    path.join(cwd, stateDir, "greenfield-formation.json"),
    path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR, "greenfield-formation.json"),
  ];
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
      return null;
    }
    if (Value.Check(GreenfieldFormationSchema, parsed)) {
      return parsed as GreenfieldFormation;
    }
  }
  return null;
}

export function createWriteGreenfieldArtifactsTool(opts?: { stateDir?: string }): ToolDefinition {
  const stateDir = opts?.stateDir;
  return defineTool({
    name: "write_greenfield_artifacts",
    label: "Write Greenfield Artifacts",
    description:
      "Persist structured greenfield formation data. agentify renders CONTEXT.md, " +
      "GOALS.md, docs/prds, docs/plans, docs/issues, and specs deterministically " +
      "from this payload after the session. Use this instead of writing planning " +
      "markdown files directly.",
    parameters: GreenfieldFormationSchema,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!Value.Check(GreenfieldFormationSchema, params)) {
        return {
          content: [{
            type: "text",
            text:
              "Error: write_greenfield_artifacts received invalid formation data. " +
              "Submit the exact schema with substantive project context, goals, and artifact fields.",
          }],
          isError: true,
          details: { errors: ["invalid greenfield formation schema"] },
        };
      }
      const formation = params as GreenfieldFormation;
      const renderResult = renderGreenfieldArtifacts(formation);
      if (renderResult.errors.length > 0) {
        return {
          content: [{
            type: "text",
            text: `Error: ${renderResult.errors.join("; ")}`,
          }],
          isError: true,
          details: { errors: renderResult.errors },
        };
      }
      if (stateDir !== undefined) {
        writeGreenfieldFormationAt(ctx.cwd, formation, stateDir);
      } else {
        writeGreenfieldFormation(ctx.cwd, formation);
      }
      return {
        content: [{
          type: "text",
          text:
            `Accepted greenfield formation for ${formation.project_name}. ` +
            `agentify will render ${renderResult.artifacts.length} managed artifact(s) after the session.`,
        }],
        details: {
          path: stateDir !== undefined
            ? path.join(ctx.cwd, stateDir, "greenfield-formation.json")
            : path.join(ctx.cwd, GREENFIELD_FORMATION_RELATIVE_PATH),
          artifact_count: renderResult.artifacts.length,
          artifact_paths: renderResult.artifacts.map((artifact) => artifact.relativePath),
        },
      };
    },
  }) as unknown as ToolDefinition;
}
