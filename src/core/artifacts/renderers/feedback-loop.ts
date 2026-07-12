import { normalizeArtifactPath } from "../generated-surface.ts";
import type { ArtifactIntents, CodebaseMap } from "../../audit/schema.ts";
import { REQUIRED_ALWAYS_ON_DOCS, isSafeRelativePath, markdownArtifact, oneLine } from "./artifact-builders.ts";
import type { RenderedArtifact } from "./types.ts";

export function renderFeedbackLoopArtifacts(map: CodebaseMap, intents: ArtifactIntents | undefined): RenderedArtifact[] {
  const aiDocsEntries = map.meta.documentation.has_ai_docs
    ? ["- `ai_docs/README.md` when repository-wide AI context is useful."]
    : ["- No existing AI docs were detected during bootstrap."];
  const generatedDocEntries = (intents?.always_on_docs ?? [])
    .map((doc) => ({
      path: normalizeArtifactPath(doc.path),
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
