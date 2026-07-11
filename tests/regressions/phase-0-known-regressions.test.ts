import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  expectKnownRegression,
  regressionStillPresent,
} from "../helpers/known-regression.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");

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
  const jobs: ReadonlyArray<readonly [string, string?]> = [
    ["publish-npm", "\n  github-release:"],
    ["github-release"],
  ];
  const unguardedJobs = jobs
    .filter(([jobName, endMarker]) => !jobHasTagOnlyGuard(workflow, jobName, endMarker))
    .map(([jobName]) => jobName);
  if (unguardedJobs.length > 0) {
    regressionStillPresent(`manual dispatch can reach unguarded jobs: ${unguardedJobs.join(", ")}`);
  }
}

const regressions: Array<{ name: string; invariant: () => void | Promise<void> }> = [
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
