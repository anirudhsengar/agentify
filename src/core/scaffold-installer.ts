import * as fs from "node:fs";
import * as path from "node:path";
import { alongsidePathFor } from "./apply-policy.ts";
import {
  addManagedMarker,
  markerForArtifactPath,
} from "./artifacts/managed-markers.ts";
import type { ArtifactWrite } from "./types.ts";
import type { RepositoryTaskPolicyConfiguration } from "./installer/contracts.ts";
import { AGENTIFY_INSTALLED_CONTROL_PATHS } from "./artifacts/managed-installation-paths.ts";

export interface InstallScaffoldRuntimeOptions {
  cwd: string;
  packageRoot: string;
  taskPolicyConfiguration?: RepositoryTaskPolicyConfiguration;
  knownManagedPaths?: ReadonlySet<string>;
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

function copyManaged(
  source: string,
  destination: string,
  options: { content?: string; knownManaged?: boolean } = {},
): ArtifactWrite {
  const marker = markerFor(destination);
  const raw = options.content ?? fs.readFileSync(source, "utf-8");
  const content = marker === "sha256" ? raw : addManagedMarker(raw, marker);
  const mode = modeFor(source);
  if (fs.existsSync(destination)) {
    const existing = fs.readFileSync(destination, "utf-8");
    const managed = options.knownManaged === true
      || (marker === "sha256" ? existing === content : existing.includes(marker));
    if (!managed) {
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
  const bundledRuntimes = [
    {
      source: path.join(options.packageRoot, "dist", "learning-runtime.mjs"),
      destination: path.join(options.cwd, ".github", "agentify", "learning-runtime.mjs"),
      label: "learning",
    },
    {
      source: path.join(options.packageRoot, "dist", "task-runtime.mjs"),
      destination: path.join(options.cwd, ".github", "agentify", "task-runtime.mjs"),
      label: "task lifecycle",
    },
  ];
  for (const runtime of bundledRuntimes) {
    if (!fs.existsSync(runtime.source)) {
      throw new Error(
        `Agentify ${runtime.label} runtime is missing from dist; run the package build before installing the GitHub runtime`,
      );
    }
  }

  const writes: ArtifactWrite[] = [];
  for (const source of listFiles(scaffoldRoot)) {
    const relative = path.relative(scaffoldRoot, source);
    const portableRelative = relative.split(path.sep).join("/");
    if (!AGENTIFY_INSTALLED_CONTROL_PATHS.has(portableRelative)) continue;
    const destination = path.join(options.cwd, relative);
    const policyContent = portableRelative === ".github/agentify-task-policy.json"
      && options.taskPolicyConfiguration
      ? `${JSON.stringify(options.taskPolicyConfiguration, null, 2)}\n`
      : undefined;
    writes.push(copyManaged(source, destination, {
      content: policyContent,
      knownManaged: options.knownManagedPaths?.has(portableRelative) === true,
    }));
  }
  for (const runtime of bundledRuntimes) {
    const relative = path.relative(options.cwd, runtime.destination).split(path.sep).join("/");
    writes.push(copyManaged(runtime.source, runtime.destination, {
      knownManaged: options.knownManagedPaths?.has(relative) === true,
    }));
  }
  return writes;
}
