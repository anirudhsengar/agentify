import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeDefenseHook } from "../../src/core/audit/defense-hook.ts";
import { setAgentifySessionActive } from "../../src/core/audit/state.ts";
import {
  expectKnownRegression,
  regressionStillPresent,
} from "../helpers/known-regression.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf-8");
}

function sourceSection(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function sanitizedCliEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CI: "1",
    NO_COLOR: "1",
  };
  for (const key of Object.keys(env)) {
    if (key.endsWith("_API_KEY") || key.endsWith("_TOKEN")) delete env[key];
  }
  return env;
}

function runCli(args: readonly string[]) {
  const cwd = tempDir("agentify-phase0-cli-cwd-");
  const home = tempDir("agentify-phase0-cli-home-");
  try {
    return spawnSync(
      process.execPath,
      [path.join(repoRoot, "bin", "agentify.js"), ...args],
      {
        cwd,
        env: sanitizedCliEnv(home),
        encoding: "utf-8",
        timeout: 10_000,
      },
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function assertTopLevelOptionsAreRecognized(args: readonly string[]): void {
  const result = runCli(args);
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  assert.notEqual(errorCode, "ETIMEDOUT", `CLI timed out for ${args.join(" ")}`);
  assert.equal(result.error, undefined, `CLI process failed to start for ${args.join(" ")}`);
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/unknown subcommand '--(?:mode|targets)'/.test(output)) {
    regressionStillPresent(`top-level options are dispatched as subcommands: ${args.join(" ")}`);
  }
}

function defenseEvent(
  command: string,
  cwd: string,
): never {
  return {
    toolName: "bash",
    input: { command },
    cwd,
    activeTools: ["read", "write", "edit", "bash"],
  } as never;
}

async function assertBashCommandBlocked(command: string): Promise<void> {
  const cwd = tempDir("agentify-phase0-defense-");
  setAgentifySessionActive(null, true);
  try {
    const hook = makeDefenseHook({ repoJail: true });
    const result = await hook(defenseEvent(command, cwd));
    if (!result?.block) {
      regressionStillPresent(`bash command remains allowed: ${command}`);
    }
  } finally {
    setAgentifySessionActive(null, false);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function assertWebhookWorkerHasExplicitSandbox(): void {
  const source = readSource("src/core/webhook/worker.ts");
  const sessionBuilder = sourceSection(
    source,
    "function buildSessionOptions(",
    "function normalizeModelRole(",
  );
  if (!/\b(repoJail|executionPolicy|securityPolicy|capabilityPolicy)\b/.test(sessionBuilder)) {
    regressionStillPresent("webhook session options do not carry an explicit sandbox policy");
  }
}

function assertProviderScopedStateSnapshot(providerDir: string): void {
  const source = readSource("src/core/run-agentify.ts");
  const snapshotAssignment = source.match(
    /const internalStateSnapshot\s*=\s*([^;]+);/s,
  );
  assert.ok(snapshotAssignment, "brownfield audit must capture internal state before cleanup");
  if (!/stateDir/.test(snapshotAssignment[1] ?? "")) {
    regressionStillPresent(`${providerDir} is deleted without a provider-scoped state snapshot`);
  }
}

function assertSignaturePrecedesAuthenticatedRateLimit(): void {
  const source = readSource("src/core/webhook/server.ts");
  const handlerPrefix = sourceSection(
    source,
    "async function handle(",
    "// Parse payload (best effort)",
  );
  const signatureIndex = handlerPrefix.indexOf("verifySignatureWithHeaders(");
  const rateLimitIndex = handlerPrefix.indexOf("checkRateLimit(");
  assert.ok(signatureIndex >= 0, "signature verification call must exist");
  assert.ok(rateLimitIndex >= 0, "authenticated rate-limit call must exist");
  if (signatureIndex >= rateLimitIndex) {
    regressionStillPresent("invalid signatures consume the authenticated trigger bucket");
  }
}

function assertReloadEndpointDisabledByDefault(): void {
  const source = readSource("src/core/webhook/server.ts");
  if (!source.includes('pathOnly === "/__reload__"')) return;

  const options = sourceSection(source, "export interface ServerOptions", "export interface ServerLogger");
  const reloadRoute = sourceSection(source, "// Reload", "// Task status lookups");
  const hasEnableOption = /enableReloadEndpoint|reloadEndpointEnabled/.test(options);
  const routeChecksOption = /enableReloadEndpoint|reloadEndpointEnabled/.test(reloadRoute);
  if (!hasEnableOption || !routeChecksOption) {
    regressionStillPresent("POST /__reload__ is exposed without explicit enablement");
  }
}

function jobHasTagOnlyGuard(workflow: string, jobName: string, endMarker?: string): boolean {
  const startMarker = `\n  ${jobName}:`;
  const start = workflow.indexOf(startMarker);
  assert.notEqual(start, -1, `missing release job: ${jobName}`);
  const end = endMarker ? workflow.indexOf(endMarker, start + startMarker.length) : workflow.length;
  assert.ok(end > start, `could not isolate release job: ${jobName}`);
  const block = workflow.slice(start, end);
  const jobIf = block.match(/\n    if:\s*([^\n]+)/)?.[1] ?? "";
  return /github\.event_name/.test(jobIf) && /refs\/tags\/v/.test(jobIf);
}

function assertManualReleaseCannotPublish(): void {
  const workflow = readSource(".github/workflows/release-publish.yml");
  const unguardedJobs = [
    ["publish-npm", "\n  github-release:"],
    ["github-release", undefined],
  ].filter(([jobName, endMarker]) => !jobHasTagOnlyGuard(workflow, jobName!, endMarker))
    .map(([jobName]) => jobName);
  if (unguardedJobs.length > 0) {
    regressionStillPresent(`manual dispatch can reach unguarded jobs: ${unguardedJobs.join(", ")}`);
  }
}

const regressions: Array<{ name: string; invariant: () => void | Promise<void> }> = [
  {
    name: "CLI accepts --mode brownfield as a top-level option",
    invariant: () => assertTopLevelOptionsAreRecognized(["--mode", "brownfield"]),
  },
  {
    name: "CLI accepts --targets codex as a top-level option",
    invariant: () => assertTopLevelOptionsAreRecognized(["--targets", "codex"]),
  },
  {
    name: "CLI accepts combined --mode and --targets options",
    invariant: () => assertTopLevelOptionsAreRecognized(["--mode", "brownfield", "--targets", "codex"]),
  },
  {
    name: "bash cannot read the Agentify credential store",
    invariant: () => assertBashCommandBlocked("cat ~/.agentify/auth.json"),
  },
  {
    name: "bash cannot write outside the repository",
    invariant: () => assertBashCommandBlocked("cp package.json /tmp/agentify-phase0-outside.txt"),
  },
  {
    name: "bash cannot modify ordinary repository source files",
    invariant: () => assertBashCommandBlocked("rm package.json"),
  },
  {
    name: "webhook worker sessions always receive an explicit sandbox",
    invariant: assertWebhookWorkerHasExplicitSandbox,
  },
  {
    name: "failed Claude-scoped audits can restore .claude/agentify state",
    invariant: () => assertProviderScopedStateSnapshot(".claude/agentify"),
  },
  {
    name: "failed Codex-scoped audits can restore .agents/agentify state",
    invariant: () => assertProviderScopedStateSnapshot(".agents/agentify"),
  },
  {
    name: "invalid webhook signatures do not consume authenticated rate limits",
    invariant: assertSignaturePrecedesAuthenticatedRateLimit,
  },
  {
    name: "webhook reload endpoint is unavailable unless explicitly enabled",
    invariant: assertReloadEndpointDisabledByDefault,
  },
  {
    name: "manual release dispatch cannot reach publication jobs",
    invariant: assertManualReleaseCannotPublish,
  },
];

let passed = 0;
for (const regression of regressions) {
  try {
    await expectKnownRegression(regression.name, regression.invariant);
    passed += 1;
  } catch (error) {
    console.error(`  FAIL ${regression.name}: ${(error as Error).message}`);
    if ((error as Error).stack) console.error((error as Error).stack);
    process.exit(1);
  }
}

console.log(`phase-0 known regressions recorded (${passed}/${regressions.length}).`);
