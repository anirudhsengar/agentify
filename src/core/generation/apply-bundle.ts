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
  writeManifestAt,
  type ManagedManifest,
  type ManagedManifestFile,
} from "../manifest.ts";
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
  // Never follow a repository symlink while deciding ownership. Treat it as
  // user-owned so staged writes cannot escape the repository root.
  if (destinationStat.isSymbolicLink()) return true;
  const snapshotEntry = snapshot.get(relativePath);
  // Pre-run unmanaged files (user-owned) are always conflicts:
  // they were on disk before the run started and we must not
  // overwrite them silently.
  if (snapshotEntry) return snapshotEntry.ownership === "unmanaged";
  // The destination exists but wasn't in the pre-run snapshot.
  // Two cases reach here: (a) the runtime (or the mirror step
  // for `.pi/agents/*.md`) wrote it during this run — agentify
  // owns it, so overwriting with a managed version is correct;
  // (b) the file is outside any generated-surface path and the
  // snapshot enumeration missed it — irrelevant for the apply
  // loop because only generated-surface paths are staged. Treat
  // both as non-conflicts so the staged content lands at the
  // canonical destination rather than alongside it.
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
}): { writes: ArtifactWrite[]; requiredConflictCount: number; manifest: ManagedManifest | null } {
  const stagedFiles = collectStagedFiles(params.stagingRoot, params.stateDir);
  const writes: ArtifactWrite[] = [];
  const manifestFiles: ManagedManifestFile[] = [];
  let requiredConflictCount = 0;

  // Required aborts are a bundle-level preflight. Discover them before
  // writing any non-conflicting file so a rejected generation is atomic.
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
      // No conflict — write the canonical file in the repo and
      // record the manifest entry unchanged.
      const destination = path.join(params.cwd, file.relativePath);
      const existing = fs.existsSync(destination) ? fs.readFileSync(destination) : null;
      const writeAction = existing && Buffer.compare(existing, file.content) === 0 ? "skipped" : "written";
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.content, { mode: 0o644 });
      writes.push({ path: destination, action: writeAction });
      manifestFiles.push(baseEntry);
      continue;
    }

    // Conflict at the canonical path. Resolve per policy.
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
      // Leave the user's file; do not save agentify's version
      // anywhere. Record the user's sha so `revert` knows the
      // file was deliberately preserved.
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

    // action === "alongside" (default). Write the staged content
    // to a sibling file next to the user's, leave the user's
    // file untouched, and record both paths in the manifest.
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
  writeManifestAt(params.cwd, manifest, params.stateDir);
  writes.push({ path: path.join(params.cwd, manifestRelativePath(params.stateDir)), action: "written" });
  return { writes, requiredConflictCount, manifest };
}
