/**
 * Exhaustive installer/build-system edge-case campaign.
 * Synthetic temp repos exercise discovery blockers and command selection.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverRepositoryCommands } from "../../src/core/installer/command-discovery.ts";
import type {
  InstallerBlocker,
  InstallerProcessRequest,
  InstallerProcessResult,
  InstallerProcessRunner,
} from "../../src/core/installer/contracts.ts";
import { selectModelForRole } from "../../src/core/models/resolver.ts";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AgentifyConfig } from "../../src/core/types.ts";

function ok(stdout = ""): InstallerProcessResult {
  return { status: 0, stdout, stderr: "", timedOut: false, errorMessage: null };
}

function fakeRunner(cwd: string): InstallerProcessRunner {
  return {
    run(request: InstallerProcessRequest): InstallerProcessResult {
      const key = `${request.program} ${request.args.join(" ")}`;
      if (key === "git rev-parse --show-toplevel") return ok(cwd);
      return ok("passed\n");
    },
  };
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeRepo(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
}

function hasBlocker(blockers: InstallerBlocker[], code: string): boolean {
  return blockers.some((entry) => entry.code === code);
}

function stubModel(provider: string, id: string): Model<Api> {
  return {
    id,
    name: id,
    api: "anthropic-messages",
    provider,
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 8000,
  } as unknown as Model<Api>;
}

function stubRegistry(models: ReadonlyArray<Model<Api>>): ModelRegistry {
  return {
    find: (provider: string, id: string) =>
      models.find((m) => m.provider === provider && m.id === id),
    getAvailable: () => [...models],
    getAll: () => [...models],
  } as unknown as ModelRegistry;
}

// --- Node.js edge cases ---

async function nodeOnlyCheckScript(): Promise<void> {
  const cwd = tempDir("edge-node-check-");
  try {
    writeRepo(cwd, {
      "package.json": JSON.stringify({ scripts: { check: "node --test" } }),
      "package-lock.json": "{}",
    });
    const { blockers, commands } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.equal(blockers.length, 0, "check is a recognized test script alias");
    assert.ok(commands.some((c) => c.kind === "test" && c.argv.join(" ") === "npm run check"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function nodeUnsafeDatabaseUrl(): Promise<void> {
  const cwd = tempDir("edge-node-unsafe-db-");
  try {
    writeRepo(cwd, {
      "package.json": JSON.stringify({
        scripts: { test: "DATABASE_URL=postgres://prod node --test" },
      }),
      "package-lock.json": "{}",
    });
    const { blockers, commands } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.ok(commands.some((c) => c.assessment === "unsafe"));
    assert.ok(hasBlocker(blockers, "unsafe_production_credentials"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function nodeDeployOnly(): Promise<void> {
  const cwd = tempDir("edge-node-deploy-");
  try {
    writeRepo(cwd, {
      "package.json": JSON.stringify({ scripts: { test: "npm run deploy" } }),
      "package-lock.json": "{}",
    });
    const { blockers } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.ok(hasBlocker(blockers, "unsafe_network_or_deployment"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function nodeMissingLockfileWithDeps(): Promise<void> {
  const cwd = tempDir("edge-node-nolock-");
  try {
    writeRepo(cwd, {
      "package.json": JSON.stringify({
        dependencies: { lodash: "^4.0.0" },
        scripts: { test: "node --test" },
      }),
    });
    const { blockers } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.ok(hasBlocker(blockers, "missing_dependency_lock"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function nodePnpmLock(): Promise<void> {
  const cwd = tempDir("edge-node-pnpm-");
  try {
    writeRepo(cwd, {
      "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
      "pnpm-lock.yaml": "lockfileVersion: 6\n",
    });
    const { commands } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.ok(commands.some((c) => c.argv.join(" ") === "pnpm install --frozen-lockfile"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function nodeYarnLock(): Promise<void> {
  const cwd = tempDir("edge-node-yarn-");
  try {
    writeRepo(cwd, {
      "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
      "yarn.lock": "# yarn lockfile v1\n",
    });
    const { commands } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.ok(commands.some((c) => c.argv.join(" ") === "yarn install --frozen-lockfile"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function nodeEmptyScripts(): Promise<void> {
  const cwd = tempDir("edge-node-empty-");
  try {
    writeRepo(cwd, { "package.json": JSON.stringify({ scripts: {} }) });
    const { blockers } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.ok(hasBlocker(blockers, "missing_deterministic_validation"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function nodePrecedenceOverMakefile(): Promise<void> {
  const cwd = tempDir("edge-node-make-");
  try {
    writeRepo(cwd, {
      "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
      "package-lock.json": "{}",
      "Makefile": "test:\n\techo make-test\n",
    });
    const { manifest, commands } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.equal(manifest?.path, "package.json");
    assert.ok(commands.some((c) => c.argv.join(" ") === "npm run test"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

// --- Python edge cases ---

async function pythonPyprojectNoLock(): Promise<void> {
  const cwd = tempDir("edge-py-nolock-");
  try {
    writeRepo(cwd, {
      "pyproject.toml": "[project]\nname = \"demo\"\ndependencies = [\"pytest\"]\n",
      "tests/test_x.py": "def test_x(): pass\n",
    });
    const { blockers } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.ok(hasBlocker(blockers, "missing_dependency_lock"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function pythonRequirementsOnly(): Promise<void> {
  const cwd = tempDir("edge-py-req-");
  try {
    writeRepo(cwd, {
      "requirements.txt": "pytest\n",
      "tests/test_x.py": "def test_x(): pass\n",
    });
    const { manifest } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.equal(manifest?.path, "requirements.txt");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function pythonMakefileWithPyproject(): Promise<void> {
  const cwd = tempDir("edge-py-make-");
  try {
    writeRepo(cwd, {
      "pyproject.toml": "[project]\nname = \"demo\"\n",
      "uv.lock": "# lock\n",
      "Makefile": "test:\n\techo make-test\n",
    });
    const { commands } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.ok(commands.some((c) => c.argv.join(" ") === "make test"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function pythonUvLockPrecedence(): Promise<void> {
  const cwd = tempDir("edge-py-uv-");
  try {
    writeRepo(cwd, {
      "pyproject.toml": "[project]\nname = \"demo\"\n",
      "uv.lock": "# uv\n",
      "poetry.lock": "# poetry\n",
    });
    const { commands } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.ok(commands.some((c) => c.argv[0] === "uv"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

// --- Rust / Go / Java / Ruby ---

async function rustNoCargoLock(): Promise<void> {
  const cwd = tempDir("edge-rust-nolock-");
  try {
    writeRepo(cwd, {
      "Cargo.toml": "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n",
      "src/main.rs": "fn main() {}\n",
    });
    const { blockers } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.ok(hasBlocker(blockers, "missing_dependency_lock"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function goNoGoSum(): Promise<void> {
  const cwd = tempDir("edge-go-nosum-");
  try {
    writeRepo(cwd, {
      "go.mod": "module example.com/demo\n\ngo 1.22\n",
      "main.go": "package main\n\nfunc main() {}\n",
    });
    const { blockers } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.ok(hasBlocker(blockers, "missing_dependency_lock"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function javaPomXml(): Promise<void> {
  const cwd = tempDir("edge-java-pom-");
  try {
    writeRepo(cwd, {
      "pom.xml": "<project><modelVersion>4.0.0</modelVersion></project>\n",
    });
    const { manifest, commands } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.equal(manifest?.path, "pom.xml");
    assert.ok(commands.some((c) => c.argv.includes("test")));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function javaGradleKts(): Promise<void> {
  const cwd = tempDir("edge-java-gradle-");
  try {
    writeRepo(cwd, {
      "build.gradle.kts": "plugins { java }\n",
    });
    const { manifest, commands } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.equal(manifest?.path, "build.gradle.kts");
    assert.ok(commands.some((c) => c.argv.includes("test")));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function rubyNoGemfileLock(): Promise<void> {
  const cwd = tempDir("edge-ruby-nolock-");
  try {
    writeRepo(cwd, { "Gemfile": "source 'https://rubygems.org'\n" });
    const { blockers } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.ok(hasBlocker(blockers, "missing_dependency_lock"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

// --- Cross-ecosystem ---

async function makefileOnlyNoTestTarget(): Promise<void> {
  const cwd = tempDir("edge-make-notest-");
  try {
    writeRepo(cwd, { "Makefile": "build:\n\techo ok\n" });
    const { blockers } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.ok(hasBlocker(blockers, "missing_deterministic_validation"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function noManifest(): Promise<void> {
  const cwd = tempDir("edge-none-");
  try {
    writeRepo(cwd, { "README.md": "# empty\n" });
    const { blockers } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.ok(hasBlocker(blockers, "unsupported_build_system"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function multiManifestNodeWins(): Promise<void> {
  const cwd = tempDir("edge-multi-");
  try {
    writeRepo(cwd, {
      "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
      "package-lock.json": "{}",
      "pyproject.toml": "[project]\nname = \"demo\"\n",
      "uv.lock": "# lock\n",
    });
    const { manifest } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.equal(manifest?.path, "package.json");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

// --- Resolver/config edge cases ---

async function resolverEmptyModels(): Promise<void> {
  const model = stubModel("openai", "gpt-4o");
  const registry = stubRegistry([model]);
  const config: AgentifyConfig = {
    schemaVersion: 1,
    provider: "openai",
    thinkingLevel: "high",
    models: {},
  };
  const resolved = selectModelForRole(registry, config, "primary");
  assert.ok(resolved);
  assert.equal(resolved.source, "provider-default");
}

async function resolverOnlyExplorerSlot(): Promise<void> {
  const explorer = stubModel("anthropic", "claude-haiku");
  const registry = stubRegistry([explorer]);
  const config: AgentifyConfig = {
    schemaVersion: 1,
    provider: "anthropic",
    thinkingLevel: "high",
    models: { explorer: { provider: "anthropic", model: "claude-haiku" } },
  };
  const resolved = selectModelForRole(registry, config, "explorer");
  assert.ok(resolved);
  assert.equal(resolved.source, "explicit-slot");
}

async function resolverMissingModelsField(): Promise<void> {
  const model = stubModel("openai", "gpt-4o");
  const registry = stubRegistry([model]);
  const config = {
    schemaVersion: 1,
    provider: "openai",
    thinkingLevel: "high",
  } as unknown as AgentifyConfig;
  const resolved = selectModelForRole(registry, config, "primary");
  assert.ok(resolved);
  assert.equal(resolved.source, "provider-default");
}

const tests = [
  { name: "node only check script", fn: nodeOnlyCheckScript },
  { name: "node unsafe DATABASE_URL", fn: nodeUnsafeDatabaseUrl },
  { name: "node deploy-only script", fn: nodeDeployOnly },
  { name: "node missing lockfile with deps", fn: nodeMissingLockfileWithDeps },
  { name: "node pnpm lock", fn: nodePnpmLock },
  { name: "node yarn lock", fn: nodeYarnLock },
  { name: "node empty scripts", fn: nodeEmptyScripts },
  { name: "node precedence over makefile", fn: nodePrecedenceOverMakefile },
  { name: "python pyproject no lock", fn: pythonPyprojectNoLock },
  { name: "python requirements only", fn: pythonRequirementsOnly },
  { name: "python makefile with pyproject", fn: pythonMakefileWithPyproject },
  { name: "python uv lock precedence", fn: pythonUvLockPrecedence },
  { name: "rust no cargo lock", fn: rustNoCargoLock },
  { name: "go no go.sum", fn: goNoGoSum },
  { name: "java pom.xml", fn: javaPomXml },
  { name: "java build.gradle.kts", fn: javaGradleKts },
  { name: "ruby no gemfile lock", fn: rubyNoGemfileLock },
  { name: "makefile only no test target", fn: makefileOnlyNoTestTarget },
  { name: "no manifest", fn: noManifest },
  { name: "multi manifest node wins", fn: multiManifestNodeWins },
  { name: "resolver empty models", fn: resolverEmptyModels },
  { name: "resolver only explorer slot", fn: resolverOnlyExplorerSlot },
  { name: "resolver missing models field", fn: resolverMissingModelsField },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.fn();
    passed += 1;
    console.log(`  ok ${test.name}`);
  } catch (error) {
    console.error(`  FAIL ${test.name}: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) console.error(error.stack);
    process.exit(1);
  }
}
console.log(`edge-case campaign tests passed (${passed}/${tests.length}).`);
