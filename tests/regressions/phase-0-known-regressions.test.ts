import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeDefenseHook } from "../../src/core/audit/defense-hook.ts";
import { setAgentifySessionActive } from "../../src/core/audit/state.ts";
import { expectKnownRegression } from "../helpers/known-regression.ts";

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
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.doesNotMatch(output, /unknown subcommand '--(?:mode|targets)'/);
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
    assert.ok(result?.block, `expected bash command to be blocked: ${command}`);
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
  assert.match(
    sessionBuilder,
    /\b(repoJail|executionPolicy|securityPolicy|capabilityPolicy)\b/,
    "webhook session options must carry an explicit sandbox policy",
  );
}

function assertProviderScopedStateSnapshot(providerDir: string): void {
  const source = readSource("src/core/run-agentify.ts");
  const snapshotAssignment = source.match(
    /const internalStateSnapshot\s*=\s*([^;]+);/s,
  );
  assert.ok(snapshotAssignment, "brownfield audit must capture internal state before cleanup");
  assert.match(
    snapshotAssignment[1] ?? "",
    /stateDir/,
    `${providerDir} state must be snapshotted through the resolved provider directory`,
  );
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
  assert.ok(
    signatureIndex < rateLimitIndex,
    "invalid signatures must not consume the authenticated trigger bucket",
  );
}

function assertReloadEndpointDisabledByDefault(): void {
  const source = readSource("src/core/webhook/server.ts");
  if (!source.includes('pathOnly === "/__reload__"')) return;

  const options = sourceSection(source, "export interface ServerOptions", "export interface ServerLogger");
  const reloadRoute = sourceSection(source, "// Reload", "// Task status lookups");
  assert.match(options, /enableReloadEndpoint|reloadEndpointEnabled/);
  assert.match(reloadRoute, /enableReloadEndpoint|reloadEndpointEnabled/);
}

function assertJobIsTagOnly(workflow: string, jobName: string, endMarker?: string): void {
  const startMarker = `\n  ${jobName}:`;
  const start = workflow.indexOf(startMarker);
  assert.notEqual(start, -1, `missing release job: ${jobName}`);
  const end = endMarker ? workflow.indexOf(endMarker, start + startMarker.length) : workflow.length;
  assert.ok(end > start, `could not isolate release job: ${jobName}`);
  const block = workflow.slice(start, end);
  const jobIf = block.match(/\n    if:\s*([^\n]+)/)?.[1] ?? "";
  assert.match(jobIf, /github\.event_name/);
  assert.match(jobIf, /refs\/tags\/v/);
}

function assertManualReleaseCannotPublish(): void {
  const workflow = readSource(".github/workflows/release-publish.yml");
  assertJobIsTagOnly(workflow, "publish-npm", "\n  github-release:");
  assertJobIsTagOnly(workflow, "github-release");
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
