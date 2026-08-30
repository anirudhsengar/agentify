import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverRepositoryCommands } from "../../src/core/installer/command-discovery.ts";
import {
  createRepositoryValidationApproval,
  repositoryValidationApprovalCurrent,
} from "../../src/core/installer/task-policy.ts";
import type {
  InstallerProcessRequest,
  InstallerProcessResult,
  InstallerProcessRunner,
} from "../../src/core/installer/contracts.ts";
import { inspectRepositoryForInstallation } from "../../src/core/installer/repository-inspection.ts";

function ok(stdout = ""): InstallerProcessResult {
  return { status: 0, stdout, stderr: "", timedOut: false, errorMessage: null };
}

function fakeRunner(cwd: string, succeed = true): InstallerProcessRunner {
  return {
    run(request: InstallerProcessRequest): InstallerProcessResult {
      const key = `${request.program} ${request.args.join(" ")}`;
      if (key === "git rev-parse --show-toplevel") return ok(cwd);
      if (key === "git rev-parse --verify HEAD^{commit}") return ok("a".repeat(40));
      if (key === "git branch --show-current") return ok("main\n");
      if (key === "git remote get-url origin") return ok("git@github.com:owner/repo.git\n");
      if (key === "git ls-files -z") {
        return ok("src/main.py\0tests/test_main.py\0pyproject.toml\0uv.lock\0");
      }
      if (key === "gh --version" || key === "gh auth status") return ok();
      if (key === "gh api repos/owner/repo") {
        return ok(JSON.stringify({
          id: 123,
          full_name: "owner/repo",
          default_branch: "main",
          permissions: { admin: true, push: true, pull: true },
        }));
      }
      if (key === "gh api user") return ok(JSON.stringify({ login: "maintainer" }));
      if (key === "gh api repos/owner/repo/branches/main/protection") return ok("{}");
      if (key.startsWith("npm run ") || key.startsWith("pytest") || key.startsWith("uv ")
        || key.startsWith("cargo ") || key.startsWith("go ") || key.startsWith("bundle ")
        || key.startsWith("make ") || key.startsWith("mvn") || key.startsWith("./mvnw")
        || key.startsWith("gradle") || key.startsWith("./gradlew") || key.startsWith("gradlew.bat")) {
        return succeed ? ok("passed\n") : { status: 1, stdout: "", stderr: "failed", timedOut: false, errorMessage: null };
      }
      return succeed ? ok("passed\n") : { status: 1, stdout: "", stderr: "failed", timedOut: false, errorMessage: null };
    },
  };
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

async function testPythonPyprojectDiscovery(): Promise<void> {
  const cwd = tempDir("agentify-build-python-");
  try {
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "tests"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "main.py"), "def add(a, b):\n    return a + b\n");
    fs.writeFileSync(path.join(cwd, "tests", "test_main.py"), "def test_add():\n    assert 1 + 1 == 2\n");
    fs.writeFileSync(path.join(cwd, "pyproject.toml"), [
      "[project]",
      "name = \"demo\"",
      "dependencies = [\"pytest\"]",
      "",
      "[tool.pytest.ini_options]",
      "testpaths = [\"tests\"]",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(cwd, "uv.lock"), "# lock\n");
    const { commands, blockers, manifest } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.equal(manifest?.path, "pyproject.toml");
    assert.equal(manifest?.ecosystem, "python");
    assert.ok(commands.some((command) => command.kind === "test" && command.argv.includes("pytest")));
    assert.equal(blockers.length, 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testRustCargoDiscovery(): Promise<void> {
  const cwd = tempDir("agentify-build-rust-");
  try {
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "Cargo.toml"), "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n");
    fs.writeFileSync(path.join(cwd, "Cargo.lock"), "# lock\n");
    fs.writeFileSync(path.join(cwd, "src", "main.rs"), "fn main() {}\n");
    const { commands, manifest } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.equal(manifest?.path, "Cargo.toml");
    assert.ok(commands.some((command) => command.argv[0] === "cargo" && command.argv[1] === "test"));
    assert.ok(commands.some((command) => command.argv[0] === "cargo" && command.argv[1] === "check"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testGoModuleDiscovery(): Promise<void> {
  const cwd = tempDir("agentify-build-go-");
  try {
    fs.writeFileSync(path.join(cwd, "go.mod"), "module example.com/demo\n\ngo 1.22\n");
    fs.writeFileSync(path.join(cwd, "go.sum"), "demo checksum\n");
    fs.writeFileSync(path.join(cwd, "main.go"), "package main\n\nfunc main() {}\n");
    const { commands, manifest } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.equal(manifest?.path, "go.mod");
    assert.ok(commands.some((command) => command.argv.join(" ") === "go test ./..."));
    assert.ok(commands.some((command) => command.argv.join(" ") === "go vet ./..."));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testMakefileDiscovery(): Promise<void> {
  const cwd = tempDir("agentify-build-make-");
  try {
    fs.writeFileSync(path.join(cwd, "Makefile"), "test:\n\t@echo ok\n\ncheck:\n\t@echo ok\n");
    const { commands, manifest } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.equal(manifest?.path, "Makefile");
    assert.ok(commands.some((command) => command.argv.join(" ") === "make test"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testPythonValidationApprovalBinding(): Promise<void> {
  const cwd = tempDir("agentify-build-python-approval-");
  try {
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "tests"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "main.py"), "x = 1\n");
    fs.writeFileSync(path.join(cwd, "tests", "test_main.py"), "def test_x():\n    assert True\n");
    fs.writeFileSync(path.join(cwd, "pyproject.toml"), "[project]\nname = \"demo\"\ndependencies = [\"pytest\"]\n");
    fs.writeFileSync(path.join(cwd, "uv.lock"), "# lock\n");
    const runner = fakeRunner(cwd);
    const preflight = inspectRepositoryForInstallation({ cwd, runner, runValidation: true });
    const approval = createRepositoryValidationApproval({
      cwd,
      preflight,
      approvedBy: "maintainer",
      approvedAt: "2026-08-05T00:00:00.000Z",
    });
    assert.equal(approval.manifest_path, "pyproject.toml");
    assert.equal(approval.lockfile?.path, "uv.lock");
    assert.equal(repositoryValidationApprovalCurrent({ cwd, preflight, approval }), true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testShellScriptDiscovery(): Promise<void> {
  const cwd = tempDir("agentify-build-shell-");
  try {
    fs.writeFileSync(path.join(cwd, "compile.sh"), "#!/usr/bin/env bash\nset -e\necho compiled\n");
    fs.chmodSync(path.join(cwd, "compile.sh"), 0o755);
    fs.writeFileSync(path.join(cwd, "test.sh"), "#!/usr/bin/env bash\nset -e\necho tested\n");
    fs.chmodSync(path.join(cwd, "test.sh"), 0o755);
    const { commands, manifest } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.equal(manifest?.path, "compile.sh");
    assert.equal(manifest?.ecosystem, "shell");
    assert.ok(commands.some((command) => command.kind === "build" && command.argv.join(" ") === "bash compile.sh"));
    assert.ok(commands.some((command) => command.kind === "test" && command.argv.join(" ") === "bash test.sh"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testShellScriptMarkedUnsafeWhenNetworkAccessed(): Promise<void> {
  const cwd = tempDir("agentify-build-shell-unsafe-");
  try {
    fs.writeFileSync(
      path.join(cwd, "build.sh"),
      "#!/usr/bin/env bash\ncurl -s https://example.invalid > /dev/null\n",
    );
    fs.chmodSync(path.join(cwd, "build.sh"), 0o755);
    const { commands, blockers } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.ok(commands.some((command) => command.kind === "build" && command.assessment === "unsafe"));
    assert.ok(blockers.some((entry) => entry.code === "unsafe_network_or_deployment"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testShellValidationApprovalBinding(): Promise<void> {
  const cwd = tempDir("agentify-build-shell-approval-");
  try {
    fs.writeFileSync(path.join(cwd, "build.sh"), "#!/usr/bin/env bash\necho ok\n");
    fs.chmodSync(path.join(cwd, "build.sh"), 0o755);
    const runner = fakeRunner(cwd);
    const preflight = inspectRepositoryForInstallation({ cwd, runner, runValidation: true });
    const approval = createRepositoryValidationApproval({
      cwd,
      preflight,
      approvedBy: "maintainer",
      approvedAt: "2026-08-05T00:00:00.000Z",
    });
    assert.equal(approval.manifest_path, "build.sh");
    assert.equal(approval.lockfile, null);
    assert.equal(repositoryValidationApprovalCurrent({ cwd, preflight, approval }), true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testUnsupportedRepository(): Promise<void> {
  const cwd = tempDir("agentify-build-none-");
  try {
    fs.writeFileSync(path.join(cwd, "README.md"), "# no build manifest\n");
    const { blockers } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.ok(blockers.some((entry) => entry.code === "unsupported_build_system"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testTrackedNestedPythonTestsOutrankRootBuildOnlyShell(): Promise<void> {
  const cwd = tempDir("agentify-build-nested-python-");
  try {
    fs.writeFileSync(path.join(cwd, "compile.sh"), "#!/usr/bin/env bash\nset -e\necho compiled\n");
    fs.mkdirSync(path.join(cwd, "scripts", "tool", "tests"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "scripts", "tool", "pyproject.toml"), "[project]\nname='tool'\n");
    fs.writeFileSync(
      path.join(cwd, "scripts", "tool", "requirements.txt"),
      "example==1.0 --hash=sha256:" + "a".repeat(64) + "\n",
    );
    fs.writeFileSync(
      path.join(cwd, "scripts", "tool", "tests", "test_tool.py"),
      "from unittest import TestCase\nclass ToolTest(TestCase):\n    def test_tool(self): self.assertTrue(True)\n",
    );
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "fixture");

    const { commands, blockers, manifest } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.equal(manifest?.path, "scripts/tool/pyproject.toml");
    assert.ok(commands.some((command) =>
      command.kind === "test"
      && command.cwd === "scripts/tool"
      && command.argv.join(" ") === "python -m unittest discover tests"
    ));
    assert.ok(commands.some((command) =>
      command.kind === "install"
      && command.cwd === "scripts/tool"
      && command.argv.join(" ") === "pip install -r requirements.txt"
    ));
    assert.ok(!blockers.some((blocker) => blocker.code === "missing_dependency_lock"));
    assert.ok(!blockers.some((blocker) => blocker.code === "missing_deterministic_validation"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testUntrackedNestedManifestCannotChangeBuildSelection(): Promise<void> {
  const cwd = tempDir("agentify-build-untracked-nested-");
  try {
    fs.writeFileSync(path.join(cwd, "compile.sh"), "#!/usr/bin/env bash\nset -e\necho compiled\n");
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "fixture");
    fs.mkdirSync(path.join(cwd, "untracked", "tests"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "untracked", "pyproject.toml"), "[project]\nname='untracked'\n");
    fs.writeFileSync(path.join(cwd, "untracked", "tests", "test_fake.py"), "assert True\n");

    const { manifest } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.equal(manifest?.path, "compile.sh");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testDocumentedOfflineUnittestOutranksNetworkDependentDiscovery(): Promise<void> {
  const cwd = tempDir("agentify-build-python-offline-test-");
  try {
    fs.mkdirSync(path.join(cwd, "tests"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "pyproject.toml"), "[project]\nname='tool'\n");
    fs.writeFileSync(
      path.join(cwd, "README.md"),
      "```shell\npython -m unittest discover tests\npython -m unittest tests/test_parser.py\n```\n",
    );
    fs.writeFileSync(
      path.join(cwd, "tests", "test_remote.py"),
      "from remote_status import fetch_status\n",
    );
    fs.writeFileSync(path.join(cwd, "remote_status.py"), "from network_client import fetch\n");
    fs.writeFileSync(path.join(cwd, "network_client.py"), "import requests\n");
    fs.writeFileSync(
      path.join(cwd, "tests", "test_parser.py"),
      "from parser import parse\nfrom unittest import TestCase\nclass TestParser(TestCase):\n    def test_parse(self): self.assertEqual(parse('ok'), 'ok')\n",
    );
    fs.writeFileSync(
      path.join(cwd, "tests", "test_alpha.py"),
      "from unittest import TestCase\nclass TestAlpha(TestCase):\n    def test_alpha(self): self.assertTrue(True)\n",
    );
    fs.writeFileSync(path.join(cwd, "parser.py"), "def parse(value): return value\n");
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "fixture");

    const { commands, blockers } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.ok(commands.some((command) => (
      command.kind === "test"
      && command.argv.join(" ") === "python -m unittest tests/test_alpha.py"
    )));
    assert.ok(!commands.some((command) => command.argv.join(" ") === "python -m unittest discover tests"));
    assert.ok(!blockers.some((blocker) => blocker.code === "missing_deterministic_validation"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testNetworkDependentUnittestWithoutDocumentedIndividualFormFailsClosed(): Promise<void> {
  const cwd = tempDir("agentify-build-python-no-individual-form-");
  try {
    fs.mkdirSync(path.join(cwd, "tests"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "pyproject.toml"), "[project]\nname='tool'\n");
    fs.writeFileSync(path.join(cwd, "README.md"), "Run the complete test suite before submitting.\n");
    fs.writeFileSync(path.join(cwd, "tests", "test_remote.py"), "import requests\n");
    fs.writeFileSync(
      path.join(cwd, "tests", "test_safe.py"),
      "from unittest import TestCase\nclass TestSafe(TestCase):\n    def test_safe(self): self.assertTrue(True)\n",
    );
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "fixture");

    const { commands, blockers } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.ok(!commands.some((command) => command.kind === "test"));
    assert.ok(blockers.some((blocker) => blocker.code === "missing_deterministic_validation"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testUnittestFixtureUrlsDoNotImplyNetworkExecution(): Promise<void> {
  const cwd = tempDir("agentify-build-python-url-fixture-");
  try {
    fs.mkdirSync(path.join(cwd, "tests"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "pyproject.toml"), "[project]\nname='tool'\n");
    fs.writeFileSync(
      path.join(cwd, "tests", "test_parser.py"),
      "from unittest import TestCase\nclass TestParser(TestCase):\n    def test_url(self): self.assertEqual('https://example.invalid', 'https://example.invalid')\n",
    );
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "fixture");

    const { commands } = discoverRepositoryCommands(cwd, fakeRunner(cwd), false);
    assert.ok(commands.some((command) => command.argv.join(" ") === "python -m unittest discover tests"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const tests = [
  { name: "python pyproject discovery", fn: testPythonPyprojectDiscovery },
  { name: "rust cargo discovery", fn: testRustCargoDiscovery },
  { name: "go module discovery", fn: testGoModuleDiscovery },
  { name: "makefile discovery", fn: testMakefileDiscovery },
  { name: "python validation approval binding", fn: testPythonValidationApprovalBinding },
  { name: "shell script discovery", fn: testShellScriptDiscovery },
  { name: "shell script marked unsafe when network accessed", fn: testShellScriptMarkedUnsafeWhenNetworkAccessed },
  { name: "shell validation approval binding", fn: testShellValidationApprovalBinding },
  { name: "unsupported repository", fn: testUnsupportedRepository },
  { name: "tracked nested Python tests outrank root build-only shell", fn: testTrackedNestedPythonTestsOutrankRootBuildOnlyShell },
  { name: "untracked nested manifest cannot change build selection", fn: testUntrackedNestedManifestCannotChangeBuildSelection },
  { name: "documented offline unittest outranks network-dependent discovery", fn: testDocumentedOfflineUnittestOutranksNetworkDependentDiscovery },
  { name: "network-dependent unittest without documented individual form fails closed", fn: testNetworkDependentUnittestWithoutDocumentedIndividualFormFailsClosed },
  { name: "unittest fixture URLs do not imply network execution", fn: testUnittestFixtureUrlsDoNotImplyNetworkExecution },
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
console.log(`build-system discovery tests passed (${passed}/${tests.length}).`);
