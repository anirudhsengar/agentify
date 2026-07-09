import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProviders } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  authPath,
  configPath,
  ensureAgentifyConfig,
  saveAgentifyConfig,
} from "../src/core/agentify-config.ts";
import {
  AGENTIFY_MANAGED_MARKERS,
  exportAgenticSurface,
} from "../src/core/artifact-exporters.ts";
import { ProjectClassifier } from "../src/core/project-classifier.ts";
import { writeGreenfieldFormation } from "../src/core/greenfield-artifacts.ts";
import { readGreenfieldState } from "../src/core/greenfield-state.ts";
import { readManifest } from "../src/core/manifest.ts";
import { readProjectState } from "../src/core/project-state.ts";
import { AGENTIFY_PROVIDERS, PROVIDER_ENV_KEYS } from "../src/core/provider-auth.ts";
import { runAgentify } from "../src/core/run-agentify.ts";
import { makeValidCodebaseMap } from "./fixtures/codebase-map.ts";
import { makeGreenfieldFormation } from "./fixtures/greenfield-formation.ts";
import type {
  AgentRuntime,
  AgentRuntimeResult,
  AgentRuntimeSessionOptions,
  AgentifyUi,
  GitHubReadiness,
} from "../src/core/types.ts";

class TestUi implements AgentifyUi {
  statuses: string[] = [];
  infos: string[] = [];
  errors: string[] = [];

  constructor(
    private readonly selectAnswers: string[] = [],
    private readonly secretAnswers: string[] = [],
  ) {}

  status(message: string): void {
    this.statuses.push(message);
  }

  info(message: string): void {
    this.infos.push(message);
  }

  error(message: string): void {
    this.errors.push(message);
  }

  async promptSelect(): Promise<string> {
    const next = this.selectAnswers.shift();
    if (!next) throw new Error("No promptSelect answer queued.");
    return next;
  }

  async promptSecret(): Promise<string> {
    const next = this.secretAnswers.shift();
    if (!next) throw new Error("No promptSecret answer queued.");
    return next;
  }
}

class BrownfieldFakeRuntime implements AgentRuntime {
  async runSession(options: AgentRuntimeSessionOptions): Promise<AgentRuntimeResult> {
    fs.mkdirSync(path.join(options.cwd, "specs"), { recursive: true });
    fs.mkdirSync(path.join(options.cwd, "ai_docs"), { recursive: true });
    fs.mkdirSync(path.join(options.cwd, ".pi", "agents"), { recursive: true });
    fs.mkdirSync(path.join(options.cwd, ".pi", "agentify"), { recursive: true });
    fs.writeFileSync(
      path.join(options.cwd, ".pi", "agentify", "codebase_map.json"),
      JSON.stringify(makeValidCodebaseMap(), null, 2),
    );
    fs.writeFileSync(path.join(options.cwd, "AGENTS.md"), "# Agentified\n");
    fs.writeFileSync(path.join(options.cwd, "specs", "README.md"), "# Specs\n");
    fs.writeFileSync(path.join(options.cwd, "ai_docs", "README.md"), "# AI Docs\n");
    fs.writeFileSync(
      path.join(options.cwd, ".pi", "agents", "payments.md"),
      "---\nname: payments\ndescription: Payments specialist\n---\n\nUse payment domain knowledge.\n",
    );
    options.onEvent?.({ type: "agent_end", willRetry: false } as AgentSessionEvent);
    return { turns: 1, costUsd: null, aborted: false };
  }

  async runGreenfield(): Promise<AgentRuntimeResult> {
    throw new Error("Greenfield mode should not run in this test.");
  }
}

class GreenfieldFakeRuntime implements AgentRuntime {
  async runSession(): Promise<AgentRuntimeResult> {
    throw new Error("Brownfield mode should not run in this test.");
  }

  async runGreenfield(options: {
    cwd: string;
  }): Promise<AgentRuntimeResult> {
    writeGreenfieldFormation(options.cwd, makeGreenfieldFormation());
    return { turns: 2, costUsd: null, aborted: false };
  }
}

class PlaceholderGreenfieldFakeRuntime implements AgentRuntime {
  async runSession(): Promise<AgentRuntimeResult> {
    throw new Error("Brownfield mode should not run in this test.");
  }

  async runGreenfield(options: { cwd: string }): Promise<AgentRuntimeResult> {
    fs.writeFileSync(path.join(options.cwd, "CONTEXT.md"), "# Context\n");
    fs.writeFileSync(path.join(options.cwd, "GOALS.md"), "# Goals\n");
    return { turns: 1, costUsd: null, aborted: false };
  }
}

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentify-${name}-`));
}

const READY_GITHUB: GitHubReadiness = {
  hasGitDirectory: true,
  hasGitHubRemote: true,
  originUrl: "git@github.com:owner/repo.git",
  ghCliAvailable: true,
  guidance: [
    "GitHub bootstrap looks ready. Review SETUP.md, run `bash .github/scripts/setup-agentify.sh`, then use GitHub issues/comments as the async inbox.",
  ],
};

function withNoProviderEnv(fn: () => Promise<void>): Promise<void> {
  const snapshot = new Map<string, string | undefined>();
  for (const key of PROVIDER_ENV_KEYS) {
    snapshot.set(key, process.env[key]);
    delete process.env[key];
  }
  return fn().finally(() => {
    for (const key of PROVIDER_ENV_KEYS) {
      const previous = snapshot.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
}

async function testProjectClassifier(): Promise<void> {
  const empty = tempDir("empty");
  assert.equal(ProjectClassifier.classify(empty).kind, "greenfield");

  const brownfield = tempDir("brownfield");
  fs.mkdirSync(path.join(brownfield, "src"));
  fs.writeFileSync(path.join(brownfield, "package.json"), "{}\n");
  fs.writeFileSync(path.join(brownfield, "src", "index.ts"), "export const x = 1;\n");
  assert.equal(ProjectClassifier.classify(brownfield).kind, "brownfield");

  const ambiguous = tempDir("ambiguous");
  fs.writeFileSync(path.join(ambiguous, "notes.txt"), "maybe a project\n");
  assert.equal(ProjectClassifier.classify(ambiguous).kind, "ambiguous");
}

async function testProviderListMatchesPi(): Promise<void> {
  const agentifyProviders = AGENTIFY_PROVIDERS.map((provider) => provider.value).sort();
  const piProviders = getProviders().sort();
  assert.deepEqual(agentifyProviders, piProviders);
}

async function testAuthPromptAnd0600Write(): Promise<void> {
  await withNoProviderEnv(async () => {
    const configDir = tempDir("auth");
    const ui = new TestUi(["openai"], ["sk-test"]);
    const config = await ensureAgentifyConfig(configDir, ui);
    assert.equal(config.provider, "openai");
    assert.equal(config.thinkingLevel, "high");
    assert.match(fs.readFileSync(authPath(configDir), "utf-8"), /sk-test/);
    assert.equal(fs.statSync(authPath(configDir)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(configPath(configDir)).mode & 0o777, 0o600);
  });
}

async function testArtifactExporter(): Promise<void> {
  const packageRoot = tempDir("package");
  const cwd = tempDir("export");
  fs.mkdirSync(path.join(packageRoot, ".agents", "skills", "demo"), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, ".agents", "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: Demo skill\n---\n\nUse demo skill.\n",
  );
  fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "AGENTS.md"),
    `${AGENTIFY_MANAGED_MARKERS.markdown}\n# Target AGENTS\n`,
  );
  fs.writeFileSync(
    path.join(cwd, ".pi", "agents", "payments.md"),
    "---\nname: payments\ndescription: Payments specialist\n---\n\nUse payments.\n",
  );

  const results = exportAgenticSurface({ cwd, packageRoot, targets: ["codex", "claude", "pi"] });
  assert.equal(results.length, 3);
  assert.ok(fs.existsSync(path.join(cwd, ".codex", "agents", "payments.toml")));
  assert.ok(fs.existsSync(path.join(cwd, ".claude", "agents", "payments.md")));
  assert.ok(fs.existsSync(path.join(cwd, "CLAUDE.md")));

  const exportedSkill = fs.readFileSync(
    path.join(cwd, ".agents", "skills", "demo", "SKILL.md"),
    "utf-8",
  );
  assert.ok(exportedSkill.startsWith("---\nname: demo\n"));
  assert.ok(exportedSkill.includes(AGENTIFY_MANAGED_MARKERS.markdown));

  fs.writeFileSync(path.join(cwd, ".codex", "agents", "payments.toml"), "user-owned = true\n");
  const conflict = exportAgenticSurface({ cwd, packageRoot, targets: ["codex"] })
    .flatMap((result) => result.writes)
    .find((write) => write.path.endsWith(path.join(".codex", "agents", "payments.toml")));
  assert.equal(conflict?.action, "conflict");

  fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# User-owned AGENTS\n");
  fs.rmSync(path.join(cwd, "CLAUDE.md"), { force: true });
  const claudeConflict = exportAgenticSurface({ cwd, packageRoot, targets: ["claude"] })
    .flatMap((result) => result.writes)
    .find((write) => write.path.endsWith("CLAUDE.md"));
  assert.equal(claudeConflict?.action, "conflict");
  assert.ok(!fs.existsSync(path.join(cwd, "CLAUDE.md")));
}

async function testBrownfieldRunWithFakeRuntime(): Promise<void> {
  const cwd = tempDir("run");
  const configDir = tempDir("config");
  fs.writeFileSync(path.join(cwd, "package.json"), "{}\n");
  saveAgentifyConfig(configDir, { provider: "openai", thinkingLevel: "high" });
  fs.writeFileSync(authPath(configDir), JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }));

  const ui = new TestUi();
  await runAgentify({
    cwd,
    configDir,
    ui,
    runtime: new BrownfieldFakeRuntime(),
    targets: ["codex", "claude", "pi"],
    assumeProjectKind: "brownfield",
    githubReadinessOverride: READY_GITHUB,
  });

  assert.ok(fs.existsSync(path.join(cwd, ".codex", "agents", "payments.toml")));
  assert.ok(fs.existsSync(path.join(cwd, ".claude", "agents", "payments.md")));
  assert.ok(fs.existsSync(path.join(cwd, ".github", "workflows", "agent-implement.yml")));
  assert.ok(fs.existsSync(path.join(cwd, "SETUP.md")));
  assert.ok(
    fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf-8")
      .includes(AGENTIFY_MANAGED_MARKERS.markdown),
  );
  assert.ok(
    fs.readFileSync(path.join(cwd, ".pi", "agents", "payments.md"), "utf-8")
      .includes(AGENTIFY_MANAGED_MARKERS.markdown),
  );
  assert.ok(ui.infos.some((message) => message.includes("audit complete")));
  assert.ok(ui.infos.some((message) => message.includes("scaffold file(s) installed")));
  assert.ok(ui.infos.some((message) => message.includes("GitHub bootstrap is ready")));
}

async function testGreenfieldRunWithFakeRuntime(): Promise<void> {
  const cwd = tempDir("greenfield");
  const configDir = tempDir("greenfield-config");
  saveAgentifyConfig(configDir, { provider: "openai", thinkingLevel: "high" });
  fs.writeFileSync(authPath(configDir), JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }));

  const ui = new TestUi();
  await runAgentify({
    cwd,
    configDir,
    ui,
    runtime: new GreenfieldFakeRuntime(),
    targets: ["codex", "claude", "pi"],
    assumeProjectKind: "greenfield",
    githubReadinessOverride: READY_GITHUB,
  });

  assert.ok(fs.existsSync(path.join(cwd, "CONTEXT.md")));
  assert.ok(fs.existsSync(path.join(cwd, "GOALS.md")));
  assert.ok(fs.existsSync(path.join(cwd, "docs", "issues", "001-import-invoices.md")));
  assert.ok(fs.existsSync(path.join(cwd, "specs", "feature-first.md")));
  assert.ok(
    fs.readFileSync(path.join(cwd, "GOALS.md"), "utf-8")
      .includes(AGENTIFY_MANAGED_MARKERS.markdown),
  );
  assert.ok(fs.existsSync(path.join(cwd, ".pi", "agentify", "greenfield-state.json")));
  const greenfieldState = readGreenfieldState(cwd);
  assert.equal(greenfieldState?.checkpoint, "spec");
  assert.equal(greenfieldState?.artifact_validation.ok, true);
  assert.equal(greenfieldState?.resume.source, "formation");
  assert.equal(greenfieldState?.resume.stop_at, "spec");
  assert.ok(greenfieldState?.resume.artifact_paths.includes("specs/feature-first.md"));
  assert.ok(greenfieldState?.resume.github_resume.includes("agent:queued"));
  assert.equal(greenfieldState?.github_handoff.action, "open_implementation_issue");
  assert.deepEqual(greenfieldState?.github_handoff.labels, ["agent:queued", "agent:implement"]);
  assert.ok(greenfieldState?.github_handoff.body.includes("specs/feature-first.md"));
  assert.ok(greenfieldState?.next_actions.some((action) => action.includes("/implement")));
  const manifest = readManifest(cwd);
  assert.equal(manifest?.mode, "greenfield");
  assert.ok(manifest?.files.some((file) => file.path === "GOALS.md" && file.required));
  assert.ok(fs.existsSync(path.join(cwd, ".github", "workflows", "agent-implement.yml")));
  assert.ok(fs.existsSync(path.join(cwd, "SETUP.md")));
  assert.ok(ui.infos.some((message) => message.includes("greenfield session complete")));
  assert.ok(ui.infos.some((message) => message.includes("scaffold file(s) installed")));
  assert.ok(ui.infos.some((message) => message.includes("GitHub bootstrap is ready")));
}

async function testInvalidGreenfieldArtifactsRemainPartial(): Promise<void> {
  const cwd = tempDir("greenfield-invalid");
  const configDir = tempDir("greenfield-invalid-config");
  saveAgentifyConfig(configDir, { provider: "openai", thinkingLevel: "high" });
  fs.writeFileSync(authPath(configDir), JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }));

  const ui = new TestUi();
  await runAgentify({
    cwd,
    configDir,
    ui,
    runtime: new PlaceholderGreenfieldFakeRuntime(),
    targets: ["codex", "claude", "pi"],
    assumeProjectKind: "greenfield",
    githubReadinessOverride: READY_GITHUB,
  });

  const state = readGreenfieldState(cwd);
  assert.equal(state?.artifact_validation.ok, false);
  assert.ok(state?.artifact_validation.reasons.some((reason) => reason.includes("GOALS.md")));
  assert.ok(!fs.existsSync(path.join(cwd, "SETUP.md")), "invalid greenfield artifacts must not install scaffold");
  assert.equal(readProjectState(configDir, cwd)?.runStatus, "partial");
  assert.ok(ui.errors.some((message) => message.includes("substance gate")));
  assert.ok(ui.infos.some((message) => message.includes("scaffold not installed")));
  assert.ok(!ui.infos.some((message) => message.includes("GitHub bootstrap is ready")));
}

await testProjectClassifier();
await testProviderListMatchesPi();
await testAuthPromptAnd0600Write();
await testArtifactExporter();
await testBrownfieldRunWithFakeRuntime();
await testGreenfieldRunWithFakeRuntime();
await testInvalidGreenfieldArtifactsRemainPartial();

console.log("agentify core tests passed.");
