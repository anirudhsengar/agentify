import * as fs from "node:fs";
import * as path from "node:path";
import { resolvePackageRoot } from "./package-root.ts";

/** Read package.json from a source or compiled package root. */
export function readPackageVersion(packageRoot: string = resolvePackageRoot()): string {
  try {
    const raw = fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
