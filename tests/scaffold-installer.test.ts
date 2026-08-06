import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
    const root = packageRoot();
    const writes = installScaffoldRuntime({ cwd, packageRoot: root });
    assert.ok(writes.length > 0);

    const workflow = path.join(cwd, ".github", "workflows", "agentify-issue.yml");
    const learningWorkflow = path.join(cwd, ".github", "workflows", "agentify-learn.yml");
    const taskRuntime = path.join(cwd, ".github", "agentify", "task-runtime.mjs");
    const learningRuntime = path.join(cwd, ".github", "agentify", "learning-runtime.mjs");
    const controller = path.join(cwd, ".github", "scripts", "run-task-lifecycle.mjs");
    const policy = path.join(cwd, ".github", "agentify-task-policy.json");
    const setup = path.join(cwd, "SETUP.md");
    const agents = path.join(cwd, "AGENTS.md");

    assert.ok(fs.existsSync(workflow));
    assert.ok(fs.existsSync(learningWorkflow));
    assert.ok(fs.existsSync(taskRuntime));
    assert.ok(fs.existsSync(learningRuntime));
    assert.ok(fs.existsSync(controller));
    assert.ok(fs.existsSync(policy));
    assert.ok(fs.existsSync(setup));
    assert.ok(fs.existsSync(agents));
    assert.match(fs.readFileSync(workflow, "utf-8"), /^# agentify:managed/m);
    assert.match(fs.readFileSync(controller, "utf-8"), /^#![^\r\n]*(?:\r\n|\n|\r)\/\/ agentify:managed/m);
    assert.match(fs.readFileSync(setup, "utf-8"), /<!-- agentify:managed -->/);
    assert.match(fs.readFileSync(agents, "utf-8"), /<!-- agentify:managed -->/);

    const sourceScripts = path.join(root, "scaffold", ".github", "scripts");
    for (const entry of fs.readdirSync(sourceScripts, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
      const source = path.join(sourceScripts, entry.name);
      if (!fs.readFileSync(source, "utf-8").startsWith("#!")) continue;

      const installed = path.join(cwd, ".github", "scripts", entry.name);
      const content = fs.readFileSync(installed, "utf-8");
      assert.match(
        content,
        /^#![^\r\n]*(?:\r\n|\n|\r)\/\/ agentify:managed(?:\r\n|\n|\r)/,
        `${entry.name} must keep its shebang before the managed marker`,
      );
      execFileSync(process.execPath, ["--check", installed], { stdio: "pipe" });
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testAlongsideOnUserOwnedFiles(): Promise<void> {
  const cwd = tempDir("agentify-scaffold-alongside-");
  try {
    const workflow = path.join(cwd, ".github", "workflows", "agentify-issue.yml");
    fs.mkdirSync(path.dirname(workflow), { recursive: true });
    fs.writeFileSync(workflow, "name: user-owned\n");

    const writes = installScaffoldRuntime({ cwd, packageRoot: packageRoot() });
    const record = writes.find((write) => write.path === workflow);
    assert.equal(record?.action, "alongside");
    // The user's file is left untouched.
    assert.equal(fs.readFileSync(workflow, "utf-8"), "name: user-owned\n");
    // Agentify's version is saved next to it.
    const alongside = path.join(
      cwd, ".github", "workflows", "agentify-issue.agentify.yml",
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
