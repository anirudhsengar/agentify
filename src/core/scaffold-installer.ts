import * as fs from "node:fs";
import * as path from "node:path";
import { alongsidePathFor } from "./apply-policy.ts";
import {
  addManagedMarker,
  markerForArtifactPath,
} from "./artifacts/managed-markers.ts";
import type { ArtifactWrite } from "./types.ts";
import type { RepositoryTaskPolicyConfiguration } from "./installer/contracts.ts";
import { isAgentifyOwnedTaskPolicyFile } from "./installer/task-policy.ts";
import { AGENTIFY_INSTALLED_CONTROL_PATHS } from "./artifacts/managed-installation-paths.ts";

const TASK_POLICY_PORTABLE_PATH = ".github/agentify-task-policy.json";
const RUNTIME_LOADER_PORTABLE_PATH = ".github/agentify/runtime-loader.mjs";
const AGENTS_PORTABLE_PATH = "AGENTS.md";
const SETUP_PORTABLE_PATH = "SETUP.md";
const RUNTIME_VERSION_PLACEHOLDER = "__AGENTIFY_RUNTIME_VERSION__";

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

function packageVersion(packageRoot: string): string {
  const metadata = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  ) as { name?: unknown; version?: unknown };
  if (metadata.name !== "@anirudhsengar/agentify") {
    throw new Error("Agentify package root has an unexpected package identity");
  }
  if (
    typeof metadata.version !== "string"
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version)
  ) {
    throw new Error("Agentify package root has no valid semantic version");
  }
  return metadata.version;
}

function replaceDocumentationSection(
  content: string,
  startHeading: string,
  endHeading: string,
  replacement: string,
): string {
  const start = content.indexOf(`${startHeading}\n`);
  const end = content.indexOf(`${endHeading}\n`, start + startHeading.length);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`Agentify scaffold documentation is missing ${startHeading}`);
  }
  return `${content.slice(0, start)}${replacement.trimEnd()}\n\n${content.slice(end)}`;
}

function readinessAwareDocumentation(
  source: string,
  portableRelative: string,
  configuration: RepositoryTaskPolicyConfiguration,
): string {
  const content = fs.readFileSync(source, "utf8");
  if (configuration.configured) return content;

  if (portableRelative === AGENTS_PORTABLE_PATH) {
    const readyGuidance = [
      "Use GitHub issues with the `agentify:queue` label to request implementation.",
      "Agentify plans with a read-only planner and repository-specific read-only",
      "specialists, grants exactly one builder bounded write authority, validates",
      "deterministically, obtains an role-separated automated read-only review, and",
      "stops at an unmerged draft pull request.",
    ].join("\n");
    const disabledGuidance = [
      "Issue execution is disabled because the trusted repository task policy is not",
      "configured. The orchestrator and specialists are available only for analysis.",
      "Resolve the installer blockers and rerun Agentify verification before adding",
      "the `agentify:queue` label or expecting a draft pull request.",
    ].join("\n");
    if (!content.includes(readyGuidance)) {
      throw new Error("Agentify AGENTS.md scaffold is missing its managed work guidance");
    }
    return content.replace(readyGuidance, disabledGuidance);
  }

  if (portableRelative === SETUP_PORTABLE_PATH) {
    const readyIntroduction = [
      "Agentify is installed once for this repository. Authorized GitHub issues are",
      "the normal work interface; do not rerun the CLI for ordinary tasks.",
    ].join("\n");
    const disabledIntroduction = [
      "Agentify's repository analysis and specialist memory are installed, but issue",
      "execution is disabled because the trusted repository task policy is not",
      "configured. Do not queue work until the installer reports readiness `ready`.",
    ].join("\n");
    if (!content.includes(readyIntroduction)) {
      throw new Error("Agentify SETUP.md scaffold is missing its managed introduction");
    }
    return replaceDocumentationSection(
      content.replace(readyIntroduction, disabledIntroduction),
      "## Queue work",
      "## Credentials",
      [
        "## Issue execution disabled",
        "",
        "The `agentify:queue` label will not start authorized work in this state.",
        "Resolve the installer blockers—typically a missing toolchain, failed repository",
        "validation, or incomplete policy attestation—and rerun Agentify verification.",
        "When `.github/agentify-task-policy.json` becomes configured, Agentify rewrites",
        "this guide with the issue workflow and trusted maintainer commands.",
      ].join("\n"),
    );
  }

  return content;
}

function contentFor(
  source: string,
  portableRelative: string,
  options: InstallScaffoldRuntimeOptions,
): string | undefined {
  if (portableRelative === TASK_POLICY_PORTABLE_PATH && options.taskPolicyConfiguration) {
    return `${JSON.stringify(options.taskPolicyConfiguration, null, 2)}\n`;
  }
  if (
    options.taskPolicyConfiguration
    && (portableRelative === AGENTS_PORTABLE_PATH || portableRelative === SETUP_PORTABLE_PATH)
  ) {
    return readinessAwareDocumentation(
      source,
      portableRelative,
      options.taskPolicyConfiguration,
    );
  }
  if (portableRelative === RUNTIME_LOADER_PORTABLE_PATH) {
    const sourceContent = fs.readFileSync(source, "utf8");
    if (!sourceContent.includes(RUNTIME_VERSION_PLACEHOLDER)) {
      throw new Error("Agentify runtime loader is missing its version placeholder");
    }
    return sourceContent.replaceAll(
      RUNTIME_VERSION_PLACEHOLDER,
      packageVersion(options.packageRoot),
    );
  }
  return undefined;
}

export function installScaffoldRuntime(options: InstallScaffoldRuntimeOptions): ArtifactWrite[] {
  const scaffoldRoot = path.join(options.packageRoot, "scaffold");
  if (!fs.existsSync(scaffoldRoot)) {
    return [];
  }

  const writes: ArtifactWrite[] = [];
  for (const source of listFiles(scaffoldRoot)) {
    const relative = path.relative(scaffoldRoot, source);
    const portableRelative = relative.split(path.sep).join("/");
    if (!AGENTIFY_INSTALLED_CONTROL_PATHS.has(portableRelative)) continue;
    const destination = path.join(options.cwd, relative);
    writes.push(copyManaged(source, destination, {
      content: contentFor(source, portableRelative, options),
      knownManaged: options.knownManagedPaths?.has(portableRelative) === true
        || (portableRelative === TASK_POLICY_PORTABLE_PATH && isAgentifyOwnedTaskPolicyFile(destination)),
    }));
  }
  return writes;
}
