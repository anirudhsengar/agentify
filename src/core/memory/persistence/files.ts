import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeMemoryRepositoryPath } from "../paths.ts";
import { canonicalJson } from "../serialization.ts";
import { TeamMemoryError, type MemoryStoreOptions } from "../contracts.ts";

export const LEGACY_TEAM_IGNORE_CONTENT = "runtime/\nstate-transactions/\n";

export const TEAM_IGNORE_CONTENT = [
  "runtime/*",
  "!runtime/audit/",
  "runtime/audit/*",
  "!runtime/audit/codebase_map.json",
  "state-transactions/",
  "",
].join("\n");

export const MAX_ENTITY_BYTES = 256 * 1024;

export const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

export const MAX_VISIBLE_BYTES = 64 * 1024 * 1024;

export const MAX_MEMORY_RECORDS = 5_000;

export const MAX_PENDING_CANDIDATES = 1_024;

export const DEFAULT_STALE_LOCK_MS = 10 * 60 * 1000;

export function repositoryRoot(cwd: string): string {
  const resolved = path.resolve(cwd);
  try {
    return fs.realpathSync.native(resolved);
  } catch (error) {
    throw new TeamMemoryError(
      "unsafe_path",
      `cannot resolve repository root ${resolved}`,
      { cause: error },
    );
  }
}

export function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? value : null;
}

export function ensureSafeDirectory(cwd: string, relativeDirectory: string): string {
  const root = repositoryRoot(cwd);
  const normalized = normalizeMemoryRepositoryPath(relativeDirectory, "memory directory");
  let current = root;
  for (const segment of normalized.split("/")) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw new TeamMemoryError(
          "unsafe_path",
          `cannot inspect memory directory ${path.relative(root, current)}`,
          { cause: error },
        );
      }
      try {
        fs.mkdirSync(current, { mode: 0o700 });
        stat = fs.lstatSync(current);
      } catch (mkdirError) {
        throw new TeamMemoryError(
          "persistence_failed",
          `cannot create memory directory ${path.relative(root, current)}`,
          { cause: mkdirError },
        );
      }
    }
    if (stat.isSymbolicLink()) {
      throw new TeamMemoryError(
        "unsafe_path",
        `memory directory cannot contain symlink ancestor ${path.relative(root, current)}`,
      );
    }
    if (!stat.isDirectory()) {
      throw new TeamMemoryError(
        "unsafe_path",
        `memory directory ancestor is not a directory: ${path.relative(root, current)}`,
      );
    }
  }
  return current;
}

export function resolveExistingSafeFile(cwd: string, relativePath: string): string {
  const root = repositoryRoot(cwd);
  const normalized = normalizeMemoryRepositoryPath(relativePath, "memory file path");
  const segments = normalized.split("/");
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new TeamMemoryError("not_found", `${normalized} does not exist`, { cause: error });
      }
      throw new TeamMemoryError(
        "corrupt_state",
        `cannot inspect ${path.relative(root, current)}`,
        { cause: error },
      );
    }
    if (stat.isSymbolicLink()) {
      throw new TeamMemoryError(
        "unsafe_path",
        `memory path cannot contain symlink ${path.relative(root, current)}`,
      );
    }
    const final = index === segments.length - 1;
    if (final ? !stat.isFile() : !stat.isDirectory()) {
      throw new TeamMemoryError(
        "unsafe_path",
        `memory path has unexpected entry type at ${path.relative(root, current)}`,
      );
    }
  }
  return current;
}

export function resolveExistingSafeDirectory(cwd: string, relativeDirectory: string): string {
  const root = repositoryRoot(cwd);
  const normalized = normalizeMemoryRepositoryPath(relativeDirectory, "memory directory");
  let current = root;
  for (const segment of normalized.split("/")) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new TeamMemoryError("not_found", `${normalized} does not exist`, { cause: error });
      }
      throw new TeamMemoryError(
        "corrupt_state",
        `cannot inspect ${path.relative(root, current)}`,
        { cause: error },
      );
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new TeamMemoryError(
        "unsafe_path",
        `memory directory must be a non-symlink directory: ${path.relative(root, current)}`,
      );
    }
  }
  return current;
}

export function assertSafeFileDestination(cwd: string, relativePath: string): string {
  const root = repositoryRoot(cwd);
  const normalized = normalizeMemoryRepositoryPath(relativePath, "memory file path");
  ensureSafeDirectory(cwd, path.posix.dirname(normalized));
  const absolute = path.join(root, ...normalized.split("/"));
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      throw new TeamMemoryError("unsafe_path", `memory file cannot be a symlink: ${normalized}`);
    }
    if (!stat.isFile()) {
      throw new TeamMemoryError("unsafe_path", `memory file is not a regular file: ${normalized}`);
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  return absolute;
}

export function assertEntitySize(
  value: unknown,
  label: string,
  maximumBytes = MAX_ENTITY_BYTES,
): string {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(content, "utf-8") > maximumBytes) {
    throw new TeamMemoryError(
      "capacity_exceeded",
      `${label} exceeds the ${maximumBytes}-byte durable file limit`,
    );
  }
  return content;
}

export function fsyncDirectory(directory: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch {
    // File fsync and same-directory atomic rename remain available.
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

export function writeTextAtomic(
  cwd: string,
  relativePath: string,
  content: string,
  options?: MemoryStoreOptions,
): void {
  const destination = assertSafeFileDestination(cwd, relativePath);
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, content, "utf-8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    options?.beforeCurrentRename?.(temporary, destination);
    fs.renameSync(temporary, destination);
    fsyncDirectory(path.dirname(destination));
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Best-effort temporary cleanup.
    }
    if (error instanceof TeamMemoryError) throw error;
    throw new TeamMemoryError(
      "persistence_failed",
      `failed to persist ${relativePath}`,
      { cause: error },
    );
  }
}

export function writeJsonAtomic(
  cwd: string,
  relativePath: string,
  value: unknown,
  options?: MemoryStoreOptions,
  maximumBytes = MAX_ENTITY_BYTES,
): void {
  writeTextAtomic(
    cwd,
    relativePath,
    assertEntitySize(value, relativePath, maximumBytes),
    options,
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function writeJsonImmutable(cwd: string, relativePath: string, value: unknown): void {
  const destination = assertSafeFileDestination(cwd, relativePath);
  if (fs.existsSync(destination)) {
    const existing = readJsonFile(destination, relativePath);
    if (canonicalJson(existing) === canonicalJson(value)) return;
    throw new TeamMemoryError("corrupt_state", `immutable memory event already differs: ${relativePath}`);
  }
  const content = assertEntitySize(value, relativePath);
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, content, "utf-8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.linkSync(temporary, destination);
    fs.unlinkSync(temporary);
    fsyncDirectory(path.dirname(destination));
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Best-effort temporary cleanup.
    }
    if (errorCode(error) === "EEXIST") {
      const existing = readJsonFile(destination, relativePath);
      if (canonicalJson(existing) === canonicalJson(value)) return;
    }
    throw new TeamMemoryError(
      "persistence_failed",
      `failed to create immutable memory event ${relativePath}`,
      { cause: error },
    );
  }
}

export function readJsonFile(
  absolutePath: string,
  label: string,
  maximumBytes = MAX_ENTITY_BYTES,
): unknown {
  let text: string;
  try {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new TeamMemoryError("unsafe_path", `${label} must be a regular non-symlink file`);
    }
    if (stat.size > maximumBytes) {
      throw new TeamMemoryError("capacity_exceeded", `${label} exceeds its durable file limit`);
    }
    text = fs.readFileSync(absolutePath, "utf-8");
  } catch (error) {
    if (error instanceof TeamMemoryError) throw error;
    throw new TeamMemoryError("corrupt_state", `cannot read ${label}`, { cause: error });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new TeamMemoryError("corrupt_state", `${label} contains invalid JSON`, { cause: error });
  }
}

export function readRelativeJson(
  cwd: string,
  relativePath: string,
  maximumBytes = MAX_ENTITY_BYTES,
): unknown {
  const normalized = normalizeMemoryRepositoryPath(relativePath);
  return readJsonFile(resolveExistingSafeFile(cwd, normalized), normalized, maximumBytes);
}
