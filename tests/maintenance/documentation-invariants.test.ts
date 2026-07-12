import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

interface PackageJson {
  name: string;
  bin?: Record<string, string>;
  files?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  exports?: Record<string, string>;
}

interface TypeScriptConfig {
  compilerOptions?: {
    strict?: boolean;
    noUnusedLocals?: boolean;
    noUnusedParameters?: boolean;
  };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf-8");
}

function readPackageJson(): PackageJson {
  return JSON.parse(read("package.json")) as PackageJson;
}

test("changelog keeps a structured Unreleased section", () => {
  const changelog = read("CHANGELOG.md");
  assert.match(changelog, /^# Changelog/m);
  assert.match(changelog, /^## \[Unreleased\]$/m);
  for (const heading of ["Added", "Changed", "Fixed"]) {
    assert.match(changelog, new RegExp(`^### ${heading}$`, "m"));
  }
});

test("strict TypeScript and unused-code checks remain enabled", () => {
  const config = JSON.parse(read("tsconfig.json")) as TypeScriptConfig;
  assert.equal(config.compilerOptions?.strict, true);
  assert.equal(config.compilerOptions?.noUnusedLocals, true);
  assert.equal(config.compilerOptions?.noUnusedParameters, true);
});

test("documentation index covers every maintained trust boundary", () => {
  const index = read("docs/README.md");
  for (const documentedPath of [
    "docs/architecture.md",
    "docs/build-and-package.md",
    "docs/experimental-surfaces.md",
    "docs/refactors/modernization-baseline.md",
    "docs/refactors/runtime-reachability.md",
    "docs/state-lifecycle.md",
    "docs/webhook-security.md",
    "docs/release-process.md",
    "SECURITY.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "AGENTS.md",
  ]) {
    assert.ok(
      index.includes(`\`${documentedPath}\``),
      `documentation index must reference ${documentedPath}`,
    );
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, documentedPath)),
      `${documentedPath} must exist`,
    );
  }
});

test("package guidance files referenced by shipped docs are published", () => {
  const packageJson = readPackageJson();
  const files = new Set(packageJson.files ?? []);

  for (const requiredPath of [
    "bin",
    "dist",
    "scaffold",
    "docs",
    "README.md",
    "SECURITY.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "AGENTS.md",
  ]) {
    assert.ok(files.has(requiredPath), `package files allowlist must include ${requiredPath}`);
  }

  assert.ok(!files.has("src"), "raw src must remain outside the npm artifact");
  assert.deepEqual(packageJson.exports, { "./package.json": "./package.json" });
});

test("binary and scripts preserve the compiled package boundary", () => {
  const packageJson = readPackageJson();
  const binary = read("bin/agentify.js");
  const scripts = packageJson.scripts ?? {};

  assert.equal(packageJson.bin?.agentify, "./bin/agentify.js");
  assert.match(binary, /from "\.\.\/dist\/cli\.js"/);
  assert.doesNotMatch(binary, /src\/cli\.ts|\bjiti\b/);

  assert.equal(scripts.build, "node scripts/build.mjs");
  assert.equal(scripts.prepack, "npm run build");
  assert.ok(scripts["test:package"]?.includes("installed-cli-smoke.mjs"));
  for (const focusedScript of ["test:parity:cli", "test:parity:generated", "test:parity:state"]) {
    assert.ok(scripts[focusedScript]?.includes("tests/parity/"));
    assert.ok(scripts["test:parity"]?.includes(focusedScript));
  }
  assert.ok(scripts["test:parity"]?.includes("test:package"));
  assert.ok(scripts["release:check"]?.includes("test:package"));
});

test("dependency policy documentation matches package metadata", () => {
  const packageJson = readPackageJson();
  const agents = read("AGENTS.md");
  const contributing = read("CONTRIBUTING.md");
  const buildDocumentation = read("docs/build-and-package.md");

  for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
    assert.ok(agents.includes(`\`${dependency}\``), `AGENTS.md must classify ${dependency}`);
    assert.ok(
      contributing.includes(`\`${dependency}\``),
      `CONTRIBUTING.md must classify ${dependency}`,
    );
  }

  for (const buildDependency of ["esbuild", "tsx", "typescript"]) {
    assert.ok(
      Object.keys(packageJson.devDependencies ?? {}).some(
        (dependency) => dependency.toLowerCase() === buildDependency.toLowerCase(),
      ),
      `${buildDependency} must remain a development dependency`,
    );
  }

  assert.ok(buildDocumentation.includes("`scripts/build.mjs`"));
  assert.ok(buildDocumentation.includes("excludes raw `src/`"));
});

test("architecture documentation names the enforced safety mechanisms", () => {
  const architecture = read("docs/architecture.md");
  for (const concept of [
    "Capability security",
    "State transaction",
    "Artifact ownership and rollback",
    "Webhook boundary",
    "Build and release boundary",
  ]) {
    assert.ok(architecture.includes(concept), `architecture must document ${concept}`);
  }
});

test("audit schema algorithms preserve the TypeBox ownership boundary", () => {
  const schema = read("src/core/audit/schema.ts");
  const algorithmPaths = [
    "src/core/audit/coverage.ts",
    "src/core/audit/map-defaults.ts",
    "src/core/audit/schema-compatibility.ts",
  ];

  assert.match(schema, /import \{ Type, type Static \} from "typebox"/);
  for (const algorithmPath of algorithmPaths) {
    const source = read(algorithmPath);
    assert.doesNotMatch(source, /from ["']typebox(?:\/[^"']*)?["']/);
    assert.doesNotMatch(source, /from ["']@earendil-works\/pi-ai["']/);
    assert.doesNotMatch(source, /\bType\s*\./);
  }

  for (const exportedName of [
    "assessCoverageClosure",
    "extractCoverageSummary",
    "applyMapDefaults",
    "resolveLifecyclePresence",
    "resolveFrameworks",
    "resolveApiContracts",
    "resolveSyncedTypes",
    "resolveProductionCredentials",
  ]) {
    assert.ok(schema.includes(exportedName), `schema façade must re-export ${exportedName}`);
  }
});

test("schema algorithm ownership is documented for maintainers", () => {
  const architecture = read("docs/architecture.md");
  const agents = read("AGENTS.md");
  const contributing = read("CONTRIBUTING.md");

  for (const moduleName of ["coverage.ts", "map-defaults.ts", "schema-compatibility.ts"]) {
    assert.ok(architecture.includes(`\`${moduleName}\``));
    assert.ok(agents.includes(`\`${moduleName}\``));
  }
  assert.ok(contributing.includes("adjacent algorithm modules"));
  assert.ok(architecture.includes("sole owner"));
  assert.ok(architecture.includes("Golden schema fingerprints"));
});
