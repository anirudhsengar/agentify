import assert from "node:assert/strict";
import { renderBrownfieldArtifacts as renderBrownfieldWithContext, type RenderedArtifact } from "../src/core/artifacts/renderers.ts";
import type { CodebaseMap } from "../src/core/audit/schema.ts";

const renderBrownfieldArtifacts = (map: CodebaseMap) => renderBrownfieldWithContext(map, { stateDir: ".pi" });
import { AGENTS_MD_MAX_LINES } from "../src/core/audit/schema.ts";
import { makeValidCodebaseMap } from "./fixtures/codebase-map.ts";

function byPath(artifacts: RenderedArtifact[]): Map<string, RenderedArtifact> {
  return new Map(artifacts.map((artifact) => [artifact.relativePath, artifact]));
}

function lineCount(content: string): number {
  const trimmed = content.endsWith("\n") ? content.slice(0, -1) : content;
  return trimmed.length === 0 ? 0 : trimmed.split("\n").length;
}

function assertContains(content: string, pattern: RegExp, label: string): void {
  assert.match(content, pattern, `missing ${label}`);
}


export function testTypescriptCliFallbackSurfaceIsActionable(): void {
  const map = makeValidCodebaseMap({
    meta: {
      ...makeValidCodebaseMap().meta,
      project_type: "typescript-cli",
      domain_hypothesis: "A CLI that processes customer invoices.",
      suggested_subagent_domains: ["payments"],
    },
  });
  map.skeleton.first_5_files_for_fresh_agent = [
    { path: "src/index.ts", why: "CLI entry point." },
    { path: "src/payments/service.ts", why: "Payment orchestration." },
  ];
  map.validation_surface.test_command = "npm test -- payments";
  map.pitfalls = [
    {
      module: "src/payments/service.ts",
      what: "Retries must be idempotent.",
      consequence: "A retry can duplicate a charge.",
      line_ref: 42,
    },
  ];

  const result = renderBrownfieldArtifacts(map);
  assert.deepEqual(result.errors, []);
  const artifacts = byPath(result.artifacts);

  const agentsMd = artifacts.get("AGENTS.md")?.content ?? "";
  assert.ok(lineCount(agentsMd) <= AGENTS_MD_MAX_LINES, "AGENTS.md must stay under the hard cap");
  assertContains(agentsMd, /## Validation/, "AGENTS.md validation section");
  assertContains(agentsMd, /npm test -- payments/, "primary validation command");
  assertContains(agentsMd, /Retries must be idempotent/, "pitfall text");

  const specialist = artifacts.get(".pi/agents/payments.md")?.content ?? "";
  assertContains(specialist, /^## Scope$/m, "specialist scope section");
  assertContains(specialist, /^## First Files$/m, "specialist first-files section");
  assertContains(specialist, /^## Validation$/m, "specialist validation section");
  assertContains(specialist, /^## Pitfalls$/m, "specialist pitfalls section");
  assertContains(specialist, /src\/payments\/service\.ts/, "specialist domain file reference");
  assertContains(specialist, /npm test -- payments/, "specialist validation command");
  assertContains(specialist, /A retry can duplicate a charge/, "specialist pitfall consequence");
}

