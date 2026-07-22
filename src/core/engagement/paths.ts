import * as fs from "node:fs";
import * as path from "node:path";
import { EngagementError } from "./errors.ts";

const SAFE_ENGAGEMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validateEngagementId(engagementId: string): void {
  let decoded = engagementId;
  try {
    decoded = decodeURIComponent(engagementId);
  } catch {
    throw new EngagementError("invalid_id", `engagement ID is not valid URI text: ${engagementId}`);
  }
  if (
    !SAFE_ENGAGEMENT_ID.test(engagementId)
    || decoded !== engagementId
    || engagementId === "."
    || engagementId === ".."
    || path.isAbsolute(engagementId)
    || engagementId.includes("/")
    || engagementId.includes("\\")
  ) {
    throw new EngagementError(
      "invalid_id",
      "engagement ID must be 1-128 ASCII letters, numbers, dots, underscores, or hyphens and cannot contain path syntax",
    );
  }
}

export function engagementRootPath(resolvedStateDir: string): string {
  const stateRoot = path.resolve(resolvedStateDir);
  const root = path.join(stateRoot, "engagements");
  for (const candidate of [stateRoot, root]) {
    try {
      if (fs.lstatSync(candidate).isSymbolicLink()) {
        throw new EngagementError("unsafe_path", `engagement state path cannot be a symlink: ${candidate}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return root;
}

export function engagementCharterPath(resolvedStateDir: string, engagementId: string): string {
  validateEngagementId(engagementId);
  const stateRoot = path.resolve(resolvedStateDir);
  const root = engagementRootPath(resolvedStateDir);
  const charterPath = path.resolve(root, engagementId, "charter.json");
  const relative = path.relative(stateRoot, charterPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new EngagementError("invalid_id", `engagement path escapes the resolved state directory: ${engagementId}`);
  }
  for (const candidate of [
    path.join(root, engagementId),
    charterPath,
  ]) {
    try {
      if (fs.lstatSync(candidate).isSymbolicLink()) {
        throw new EngagementError(
          "unsafe_path",
          `engagement state path cannot contain symlinks beneath the resolved state directory: ${candidate}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return charterPath;
}
