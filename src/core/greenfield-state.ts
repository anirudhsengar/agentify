import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { LEGACY_PI_STATE_RELATIVE_DIR } from "./state-dir.ts";
import {
  readGreenfieldFormation,
  readGreenfieldFormationAt,
  type GreenfieldFormation,
} from "./greenfield-artifacts.ts";

/** Posix-style relative path of the greenfield state file under the
 *  supplied agentify state dir. */
export function greenfieldStateRelativePath(stateDir: string): string {
  return path.join(stateDir, "greenfield-state.json");
}

/** @deprecated Use `greenfieldStateRelativePath(stateDir)`. Always
 *  resolves to the legacy `.pi/agentify/` path. */
export const GREENFIELD_STATE_RELATIVE_PATH = path.join(
  LEGACY_PI_STATE_RELATIVE_DIR,
  "greenfield-state.json",
);

export const GreenfieldCheckpointSchema = StringEnum([
  "wide_idea",
  "goals",
  "prd",
  "plan",
  "issue_slices",
  "spec",
] as const, {
  description:
    "Furthest durable greenfield formation checkpoint reached by this repository.",
});

export const GreenfieldCheckpointsSchema = Type.Object({
  wide_idea: Type.Boolean({
    description: "Whether CONTEXT.md exists.",
  }),
  goals: Type.Boolean({
    description: "Whether GOALS.md exists.",
  }),
  prd: Type.Boolean({
    description: "Whether docs/prds/ contains at least one file.",
  }),
  plan: Type.Boolean({
    description: "Whether docs/plans/ contains at least one file.",
  }),
  issue_slices: Type.Boolean({
    description: "Whether docs/issues/ contains at least one file.",
  }),
  spec: Type.Boolean({
    description: "Whether specs/ contains at least one file.",
  }),
}, {
  description:
    "Boolean formation milestones derived from the greenfield artifact files on disk.",
});

export const GreenfieldArtifactValidationSchema = Type.Object({
  ok: Type.Boolean({
    description:
      "True only when the current greenfield artifacts are substantive enough to install the GitHub runtime scaffold.",
  }),
  reasons: Type.Array(Type.String({
    description: "Concrete artifact-quality failure reason.",
  }), {
    description:
      "Why artifact validation failed. Empty when ok is true.",
    minItems: 0,
    maxItems: 50,
  }),
}, {
  description:
    "Result of validating greenfield artifacts for required sections and minimum substance.",
});

export const GreenfieldResumeSourceSchema = StringEnum([
  "formation",
  "filesystem",
] as const, {
  description:
    "Where the resume context came from. formation = typed write_greenfield_artifacts payload; filesystem = inferred fallback.",
});

export const GreenfieldResumeSchema = Type.Object({
  source: GreenfieldResumeSourceSchema,
  stop_at: Type.Union([GreenfieldCheckpointSchema, Type.Null()], {
    description:
      "User-approved milestone gate from structured formation, or null when only filesystem inference is available.",
  }),
  current_focus: Type.Union([Type.String(), Type.Null()], {
    description:
      "Human-readable unit to resume, usually the first selected Goal title from the formation payload.",
  }),
  artifact_paths: Type.Array(Type.String({
    description: "Repo-relative planning artifact path that exists for this checkpoint.",
  }), {
    description:
      "Exact planning files that define the current greenfield checkpoint.",
    minItems: 0,
    maxItems: 80,
  }),
  local_resume: Type.String({
    description:
      "Concrete local terminal continuation instruction for the next agent/user turn.",
  }),
  github_resume: Type.String({
    description:
      "Concrete post-bootstrap GitHub continuation instruction for async drilling or implementation.",
  }),
}, {
  description:
    "Persisted handoff context that makes local greenfield formation resumable and connects it to the GitHub loop.",
});

export const GreenfieldGitHubHandoffActionSchema = StringEnum([
  "open_drill_issue",
  "create_implementation_issues",
  "open_implementation_issue",
] as const, {
  description:
    "Machine-readable next GitHub action for continuing greenfield formation after bootstrap.",
});

export const GreenfieldGitHubHandoffSchema = Type.Object({
  action: GreenfieldGitHubHandoffActionSchema,
  title: Type.String({
    description: "Suggested GitHub issue title for the next async greenfield step.",
  }),
  body: Type.String({
    description:
      "Suggested GitHub issue body with artifact references and state-file context.",
  }),
  labels: Type.Array(Type.String({
    description: "GitHub label to apply to the handoff issue.",
  }), {
    description:
      "Labels that trigger or prepare the next scaffold workflow.",
    minItems: 1,
    maxItems: 6,
  }),
  artifact_paths: Type.Array(Type.String({
    description: "Repo-relative greenfield artifact path referenced by this handoff.",
  }), {
    description:
      "Artifact files the GitHub issue should cite so the async workflow resumes from the right checkpoint.",
    minItems: 0,
    maxItems: 80,
  }),
}, {
  description:
    "Structured GitHub issue handoff for continuing greenfield work through the public scaffold loop.",
});

export const GreenfieldStateSchema = Type.Object({
  schema_version: Type.Literal("1", {
    description: "Version of the greenfield-state.json schema.",
  }),
  updated_at: Type.String({
    description: "ISO timestamp for when agentify wrote this checkpoint state.",
  }),
  checkpoint: GreenfieldCheckpointSchema,
  turns: Type.Number({
    description: "Number of model turns used by the greenfield formation session.",
  }),
  cost_usd: Type.Union([Type.Number(), Type.Null()], {
    description: "Provider-reported session cost, or null when unavailable.",
  }),
  aborted: Type.Boolean({
    description: "Whether the greenfield formation session ended through abort/cancel.",
  }),
  checkpoints: GreenfieldCheckpointsSchema,
  next_actions: Type.Array(Type.String({
    description: "Concrete next action for continuing from the current checkpoint.",
  }), {
    description:
      "Deterministic next actions that keep the greenfield workflow resumable.",
    minItems: 1,
    maxItems: 8,
  }),
  artifact_validation: GreenfieldArtifactValidationSchema,
  resume: GreenfieldResumeSchema,
  github_handoff: GreenfieldGitHubHandoffSchema,
}, {
  description:
    "Checkpoint handoff written after greenfield formation so later runs can resume deliberately.",
});

export type GreenfieldCheckpoint = Static<typeof GreenfieldCheckpointSchema>;
export type GreenfieldState = Static<typeof GreenfieldStateSchema>;
export type GreenfieldArtifactValidation = Static<typeof GreenfieldArtifactValidationSchema>;
export type GreenfieldGitHubHandoff = Static<typeof GreenfieldGitHubHandoffSchema>;

export interface BuildGreenfieldStateParams {
  turns: number;
  aborted: boolean;
  costUsd: number | null;
  nowIso?: string;
}

function listFilesRecursively(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        stack.push(path.join(current, entry));
      }
    } else if (stat.isFile()) {
      out.push(current);
    }
  }
  return out;
}

function hasFiles(cwd: string, relativePath: string): boolean {
  return listFilesRecursively(path.join(cwd, relativePath)).length > 0;
}

function markdownFiles(cwd: string, relativePath: string): string[] {
  return listFilesRecursively(path.join(cwd, relativePath))
    .filter((filePath) => filePath.endsWith(".md"))
    .sort((a, b) => a.localeCompare(b));
}

function readIfExists(cwd: string, relativePath: string): string | null {
  const filePath = path.join(cwd, relativePath);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null;
}

function hasHeading(content: string, heading: string): boolean {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^## ${escaped}\\s*$`, "m").test(content);
}

function requireHeadings(reasons: string[], relativePath: string, content: string, headings: string[]): void {
  for (const heading of headings) {
    if (!hasHeading(content, heading)) {
      reasons.push(`${relativePath}: missing "## ${heading}" section`);
    }
  }
}

function hasSubstance(content: string, minimumLength = 120): boolean {
  return content.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").trim().length >= minimumLength;
}

function validateContext(cwd: string, reasons: string[]): void {
  const content = readIfExists(cwd, "CONTEXT.md");
  if (content === null) return;
  if (!hasSubstance(content, 80)) {
    reasons.push("CONTEXT.md: content is too thin to preserve project domain context");
  }
}

function validateGoals(cwd: string, reasons: string[]): void {
  const content = readIfExists(cwd, "GOALS.md");
  if (content === null) return;
  if (!/^## Final system goal\s*$/m.test(content)) {
    reasons.push('GOALS.md: missing "## Final system goal" section');
  }
  if (!/^# Phase \d+\s+/.test(content) && !/^# Phase \d+\s+.+$/m.test(content)) {
    reasons.push("GOALS.md: missing at least one Phase heading");
  }
  if (!/^## Goal \d+:/m.test(content)) {
    reasons.push("GOALS.md: missing at least one Goal heading");
  }
  for (const heading of ["Objective", "Required artifacts", "Definition of done", "Next action"]) {
    if (!new RegExp(`^### ${heading}\\s*$`, "m").test(content)) {
      reasons.push(`GOALS.md: missing "### ${heading}" field`);
    }
  }
  if (!hasSubstance(content, 300)) {
    reasons.push("GOALS.md: content is too thin for a durable goal map");
  }
}

function validateMarkdownDir(cwd: string, relativePath: string, headings: string[], reasons: string[]): void {
  for (const filePath of markdownFiles(cwd, relativePath)) {
    const rel = path.relative(cwd, filePath).split(path.sep).join("/");
    const content = fs.readFileSync(filePath, "utf-8");
    requireHeadings(reasons, rel, content, headings);
    if (!hasSubstance(content, 180)) {
      reasons.push(`${rel}: content is too thin for a durable artifact`);
    }
  }
}

export function validateGreenfieldArtifacts(cwd: string): GreenfieldArtifactValidation {
  const reasons: string[] = [];
  validateContext(cwd, reasons);
  validateGoals(cwd, reasons);
  validateMarkdownDir(cwd, path.join("docs", "prds"), [
    "Problem Statement",
    "Solution",
    "User Stories",
    "Implementation Decisions",
    "Testing Decisions",
    "Out of Scope",
  ], reasons);
  validateMarkdownDir(cwd, path.join("docs", "plans"), [
    "PRD",
    "Ordering",
    "Open risks",
  ], reasons);
  validateMarkdownDir(cwd, path.join("docs", "issues"), [
    "What to build",
    "Acceptance criteria",
    "Blocked by",
  ], reasons);
  validateMarkdownDir(cwd, "specs", [
    "Relevant Files",
    "Steps",
    "Validation Commands",
  ], reasons);
  const hasDurableArtifact = fs.existsSync(path.join(cwd, "CONTEXT.md"))
    || fs.existsSync(path.join(cwd, "GOALS.md"))
    || hasFiles(cwd, path.join("docs", "prds"))
    || hasFiles(cwd, path.join("docs", "plans"))
    || hasFiles(cwd, path.join("docs", "issues"))
    || hasFiles(cwd, "specs");
  if (!hasDurableArtifact) {
    reasons.push("greenfield session produced no durable planning artifact");
  }
  return { ok: reasons.length === 0, reasons };
}

export function inferGreenfieldCheckpoint(cwd: string): GreenfieldCheckpoint {
  if (hasFiles(cwd, "specs")) return "spec";
  if (hasFiles(cwd, path.join("docs", "issues"))) return "issue_slices";
  if (hasFiles(cwd, path.join("docs", "plans"))) return "plan";
  if (hasFiles(cwd, path.join("docs", "prds"))) return "prd";
  if (fs.existsSync(path.join(cwd, "GOALS.md"))) return "goals";
  return "wide_idea";
}

function checkpointsFor(cwd: string): GreenfieldState["checkpoints"] {
  return {
    wide_idea: fs.existsSync(path.join(cwd, "CONTEXT.md")),
    goals: fs.existsSync(path.join(cwd, "GOALS.md")),
    prd: hasFiles(cwd, path.join("docs", "prds")),
    plan: hasFiles(cwd, path.join("docs", "plans")),
    issue_slices: hasFiles(cwd, path.join("docs", "issues")),
    spec: hasFiles(cwd, "specs"),
  };
}

function nextActionsFor(checkpoint: GreenfieldCheckpoint): string[] {
  switch (checkpoint) {
    case "wide_idea":
      return [
        "Continue /drill-me until the wide idea is concrete enough to publish GOALS.md.",
        "Use /domain-modeling if terms or invariants are unclear.",
      ];
    case "goals":
      return [
        "Select one Goal or Sub-goal and continue /drill-me on that unit.",
        "Use /to-prd once the selected unit has confirmed boundaries and test seams.",
      ];
    case "prd":
      return [
        "Ask the next /to-plan ordering question for the PRD.",
        "Write docs/plans/<slug>.md after ordering is resolved.",
      ];
    case "plan":
      return [
        "Run /to-issues for the selected plan and present the slice breakdown for approval.",
        "Create specs only after the issue breakdown is approved.",
      ];
    case "issue_slices":
      return [
        "Pick the next approved slice and run /spec for that issue.",
        "Queue implementation only after the build spec has validation commands.",
      ];
    case "spec":
      return [
        "Run /implement on one selected spec.",
        "After implementation, run /review or /plan-build depth:4 depending on risk.",
      ];
  }
}

function durableArtifactPaths(cwd: string): string[] {
  const paths: string[] = [];
  for (const relativePath of ["CONTEXT.md", "GOALS.md"]) {
    if (fs.existsSync(path.join(cwd, relativePath))) paths.push(relativePath);
  }
  for (const dir of [
    path.join("docs", "prds"),
    path.join("docs", "plans"),
    path.join("docs", "issues"),
    "specs",
  ]) {
    for (const filePath of markdownFiles(cwd, dir)) {
      paths.push(path.relative(cwd, filePath).split(path.sep).join("/"));
    }
  }
  return paths.sort((a, b) => a.localeCompare(b));
}

function firstGoalTitle(formation: GreenfieldFormation | null): string | null {
  return formation?.phases[0]?.goals[0]?.title ?? formation?.project_name ?? null;
}

function localResumeFor(checkpoint: GreenfieldCheckpoint, formation: GreenfieldFormation | null): string {
  const focus = firstGoalTitle(formation);
  switch (checkpoint) {
    case "wide_idea":
      return "Run `agentify` again and continue /drill-me until CONTEXT.md and GOALS.md can be rendered.";
    case "goals":
      return focus
        ? `Resume local formation by drilling "${focus}" and then produce a PRD with /to-prd.`
        : "Resume local formation by selecting one Goal in GOALS.md and producing a PRD with /to-prd.";
    case "prd":
      return "Resume local formation with /to-plan for the selected PRD under docs/prds/.";
    case "plan":
      return "Resume local formation with /to-issues for the selected plan under docs/plans/.";
    case "issue_slices":
      return "Resume local formation by choosing one approved docs/issues/ slice and writing a build spec with /spec.";
    case "spec":
      return "Resume by running /implement on one selected specs/ file, then /review or /plan-build depth:4 depending on risk.";
  }
}

function githubResumeFor(checkpoint: GreenfieldCheckpoint, formation: GreenfieldFormation | null): string {
  const focus = firstGoalTitle(formation);
  switch (checkpoint) {
    case "wide_idea":
    case "goals":
      return focus
        ? `After bootstrap, open a GitHub issue labeled agent:drill-me for "${focus}" and ask it to continue from GOALS.md.`
        : "After bootstrap, open a GitHub issue labeled agent:drill-me and ask it to continue from GOALS.md.";
    case "prd":
      return "After bootstrap, open an agent:drill-me issue referencing the PRD and ask for implementation ordering.";
    case "plan":
      return "After bootstrap, open an agent:drill-me issue referencing the plan and ask for executable issue slices.";
    case "issue_slices":
      return "After bootstrap, create/queue implementation issues from docs/issues/ and add agent:queued only to approved slices.";
    case "spec":
      return "After bootstrap, create an implementation issue referencing the chosen specs/ file, label it agent:queued, then add agent:implement when ready.";
  }
}

function artifactBullets(artifactPaths: string[], statePath: string): string {
  if (artifactPaths.length === 0) return `- \`${statePath}\``;
  return artifactPaths.map((artifactPath) => `- \`${artifactPath}\``).join("\n");
}

function firstArtifact(artifactPaths: string[], prefix: string): string | null {
  return artifactPaths.find((artifactPath) => artifactPath.startsWith(prefix)) ?? null;
}

function handoffTitle(verb: string, formation: GreenfieldFormation | null): string {
  return `${verb} ${firstGoalTitle(formation) ?? formation?.project_name ?? "greenfield project"}`;
}

function githubHandoffFor(
  checkpoint: GreenfieldCheckpoint,
  formation: GreenfieldFormation | null,
  artifactPaths: string[],
  statePath: string,
): GreenfieldGitHubHandoff {
  const focus = firstGoalTitle(formation) ?? formation?.project_name ?? "the greenfield project";
  const specPath = firstArtifact(artifactPaths, "specs/");
  const issuePath = firstArtifact(artifactPaths, "docs/issues/");
  const planPath = firstArtifact(artifactPaths, "docs/plans/");
  const prdPath = firstArtifact(artifactPaths, "docs/prds/");

  if (checkpoint === "spec") {
    const target = specPath ?? issuePath ?? "the selected spec";
    return {
      action: "open_implementation_issue",
      title: handoffTitle("Implement", formation),
      body: [
        "## Context",
        "",
        `Continue the greenfield project from \`${statePath}\`.`,
        "",
        "## Artifacts",
        "",
        artifactBullets(artifactPaths, statePath),
        "",
        "## Requested action",
        "",
        `Implement the next approved slice for ${focus}. Start from \`${target}\`.`,
        "",
        "## Labels",
        "",
        "Apply `agent:queued` first, then add `agent:implement` when ready to start the GitHub implementation loop.",
      ].join("\n"),
      labels: ["agent:queued", "agent:implement"],
      artifact_paths: artifactPaths,
    };
  }

  if (checkpoint === "issue_slices") {
    const target = issuePath ?? planPath ?? "docs/issues/";
    return {
      action: "create_implementation_issues",
      title: handoffTitle("Create implementation issues for", formation),
      body: [
        "## Context",
        "",
        `Continue the greenfield project from \`${statePath}\`.`,
        "",
        "## Artifacts",
        "",
        artifactBullets(artifactPaths, statePath),
        "",
        "## Requested action",
        "",
        `Turn the approved slices for ${focus} into implementation issues. Start from \`${target}\` and preserve blocked-by sections.`,
      ].join("\n"),
      labels: ["agent:drill-me"],
      artifact_paths: artifactPaths,
    };
  }

  const target = planPath ?? prdPath ?? "GOALS.md";
  return {
    action: "open_drill_issue",
    title: handoffTitle("Continue planning", formation),
    body: [
      "## Context",
      "",
      `Continue the greenfield project from \`${statePath}\`.`,
      "",
      "## Artifacts",
      "",
      artifactBullets(artifactPaths, statePath),
      "",
      "## Requested action",
      "",
      `Drill the next planning step for ${focus}. Start from \`${target}\` and produce the next approved artifact only.`,
    ].join("\n"),
    labels: ["agent:drill-me"],
    artifact_paths: artifactPaths,
  };
}

export function buildGreenfieldState(cwd: string, params: BuildGreenfieldStateParams): GreenfieldState {
  const checkpoint = inferGreenfieldCheckpoint(cwd);
  const formation = readGreenfieldFormation(cwd);
  const artifactPaths = durableArtifactPaths(cwd);
  return {
    schema_version: "1",
    updated_at: params.nowIso ?? new Date().toISOString(),
    checkpoint,
    turns: params.turns,
    cost_usd: params.costUsd,
    aborted: params.aborted,
    checkpoints: checkpointsFor(cwd),
    next_actions: nextActionsFor(checkpoint),
    artifact_validation: validateGreenfieldArtifacts(cwd),
    resume: {
      source: formation ? "formation" : "filesystem",
      stop_at: formation?.stop_at ?? null,
      current_focus: firstGoalTitle(formation),
      artifact_paths: artifactPaths,
      local_resume: localResumeFor(checkpoint, formation),
      github_resume: githubResumeFor(checkpoint, formation),
    },
    github_handoff: githubHandoffFor(
      checkpoint,
      formation,
      artifactPaths,
      GREENFIELD_STATE_RELATIVE_PATH,
    ),
  };
}

export function writeGreenfieldState(cwd: string, params: BuildGreenfieldStateParams): GreenfieldState {
  const state = buildGreenfieldState(cwd, params);
  const filePath = path.join(cwd, GREENFIELD_STATE_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o644 });
  return state;
}

export function readGreenfieldState(cwd: string): GreenfieldState | null {
  const filePath = path.join(cwd, GREENFIELD_STATE_RELATIVE_PATH);
  if (!fs.existsSync(filePath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
  return Value.Check(GreenfieldStateSchema, parsed) ? (parsed as GreenfieldState) : null;
}

/**
 * Build the greenfield-state payload using a provider-scoped state
 * dir. The github handoff body now references the supplied
 * `<stateDir>/greenfield-state.json` rather than the legacy
 * `.pi/agentify/` path. This is the function new audit code should
 * call; the legacy `buildGreenfieldState(cwd, params)` is kept for
 * backward compatibility.
 */
export function buildGreenfieldStateAt(
  cwd: string,
  params: BuildGreenfieldStateParams,
  stateDir: string,
): GreenfieldState {
  const checkpoint = inferGreenfieldCheckpoint(cwd);
  // Formation lookup is unchanged — formation always lives under
  // the active state dir per `readGreenfieldFormationAt`.
  const formation = readGreenfieldFormationAt(cwd, stateDir);
  const artifactPaths = durableArtifactPaths(cwd);
  const statePath = greenfieldStateRelativePath(stateDir);
  return {
    schema_version: "1",
    updated_at: params.nowIso ?? new Date().toISOString(),
    checkpoint,
    turns: params.turns,
    cost_usd: params.costUsd,
    aborted: params.aborted,
    checkpoints: checkpointsFor(cwd),
    next_actions: nextActionsFor(checkpoint),
    artifact_validation: validateGreenfieldArtifacts(cwd),
    resume: {
      source: formation ? "formation" : "filesystem",
      stop_at: formation?.stop_at ?? null,
      current_focus: firstGoalTitle(formation),
      artifact_paths: artifactPaths,
      local_resume: localResumeFor(checkpoint, formation),
      github_resume: githubResumeFor(checkpoint, formation),
    },
    github_handoff: githubHandoffFor(checkpoint, formation, artifactPaths, statePath),
  };
}

/**
 * Write the greenfield-state payload at `<stateDir>/greenfield-state.json`.
 * Use this when the audit is wired to a provider-scoped state dir;
 * the legacy `writeGreenfieldState(cwd, params)` always writes to
 * `.pi/agentify/greenfield-state.json` and is preserved for callers
 * that have not yet been migrated.
 */
export function writeGreenfieldStateAt(
  cwd: string,
  params: BuildGreenfieldStateParams,
  stateDir: string,
): GreenfieldState {
  const state = buildGreenfieldStateAt(cwd, params, stateDir);
  const filePath = path.join(cwd, stateDir, "greenfield-state.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o644 });
  return state;
}

/**
 * Read the greenfield-state payload at `<stateDir>/greenfield-state.json`.
 * Returns null when the file is missing or fails schema
 * validation. Use this from the greenfield run path when the audit
 * is wired to a provider-scoped state dir.
 */
export function readGreenfieldStateAt(cwd: string, stateDir: string): GreenfieldState | null {
  const filePath = path.join(cwd, stateDir, "greenfield-state.json");
  if (!fs.existsSync(filePath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
  return Value.Check(GreenfieldStateSchema, parsed) ? (parsed as GreenfieldState) : null;
}
