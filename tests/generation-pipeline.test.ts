import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Value } from "typebox/value";
import { AGENTIFY_MANAGED_MARKERS } from "../src/core/artifact-exporters.ts";
import { PartialCodebaseMapSchema } from "../src/core/audit/schema.ts";
import { renderValidatedBrownfieldArtifacts } from "../src/core/artifacts/renderers.ts";
import { DEFAULT_APPLY_POLICY } from "../src/core/apply-policy.ts";
import { manifestFileFromContent, readManifestAt, sha256, type ManagedManifestFile } from "../src/core/manifest.ts";
import { applyStagedBundle, collectAuditArtifactSnapshot, writeRenderedArtifactsToStaging } from "../src/core/run-agentify.ts";
import { makeValidCodebaseMap } from "./fixtures/codebase-map.ts";

const STATE_DIR = ".pi/agentify";
const tempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "agentify-generation-"));
function files(root: string): Map<string, Buffer> { const result = new Map<string, Buffer>(); const visit = (dir: string): void => { for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const full = path.join(dir, entry.name); if (entry.isDirectory()) visit(full); else if (entry.isFile()) result.set(path.relative(root, full).split(path.sep).join("/"), fs.readFileSync(full)); } }; visit(root); return result; }
function stableFiles(root: string): Map<string, Buffer> { const result = files(root); result.delete(`${STATE_DIR}/manifest.json`); return result; }

function apply(cwd: string, map: unknown, runId: string, policy = DEFAULT_APPLY_POLICY) {
  const rendered = renderValidatedBrownfieldArtifacts(map, { stateDir: ".pi" });
  if (rendered.validationErrors.length > 0) return { rendered, applied: null };
  const staging = tempDir();
  try {
    const metadata = new Map<string, ManagedManifestFile>();
    writeRenderedArtifactsToStaging(staging, rendered.artifacts, metadata, "brownfield", STATE_DIR);
    const content = `${JSON.stringify(map, null, 2)}\n`; const relativePath = `${STATE_DIR}/codebase_map.json`;
    fs.mkdirSync(path.join(staging, STATE_DIR), { recursive: true }); fs.writeFileSync(path.join(staging, relativePath), content);
    metadata.set(relativePath, manifestFileFromContent({ relativePath, content, required: true }, "brownfield", STATE_DIR));
    return { rendered, applied: applyStagedBundle({ cwd, stagingRoot: staging, snapshot: collectAuditArtifactSnapshot(cwd), metadata, agentifyVersion: "test", mode: "brownfield", policy, runId, stateDir: STATE_DIR }) };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

function testInvalidMapsNeverApply(): void {
  const valid = makeValidCodebaseMap({ generated_at: "2026-07-11T00:00:00.000Z" });
  const invalid: unknown[] = [{ ...valid, meta: undefined }, { ...valid, schema_version: "99" }, { ...valid, module_graph: { ...valid.module_graph, edges: [{ from: 1, to: "x", kind: "import" }] } }, { ...valid, coverage: { ...valid.coverage, D4_conventions: { ...valid.coverage.D4_conventions, status: "gap" } } }];
  for (const candidate of invalid) { const cwd = tempDir(); try { fs.writeFileSync(path.join(cwd, "developer.txt"), "owned\n"); const result = apply(cwd, candidate, "invalid"); assert.equal(result.applied, null); assert.equal(result.rendered.artifacts.length, 0); assert.ok(result.rendered.validationErrors.length > 0); assert.deepEqual([...files(cwd).keys()], ["developer.txt"]); } finally { fs.rmSync(cwd, { recursive: true, force: true }); } }
  assert.equal(Value.Check(PartialCodebaseMapSchema, { schema_version: "1", meta: valid.meta }), true);
  assert.equal(Value.Check(PartialCodebaseMapSchema, { schema_version: "99", meta: valid.meta }), false);
}

function testOwnershipDeterminismAndRepeatability(): void {
  const cwd = tempDir();
  try {
    fs.mkdirSync(path.join(cwd, "src")); fs.mkdirSync(path.join(cwd, "tests")); fs.writeFileSync(path.join(cwd, "package.json"), "{\"type\":\"module\"}\n"); fs.writeFileSync(path.join(cwd, "src/index.ts"), "export const value = 1;\n"); fs.writeFileSync(path.join(cwd, "tests/index.test.ts"), "// fixture test\n");
    const userAgents = "# Developer-owned instructions\n\nKeep exactly.\n"; fs.writeFileSync(path.join(cwd, "AGENTS.md"), userAgents); fs.mkdirSync(path.join(cwd, ".pi/agents"), { recursive: true }); fs.writeFileSync(path.join(cwd, ".pi/agents/payments.md"), "# User payments notes\n");
    const map = makeValidCodebaseMap({ generated_at: "2026-07-11T00:00:00.000Z" }); const firstRender = renderValidatedBrownfieldArtifacts(map, { stateDir: ".pi" }); assert.deepEqual(renderValidatedBrownfieldArtifacts(map, { stateDir: ".pi" }), firstRender); assert.ok(firstRender.artifacts.length > 3);
    const first = apply(cwd, map, "run-one"); assert.ok(first.applied?.manifest); assert.equal(fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8"), userAgents); assert.equal(fs.readFileSync(path.join(cwd, ".pi/agents/payments.md"), "utf8"), "# User payments notes\n"); assert.ok(first.applied?.writes.some((write) => write.action === "alongside" && write.path.endsWith("AGENTS.md"))); assert.ok(first.applied?.writes.some((write) => write.action === "alongside" && write.path.endsWith("payments.md"))); assert.ok(fs.readFileSync(path.join(cwd, "specs/README.md"), "utf8").includes(AGENTIFY_MANAGED_MARKERS.markdown));
    const stateOne = stableFiles(cwd); const second = apply(cwd, map, "run-two"); assert.deepEqual(stableFiles(cwd), stateOne); assert.ok(second.applied?.writes.some((write) => write.action === "skipped")); assert.equal(second.applied?.manifest?.run_id, "run-two"); const manifest = readManifestAt(cwd, STATE_DIR); assert.deepEqual(manifest?.files, [...(manifest?.files ?? [])].sort((a, b) => a.path.localeCompare(b.path)));
    const managed = path.join(cwd, "specs/README.md"); fs.writeFileSync(managed, `${AGENTIFY_MANAGED_MARKERS.markdown}\n# stale managed content\n`); apply(cwd, map, "managed-update"); assert.notEqual(fs.readFileSync(managed, "utf8"), `${AGENTIFY_MANAGED_MARKERS.markdown}\n# stale managed content\n`);
    const before = files(cwd); const changedMap = { ...map, meta: { ...map.meta, domain_hypothesis: "A changed fixture domain." } }; const changed = apply(cwd, changedMap, "changed-input"); assert.ok(changed.applied?.manifest); const after = files(cwd); const changedPaths = [...after].filter(([name, content]) => !before.has(name) || !content.equals(before.get(name)!)).map(([name]) => name); assert.deepEqual(changedPaths, [".pi/agentify/codebase_map.json", ".pi/agentify/manifest.json", ".pi/agents/payments.agentify.md", "AGENTS.agentify.md"]); for (const unchanged of ["specs/README.md", "ai_docs/README.md", ".pi/workflows/payments-plan-build-review-fix.json", "app_docs/README.md"]) assert.ok(after.get(unchanged)?.equals(before.get(unchanged)!), `${unchanged} changed unexpectedly`); assert.equal(fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8"), userAgents); assert.equal(readManifestAt(cwd, STATE_DIR)?.files.find((file) => file.path === `${STATE_DIR}/codebase_map.json`)?.sha256, sha256(fs.readFileSync(path.join(cwd, STATE_DIR, "codebase_map.json"))));
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

function testRequiredConflictIsAtomic(): void {
  const cwd = tempDir();
  try {
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# user owned\n");
    const before = files(cwd);
    const result = apply(cwd, makeValidCodebaseMap(), "abort", { ...DEFAULT_APPLY_POLICY, requiredAction: "abort" });
    assert.equal(result.applied?.manifest, null);
    assert.equal(result.applied?.requiredConflictCount, 1);
    assert.deepEqual(files(cwd), before);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

function testSymlinkDestinationCannotEscapeRepository(): void {
  const cwd = tempDir();
  const outside = tempDir();
  try {
    const outsideFile = path.join(outside, "AGENTS.md");
    fs.writeFileSync(outsideFile, "outside\n");
    fs.symlinkSync(outsideFile, path.join(cwd, "AGENTS.md"));
    const result = apply(cwd, makeValidCodebaseMap(), "symlink", { ...DEFAULT_APPLY_POLICY, requiredAction: "abort" });
    assert.equal(result.applied?.manifest, null);
    assert.equal(result.applied?.requiredConflictCount, 1);
    assert.equal(fs.readFileSync(outsideFile, "utf8"), "outside\n");
    fs.rmSync(path.join(cwd, "AGENTS.md"));
    fs.mkdirSync(path.join(outside, "specs"));
    const outsideSpecs = path.join(outside, "specs", "README.md");
    fs.writeFileSync(outsideSpecs, "outside specs\n");
    fs.symlinkSync(path.join(outside, "specs"), path.join(cwd, "specs"));
    const parentResult = apply(cwd, makeValidCodebaseMap(), "parent-symlink", { ...DEFAULT_APPLY_POLICY, requiredAction: "abort" });
    assert.equal(parentResult.applied?.manifest, null);
    assert.equal(fs.readFileSync(outsideSpecs, "utf8"), "outside specs\n");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

testInvalidMapsNeverApply(); testOwnershipDeterminismAndRepeatability(); testRequiredConflictIsAtomic(); testSymlinkDestinationCannotEscapeRepository(); console.log("generation pipeline tests passed.");
