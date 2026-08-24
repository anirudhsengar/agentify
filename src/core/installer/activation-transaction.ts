import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { alongsidePathFor } from "../apply-policy.ts";
import { AGENTIFY_INSTALLED_CONTROL_PATHS } from "../artifacts/managed-installation-paths.ts";

const BUNDLED_RUNTIME_PATHS = [
  ".github/agentify/learning-runtime.mjs",
  ".github/agentify/runtime-inventory.json",
  ".github/agentify/task-runtime.mjs",
] as const;

interface SnapshotEntry {
  relativePath: string;
  backupPath: string;
  existed: boolean;
  mode: number | null;
}

export interface InstallationActivationTransaction {
  commit(): void;
  rollback(): void;
}

function activationPaths(): string[] {
  const canonical = [
    ...AGENTIFY_INSTALLED_CONTROL_PATHS,
    ...BUNDLED_RUNTIME_PATHS,
  ];
  return [...new Set(canonical.flatMap((relativePath) => [
    relativePath,
    alongsidePathFor(relativePath),
  ]))].sort((left, right) => left.localeCompare(right));
}

function absoluteInside(root: string, relativePath: string): string {
  const absolute = path.resolve(root, ...relativePath.split("/"));
  const relation = path.relative(root, absolute);
  if (relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new Error(`managed activation path escapes the repository: ${relativePath}`);
  }
  return absolute;
}

function removeRegularFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`managed activation path changed to a non-regular file: ${filePath}`);
  }
  fs.rmSync(filePath);
}

function pruneEmptyParents(root: string, start: string): void {
  let current = path.dirname(start);
  while (current !== root) {
    const relation = path.relative(root, current);
    if (relation.startsWith("..") || path.isAbsolute(relation)) return;
    try {
      fs.rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

export function beginInstallationActivationTransaction(
  cwd: string,
): InstallationActivationTransaction {
  const root = fs.realpathSync.native(path.resolve(cwd));
  const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-activation-"));
  let entries: SnapshotEntry[];
  try {
    entries = activationPaths().map((relativePath, index) => {
      const absolute = absoluteInside(root, relativePath);
      const backupPath = path.join(backupRoot, `${String(index).padStart(4, "0")}.bin`);
      if (!fs.existsSync(absolute)) {
        return { relativePath, backupPath, existed: false, mode: null };
      }
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`managed activation path is not a regular file: ${relativePath}`);
      }
      fs.copyFileSync(absolute, backupPath);
      return { relativePath, backupPath, existed: true, mode: stat.mode & 0o777 };
    });
  } catch (error) {
    fs.rmSync(backupRoot, { recursive: true, force: true });
    throw error;
  }
  let closed = false;
  const close = (): void => {
    fs.rmSync(backupRoot, { recursive: true, force: true });
    closed = true;
  };
  return {
    commit(): void {
      if (closed) return;
      close();
    },
    rollback(): void {
      if (closed) return;
      for (const entry of [...entries].reverse()) {
        const absolute = absoluteInside(root, entry.relativePath);
        removeRegularFile(absolute);
        if (entry.existed) {
          fs.mkdirSync(path.dirname(absolute), { recursive: true });
          fs.copyFileSync(entry.backupPath, absolute);
          if (entry.mode !== null) fs.chmodSync(absolute, entry.mode);
        } else {
          pruneEmptyParents(root, absolute);
        }
      }
      close();
    },
  };
}
