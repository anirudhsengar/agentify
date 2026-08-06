import * as fs from "node:fs";
import * as path from "node:path";
import { markerForArtifactPath } from "../artifacts/managed-markers.ts";
import { hasRecognizedManifestMarker } from "../memory/index.ts";
import { installScaffoldRuntime } from "../scaffold-installer.ts";
import type { ArtifactWrite } from "../types.ts";
import type {
  RepositoryInstallationPreflight,
  RepositoryValidationApproval,
} from "./contracts.ts";
import { buildRepositoryTaskPolicyConfiguration } from "./task-policy.ts";

export interface RepairInstalledRuntimeInput {
  cwd: string;
  packageRoot: string;
  agentifyVersion: string;
  preflight: RepositoryInstallationPreflight;
  validationApproval?: RepositoryValidationApproval;
}

export interface RepairInstalledRuntimeResult {
  status: "absent" | "repaired" | "conflict";
  repaired_paths: string[];
  conflicts: ArtifactWrite[];
}

const FOCUSED_RUNTIME_PATHS = [
  "AGENTS.md",
  "SETUP.md",
  ".github/agentify-task-policy.json",
  ".github/scripts/complete-accepted-task-merge.mjs",
  ".github/scripts/task-state-github.mjs",
  ".github/workflows/agentify-issue.yml",
  ".github/workflows/agentify-learn.yml",
  ".github/agentify/task-runtime.mjs",
  ".github/agentify/learning-runtime.mjs",
] as const;

function recognizedManagedFile(cwd: string, relativePath: string): boolean {
  const filePath = path.join(cwd, relativePath);
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const marker = markerForArtifactPath(relativePath);
    return marker === "sha256" || fs.readFileSync(filePath, "utf-8").includes(marker);
  } catch {
    return false;
  }
}

/** Repair only paths recognized by the focused vendor-neutral installation. */
export function repairInstalledRuntime(
  input: RepairInstalledRuntimeInput,
): RepairInstalledRuntimeResult {
  if (!hasRecognizedManifestMarker(input.cwd)) {
    return { status: "absent", repaired_paths: [], conflicts: [] };
  }
  const knownManagedPaths = new Set(
    FOCUSED_RUNTIME_PATHS.filter((relativePath) => recognizedManagedFile(input.cwd, relativePath)),
  );
  const writes = installScaffoldRuntime({
    cwd: input.cwd,
    packageRoot: input.packageRoot,
    taskPolicyConfiguration: buildRepositoryTaskPolicyConfiguration(
      input.preflight,
      input.validationApproval ?? null,
      input.cwd,
    ),
    knownManagedPaths,
  });
  const conflicts = writes.filter(
    (write) => write.action === "alongside",
  );
  const repairedPaths = writes
    .filter((write) => write.action === "written")
    .map((write) => path.relative(input.cwd, write.path).split(path.sep).join("/"))
    .sort((left, right) => left.localeCompare(right));
  return {
    status: conflicts.length > 0 ? "conflict" : repairedPaths.length > 0 ? "repaired" : "absent",
    repaired_paths: repairedPaths,
    conflicts,
  };
}
