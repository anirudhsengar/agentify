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
    "docs/architecture/dependency-compatibility-matrix.md",
    "docs/architecture/experimental-runtime-decisions.md",
    "docs/build-and-package.md",
    "docs/experimental-surfaces.md",
    "docs/refactors/audit-schema-domain-migration.md",
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

test("experimental runtime decision record covers every subsystem and approved action", () => {
  const decisions = read("docs/architecture/experimental-runtime-decisions.md");
  for (const decisionId of ["ERD-001", "ERD-002", "ERD-003", "ERD-004", "ERD-005"]) {
    assert.ok(decisions.includes(decisionId), `decision record must include ${decisionId}`);
  }
  for (const subsystem of ["Webhook", "AIW", "Orchestrator", "Communications", "Agent Expert"]) {
    assert.ok(decisions.includes(subsystem), `decision record must include ${subsystem}`);
  }
  assert.equal((decisions.match(/\*\*Retain internal in place\.\*\*/g) ?? []).length, 4);
  assert.equal((decisions.match(/\*\*Relocate internally\.\*\*/g) ?? []).length, 1);
  assert.match(decisions, /Issue #48/);
  assert.match(decisions, /No subsystem is approved for graduation, archive, or removal/);
});

test("dependency compatibility matrix preserves the upgrade gate and group ownership", () => {
  const matrix = read("docs/architecture/dependency-compatibility-matrix.md");

  for (const packageName of [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "typebox",
    "typescript",
    "@types/node",
    "esbuild",
    "tsx",
    "@smithy/util-buffer-from",
  ]) {
    assert.ok(matrix.includes(packageName), `compatibility matrix must include ${packageName}`);
  }

  for (const issueNumber of [60, 61, 62, 63, 64, 65]) {
    assert.ok(matrix.includes(`#${issueNumber}`), `compatibility matrix must include #${issueNumber}`);
  }

  assert.match(matrix, /Completed groups may change only their owned manifest, lockfile, configuration, documentation, and characterization surfaces/);
  assert.match(matrix, /TypeScript 6\.0\.3/);
  assert.match(matrix, /TypeBox.*1\.3\.6/s);
  assert.match(matrix, /Pi runtime pair.*0\.80\.7/s);
  assert.match(matrix, /make no Node 26 support claim/);
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

test("official npm package identity remains scoped while the CLI command stays stable", () => {
  const packageJson = readPackageJson();
  const readme = read("README.md");
  const releaseWorkflow = read(".github/workflows/release-publish.yml");

  assert.equal(packageJson.name, "@anirudhsengar/agentify");
  assert.deepEqual(packageJson.bin, { agentify: "./bin/agentify.js" });
  assert.match(readme, /npm install -g @anirudhsengar\/agentify/);
  assert.match(readme, /npx @anirudhsengar\/agentify/);
  assert.match(readme, /https:\/\/www\.npmjs\.com\/package\/@anirudhsengar\/agentify/);
  assert.doesNotMatch(readme, /npm install -g agentify|npx agentify/);
  assert.match(releaseWorkflow, /https:\/\/www\.npmjs\.com\/package\/@anirudhsengar\/agentify/);
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
  assert.ok(scripts["test:maintenance"]?.includes("schema-boundaries.test.ts"));
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
    "Audit schema ownership and dependency direction",
    "Webhook boundary",
    "Build and release boundary",
  ]) {
    assert.ok(architecture.includes(concept), `architecture must document ${concept}`);
  }
});

test("audit schema algorithms preserve the declaration-free façade boundary", () => {
  const schema = read("src/core/audit/schema.ts");
  const composition = read("src/core/audit/schema/codebase-map.ts");
  const parameters = read("src/core/audit/schema/write-map-params.ts");
  const algorithmPaths = [
    "src/core/audit/coverage.ts",
    "src/core/audit/map-defaults.ts",
    "src/core/audit/schema-compatibility.ts",
  ];

  assert.doesNotMatch(schema, /from ["']typebox(?:\/[^"']*)?["']/);
  assert.doesNotMatch(schema, /\bType\s*\./);
  assert.match(composition, /import \{ Type, type Static \} from "typebox"/);
  assert.match(parameters, /import \{ Type, type Static \} from "typebox"/);
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

test("schema domain ownership is documented for maintainers", () => {
  const architecture = read("docs/architecture.md");
  const agents = read("AGENTS.md");
  const contributing = read("CONTRIBUTING.md");

  for (const moduleName of [
    "primitives.ts",
    "codebase-map.ts",
    "write-map-params.ts",
    "coverage.ts",
    "map-defaults.ts",
    "schema-compatibility.ts",
  ]) {
    assert.ok(architecture.includes(`\`${moduleName}\``));
    assert.ok(agents.includes(`\`${moduleName}\``));
    assert.ok(contributing.includes(`\`${moduleName}\``));
  }
  assert.ok(architecture.includes("downward"));
  assert.ok(architecture.includes("Golden fingerprint"));
  assert.ok(agents.includes("tests/maintenance/schema-boundaries.test.ts"));
  assert.ok(contributing.includes("Golden fixture drift"));
});
