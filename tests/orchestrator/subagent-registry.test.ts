// tests/orchestrator/subagent-registry.test.ts — SubagentRegistry parser + discovery.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AgentFrontmatter,
  SubagentRegistry,
  discoverAgents,
  formatRegistryForPrompt,
  loadAgentFile,
  parseAgentFrontmatter,
  resolveTemplate,
} from "../../src/core/orchestrator/subagent-registry.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeAgentFile(dir: string, name: string, body: string): string {
  const filePath = path.join(dir, `${name}.md`);
  fs.writeFileSync(filePath, body, { mode: 0o600 });
  return filePath;
}

async function testParseFrontmatterMinimal(): Promise<void> {
  const raw = `---
name: tester
description: Runs the test suite.
---

You are a tester.`;
  const result = parseAgentFrontmatter(raw, "/tmp/tester.md");
  assert.ok(result);
  if (!result) return;
  assert.equal(result.frontmatter.name, "tester");
  assert.equal(result.frontmatter.description, "Runs the test suite.");
  assert.deepEqual(result.frontmatter.tools, []);
  assert.equal(result.frontmatter.model, "inherit");
  assert.equal(result.frontmatter.domain, null);
  assert.equal(result.frontmatter.expertise, null);
  assert.equal(result.frontmatter.color, "white");
  assert.equal(result.frontmatter.system_prompt_inline, false);
  assert.equal(result.body.trim(), "You are a tester.");
}

async function testParseFrontmatterAllFields(): Promise<void> {
  const raw = `---
name: backend-dev
description: Implements backend code.
tools: read, write, edit, bash, grep, find, ls
model: sonnet
domain: apps/api/**, packages/classifier/**
expertise: ./experts/backend-dev.md
color: green
system_prompt_inline: true
---

You are a backend developer.`;
  const result = parseAgentFrontmatter(raw, "/tmp/backend.md");
  assert.ok(result);
  if (!result) return;
  assert.equal(result.frontmatter.name, "backend-dev");
  assert.equal(result.frontmatter.model, "sonnet");
  assert.deepEqual(result.frontmatter.domain, ["apps/api/**", "packages/classifier/**"]);
  assert.equal(result.frontmatter.expertise, "./experts/backend-dev.md");
  assert.equal(result.frontmatter.color, "green");
  assert.equal(result.frontmatter.system_prompt_inline, true);
  assert.deepEqual(result.frontmatter.tools, [
    "read", "write", "edit", "bash", "grep", "find", "ls",
  ]);
}

async function testParseFrontmatterMissingFields(): Promise<void> {
  const noName = `---
description: no name
---

x`;
  assert.equal(parseAgentFrontmatter(noName, "/tmp/x.md"), null);

  const noDesc = `---
name: tester
---

x`;
  assert.equal(parseAgentFrontmatter(noDesc, "/tmp/x.md"), null);
}

async function testParseFrontmatterBadModelDefaults(): Promise<void> {
  const raw = `---
name: x
description: y
model: gpt-99
---

z`;
  const result = parseAgentFrontmatter(raw, "/tmp/x.md");
  assert.ok(result);
  if (!result) return;
  assert.equal(result.frontmatter.model, "inherit");
}

async function testLoadAgentFile(): Promise<void> {
  const tmp = tempDir("agentify-reg-load-");
  try {
    const filePath = writeAgentFile(tmp, "tester", `---
name: tester
description: test
tools: read, bash
---

System prompt body.`);
    const def = loadAgentFile(filePath, "project");
    assert.ok(def);
    if (!def) return;
    assert.equal(def.name, "tester");
    assert.equal(def.source, "project");
    assert.equal(def.filePath, filePath);
    assert.deepEqual(def.tools, ["read", "bash"]);
    assert.equal(def.systemPrompt.trim(), "System prompt body.");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testLoadAgentFileMissing(): Promise<void> {
  const def = loadAgentFile("/tmp/nonexistent-agentify.md", "project");
  assert.equal(def, null);
}

async function testLoadAgentsFromDir(): Promise<void> {
  const tmp = tempDir("agentify-reg-dir-");
  try {
    writeAgentFile(tmp, "a", `---
name: a
description: A
---

a`);
    writeAgentFile(tmp, "b", `---
name: b
description: B
---

b`);
    // A file without frontmatter is logged as an error (per the
    // loader's contract: "missing 'name' or 'description'").
    writeAgentFile(tmp, "ignored", "not a markdown file");
    fs.writeFileSync(path.join(tmp, "not-md.txt"), "skip me");

    const { agents, errors } = await import("../../src/core/orchestrator/subagent-registry.ts").then((m) =>
      m.loadAgentsFromDir(tmp, "project"),
    );
    assert.equal(agents.length, 2);
    // The malformed markdown file produces one error; the .txt
    // file is skipped silently (extension filter).
    assert.equal(errors.length, 1);
    const names = agents.map((a) => a.name).sort();
    assert.deepEqual(names, ["a", "b"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testDiscoverConflictResolution(): Promise<void> {
  const tmp = tempDir("agentify-reg-conflict-");
  const configDir = tempDir("agentify-reg-conflict-config-");
  try {
    const userAgentsDir = path.join(configDir, "agents");
    const projectAgentsDir = path.join(tmp, ".pi", "agents");
    fs.mkdirSync(userAgentsDir, { recursive: true });
    fs.mkdirSync(projectAgentsDir, { recursive: true });

    // Project wins on conflict.
    writeAgentFile(userAgentsDir, "tester", `---
name: tester
description: user version
tools: read
---

USER_BODY`);
    writeAgentFile(projectAgentsDir, "tester", `---
name: tester
description: project version
tools: read, write
---

PROJECT_BODY`);

    const result = discoverAgents(tmp, configDir);
    const tester = result.agents.find((a) => a.name === "tester");
    assert.ok(tester);
    assert.equal(tester?.source, "project");
    assert.equal(tester?.description, "project version");
    assert.deepEqual(tester?.tools, ["read", "write"]);
    assert.ok(tester?.systemPrompt.includes("PROJECT_BODY"));
    assert.equal(result.projectAgentsDir, projectAgentsDir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testResolveTemplate(): Promise<void> {
  const a: AgentFrontmatter = {
    name: "a",
    description: "",
    tools: [],
    model: "inherit",
    domain: null,
    expertise: null,
    color: "white",
    system_prompt_inline: false,
  };
  const def = { ...a, systemPrompt: "", filePath: "", source: "user" as const };
  assert.ok(resolveTemplate("a", [def]));
  assert.equal(resolveTemplate("missing", [def]), null);
}

async function testFormatRegistryEmpty(): Promise<void> {
  const s = formatRegistryForPrompt([]);
  assert.ok(s.includes("no sub-agent templates"));
}

async function testFormatRegistryMultiple(): Promise<void> {
  const a: AgentFrontmatter = {
    name: "a",
    description: "First",
    tools: ["read"],
    model: "haiku",
    domain: null,
    expertise: null,
    color: "white",
    system_prompt_inline: false,
  };
  const defA = { ...a, systemPrompt: "", filePath: "", source: "user" as const };
  const defB = {
    ...a,
    name: "b",
    description: "Second",
    model: "inherit" as const,
    tools: [],
    filePath: "",
    systemPrompt: "",
    source: "user" as const,
  };
  const s = formatRegistryForPrompt([defA, defB]);
  assert.ok(s.includes("| `a`"));
  assert.ok(s.includes("haiku"));
  assert.ok(s.includes("(read-only)"));
  assert.ok(s.includes("(inherit)"));
}

async function testSubagentRegistryClass(): Promise<void> {
  const tmp = tempDir("agentify-reg-class-");
  const configDir = tempDir("agentify-reg-class-config-");
  try {
    const projectAgentsDir = path.join(tmp, ".pi", "agents");
    fs.mkdirSync(projectAgentsDir, { recursive: true });
    writeAgentFile(projectAgentsDir, "scout", `---
name: scout
description: scout
tools: read
---

SCOUT_BODY`);

    const reg = SubagentRegistry.fromCwd(tmp, configDir);
    assert.ok(reg.has("scout"));
    assert.equal(reg.get("scout")?.filePath, path.join(projectAgentsDir, "scout.md"));
    assert.equal(reg.has("missing"), false);
    assert.equal(reg.list().length, reg.list().length); // sanity
    const prompt = reg.formatForPrompt();
    assert.ok(prompt.includes("scout"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testDomainEmptyString(): Promise<void> {
  const raw = `---
name: x
description: y
domain:
---

z`;
  const result = parseAgentFrontmatter(raw, "/tmp/x.md");
  assert.ok(result);
  if (!result) return;
  assert.equal(result.frontmatter.domain, null);
}

async function testExpertiseEmptyString(): Promise<void> {
  const raw = `---
name: x
description: y
expertise: ""
---

z`;
  const result = parseAgentFrontmatter(raw, "/tmp/x.md");
  assert.ok(result);
  if (!result) return;
  assert.equal(result.frontmatter.expertise, null);
}

await testParseFrontmatterMinimal();
await testParseFrontmatterAllFields();
await testParseFrontmatterMissingFields();
await testParseFrontmatterBadModelDefaults();
await testLoadAgentFile();
await testLoadAgentFileMissing();
await testLoadAgentsFromDir();
await testDiscoverConflictResolution();
await testResolveTemplate();
await testFormatRegistryEmpty();
await testFormatRegistryMultiple();
await testSubagentRegistryClass();
await testDomainEmptyString();
await testExpertiseEmptyString();

console.log("subagent-registry tests passed.");
