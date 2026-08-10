#!/usr/bin/env node
/**
 * Live multi-ecosystem discovery smoke test.
 * Always verifies command discovery for each ecosystem.
 * Runs real validation when the host toolchain is available.
 * Optionally probes MiniMax when MINIMAX_API_KEY is present.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverRepositoryCommands } from "../../src/core/installer/command-discovery.ts";
import { DEFAULT_INSTALLER_PROCESS_RUNNER } from "../../src/core/installer/process-runner.ts";
import { probeProviderReachable } from "../../src/core/runs/provider-probe.ts";
import { PiSdkRuntime } from "../../src/core/pi-sdk-runtime.ts";
import { defaultConfigDir, loadAgentifyConfig } from "../../src/core/agentify-config.ts";
import type { AgentifyConfig } from "../../src/core/types.ts";

function loadDotEnv(repoRoot: string): void {
  const envPath = path.join(repoRoot, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function toolAvailable(command: string, args: string[] = ["--version"]): boolean {
  const result = spawnSync(command, args, { encoding: "utf-8", windowsHide: true });
  return result.status === 0;
}

/** Windows ships npm as npm.cmd; Agentify resolves via npm-cli.js / npm_execpath. */
function npmAvailableForValidation(): boolean {
  if (process.env.npm_execpath && fs.existsSync(process.env.npm_execpath)) return true;
  const bundled = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (fs.existsSync(bundled)) return true;
  // Last resort: shell lookup (npm.cmd on Windows).
  const result = spawnSync("npm", ["--version"], {
    encoding: "utf-8",
    windowsHide: true,
    shell: process.platform === "win32",
  });
  return result.status === 0;
}

/** `go --version` fails; Go expects `go version`. */
function goAvailable(): boolean {
  return toolAvailable("go", ["version"]);
}

function rustLinkerAvailable(): boolean {
  if (!toolAvailable("cargo")) return false;
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-rust-linker-"));
  try {
    writeRepo(probe, {
      "Cargo.toml": "[package]\nname = \"linker_probe\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
      "src/lib.rs": "#[cfg(test)]\nmod t { #[test] fn ok() { assert_eq!(1, 1); } }\n",
    });
    spawnSync("cargo", ["generate-lockfile"], { cwd: probe, encoding: "utf-8", windowsHide: true });
    const result = spawnSync("cargo", ["test", "--locked", "--", "--nocapture"], {
      cwd: probe,
      encoding: "utf-8",
      windowsHide: true,
      timeout: 120_000,
    });
    return result.status === 0;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

function writeRepo(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
}

interface LiveCase {
  name: string;
  canValidate: boolean;
  setup(root: string): void;
  expectedManifest: string;
  expectedCommand?: string;
}

const repoRoot = path.resolve(import.meta.dirname, "../..");
loadDotEnv(repoRoot);

const cases: LiveCase[] = [
  {
    name: "node-package-json",
    canValidate: npmAvailableForValidation(),
    setup(root) {
      writeRepo(root, {
        "package.json": JSON.stringify({
          scripts: { test: "node -e \"process.exit(0)\"" },
        }, null, 2),
        "package-lock.json": "{}",
        "src/index.js": "module.exports = {};\n",
      });
    },
    expectedManifest: "package.json",
    expectedCommand: "npm run test",
  },
  {
    name: "python-pyproject",
    canValidate: (toolAvailable("make") || toolAvailable("gmake")),
    setup(root) {
      writeRepo(root, {
        "pyproject.toml": "[project]\nname = \"live-python-demo\"\nversion = \"0.1.0\"\n",
        "Makefile": "test:\n\techo python-manifest-ok\n",
      });
    },
    expectedManifest: "pyproject.toml",
    expectedCommand: "make test",
  },
  {
    name: "rust-cargo",
    canValidate: rustLinkerAvailable(),
    setup(root) {
      writeRepo(root, {
        "Cargo.toml": "[package]\nname = \"live_rust\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        "src/lib.rs": "#[cfg(test)]\nmod tests {\n    #[test]\n    fn it_works() { assert_eq!(2 + 2, 4); }\n}\n",
      });
      // Discovery always needs Cargo.lock; only generate a real lock when cargo exists.
      if (!toolAvailable("cargo")) {
        fs.writeFileSync(path.join(root, "Cargo.lock"), "# agentify live-smoke stub\n");
        return;
      }
      const lock = spawnSync("cargo", ["generate-lockfile"], {
        cwd: root,
        encoding: "utf-8",
        windowsHide: true,
      });
      if (lock.status !== 0) {
        throw new Error(`cargo generate-lockfile failed: ${lock.stderr || lock.stdout}`);
      }
    },
    expectedManifest: "Cargo.toml",
    expectedCommand: "cargo test --locked",
  },
  {
    name: "go-module",
    canValidate: goAvailable(),
    setup(root) {
      writeRepo(root, {
        "go.mod": "module example.com/live\n\ngo 1.22\n",
        "main.go": "package main\n\nfunc Add(a, b int) int { return a + b }\n\nfunc main() {}\n",
        "main_test.go": "package main\n\nimport \"testing\"\n\nfunc TestAdd(t *testing.T) {\n    if Add(1, 2) != 3 { t.Fatal(\"bad add\") }\n}\n",
      });
      spawnSync("go", ["mod", "tidy"], { cwd: root, encoding: "utf-8", windowsHide: true });
      // Agentify requires go.sum even when the module has no external dependencies.
      const sumPath = path.join(root, "go.sum");
      if (!fs.existsSync(sumPath)) fs.writeFileSync(sumPath, "");
    },
    expectedManifest: "go.mod",
    expectedCommand: "go test ./...",
  },
  {
    name: "makefile-only",
    canValidate: toolAvailable("make") || toolAvailable("gmake"),
    setup(root) {
      writeRepo(root, {
        "Makefile": "test:\n\techo makefile-ok\n",
        "src/app.c": "int main(){return 0;}\n",
      });
    },
    expectedManifest: "Makefile",
    expectedCommand: "make test",
  },
];

let passed = 0;
for (const liveCase of cases) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `agentify-live-${liveCase.name}-`));
  try {
    liveCase.setup(cwd);
    const discovery = discoverRepositoryCommands(
      cwd,
      DEFAULT_INSTALLER_PROCESS_RUNNER,
      liveCase.canValidate,
    );
    assert.equal(discovery.manifest?.path, liveCase.expectedManifest, `${liveCase.name} manifest`);
    assert.ok(
      discovery.commands.some((command) => command.kind !== "install" && command.required),
      `${liveCase.name} should discover required validation`,
    );
    if (liveCase.expectedCommand) {
      assert.ok(
        discovery.commands.some((command) => command.argv.join(" ") === liveCase.expectedCommand),
        `${liveCase.name} expected ${liveCase.expectedCommand}`,
      );
    }
    if (liveCase.canValidate) {
      const failed = discovery.commands.filter((command) => command.assessment === "failed");
      assert.equal(failed.length, 0, `${liveCase.name} validation failed: ${failed.map((c) => c.argv.join(" ")).join(", ")}`);
      assert.equal(discovery.blockers.length, 0, `${liveCase.name} blockers: ${JSON.stringify(discovery.blockers)}`);
      console.log(`  ok ${liveCase.name} validated (${liveCase.expectedCommand ?? "commands discovered"})`);
    } else {
      console.log(`  ok ${liveCase.name} discovered (validation skipped — toolchain unavailable)`);
    }
    passed += 1;
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

if (process.env.MINIMAX_API_KEY) {
  const configDir = defaultConfigDir();
  const loaded = loadAgentifyConfig(configDir);
  const config: AgentifyConfig = {
    schemaVersion: 1,
    thinkingLevel: loaded.thinkingLevel,
    provider: loaded.provider ?? "minimax",
    models: {
      ...loaded.models,
      primary: loaded.models.primary ?? { provider: "minimax", model: "MiniMax-M2.1" },
    },
  };
  const runtime = new PiSdkRuntime();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-live-minimax-"));
  try {
    writeRepo(cwd, {
      "pyproject.toml": "[project]\nname = \"probe\"\nversion = \"0.1.0\"\n",
      "Makefile": "test:\n\techo ok\n",
    });
    const probe = await probeProviderReachable(runtime, cwd, configDir, config);
    assert.equal(probe.ok, true, `MiniMax probe failed for provider ${probe.provider ?? "unknown"}`);
    passed += 1;
    console.log(`  ok minimax-provider-probe (${probe.provider ?? "minimax"})`);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
} else {
  console.log("  skip minimax-provider-probe (MINIMAX_API_KEY unavailable)");
}

console.log(`live multi-ecosystem smoke passed (${passed} checks).`);
