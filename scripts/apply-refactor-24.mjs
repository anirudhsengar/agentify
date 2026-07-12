import * as fs from "node:fs";

const runAgentifyPath = "src/core/run-agentify.ts";
let source = fs.readFileSync(runAgentifyPath, "utf8");

function replaceOnce(search, replacement) {
  const index = source.indexOf(search);
  if (index < 0) throw new Error(`Missing replacement marker: ${search.slice(0, 120)}`);
  if (source.indexOf(search, index + search.length) >= 0) {
    throw new Error(`Replacement marker is not unique: ${search.slice(0, 120)}`);
  }
  source = `${source.slice(0, index)}${replacement}${source.slice(index + search.length)}`;
}

function removeBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing removal start: ${startMarker.slice(0, 120)}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`Missing removal end: ${endMarker.slice(0, 120)}`);
  source = `${source.slice(0, start)}${source.slice(end)}`;
}

replaceOnce('import * as os from "node:os";\n', "");
replaceOnce(
  'import {\n  alongsidePathFor,\n  resolveActionForPath,\n  type ApplyPolicy,\n} from "./apply-policy.ts";\n',
  "",
);
replaceOnce(
  'import {\n  GENERATED_SURFACE_PATHS,\n  normalizeArtifactPath,\n} from "./artifacts/generated-surface.ts";\n',
  'import { normalizeArtifactPath } from "./artifacts/generated-surface.ts";\n',
);
replaceOnce('import { addMarkdownManagedMarker } from "./artifacts/managed-markers.ts";\n', "");
replaceOnce(
  'import {\n  renderValidatedBrownfieldArtifacts,\n  setRendererStateDir,\n  type RenderedArtifact,\n} from "./artifacts/renderers.ts";\n',
  'import {\n  renderValidatedBrownfieldArtifacts,\n  setRendererStateDir,\n} from "./artifacts/renderers.ts";\n',
);
replaceOnce(
  'import {\n  codebaseMapRelativePath,\n  kindForPath,\n  manifestFileFromContent,\n  manifestRelativePath,\n  markerForPath,\n  readManifestAt,\n  sha256,\n  writeManifestAt,\n  type ManagedManifest,\n  type ManagedManifestFile,\n} from "./manifest.ts";\n',
  'import {\n  readManifestAt,\n  type ManagedManifest,\n  type ManagedManifestFile,\n} from "./manifest.ts";\n',
);
replaceOnce(
  '  RunAgentifyOptions,\n  ArtifactWrite,\n} from "./types.ts";\n',
  '  RunAgentifyOptions,\n} from "./types.ts";\n',
);
replaceOnce(
  'import { beginStateTransaction } from "./state-transaction.ts";\n',
  'import { beginStateTransaction } from "./state-transaction.ts";\n' +
    'import {\n' +
    '  collectAuditArtifactSnapshot,\n' +
    '  rollbackGeneratedSurface,\n' +
    '  type AuditArtifactSnapshot,\n' +
    '} from "./generation/artifact-snapshot.ts";\n' +
    'import { applyStagedBundle, withAbortOnRequired } from "./generation/apply-bundle.ts";\n' +
    'import { formatApplyReport } from "./generation/apply-report.ts";\n' +
    'import {\n' +
    '  captureSessionAgentFiles,\n' +
    '  cleanupSessionAgentSnapshot,\n' +
    '  mirrorSessionOutputToStaging,\n' +
    '} from "./generation/session-agent-snapshot.ts";\n' +
    'import {\n' +
    '  addWriteMetadata,\n' +
    '  copyCanonicalMapToStaging,\n' +
    '  makeStagingRoot,\n' +
    '  writeRenderedArtifactsToStaging,\n' +
    '} from "./generation/staging-bundle.ts";\n\n' +
    'export {\n' +
    '  applyStagedBundle,\n' +
    '  collectAuditArtifactSnapshot,\n' +
    '  writeRenderedArtifactsToStaging,\n' +
    '};\n',
);

removeBetween("type AuditSnapshotEntry = {", "const ALWAYS_ON_ARTIFACTS");
removeBetween("function listFilesRecursively", "/**\n * Diff the previous manifest");
removeBetween("function writeFileUnderRoot", "/**\n * Capture the brownfield session");
removeBetween("/**\n * Capture the brownfield session", "/**\n * Return a copy of `policy`");
removeBetween("/**\n * Return a copy of `policy`", "function addWriteMetadata");
removeBetween("function addWriteMetadata", "function isConflictingDestination");
removeBetween("function isConflictingDestination", "/**\n * Format the post-run report");
removeBetween("/**\n * Format the post-run report", "export function applyStagedBundle");
removeBetween("export function applyStagedBundle", "function extractUsage");

if (source.includes("function applyStagedBundle") || source.includes("function collectAuditArtifactSnapshot")) {
  throw new Error("Generation implementations remain in run-agentify.ts");
}

fs.writeFileSync(runAgentifyPath, source);

const architecturePath = "docs/architecture.md";
let architecture = fs.readFileSync(architecturePath, "utf8");
const architectureNeedle =
  "compatibility exports preserve older internal import locations without making\n" +
  "them new package APIs. Package-version reading is similarly centralized in\n" +
  "`src/core/package-version.ts`.\n";
const architectureReplacement = architectureNeedle +
  "\n## Generation pipeline ownership\n\n" +
  "Repository-facing generation primitives live under `src/core/generation/`.\n" +
  "`artifact-snapshot.ts` owns generated-surface snapshots and rollback;\n" +
  "`staging-bundle.ts` owns temporary bundle construction and metadata;\n" +
  "`apply-bundle.ts` owns conflict preflight, symlink protection, apply policy,\n" +
  "and manifest assembly; `apply-report.ts` owns deterministic report text; and\n" +
  "`session-agent-snapshot.ts` owns temporary feature-agent capture and mirroring.\n" +
  "`run-agentify.ts` coordinates these modules and retains compatibility re-exports\n" +
  "for the previously imported generation helpers.\n";
if (!architecture.includes(architectureNeedle)) throw new Error("Architecture marker missing");
architecture = architecture.replace(architectureNeedle, architectureReplacement);
fs.writeFileSync(architecturePath, architecture);

const changelogPath = "CHANGELOG.md";
let changelog = fs.readFileSync(changelogPath, "utf8");
const changelogNeedle = "### Changed\n\n";
if (!changelog.includes(changelogNeedle)) throw new Error("Changelog marker missing");
changelog = changelog.replace(
  changelogNeedle,
  changelogNeedle +
    "- Repository-facing snapshot, staging, apply, reporting, and session-agent generation primitives now have dedicated internal owners while retaining compatibility re-exports.\n",
);
fs.writeFileSync(changelogPath, changelog);

fs.rmSync("scripts/apply-refactor-24.mjs", { force: true });
fs.rmSync(".github/workflows/refactor-24-apply.yml", { force: true });
