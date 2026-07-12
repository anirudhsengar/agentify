import * as fs from "node:fs";
import * as path from "node:path";

const root = process.cwd();
const sourcePath = path.join(root, "src/core/run-agentify.ts");
const source = fs.readFileSync(sourcePath, "utf8");

function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error(`Unable to extract markers: ${startMarker} -> ${endMarker}`);
  }
  return source.slice(start, end).trimEnd();
}

function convertRunFunction(block, oldName, newName) {
  const brace = block.indexOf("{");
  if (brace < 0) throw new Error(`Missing function body for ${oldName}`);
  const body = block.slice(brace + 1);
  return `export async function ${newName}(context: RunContext): Promise<void> {\n` +
    `  const options = context;\n` +
    `  const config = context.config;${body}`;
}

const helpers = between(
  "const AGENTS_MD_PATH",
  "async function chooseAmbiguousKind(",
);
const chooseAmbiguous = between(
  "async function chooseAmbiguousKind(",
  "function getGitHubReadiness(",
);
let brownfield = between(
  "async function runBrownfieldAudit(",
  "async function runGreenfield(",
);
let greenfield = between(
  "async function runGreenfield(",
  "export async function runAgentify(",
);

brownfield = convertRunFunction(brownfield, "runBrownfieldAudit", "runBrownfieldAudit")
  .replace("let artifactSnapshotForRollback: AuditArtifactSnapshot | null", "let artifactSnapshotForRollback: RunArtifactSnapshot | null")
  .replaceAll(
    'snapshot: artifactSnapshot as unknown as Record<string, { content: Buffer; mode: number; ownership: "managed" | "unmanaged" }>,',
    "snapshot: artifactSnapshot,",
  );

greenfield = convertRunFunction(greenfield, "runGreenfield", "runGreenfield")
  .replace(
    "const artifactSnapshot = collectAuditArtifactSnapshot(options.cwd);",
    "const artifactSnapshot: RunArtifactSnapshot = collectAuditArtifactSnapshot(options.cwd);",
  )
  .replaceAll(
    'snapshot: artifactSnapshot as unknown as Record<string, { content: Buffer; mode: number; ownership: "managed" | "unmanaged" }>,',
    "snapshot: artifactSnapshot,",
  );

const brownfieldImports = `import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { VERSION as PI_SDK_VERSION } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { defaultConfigDir } from "../agentify-config.ts";
import { resolveApplyPolicy } from "../agentifyrc.ts";
import { exportAgenticSurface } from "../artifact-exporters.ts";
import { isFeatureAgentFilename } from "../artifacts/agent-file-conventions.ts";
import { normalizeArtifactPath } from "../artifacts/generated-surface.ts";
import {
  renderValidatedBrownfieldArtifacts,
  setRendererStateDir,
} from "../artifacts/renderers.ts";
import { readPackageVersion } from "../package-version.ts";
import { persistRunArtifacts } from "../revert.ts";
import { packageRoot } from "../pi-sdk-runtime.ts";
import { ProjectClassifier } from "../project-classifier.ts";
import { readPackagedSkillTiers, skillsForClassification } from "../skill-curation.ts";
import { installScaffoldRuntime } from "../scaffold-installer.ts";
import { inspectAgentifyRepoState } from "../repo-status.ts";
import {
  readManifestAt,
  type ManagedManifest,
  type ManagedManifestFile,
} from "../manifest.ts";
import {
  LEGACY_PI_STATE_RELATIVE_DIR,
  resolveCanonicalStateDir,
} from "../state-dir.ts";
import type { AgentifyTarget } from "../types.ts";
import { AgentifyLog } from "../audit/log.ts";
import { loadBuilderPrompt } from "../audit/prompt.ts";
import {
  AGENTS_MD_MAX_LINES,
  COVERAGE_DIMENSIONS,
  assessCoverageClosure,
} from "../audit/schema.ts";
import {
  getOrCreateSessionId,
  setAgentifySessionActive,
  setThinkingLevel,
} from "../audit/state.ts";
import {
  loadCanonicalMapAt,
  setMapSessionStateDir,
  writeMapDeltaTool,
  writeMapTool,
} from "../audit/write-map-tool.ts";
import { createReadOnlyExecutionPolicy } from "../security/execution-policy.ts";
import { beginStateTransaction } from "../state-transaction.ts";
import {
  collectAuditArtifactSnapshot,
  rollbackGeneratedSurface,
} from "../generation/artifact-snapshot.ts";
import { applyStagedBundle, withAbortOnRequired } from "../generation/apply-bundle.ts";
import { formatApplyReport } from "../generation/apply-report.ts";
import {
  captureSessionAgentFiles,
  cleanupSessionAgentSnapshot,
  mirrorSessionOutputToStaging,
} from "../generation/session-agent-snapshot.ts";
import {
  addWriteMetadata,
  copyCanonicalMapToStaging,
  makeStagingRoot,
  writeRenderedArtifactsToStaging,
} from "../generation/staging-bundle.ts";
import { persistProjectState, reportGitHubReadiness } from "./project-state-reporter.ts";
import type { RunArtifactSnapshot, RunContext } from "./run-context.ts";
`;

const greenfieldImports = `import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultConfigDir } from "../agentify-config.ts";
import { resolveApplyPolicy } from "../agentifyrc.ts";
import { normalizeArtifactPath } from "../artifacts/generated-surface.ts";
import { readPackageVersion } from "../package-version.ts";
import { persistRunArtifacts } from "../revert.ts";
import { packageRoot } from "../pi-sdk-runtime.ts";
import { installScaffoldRuntime } from "../scaffold-installer.ts";
import { inspectAgentifyRepoState } from "../repo-status.ts";
import {
  readManifestAt,
  type ManagedManifestFile,
} from "../manifest.ts";
import { resolveCanonicalStateDir } from "../state-dir.ts";
import {
  getOrCreateSessionId,
  setAgentifySessionActive,
  setThinkingLevel,
} from "../audit/state.ts";
import {
  validateGreenfieldArtifacts,
  writeGreenfieldStateAt,
} from "../greenfield-state.ts";
import {
  readGreenfieldFormationAt,
  renderGreenfieldArtifacts,
} from "../greenfield-artifacts.ts";
import { applyStagedBundle } from "../generation/apply-bundle.ts";
import { formatApplyReport } from "../generation/apply-report.ts";
import { collectAuditArtifactSnapshot } from "../generation/artifact-snapshot.ts";
import {
  addWriteMetadata,
  makeStagingRoot,
  writeRenderedArtifactsToStaging,
} from "../generation/staging-bundle.ts";
import { persistProjectState, reportGitHubReadiness } from "./project-state-reporter.ts";
import type { RunArtifactSnapshot, RunContext } from "./run-context.ts";

function toRel(cwd: string, filePath: string): string {
  return normalizeArtifactPath(path.relative(cwd, filePath));
}
`;

const reporter = `import { defaultConfigDir } from "../agentify-config.ts";
import { formatGitHubReadiness, inspectGitHubReadiness } from "../github-readiness.ts";
import { writeProjectState } from "../project-state.ts";
import type { RunContext } from "./run-context.ts";

export interface PersistProjectStateParams {
  projectKind: "brownfield" | "greenfield" | "unknown";
  runStatus: "success" | "partial" | "aborted" | "error";
  repoMode: "brownfield" | "greenfield" | "unknown";
  repoStatus: "uninitialized" | "partial" | "ready";
  featureAgentCount: number;
  latestLogPath: string | null;
}

export function getGitHubReadiness(context: RunContext) {
  return context.githubReadinessOverride
    ?? inspectGitHubReadiness({ cwd: context.cwd });
}

export function reportGitHubReadiness(context: RunContext): void {
  const readiness = getGitHubReadiness(context);
  for (const line of formatGitHubReadiness(readiness)) {
    context.ui.info(line);
  }
}

export function persistProjectState(
  context: RunContext,
  params: PersistProjectStateParams,
): void {
  const readiness = getGitHubReadiness(context);
  writeProjectState(defaultConfigDir(), {
    cwd: context.cwd,
    lastRunAt: new Date().toISOString(),
    projectKind: params.projectKind,
    runStatus: params.runStatus,
    repoMode: params.repoMode,
    repoStatus: params.repoStatus,
    featureAgentCount: params.featureAgentCount,
    latestLogPath: params.latestLogPath,
    github: {
      hasGitDirectory: readiness.hasGitDirectory,
      hasGitHubRemote: readiness.hasGitHubRemote,
      ghCliAvailable: readiness.ghCliAvailable,
      originUrl: readiness.originUrl,
    },
  });
}
`;

const facade = `import { defaultConfigDir, ensureAgentifyConfig } from "./agentify-config.ts";
import { ProjectClassifier } from "./project-classifier.ts";
import type { ProjectKind, RunAgentifyOptions } from "./types.ts";
import { createRunContext } from "./runs/run-context.ts";
import { runBrownfieldAudit } from "./runs/brownfield-run.ts";
import { runGreenfield } from "./runs/greenfield-run.ts";
import { applyStagedBundle } from "./generation/apply-bundle.ts";
import { collectAuditArtifactSnapshot } from "./generation/artifact-snapshot.ts";
import { writeRenderedArtifactsToStaging } from "./generation/staging-bundle.ts";

export {
  applyStagedBundle,
  collectAuditArtifactSnapshot,
  writeRenderedArtifactsToStaging,
};

${chooseAmbiguous}

export async function runAgentify(options: RunAgentifyOptions): Promise<void> {
  const config = options.configOverride
    ?? await ensureAgentifyConfig(defaultConfigDir(), options.ui);
  const classification = options.mode
    ? { kind: options.mode }
    : ProjectClassifier.classify(options.cwd);
  let kind = classification.kind;
  if (kind === "ambiguous") {
    kind = await chooseAmbiguousKind(options);
  }

  const context = createRunContext(options, config);
  if (kind === "greenfield") {
    await runGreenfield(context);
    return;
  }
  await runBrownfieldAudit(context);
}
`;

const runsDir = path.join(root, "src/core/runs");
fs.mkdirSync(runsDir, { recursive: true });
fs.writeFileSync(path.join(runsDir, "brownfield-run.ts"), `${brownfieldImports}\n${helpers}\n\n${brownfield}\n`);
fs.writeFileSync(path.join(runsDir, "greenfield-run.ts"), `${greenfieldImports}\n${greenfield}\n`);
fs.writeFileSync(path.join(runsDir, "project-state-reporter.ts"), reporter);
fs.writeFileSync(sourcePath, facade);

const revertPath = path.join(root, "src/core/revert.ts");
let revert = fs.readFileSync(revertPath, "utf8");
if (!revert.includes('import type { AuditArtifactSnapshot } from "./generation/artifact-snapshot.ts";')) {
  revert = revert.replace(
    'import type { AgentifyUi } from "./types.ts";\n',
    'import type { AgentifyUi } from "./types.ts";\nimport type { AuditArtifactSnapshot } from "./generation/artifact-snapshot.ts";\n',
  );
}
revert = revert.replace(
  'snapshot: Record<string, { content: Buffer; mode: number; ownership: "managed" | "unmanaged" }>;',
  "snapshot: AuditArtifactSnapshot;",
);
revert = revert.replace(
  "for (const [rel, entry] of Object.entries(params.snapshot)) {",
  "for (const [rel, entry] of params.snapshot) {",
);
fs.writeFileSync(revertPath, revert);

console.log("Issue #25 orchestration extraction applied.");
