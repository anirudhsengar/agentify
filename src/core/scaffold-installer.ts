import * as fs from "node:fs";
import * as path from "node:path";
import { alongsidePathFor } from "./apply-policy.ts";
import {
  addManagedMarker,
  markerForArtifactPath,
} from "./artifacts/managed-markers.ts";
import type { ArtifactWrite } from "./types.ts";

export interface InstallScaffoldRuntimeOptions {
  cwd: string;
  packageRoot: string;
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  };
  visit(root);
  return out;
}

function markerFor(filePath: string): string {
  return markerForArtifactPath(filePath);
}

function modeFor(source: string): number {
  return fs.statSync(source).mode & 0o777;
}

function copyManaged(source: string, destination: string): ArtifactWrite {
  const marker = markerFor(destination);
  const raw = fs.readFileSync(source, "utf-8");
  const content = marker === "sha256" ? raw : addManagedMarker(raw, marker);
  const mode = modeFor(source);
  if (fs.existsSync(destination)) {
    const existing = fs.readFileSync(destination, "utf-8");
    const managed = marker === "sha256" ? existing === content : existing.includes(marker);
    if (!managed) {
      // User-owned file at the destination. Save the
      // agentify-managed copy alongside (`<basename>.agentify<ext>`)
      // and leave the user's file untouched.
      const alongside = alongsidePathFor(destination);
      fs.mkdirSync(path.dirname(alongside), { recursive: true });
      fs.writeFileSync(alongside, content, { mode });
      return {
        path: destination,
        action: "alongside",
        reason: "user file preserved; scaffold saved alongside",
        alongsidePath: alongside,
      };
    }
    if (existing === content) {
      return {
        path: destination,
        action: "skipped",
      };
    }
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content, { mode });
  fs.chmodSync(destination, mode);
  return {
    path: destination,
    action: "written",
  };
}

export function installScaffoldRuntime(options: InstallScaffoldRuntimeOptions): ArtifactWrite[] {
  const scaffoldRoot = path.join(options.packageRoot, "scaffold");
  if (!fs.existsSync(scaffoldRoot)) {
    return [];
  }
  const writes: ArtifactWrite[] = [];
  for (const source of listFiles(scaffoldRoot)) {
    const relative = path.relative(scaffoldRoot, source);
    // Scaffold contract tests are package tests. Target repositories receive
    // only the runtime validator, not Agentify's implementation test suite.
    if (relative === "tests/run.sh" || relative.startsWith("tests/test-")) continue;
    writes.push(copyManaged(source, path.join(options.cwd, relative)));
  }
  return writes;
}
