import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentifyUi } from "./types.ts";
import type { AuditArtifactSnapshot } from "./generation/artifact-snapshot.ts";
import {
  readManifestAt,
  writeManifestAt,
  type ManagedManifest,
} from "./manifest.ts";

/**
 * Result of a `revert` operation. Three buckets:
 *
 * - `alongsideRemoved`: `*.agentify.*` files deleted (the
 *   agentify-written alongside versions from the last run).
 * - `userRestored`: user files restored from the pre-run snapshot
 *   (the originals that agentify overwrote or that were preserved
 *   as alongside).
 * - `createdRemoved`: files that agentify created from scratch
 *   (no pre-existing user content) and that are now deleted.
 * - `errors`: per-file errors that prevented the operation.
 *
 * `kept` is the count of files that the manifest listed as
 * alongside-only (no canonical write) — nothing to do for these.
 */
export interface RevertResult {
  alongsideRemoved: string[];
  userRestored: string[];
  createdRemoved: string[];
  kept: string[];
  errors: string[];
}

export interface RevertOptions {
  cwd: string;
  stateDir: string;
  /**
   * Override the run id from the manifest. If unset, uses the
   * `run_id` field on the manifest itself (the most recent run).
   */
  runId?: string;
  /**
   * Default: true. When true, also delete the `*.agentify.*`
   * alongside files. Set to false to keep the alongside versions
   * (e.g. for inspection).
   */
  includeAlongside?: boolean;
  ui: AgentifyUi;
}

interface SnapshotEntry {
  content: string; // base64
  mode: number;
}

type Snapshot = Record<string, SnapshotEntry>;

/**
 * Undo the last agentify run. Reads the manifest, the pre-run
 * snapshot at `<stateDir>/runs/<run-id>/snapshot.json`, and the
 * pre-run manifest at `<stateDir>/runs/<run-id>/manifest.previous.json`.
 * For each file in the manifest:
 *
 * - If `alongsidePath` is set: delete the alongside file (the
 *   user's canonical file is left alone — we never touched it).
 * - Else if the snapshot has the path: restore the user's original
 *   content from the snapshot.
 * - Else: agentify created the file from scratch; delete it.
 *
 * After processing all files, the manifest itself is replaced with
 * the previous manifest (if any) or removed. The runs/ directory
 * for the run id is left in place for forensic inspection.
 *
 * v1 manifests (no `run_id`) are not revertable — the function
 * returns an error and the user is told to run agentify once to
 * upgrade.
 */
export async function revertLastRun(options: RevertOptions): Promise<RevertResult> {
  const includeAlongside = options.includeAlongside ?? true;
  const result: RevertResult = {
    alongsideRemoved: [],
    userRestored: [],
    createdRemoved: [],
    kept: [],
    errors: [],
  };

  const stateDir = options.stateDir;
  options.ui.info(`agentify: revert: inspecting state at ${stateDir}`);
  const manifest = readManifestAt(options.cwd, stateDir);
  if (!manifest) {
    options.ui.error(
      `agentify: revert: no manifest at ${stateDir}/manifest.json — nothing to revert`,
    );
    result.errors.push("no manifest");
    return result;
  }

  if (manifest.schema_version !== "2" || !manifest.run_id) {
    options.ui.error(
      "agentify: revert: manifest is v1 (no run_id). Run agentify once to upgrade before reverting.",
    );
    result.errors.push("v1 manifest");
    return result;
  }

  const runId = options.runId ?? manifest.run_id;
  const runDir = path.join(options.cwd, stateDir, "runs", runId);
  const snapshotPath = path.join(runDir, "snapshot.json");
  const previousManifestPath = path.join(runDir, "manifest.previous.json");

  if (!fs.existsSync(snapshotPath)) {
    options.ui.error(
      `agentify: revert: run snapshot missing at ${snapshotPath} — cannot restore originals`,
    );
    result.errors.push("missing snapshot");
    return result;
  }

  let snapshot: Snapshot;
  try {
    const raw = fs.readFileSync(snapshotPath, "utf-8");
    snapshot = JSON.parse(raw) as Snapshot;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    options.ui.error(`agentify: revert: failed to parse snapshot: ${message}`);
    result.errors.push("snapshot parse");
    return result;
  }

  for (const file of manifest.files) {
    const filePath = path.join(options.cwd, file.path);

    if (file.alongsidePath) {
      if (!includeAlongside) {
        result.kept.push(file.path);
        continue;
      }
      const alongsideFull = path.join(options.cwd, file.alongsidePath);
      if (fs.existsSync(alongsideFull)) {
        try {
          fs.unlinkSync(alongsideFull);
          result.alongsideRemoved.push(file.alongsidePath);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result.errors.push(`${file.alongsidePath}: ${message}`);
        }
      }
      continue;
    }

    const snap = snapshot[file.path];
    if (snap) {
      try {
        const content = Buffer.from(snap.content, "base64");
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, { mode: snap.mode });
        try {
          fs.chmodSync(filePath, snap.mode);
        } catch {
          // Best effort on filesystems without chmod support.
        }
        result.userRestored.push(file.path);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`${file.path}: ${message}`);
      }
      continue;
    }

    if (fs.existsSync(filePath)) {
      try {
        fs.rmSync(filePath, { force: true });
        result.createdRemoved.push(file.path);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`${file.path}: ${message}`);
      }
    }
  }

  if (fs.existsSync(previousManifestPath)) {
    try {
      const previousRaw = fs.readFileSync(previousManifestPath, "utf-8");
      const previous = JSON.parse(previousRaw) as ManagedManifest;
      writeManifestAt(options.cwd, previous, stateDir);
    } catch {
      // Best effort — if the previous manifest is corrupt, leave
      // the current one in place rather than deleting it.
    }
  } else {
    const manifestPath = path.join(options.cwd, stateDir, "manifest.json");
    if (fs.existsSync(manifestPath)) {
      try {
        fs.rmSync(manifestPath, { force: true });
      } catch {
        // Best effort.
      }
    }
  }

  return result;
}

/**
 * Persist the pre-run state needed by `revert`. Called from
 * `applyStagedBundle` (or just before it) so a future `revert` can
 * restore the originals. Two artifacts:
 *
 * 1. `<stateDir>/runs/<run-id>/snapshot.json` — the pre-run
 *    snapshot of every file in the generated surface, base64-
 *    encoded.
 * 2. `<stateDir>/runs/<run-id>/manifest.previous.json` — a copy
 *    of the pre-existing manifest (if any), so `revert` can
 *    restore the manifest itself. Omitted on first-run.
 */
export function persistRunArtifacts(params: {
  cwd: string;
  stateDir: string;
  runId: string;
  snapshot: AuditArtifactSnapshot | Record<string, { content: Buffer; mode: number; ownership: "managed" | "unmanaged" }>;
  previousManifest: ManagedManifest | null;
}): void {
  const runDir = path.join(params.cwd, params.stateDir, "runs", params.runId);
  fs.mkdirSync(runDir, { recursive: true });

  const snapshotPath = path.join(runDir, "snapshot.json");
  const encoded: Record<string, { content: string; mode: number }> = {};
  const snapshotEntries = params.snapshot instanceof Map
    ? params.snapshot.entries()
    : Object.entries(params.snapshot);
  for (const [rel, entry] of snapshotEntries) {
    encoded[rel] = { content: entry.content.toString("base64"), mode: entry.mode };
  }
  fs.writeFileSync(
    snapshotPath,
    `${JSON.stringify(encoded, null, 2)}\n`,
    { mode: 0o644 },
  );

  if (params.previousManifest) {
    const prevPath = path.join(runDir, "manifest.previous.json");
    fs.writeFileSync(
      prevPath,
      `${JSON.stringify(params.previousManifest, null, 2)}\n`,
      { mode: 0o644 },
    );
  }
}

export function newRunId(): string {
  return crypto.randomUUID();
}
