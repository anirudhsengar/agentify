// tests/core/agent-expert.test.ts — Agent Experts ACT → LEARN → REUSE.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ExpertRegistry,
  expertsTouchedBy,
  findStaleExperts,
  parseExpertiseYamlText,
  runQuestion,
  runSelfImprove,
  type ExpertDomain,
} from "../../src/core/agent-expert.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setupExpertDir(
  cwd: string,
  domain: string,
  opts: {
    lastUpdated?: string;
    primaryPaths?: string[];
    overviewKeyFiles?: Array<{ path: string; line_range?: [number, number]; purpose?: string }>;
    includeSelfImprove?: boolean;
    includeQuestion?: boolean;
  } = {},
): ExpertDomain {
  const dir = path.join(cwd, ".pi", "prompts", "experts", domain);
  fs.mkdirSync(dir, { recursive: true });

  const yamlText = `domain: ${domain}
last_updated: ${opts.lastUpdated ?? "2026-07-01T00:00:00Z"}
primary_paths:
${(opts.primaryPaths ?? ["src/" + domain + "/"]).map((p) => `  - ${p}`).join("\n")}
overview:
  description: ${domain} expert
  key_files:
${(opts.overviewKeyFiles ?? []).map((kf) => `    - path: ${kf.path}\n      purpose: ${kf.purpose ?? ""}`).join("\n")}
key_types:
  - name: Foo
    path: src/${domain}/foo.ts
    purpose: Test
patterns:
  - name: factory
    description: Use factory
    example_ref: src/${domain}/foo.ts:12
pitfalls:
  - risk: don't
    consequence: breaks
    reference: src/${domain}/foo.ts:1
conventions:
  - keep tests close to code
`;
  fs.writeFileSync(path.join(dir, "expertise.yaml"), yamlText);

  if (opts.includeQuestion !== false) {
    fs.writeFileSync(
      path.join(dir, "question.md"),
      `---
description: ${domain} expert — answer questions about ${domain}.
argument-hint: "<question>"
---

# ${domain} Expert — Question Mode

Read expertise.yaml first, then answer: $ARGUMENTS
`,
    );
  }

  if (opts.includeSelfImprove !== false) {
    fs.writeFileSync(
      path.join(dir, "self-improve.md"),
      `# ${domain} Self-Improve

Sync expertise.yaml against the code. Update \`last_updated\` to today.
`,
    );
  }

  return {
    domain,
    dir,
    expertisePath: path.join(dir, "expertise.yaml"),
    questionPath: path.join(dir, "question.md"),
    selfImprovePath: path.join(dir, "self-improve.md"),
    planPath: null,
    planBuildImprovePath: null,
    description: `${domain} expert — answer questions about ${domain}.`,
    lastUpdated: opts.lastUpdated ?? "2026-07-01T00:00:00Z",
  };
}

// ---------------------------------------------------------------------------
// parseExpertiseYaml
// ---------------------------------------------------------------------------

async function testParseExpertiseYaml(): Promise<void> {
  const yaml = `domain: billing
last_updated: 2026-06-10
primary_paths:
  - app/billing/
overview:
  description: billing expert
  key_files:
    - path: app/billing/stripe.py
      line_range: [1, 450]
      purpose: webhook
patterns:
  - name: idempotency
    description: check first
    example_ref: app/billing/stripe.py:42
conventions:
  - amounts in cents
`;
  const parsed = parseExpertiseYamlText(yaml);
  assert.equal(parsed.domain, "billing");
  assert.equal(parsed.last_updated, "2026-06-10");
  assert.deepEqual(parsed.primary_paths, ["app/billing/"]);
  assert.equal(parsed.overview?.description, "billing expert");
  assert.equal(parsed.overview?.key_files?.[0]?.path, "app/billing/stripe.py");
  assert.deepEqual(parsed.overview?.key_files?.[0]?.line_range, [1, 450]);
  assert.equal(parsed.patterns?.[0]?.name, "idempotency");
  assert.deepEqual(parsed.conventions, ["amounts in cents"]);
}

// ---------------------------------------------------------------------------
// ExpertRegistry
// ---------------------------------------------------------------------------

async function testRegistryEmpty(): Promise<void> {
  const cwd = tempDir("agentify-expert-empty-");
  try {
    const reg = ExpertRegistry.fromCwd(cwd);
    assert.equal(reg.list().length, 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testRegistryDiscoversExperts(): Promise<void> {
  const cwd = tempDir("agentify-expert-disc-");
  try {
    setupExpertDir(cwd, "billing");
    setupExpertDir(cwd, "database", { lastUpdated: "2026-06-15" });
    const reg = ExpertRegistry.fromCwd(cwd);
    const list = reg.list();
    assert.equal(list.length, 2);
    // Sorted by domain name.
    assert.equal(list[0]?.domain, "billing");
    assert.equal(list[1]?.domain, "database");
    assert.equal(list[1]?.lastUpdated, "2026-06-15");
    // get() lookup.
    const billing = reg.get("billing");
    assert.ok(billing);
    assert.match(billing.dir, /\/billing$/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testRegistrySkipsInvalidDomains(): Promise<void> {
  const cwd = tempDir("agentify-expert-skip-");
  try {
    // Create a domain directory without expertise.yaml.
    const invalid = path.join(cwd, ".pi", "prompts", "experts", "incomplete");
    fs.mkdirSync(invalid, { recursive: true });
    fs.writeFileSync(path.join(invalid, "question.md"), "no yaml here");
    // And a complete one.
    setupExpertDir(cwd, "complete");
    const reg = ExpertRegistry.fromCwd(cwd);
    assert.equal(reg.list().length, 1);
    assert.equal(reg.list()[0]?.domain, "complete");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// LEARN (self-improve)
// ---------------------------------------------------------------------------

async function testSelfImproveUpdatesLastUpdated(): Promise<void> {
  const cwd = tempDir("agentify-expert-improve-");
  try {
    const expert = setupExpertDir(cwd, "billing", { lastUpdated: "2026-06-01T00:00:00Z" });
    const todayIso = "2026-07-03T10:00:00Z";
    // Fake syncer that bumps last_updated.
    const fakeSyncer = async () => {
      const current = fs.readFileSync(expert.expertisePath, "utf-8");
      const updated = current.replace(/^last_updated: .*$/m, `last_updated: ${todayIso}`);
      fs.writeFileSync(expert.expertisePath, updated);
      return { stdout: "bumped last_updated", changed: true, summary: "added 1 pattern, removed 0 pitfalls" };
    };
    const result = await runSelfImprove(expert, cwd, { syncer: fakeSyncer, todayIso });
    assert.equal(result.expert, "billing");
    assert.equal(result.previousLastUpdated, "2026-06-01T00:00:00Z");
    assert.equal(result.newLastUpdated, todayIso);
    assert.equal(result.summary, "added 1 pattern, removed 0 pitfalls");
    assert.equal(result.valid, true);
    // The file was actually updated.
    const after = fs.readFileSync(expert.expertisePath, "utf-8");
    assert.match(after, new RegExp(`last_updated: ${todayIso}`));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testSelfImproveDetectsNoChange(): Promise<void> {
  const cwd = tempDir("agentify-expert-nochange-");
  try {
    const expert = setupExpertDir(cwd, "billing");
    const todayIso = "2026-07-03T10:00:00Z";
    // Fake syncer that does nothing.
    const noopSyncer = async () => ({ stdout: "", changed: false, summary: "no changes" });
    const result = await runSelfImprove(expert, cwd, { syncer: noopSyncer, todayIso });
    assert.equal(result.changed, false);
    assert.equal(result.summary, "no changes");
    assert.equal(result.valid, true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// REUSE (question)
// ---------------------------------------------------------------------------

async function testQuestionExtractsCitations(): Promise<void> {
  const cwd = tempDir("agentify-expert-question-");
  try {
    const expert = setupExpertDir(cwd, "billing");
    const fakeAnswerer = async () => ({
      answer: "Use the idempotency pattern at src/billing/stripe.py:42 — see also app/billing/charge.ts:18.",
      citations: ["src/billing/stripe.py:42", "app/billing/charge.ts:18"],
      confidence: "high" as const,
    });
    const result = await runQuestion(expert, "How do I handle webhooks?", cwd, {
      answerer: fakeAnswerer,
    });
    assert.equal(result.expert, "billing");
    assert.match(result.answer, /idempotency/);
    assert.equal(result.citations.length, 2);
    assert.equal(result.confidence, "high");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testQuestionDetectsLowConfidence(): Promise<void> {
  const cwd = tempDir("agentify-expert-lowconf-");
  try {
    const expert = setupExpertDir(cwd, "billing");
    const fakeAnswerer = async () => ({
      answer: "Low confidence: I'm not sure about the new endpoint.",
      citations: [],
      confidence: "low" as const,
    });
    const result = await runQuestion(expert, "What's new?", cwd, {
      answerer: fakeAnswerer,
    });
    assert.equal(result.confidence, "low");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Auto-trigger
// ---------------------------------------------------------------------------

async function testExpertsTouchedBy(): Promise<void> {
  const cwd = tempDir("agentify-expert-touched-");
  try {
    setupExpertDir(cwd, "billing", { primaryPaths: ["app/billing/"] });
    setupExpertDir(cwd, "auth", { primaryPaths: ["app/auth/"] });
    setupExpertDir(cwd, "frontend", { primaryPaths: ["src/components/"] });
    const reg = ExpertRegistry.fromCwd(cwd);
    const matched = expertsTouchedBy(reg, [
      "app/billing/stripe.py",
      "src/components/Button.tsx",
      "tests/test_foo.py", // unrelated
    ]);
    const domains = matched.map((m) => m.domain);
    assert.ok(domains.includes("billing"));
    assert.ok(domains.includes("frontend"));
    assert.equal(domains.includes("auth"), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testExpertsTouchedByAbsolutePaths(): Promise<void> {
  const cwd = tempDir("agentify-expert-touched-abs-");
  try {
    setupExpertDir(cwd, "billing", { primaryPaths: ["app/billing/"] });
    setupExpertDir(cwd, "auth", { primaryPaths: ["app/auth/"] });
    const reg = ExpertRegistry.fromCwd(cwd);
    const matched = expertsTouchedBy(reg, [
      path.join(cwd, "app", "billing", "stripe.py"),
    ]);
    assert.deepEqual(matched.map((m) => m.domain), ["billing"]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testFindStaleExperts(): Promise<void> {
  const cwd = tempDir("agentify-expert-stale-");
  try {
    setupExpertDir(cwd, "billing", {
      lastUpdated: "2026-07-01T00:00:00Z",
      primaryPaths: ["app/billing/"],
    });
    setupExpertDir(cwd, "auth", {
      lastUpdated: "2026-07-05T00:00:00Z",
      primaryPaths: ["app/auth/"],
    });

    const billingFile = path.join(cwd, "app", "billing", "stripe.py");
    const authFile = path.join(cwd, "app", "auth", "login.py");
    fs.mkdirSync(path.dirname(billingFile), { recursive: true });
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(billingFile, "def stripe(): pass\n");
    fs.writeFileSync(authFile, "def login(): pass\n");
    fs.utimesSync(billingFile, new Date("2026-07-03T00:00:00Z"), new Date("2026-07-03T00:00:00Z"));
    fs.utimesSync(authFile, new Date("2026-07-03T00:00:00Z"), new Date("2026-07-03T00:00:00Z"));

    const reg = ExpertRegistry.fromCwd(cwd);
    const stale = findStaleExperts(reg, cwd);

    assert.deepEqual(stale.map((s) => s.domain), ["billing"]);
    assert.equal(stale[0]?.latestChangedPath, "app/billing/stripe.py");
    assert.equal(stale[0]?.lastUpdated, "2026-07-01T00:00:00Z");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

await testParseExpertiseYaml();
await testRegistryEmpty();
await testRegistryDiscoversExperts();
await testRegistrySkipsInvalidDomains();
await testSelfImproveUpdatesLastUpdated();
await testSelfImproveDetectsNoChange();
await testQuestionExtractsCitations();
await testQuestionDetectsLowConfidence();
await testExpertsTouchedBy();
await testExpertsTouchedByAbsolutePaths();
await testFindStaleExperts();

console.log("agent-expert tests passed.");
