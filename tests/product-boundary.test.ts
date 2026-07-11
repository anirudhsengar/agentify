import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { SUBCOMMAND_NAMES } from "../src/core/cli-commands.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf-8");
}

async function testPackageExposesOnlyCliRuntime(): Promise<void> {
  const packageJson = JSON.parse(read("package.json")) as {
    bin?: Record<string, string>;
    exports?: unknown;
  };
  assert.deepEqual(packageJson.bin, { agentify: "./bin/agentify.js" });
  assert.equal(packageJson.exports, undefined, "experimental modules must not be package exports");
}

async function testCliHasNoExperimentalCommands(): Promise<void> {
  for (const command of ["webhook", "aiw", "orchestrator", "coms", "expert"]) {
    assert.ok(!SUBCOMMAND_NAMES.includes(command as never), `${command} must not become a public subcommand implicitly`);
  }
}

async function testDocumentationDefinesBoundary(): Promise<void> {
  const readme = read("README.md");
  const experimental = read("docs/experimental-surfaces.md");
  assert.match(readme, /only supported public (?:runtime )?surface/i);
  assert.match(readme, /docs\/experimental-surfaces\.md/);
  for (const area of ["Webhook", "AIW", "Orchestrator", "Communications", "Agent Expert"]) {
    assert.match(experimental, new RegExp(area, "i"));
  }
  assert.match(experimental, /not package exports/);
  assert.match(experimental, /Graduation requirements/);
}

async function testCompositionRootsAreExperimental(): Promise<void> {
  const webhook = read("src/core/webhook/index.ts");
  const aiw = read("src/core/aiw/index.ts");
  assert.match(webhook, /@experimental/);
  assert.match(aiw, /@experimental/);
  assert.doesNotMatch(webhook, /agentify webhook start/);
  assert.doesNotMatch(aiw, /export type \{\} from "\.\/index\.ts"/);
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "packageExposesOnlyCliRuntime", fn: testPackageExposesOnlyCliRuntime },
  { name: "cliHasNoExperimentalCommands", fn: testCliHasNoExperimentalCommands },
  { name: "documentationDefinesBoundary", fn: testDocumentationDefinesBoundary },
  { name: "compositionRootsAreExperimental", fn: testCompositionRootsAreExperimental },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.fn();
    passed += 1;
    console.log(`  ok ${test.name}`);
  } catch (error) {
    console.error(`  FAIL ${test.name}: ${(error as Error).message}`);
    if ((error as Error).stack) console.error((error as Error).stack);
    process.exit(1);
  }
}
console.log(`product-boundary tests passed (${passed}/${tests.length}).`);
