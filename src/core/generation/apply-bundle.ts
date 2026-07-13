import * as fs from "node:fs";
import * as path from "node:path";
import {
  alongsidePathFor,
  resolveActionForPath,
  type ApplyPolicy,
} from "../apply-policy.ts";
import {
  manifestFileFromContent,
  manifestRelativePath,
  sha256,
  type ManagedManifest,
  type ManagedManifestFile,
} from "../manifest.ts";
import { writeManifestWithStateRecord } from "../manifest-verification.ts";
import type { ArtifactWrite, ProjectKind } from "../types.ts";
import type { AuditArtifactSnapshot } from "./artifact-snapshot.ts";
import { collectStagedFiles } from "./staging-bundle.ts";

export function withAbortOnRequired(policy: ApplyPolicy): ApplyPolicy {
  return { ...policy, requiredAction: "abort" };
}

function hasSymlinkAncestor(cwd: string, relativePath: string): boolean {
  const parts = relativePath.split("/").slice(0, -1);
  let current = cwd;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return false;
    if (stat.isSymbolicLink()) return true;
  }
  return false;
}

function isConflictingDestination(
  cwd: string,
  relativePath: string,
  snapshot: AuditArtifactSnapshot,
): boolean {
  const destination = path.join(cwd, relativePath);
  if (hasSymlinkAncestor(cwd, relativePath)) return true;
  const destinationStat = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (!destinationStat) return false;
  if (destinationStat.isSymbolicLink()) return true;
  const snapshotEntry = snapshot.get(relativePath);
  if (snapshotEntry) return snapshotEntry.ownership === "unmanaged";
  return false;
}

export function applyStagedBundle(params: {
  cwd: string;
  stagingRoot: string;
  snapshot: AuditArtifactSnapshot;
  metadata: Map<string, ManagedManifestFile>;
  agentifyVersion: string;
  mode: Exclude<ProjectKind, "ambiguous">;
  policy: ApplyPolicy;
  runId: string;
  stateDir: string;
  /** null keeps a Phase A legacy manifest unstamped at its physical source. */
  manifestStateDir?: string | null;
}): { writes: ArtifactWrite[]; requiredConflictCount: number; manifest: ManagedManifest | null } {
  const stagedFiles = collectStagedFiles(params.stagingRoot, params.stateDir);
  const writes: ArtifactWrite[] = [];
  const manifestFiles: ManagedManifestFile[] = [];
  let requiredConflictCount = 0;

  for (const file of stagedFiles) {
    const entry = params.metadata.get(file.relativePath)
      ?? manifestFileFromContent({ relativePath: file.relativePath, content: file.content });
    if (entry.required
      && isConflictingDestination(params.cwd, file.relativePath, params.snapshot)
      && resolveActionForPath(params.policy, file.relativePath, true) === "abort") {
      requiredConflictCount += 1;
      writes.push({
        path: path.join(params.cwd, file.relativePath),
        action: "conflict",
        reason: "required file conflict; set requiredAction to \"alongside\" in .agentifyrc to save alongside",
      });
    }
  }
  if (requiredConflictCount > 0) return { writes, requiredConflictCount, manifest: null };

  for (const file of stagedFiles) {
    const baseEntry = params.metadata.get(file.relativePath)
      ?? manifestFileFromContent({ relativePath: file.relativePath, content: file.content });
    const isRequired = baseEntry.required;

    if (!isConflictingDestination(params.cwd, file.relativePath, params.snapshot)) {
      const destination = path.join(params.cwd, file.relativePath);
      const existing = fs.existsSync(destination) ? fs.readFileSync(destination) : null;
      const writeAction = existing && Buffer.compare(existing, file.content) === 0 ? "skipped" : "written";
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.content, { mode: 0o644 });
      writes.push({ path: destination, action: writeAction });
      manifestFiles.push(baseEntry);
      continue;
    }

    const action = resolveActionForPath(params.policy, file.relativePath, isRequired);

    if (action === "abort") {
      writes.push({
        path: path.join(params.cwd, file.relativePath),
        action: "conflict",
        reason: isRequired
          ? "required file conflict; set requiredAction to \"alongside\" in .agentifyrc to save alongside"
          : "existing file is not agentify-managed",
      });
      continue;
    }

    if (action === "keep") {
      const userContent = fs.readFileSync(path.join(params.cwd, file.relativePath));
      const preservedSha = sha256(userContent);
      writes.push({
        path: path.join(params.cwd, file.relativePath),
        action: "skipped",
        reason: "user file kept; agentify's version discarded",
      });
      manifestFiles.push({ ...baseEntry, preservedSha256: preservedSha });
      continue;
    }

    const alongsideRel = alongsidePathFor(file.relativePath);
    const alongsideDest = path.join(params.cwd, alongsideRel);
    if (hasSymlinkAncestor(params.cwd, alongsideRel)
      || fs.lstatSync(alongsideDest, { throwIfNoEntry: false })?.isSymbolicLink()) {
      writes.push({
        path: path.join(params.cwd, file.relativePath),
        action: "conflict",
        reason: "alongside destination is a symbolic link",
      });
      continue;
    }
    const userContent = fs.readFileSync(path.join(params.cwd, file.relativePath));
    const preservedSha = sha256(userContent);
    fs.mkdirSync(path.dirname(alongsideDest), { recursive: true });
    fs.writeFileSync(alongsideDest, file.content, { mode: 0o644 });
    writes.push({
      path: path.join(params.cwd, file.relativePath),
      action: "alongside",
      reason: "user file preserved; agentify's version saved alongside",
      alongsidePath: alongsideRel,
    });
    manifestFiles.push({
      ...baseEntry,
      sha256: sha256(file.content),
      alongsidePath: alongsideRel,
      preservedSha256: preservedSha,
    });
  }

  if (requiredConflictCount > 0) {
    return { writes, requiredConflictCount, manifest: null };
  }

  const sortedFiles = manifestFiles.sort((a, b) => a.path.localeCompare(b.path));
  const manifest: ManagedManifest = {
    schema_version: "2",
    agentify_version: params.agentifyVersion,
    generated_at: new Date().toISOString(),
    mode: params.mode,
    run_id: params.runId,
    files: sortedFiles,
  };
  const recordedStateDir = params.manifestStateDir === undefined
    ? params.stateDir
    : params.manifestStateDir;
  writeManifestWithStateRecord(params.cwd, manifest, params.stateDir, recordedStateDir);
  writes.push({ path: path.join(params.cwd, manifestRelativePath(params.stateDir)), action: "written" });
  return {
    writes,
    requiredConflictCount,
    manifest: recordedStateDir === null
      ? { ...manifest, state_dir: undefined }
      : { ...manifest, state_dir: recordedStateDir },
  };
}
