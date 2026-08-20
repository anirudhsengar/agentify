import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { discoverPythonBuildSystem } from "../../src/core/installer/build-systems/python.ts";

function tempPythonRepo(name: string, files: Record<string, string>): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `agentify-py-${name}-`));
  for (const [relative, content] of Object.entries(files)) {
    const destination = path.join(cwd, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
  return cwd;
}

test("python discovery respects a configured mypy file scope", () => {
  const cwd = tempPythonRepo("scoped-mypy", {
    "pyproject.toml": [
      "[project]",
      'name = "sample"',
      'dependencies = []',
      "",
      "[tool.mypy]",
      'python_version = "3.10"',
      'files = ["src"]',
      "strict = true",
      "",
      "[tool.pyright]",
      'pythonVersion = "3.10"',
      "",
    ].join("\n"),
    "uv.lock": "version = 1\n",
    "src/sample/__init__.py": "",
  });
  try {
    const discovery = discoverPythonBuildSystem(cwd);
    const mypy = discovery?.commands.find((command) => command.command_id === "typecheck-mypy");
    assert.ok(mypy, "mypy command must be discovered");
    assert.deepEqual(mypy.argv, ["uv", "run", "mypy"]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("python discovery respects a mypy ini file scope", () => {
  const cwd = tempPythonRepo("ini-scoped-mypy", {
    "pyproject.toml": "[project]\nname = \"sample\"\ndependencies = []\n\n[dependency-groups]\ndev = [\"mypy\"]\n",
    "mypy.ini": "[mypy]\nmypy_path = src\nfiles = src\n",
    "uv.lock": "version = 1\n",
  });
  try {
    const discovery = discoverPythonBuildSystem(cwd);
    const mypy = discovery?.commands.find((command) => command.command_id === "typecheck-mypy");
    assert.ok(mypy, "mypy command must be discovered");
    assert.deepEqual(mypy.argv, ["uv", "run", "mypy"]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("python discovery scans the tree only for unscoped mypy projects", () => {
  const cwd = tempPythonRepo("unscoped-mypy", {
    "pyproject.toml": "[project]\nname = \"sample\"\ndependencies = []\n\n[dependency-groups]\ndev = [\"mypy\"]\n",
    "uv.lock": "version = 1\n",
  });
  try {
    const discovery = discoverPythonBuildSystem(cwd);
    const mypy = discovery?.commands.find((command) => command.command_id === "typecheck-mypy");
    assert.ok(mypy, "mypy command must be discovered");
    assert.deepEqual(mypy.argv, ["uv", "run", "mypy", "."]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
