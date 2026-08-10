import assert from "node:assert/strict";
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

const tests = [
  { name: "python pyproject discovery", fn: testPythonPyprojectDiscovery },
  { name: "rust cargo discovery", fn: testRustCargoDiscovery },
  { name: "go module discovery", fn: testGoModuleDiscovery },
  { name: "makefile discovery", fn: testMakefileDiscovery },
  { name: "python validation approval binding", fn: testPythonValidationApprovalBinding },
  { name: "unsupported repository", fn: testUnsupportedRepository },
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
