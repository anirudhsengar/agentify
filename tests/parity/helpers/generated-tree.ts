import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CodebaseMap } from "../../../src/core/audit/schema.ts";
import { renderValidatedBrownfieldArtifacts } from "../../../src/core/artifacts/renderers.ts";
import {
  DEFAULT_APPLY_POLICY,
  type ApplyPolicy,
} from "../../../src/core/apply-policy.ts";
import {
  manifestFileFromContent,
  type ManagedManifestFile,
} from "../../../src/core/manifest.ts";
import {
  applyStagedBundle,
  collectAuditArtifactSnapshot,
  writeRenderedArtifactsToStaging,
} from "../../../src/core/run-agentify.ts";

export const PARITY_STATE_DIR = ".pi/agentify";

export interface TreeEntry {
  path: string;
  type: "file" | "symlink";
  value: string;
}

export interface BrownfieldApplyResult {
  rendered: ReturnType<typeof renderValidatedBrownfieldArtifacts>;
  applied: ReturnType<typeof applyStagedBundle> | null;
}

export function makeParityTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function normalizeManifest(content: Buffer): Buffer {
  const parsed = JSON.parse(content.toString("utf-8")) as Record<string, unknown>;
  if (Object.hasOwn(parsed, "generated_at")) parsed.generated_at = "<generated-at>";
  if (Object.hasOwn(parsed, "run_id")) parsed.run_id = "<run-id>";
  return Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
}

export function readGeneratedTree(
  root: string,
  options: { normalizeVolatileManifestFields?: boolean } = {},
): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        entries.push({ path: relativePath, type: "symlink", value: fs.readlinkSync(absolutePath) });
        continue;
      }
      if (!entry.isFile()) continue;
      const raw = fs.readFileSync(absolutePath);
      const content = options.normalizeVolatileManifestFields === true
        && relativePath.endsWith("/manifest.json")
        ? normalizeManifest(raw)
        : raw;
      entries.push({ path: relativePath, type: "file", value: content.toString("base64") });
    }
  };
  if (fs.existsSync(root)) visit(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export function applyBrownfieldFixture(
  cwd: string,
  map: CodebaseMap,
  runId: string,
  policy: ApplyPolicy = DEFAULT_APPLY_POLICY,
  stateDir = PARITY_STATE_DIR,
): BrownfieldApplyResult {
  const rendered = renderValidatedBrownfieldArtifacts(map);
  if (rendered.validationErrors.length > 0) return { rendered, applied: null };

  const stagingRoot = makeParityTempDir("agentify-parity-staging-");
  try {
    const metadata = new Map<string, ManagedManifestFile>();
    writeRenderedArtifactsToStaging(stagingRoot, rendered.artifacts, metadata);
    const mapContent = `${JSON.stringify(map, null, 2)}\n`;
    const mapRelativePath = `${stateDir}/codebase_map.json`;
    fs.mkdirSync(path.join(stagingRoot, stateDir), { recursive: true });
    fs.writeFileSync(path.join(stagingRoot, mapRelativePath), mapContent);
    metadata.set(
      mapRelativePath,
      manifestFileFromContent(
        { relativePath: mapRelativePath, content: mapContent, required: true },
        "brownfield",
        stateDir,
      ),
    );
    return {
      rendered,
      applied: applyStagedBundle({
        cwd,
        stagingRoot,
        snapshot: collectAuditArtifactSnapshot(cwd),
        metadata,
        agentifyVersion: "parity-baseline",
        mode: "brownfield",
        policy,
        runId,
        stateDir,
      }),
    };
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}
