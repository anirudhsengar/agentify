import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installScaffoldRuntime } from "../src/core/scaffold-installer.ts";
import { packageRoot } from "../src/core/pi-sdk-runtime.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function testInstallsManagedScaffoldFiles(): Promise<void> {
  const cwd = tempDir("agentify-scaffold-install-");
  try {
    const writes = installScaffoldRuntime({ cwd, packageRoot: packageRoot() });
    assert.ok(writes.length > 0);

    const workflow = path.join(cwd, ".github", "workflows", "agent-implement.yml");
    const shell = path.join(cwd, ".github", "scripts", "setup-agentify.sh");
    const setup = path.join(cwd, "SETUP.md");
    const shadowWorkflow = path.join(cwd, ".github", "workflows", "agent-shadow.yml");
    const shadowConfig = path.join(cwd, ".github", "agentify-shadow.json");

    assert.ok(fs.existsSync(workflow));
    assert.ok(fs.existsSync(shell));
    assert.ok(fs.existsSync(setup));
    assert.ok(fs.existsSync(shadowWorkflow));
    assert.equal((JSON.parse(fs.readFileSync(shadowConfig, "utf-8")) as { mode: string }).mode, "disabled");
    assert.match(fs.readFileSync(workflow, "utf-8"), /^# agentify:managed/m);
    assert.match(fs.readFileSync(shell, "utf-8"), /^#!\/usr\/bin\/env bash\n# agentify:managed/m);
    assert.match(fs.readFileSync(setup, "utf-8"), /<!-- agentify:managed -->/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testAlongsideOnUserOwnedFiles(): Promise<void> {
  const cwd = tempDir("agentify-scaffold-alongside-");
  try {
    const workflow = path.join(cwd, ".github", "workflows", "agent-implement.yml");
    fs.mkdirSync(path.dirname(workflow), { recursive: true });
    fs.writeFileSync(workflow, "name: user-owned\n");

    const writes = installScaffoldRuntime({ cwd, packageRoot: packageRoot() });
    const record = writes.find((write) => write.path === workflow);
    assert.equal(record?.action, "alongside");
    // The user's file is left untouched.
    assert.equal(fs.readFileSync(workflow, "utf-8"), "name: user-owned\n");
    // Agentify's version is saved next to it.
    const alongside = path.join(
      cwd, ".github", "workflows", "agent-implement.agentify.yml",
    );
    assert.ok(fs.existsSync(alongside), `expected alongside file at ${alongside}`);
    assert.match(fs.readFileSync(alongside, "utf-8"), /^# agentify:managed/m);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "installsManagedScaffoldFiles", fn: testInstallsManagedScaffoldFiles },
  { name: "alongsideOnUserOwnedFiles", fn: testAlongsideOnUserOwnedFiles },
];

let passed = 0;
for (const t of tests) {
  try {
    await t.fn();
    passed += 1;
    console.log(`  ok ${t.name}`);
  } catch (err) {
    console.error(`  FAIL ${t.name}: ${(err as Error).message}`);
    if ((err as Error).stack) console.error((err as Error).stack);
    process.exit(1);
  }
}
console.log(`scaffold-installer tests passed (${passed}/${tests.length}).`);
