import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { SUBCOMMAND_NAMES } from "../src/core/cli-commands.ts";
import { PUBLIC_SUBCOMMAND_NAMES } from "../src/core/public-cli-contract.ts";

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
  assert.deepEqual(
    packageJson.exports,
    { "./package.json": "./package.json" },
    "the package export map must reject deep imports into internal source",
  );
}

async function testFocusedPublicCommandInventory(): Promise<void> {
  assert.deepEqual(PUBLIC_SUBCOMMAND_NAMES, ["login", "logout", "models"]);
  assert.deepEqual(SUBCOMMAND_NAMES, PUBLIC_SUBCOMMAND_NAMES);

  const help = read("tests/parity/fixtures/cli-help.txt");
  for (const command of PUBLIC_SUBCOMMAND_NAMES) {
    assert.match(help, new RegExp(`^  agentify ${command}\\b`, "m"));
  }
}

async function testDocumentationDefinesFocusedProduct(): Promise<void> {
  const readme = read("README.md");
  const architecture = read("docs/architecture/install-once-repository-team.md");

  assert.match(readme, /persistent, repository-specific engineering team/i);
  assert.match(readme, /authorized GitHub issues are the\s+normal work interface/i);
  assert.match(readme, /exactly one builder/i);
  assert.match(readme, /role-separated automated read-only review/i);
  assert.match(readme, /human retains merge authority/i);
  assert.match(readme, /path-restricted knowledge maintainer/i);
  for (const invariant of [
    "One authoritative state model",
    "Installation contract",
    "Issue execution contract",
    "Learning contract",
    "Execution-policy contract",
    "Completion criteria",
  ]) {
    assert.ok(architecture.includes(invariant), `product architecture must define ${invariant}`);
  }

  assert.match(architecture, /Exactly one builder receives application-source write authority/i);
  assert.match(architecture, /one path-restricted knowledge maintainer/i);
  assert.match(architecture, /every changed path is allowlisted/i);
  assert.match(architecture, /runtime code, operational state, or protected policy/i);

}

async function testAuthorityBoundariesRemainExplicit(): Promise<void> {
  const architecture = read("docs/architecture/install-once-repository-team.md");
  const help = read("tests/parity/fixtures/cli-help.txt");

  assert.match(architecture, /Exactly one builder receives application-source write authority/i);
  assert.match(architecture, /reviewer.*read-only/is);
  assert.match(architecture, /It does not\s+receive GitHub write credentials/i);
  assert.match(architecture, /unmerged\s+draft pull request/i);
  assert.match(architecture, /may not change application source, dependencies, workflows/i);
  assert.match(architecture, /Prompts supplement these controls but never replace them/i);

  assert.match(help, /exactly one builder/);
  assert.match(help, /role-separated automated read-only review/);
  assert.match(help, /unmerged draft pull request/);
  assert.match(help, /human\s+retains application merge authority/i);
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "packageExposesOnlyCliRuntime", fn: testPackageExposesOnlyCliRuntime },
  { name: "focusedPublicCommandInventory", fn: testFocusedPublicCommandInventory },
  { name: "documentationDefinesFocusedProduct", fn: testDocumentationDefinesFocusedProduct },
  { name: "authorityBoundariesRemainExplicit", fn: testAuthorityBoundariesRemainExplicit },
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
