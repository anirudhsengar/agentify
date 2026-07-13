import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

interface PackageJson {
  files?: string[];
  exports?: Record<string, string>;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const SOURCE_ROOT = path.join(REPO_ROOT, "src");

const EXPERIMENTAL_DIRECTORY_PREFIXES = [
  "src/core/webhook/",
  "src/core/aiw/",
  "src/core/orchestrator/",
] as const;

const EXPERIMENTAL_FILES = new Set([
  "src/core/agent-expert.ts",
  "src/core/expert-outcome.ts",
  "src/core/release-qualification.ts",
  "src/core/workflow-afk.ts",
  "src/core/scripts/score-expert-outcomes.ts",
  "src/core/scripts/qualify-release-evidence.ts",
]);

const NEUTRAL_EXCEPTIONS_INSIDE_EXPERIMENTAL_DIRECTORIES = new Set([
  "src/core/orchestrator/workflow-spec.ts",
]);

const NEUTRAL_SHARED_FILES = [
  "src/core/types.ts",
  "src/core/agentify-config.ts",
  "src/core/models/resolver.ts",
  "src/core/pi-sdk-runtime.ts",
  "src/core/security/execution-policy.ts",
  "src/core/audit/defense-hook.ts",
  "src/core/audit/log.ts",
  "src/core/audit/state.ts",
  "src/core/orchestrator/workflow-spec.ts",
] as const;

const EXPERIMENTAL_COMPOSITION_ROOTS = [
  "src/core/webhook/index.ts",
  "src/core/aiw/index.ts",
  "src/core/orchestrator/host.ts",
  "src/core/orchestrator/worker.ts",
  "src/core/agent-expert.ts",
] as const;

const SUPPORTED_SUBCOMMANDS = ["login", "logout", "models", "revert"] as const;

function normalizeRepoPath(value: string): string {
  return value.split(path.sep).join("/");
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf-8");
}

function discoverTypeScriptFiles(): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push(normalizeRepoPath(path.relative(REPO_ROOT, absolute)));
      }
    }
  };
  visit(SOURCE_ROOT);
  return files.sort((left, right) => left.localeCompare(right));
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const staticImport = /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/gs;
  const dynamicImport = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(staticImport)) specifiers.push(match[1]);
  for (const match of source.matchAll(dynamicImport)) specifiers.push(match[1]);
  return specifiers;
}

function resolveLocalImport(
  importer: string,
  specifier: string,
  sourceFiles: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const importerDirectory = path.dirname(path.join(REPO_ROOT, importer));
  const base = path.resolve(importerDirectory, specifier);
  const candidates = [base, `${base}.ts`, path.join(base, "index.ts")];
  for (const candidate of candidates) {
    const relative = normalizeRepoPath(path.relative(REPO_ROOT, candidate));
    if (sourceFiles.has(relative)) return relative;
  }
  return null;
}

function buildImportGraph(): Map<string, Set<string>> {
  const files = discoverTypeScriptFiles();
  const sourceFiles = new Set(files);
  const graph = new Map<string, Set<string>>();
  for (const file of files) {
    const dependencies = new Set<string>();
    for (const specifier of importSpecifiers(read(file))) {
      const resolved = resolveLocalImport(file, specifier, sourceFiles);
      if (resolved !== null) dependencies.add(resolved);
    }
    graph.set(file, dependencies);
  }
  return graph;
}

function isExperimentalModule(relativePath: string): boolean {
  if (NEUTRAL_EXCEPTIONS_INSIDE_EXPERIMENTAL_DIRECTORIES.has(relativePath)) return false;
  return EXPERIMENTAL_FILES.has(relativePath)
    || EXPERIMENTAL_DIRECTORY_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

function collectReachable(graph: ReadonlyMap<string, ReadonlySet<string>>, entry: string): Set<string> {
  const reachable = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || reachable.has(current)) continue;
    reachable.add(current);
    for (const dependency of graph.get(current) ?? []) pending.push(dependency);
  }
  return reachable;
}

test("supported CLI reachability excludes experimental composition and runtime modules", () => {
  const graph = buildImportGraph();
  const reachable = collectReachable(graph, "src/cli.ts");
  const violations = [...reachable].filter(isExperimentalModule).sort();
  assert.deepEqual(violations, []);
  assert.ok(
    reachable.has("src/core/orchestrator/workflow-spec.ts"),
    "the neutral workflow contract exception must remain explicit and exercised",
  );
});

test("neutral shared infrastructure does not depend on experimental modules", () => {
  const graph = buildImportGraph();
  for (const neutralFile of NEUTRAL_SHARED_FILES) {
    assert.ok(graph.has(neutralFile), `${neutralFile} must exist and be scanned`);
    const violations = [...(graph.get(neutralFile) ?? [])].filter(isExperimentalModule).sort();
    assert.deepEqual(
      violations,
      [],
      `${neutralFile} must not depend on experimental composition or runtime modules`,
    );
  }
});

test("experimental composition roots retain an explicit designation", () => {
  for (const root of EXPERIMENTAL_COMPOSITION_ROOTS) {
    assert.equal(
      isExperimentalModule(root),
      true,
      `${root} must remain in the machine-enforced experimental classification`,
    );
  }
  for (const sourceMarkedRoot of ["src/core/webhook/index.ts", "src/core/aiw/index.ts"]) {
    assert.match(
      read(sourceMarkedRoot),
      /@experimental\b/,
      `${sourceMarkedRoot} must retain its source-level @experimental marker`,
    );
  }
});

test("orchestrator owns the communications transport", () => {
  const graph = buildImportGraph();
  const commsPrefix = "src/core/orchestrator/comms/";

  assert.equal(
    fs.existsSync(path.join(REPO_ROOT, "src/core/coms")),
    false,
    "the separate top-level communications directory must remain removed",
  );
  for (const modulePath of [
    `${commsPrefix}types.ts`,
    `${commsPrefix}registry.ts`,
    `${commsPrefix}server.ts`,
  ]) {
    assert.ok(graph.has(modulePath), `${modulePath} must remain orchestrator-owned`);
  }

  const externalConsumers = [...graph.entries()]
    .filter(([importer, dependencies]) =>
      !importer.startsWith(commsPrefix)
      && [...dependencies].some((dependency) => dependency.startsWith(commsPrefix)))
    .map(([importer]) => importer)
    .sort((left, right) => left.localeCompare(right));

  assert.deepEqual(externalConsumers, ["src/core/orchestrator/worker.ts"]);
});

test("public CLI command inventory remains restricted to supported utilities", () => {
  const commands = read("src/core/cli-commands.ts");
  const declaration = commands.match(/SUBCOMMAND_NAMES\s*=\s*\[([^\]]+)\]/s);
  assert.ok(declaration, "SUBCOMMAND_NAMES declaration must remain statically inspectable");
  const names = [...declaration[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
  assert.deepEqual(names, [...SUPPORTED_SUBCOMMANDS]);
});

test("package and build surfaces cannot expose experimental source roots", () => {
  const packageJson = JSON.parse(read("package.json")) as PackageJson;
  assert.deepEqual(packageJson.exports, { "./package.json": "./package.json" });
  assert.ok(!(packageJson.files ?? []).includes("src"), "raw src must remain unpublished");

  const build = read("scripts/build.mjs");
  assert.match(build, /entryPoints:\s*\[path\.join\(repoRoot, "src", "cli\.ts"\)\]/);
  const copySources = [...build.matchAll(
    /path\.join\(repoRoot,\s*"src",\s*"core",\s*([^\)]*)\)/g,
  )].map((match) => [...match[1].matchAll(/"([^"]+)"/g)].map((segment) => segment[1]));
  assert.deepEqual(copySources, [
    ["audit", "prompts"],
    ["orchestrator", "workflows"],
  ]);
});

test("public documentation contains no package-internal import examples", () => {
  const documentationFiles = [
    "README.md",
    "AGENTS.md",
    "CONTRIBUTING.md",
    ...fs.readdirSync(path.join(REPO_ROOT, "docs"), { recursive: true })
      .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".md"))
      .map((entry) => normalizeRepoPath(path.join("docs", entry))),
  ];
  const internalImport = /(?:from\s+|import\s*\(|require\s*\()\s*["'`]agentify\/(?:src|dist|core)\//;
  for (const documentationFile of documentationFiles) {
    assert.doesNotMatch(
      read(documentationFile),
      internalImport,
      `${documentationFile} must not present package-internal paths as supported imports`,
    );
  }
});
