import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  AGENTIFY_MANAGED_MARKERS as compatibilityMarkers,
  addMarkdownManagedMarker as compatibilityAddMarkdownMarker,
} from "../../src/core/artifact-exporters.ts";
import {
  RESERVED_AGENT_FILENAMES,
  RESERVED_AGENT_NAMES,
  isFeatureAgentFilename,
  isReservedAgentFilename,
} from "../../src/core/artifacts/agent-file-conventions.ts";
import {
  GENERATED_SURFACE_PATHS,
  normalizeArtifactPath,
} from "../../src/core/artifacts/generated-surface.ts";
import {
  AGENTIFY_MANAGED_MARKERS,
  MARKDOWN_MANAGED_MARKER,
  SHA256_MANAGED_MARKER,
  TOML_MANAGED_MARKER,
  addHashCommentManagedMarker,
  addMarkdownManagedMarker,
  markerForArtifactPath,
} from "../../src/core/artifacts/managed-markers.ts";
import { readPackageVersion } from "../../src/core/package-version.ts";

test("managed marker values and compatibility exports are exact", () => {
  assert.deepEqual(AGENTIFY_MANAGED_MARKERS, {
    markdown: "<!-- agentify:managed -->",
    toml: "# agentify:managed",
  });
  assert.equal(MARKDOWN_MANAGED_MARKER, "<!-- agentify:managed -->");
  assert.equal(TOML_MANAGED_MARKER, "# agentify:managed");
  assert.equal(SHA256_MANAGED_MARKER, "sha256");
  assert.strictEqual(compatibilityMarkers, AGENTIFY_MANAGED_MARKERS);
  assert.strictEqual(compatibilityAddMarkdownMarker, addMarkdownManagedMarker);
  assert.equal(markerForArtifactPath("notes.md"), MARKDOWN_MANAGED_MARKER);
  assert.equal(markerForArtifactPath("state.json"), SHA256_MANAGED_MARKER);
  assert.equal(markerForArtifactPath("agent.toml"), TOML_MANAGED_MARKER);
});

test("markdown marker insertion preserves frontmatter placement and is idempotent", () => {
  assert.equal(
    addMarkdownManagedMarker("body\n"),
    "<!-- agentify:managed -->\nbody\n",
  );
  const withFrontmatter = "---\nname: scout\n---\nbody\n";
  const marked = "---\nname: scout\n---\n<!-- agentify:managed -->\nbody\n";
  assert.equal(addMarkdownManagedMarker(withFrontmatter), marked);
  assert.equal(addMarkdownManagedMarker(marked), marked);
});

test("hash marker insertion preserves shebang placement and is idempotent", () => {
  assert.equal(
    addHashCommentManagedMarker('name = "agent"\n'),
    '# agentify:managed\nname = "agent"\n',
  );
  const script = "#!/usr/bin/env bash\necho ok\n";
  const marked = "#!/usr/bin/env bash\n# agentify:managed\necho ok\n";
  assert.equal(addHashCommentManagedMarker(script), marked);
  assert.equal(addHashCommentManagedMarker(marked), marked);
});

test("reserved-agent filtering has one exact convention", () => {
  assert.deepEqual(RESERVED_AGENT_NAMES, [
    "scout",
    "review",
    "implement",
    "test",
    "fix",
    "document",
  ]);
  assert.deepEqual(RESERVED_AGENT_FILENAMES, [
    "scout.md",
    "review.md",
    "implement.md",
    "test.md",
    "fix.md",
    "document.md",
  ]);
  assert.equal(isReservedAgentFilename("review.md"), true);
  assert.equal(isFeatureAgentFilename("review.md"), false);
  assert.equal(isFeatureAgentFilename("payments.md"), true);
  assert.equal(isFeatureAgentFilename("payments.toml"), false);
});

test("generated-surface inventory and normalization preserve order", () => {
  assert.deepEqual(GENERATED_SURFACE_PATHS, [
    "AGENTS.md",
    "CLAUDE.md",
    "CONTEXT.md",
    "specs/README.md",
    "ai_docs/README.md",
    "conditional_docs.md",
    ".pi/conditional_docs.md",
    "SETUP.md",
    ".pi/agents",
    ".pi/prompts",
    ".pi/workflows",
    ".pi/extensions",
    ".pi/skills",
    ".agents",
    ".claude",
    ".codex",
    ".github/actions",
    ".github/agent-prompts",
    ".github/scripts",
    ".github/workflows",
    "app_docs",
    "app_review",
    "app_fix_reports",
  ]);
  assert.equal(normalizeArtifactPath("./specs\\README.md"), "specs/README.md");
});

test("package version reader preserves success and unknown fallback", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-package-version-"));
  try {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "9.8.7" }));
    assert.equal(readPackageVersion(root), "9.8.7");
    fs.writeFileSync(path.join(root, "package.json"), "not-json");
    assert.equal(readPackageVersion(root), "unknown");
    fs.rmSync(path.join(root, "package.json"));
    assert.equal(readPackageVersion(root), "unknown");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
