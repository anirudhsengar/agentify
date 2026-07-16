import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  authPath,
  configPath,
  defaultConfigDir,
  ensureAgentifyConfig,
  saveAgentifyConfig,
} from "../src/core/agentify-config.ts";
import {
  AGENTIFY_MANAGED_MARKERS,
  exportAgenticSurface,
} from "../src/core/artifact-exporters.ts";
import { ProjectClassifier } from "../src/core/project-classifier.ts";
import { writeGreenfieldFormationAt } from "../src/core/greenfield-artifacts.ts";
import { readGreenfieldStateAt } from "../src/core/greenfield-state.ts";
import { readManifestAt } from "../src/core/manifest.ts";
import { resolveCanonicalStateDir } from "../src/core/state-dir.ts";
import { readProjectState } from "../src/core/project-state.ts";
import {
  AGENTIFY_PROVIDERS,
  PROVIDER_ENV_KEYS,
  getProviderEnvValue,
  hasProviderEnvironmentAuth,
} from "../src/core/provider-auth.ts";
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
    private readonly multiSelectAnswers: ReadonlyArray<string>[] = [],
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

  async promptMultiSelect(): Promise<ReadonlyArray<string>> {
    const next = this.multiSelectAnswers.shift();
    if (!next) throw new Error("No promptMultiSelect answer queued.");
    return next;
  }

  async promptCheckboxList(): Promise<ReadonlyArray<string>> {
    throw new Error("promptCheckboxList should not be called in this test");
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
    const stateDir = options.spawnExplorerStateDir ?? ".pi/agentify";
    fs.mkdirSync(path.join(options.cwd, stateDir), { recursive: true });
    fs.writeFileSync(
      path.join(options.cwd, stateDir, "codebase_map.json"),
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
    stateDir: string;
  }): Promise<AgentRuntimeResult> {
    writeGreenfieldFormationAt(options.cwd, makeGreenfieldFormation(), options.stateDir);
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

/**
 * Run `fn` with HOME pointed at a fresh temp dir so `defaultConfigDir()`
 * resolves there. Returns the temp configDir the function observed.
 */
async function withTempHome<T>(fn: (configDir: string) => Promise<T>): Promise<T> {
  const prevHome = process.env["HOME"];
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-core-home-"));
  process.env["HOME"] = tempHome;
  const configDir = defaultConfigDir();
  try {
    return await fn(configDir);
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
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

async function testProviderMetadataAndEnvironmentAuth(): Promise<void> {
  const values = AGENTIFY_PROVIDERS.map((provider) => provider.value);
  assert.equal(new Set(values).size, values.length, "provider IDs must be unique");
  assert.ok(values.includes("openai"));
  assert.ok(values.includes("anthropic"));
  assert.ok(values.includes("amazon-bedrock"));
  for (const provider of AGENTIFY_PROVIDERS) {
    assert.ok(provider.label.trim().length > 0, `missing provider label: ${provider.value}`);
    assert.ok(provider.value.trim().length > 0);
    assert.equal(new Set(provider.env).size, provider.env.length);
  }

  const previousOpenAi = process.env["OPENAI_API_KEY"];
  const previousAwsProfile = process.env["AWS_PROFILE"];
  const previousAwsBearer = process.env["AWS_BEARER_TOKEN_BEDROCK"];
  try {
    process.env["OPENAI_API_KEY"] = "sk-test-env";
    assert.equal(hasProviderEnvironmentAuth("openai"), true);
    assert.equal(getProviderEnvValue("openai"), "sk-test-env");

    delete process.env["AWS_BEARER_TOKEN_BEDROCK"];
    process.env["AWS_PROFILE"] = "agentify-test-profile";
    assert.equal(hasProviderEnvironmentAuth("amazon-bedrock"), true);
    assert.equal(
      getProviderEnvValue("amazon-bedrock"),
      undefined,
      "ambient AWS credentials must not be forwarded as an API key",
    );
  } finally {
    if (previousOpenAi === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = previousOpenAi;
    if (previousAwsProfile === undefined) delete process.env["AWS_PROFILE"];
    else process.env["AWS_PROFILE"] = previousAwsProfile;
    if (previousAwsBearer === undefined) delete process.env["AWS_BEARER_TOKEN_BEDROCK"];
    else process.env["AWS_BEARER_TOKEN_BEDROCK"] = previousAwsBearer;
  }
}

async function testAuthPromptAnd0600Write(): Promise<void> {
  await withNoProviderEnv(async () => {
    const configDir = tempDir("auth");
    const ui = new TestUi(["openai"], ["sk-test"]);
    const config = await ensureAgentifyConfig(configDir, ui, { modelStrategy: "skip" });
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
  fs.mkdirSync(path.join(packageRoot, "packaged", "skills", "demo"), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "packaged", "skills", "demo", "SKILL.md"),
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
  assert.ok(fs.existsSync(path.join(cwd, ".claude", "skills", "demo", "SKILL.md")));

  const exportedSkill = fs.readFileSync(
    path.join(cwd, ".agents", "skills", "demo", "SKILL.md"),
    "utf-8",
  );
  assert.ok(exportedSkill.startsWith("---\nname: demo\n"));
  assert.ok(exportedSkill.includes(AGENTIFY_MANAGED_MARKERS.markdown));

  fs.writeFileSync(path.join(cwd, ".codex", "agents", "payments.toml"), "user-owned = true\n");
  const alongsideCodex = exportAgenticSurface({ cwd, packageRoot, targets: ["codex"] })
    .flatMap((result) => result.writes)
    .find((write) => write.path.endsWith(path.join(".codex", "agents", "payments.toml")));
  assert.equal(alongsideCodex?.action, "alongside");
  assert.equal(
    fs.readFileSync(path.join(cwd, ".codex", "agents", "payments.toml"), "utf-8"),
    "user-owned = true\n",
  );
  assert.ok(
    fs.existsSync(path.join(cwd, ".codex", "agents", "payments.agentify.toml")),
    "expected agentify's version at payments.agentify.toml",
  );

  fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# User-owned AGENTS\n");
  fs.rmSync(path.join(cwd, "CLAUDE.md"), { force: true });
  const alongsideClaude = exportAgenticSurface({ cwd, packageRoot, targets: ["claude"] })
    .flatMap((result) => result.writes)
    .find((write) => write.path.endsWith("CLAUDE.md"));
  assert.equal(alongsideClaude?.action, "alongside");
  assert.ok(!fs.existsSync(path.join(cwd, "CLAUDE.md")));
  assert.ok(
    fs.existsSync(path.join(cwd, "CLAUDE.agentify.md")),
    "expected derived CLAUDE.md at CLAUDE.agentify.md",
  );
}

async function testBrownfieldRunWithFakeRuntime(): Promise<void> {
  await withTempHome(async (configDir) => {
    const cwd = tempDir("run");
    try {
      fs.writeFileSync(path.join(cwd, "package.json"), "{}\n");
      saveAgentifyConfig(configDir, { provider: "openai", thinkingLevel: "high" });
      fs.writeFileSync(authPath(configDir), JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }));

      const ui = new TestUi();
      await runAgentify({
        cwd,
        ui,
        runtime: new BrownfieldFakeRuntime(),
        targets: ["codex", "claude", "pi"],
        mode: "brownfield",
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
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

async function testGreenfieldRunWithFakeRuntime(): Promise<void> {
  const cwd = tempDir("greenfield");
  await withTempHome(async (configDir) => {
    saveAgentifyConfig(configDir, { provider: "openai", thinkingLevel: "high" });
    fs.writeFileSync(authPath(configDir), JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }));

    const ui = new TestUi();
    await runAgentify({
      cwd,
      ui,
      runtime: new GreenfieldFakeRuntime(),
      targets: ["codex", "claude", "pi"],
      mode: "greenfield",
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
    const stateDir = resolveCanonicalStateDir(cwd, ["codex", "claude", "pi"]).relativeDir;
    assert.ok(fs.existsSync(path.join(cwd, stateDir, "greenfield-state.json")));
    const greenfieldState = readGreenfieldStateAt(cwd, stateDir);
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
    const manifest = readManifestAt(cwd, stateDir);
    assert.equal(manifest?.mode, "greenfield");
    assert.ok(manifest?.files.some((file) => file.path === "GOALS.md" && file.required));
    assert.ok(fs.existsSync(path.join(cwd, ".github", "workflows", "agent-implement.yml")));
    assert.ok(fs.existsSync(path.join(cwd, "SETUP.md")));
    assert.ok(ui.infos.some((message) => message.includes("greenfield session complete")));
    assert.ok(ui.infos.some((message) => message.includes("scaffold file(s) installed")));
    assert.ok(ui.infos.some((message) => message.includes("GitHub bootstrap is ready")));
  });
}

async function testInvalidGreenfieldArtifactsRemainPartial(): Promise<void> {
  const cwd = tempDir("greenfield-invalid");
  await withTempHome(async (configDir) => {
    saveAgentifyConfig(configDir, { provider: "openai", thinkingLevel: "high" });
    fs.writeFileSync(authPath(configDir), JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }));

    const ui = new TestUi();
    await runAgentify({
      cwd,
      ui,
      runtime: new PlaceholderGreenfieldFakeRuntime(),
      targets: ["codex", "claude", "pi"],
      mode: "greenfield",
      githubReadinessOverride: READY_GITHUB,
    });

    const state = readGreenfieldStateAt(cwd, resolveCanonicalStateDir(cwd, ["codex", "claude", "pi"]).relativeDir);
    assert.equal(state?.artifact_validation.ok, false);
    assert.ok(state?.artifact_validation.reasons.some((reason) => reason.includes("GOALS.md")));
    assert.ok(!fs.existsSync(path.join(cwd, "SETUP.md")), "invalid greenfield artifacts must not install scaffold");
    assert.equal(readProjectState(configDir, cwd)?.runStatus, "partial");
    assert.ok(ui.errors.some((message) => message.includes("substance gate")));
    assert.ok(ui.infos.some((message) => message.includes("scaffold not installed")));
    assert.ok(!ui.infos.some((message) => message.includes("GitHub bootstrap is ready")));
  });
}

await testProjectClassifier();
await testProviderMetadataAndEnvironmentAuth();
await testAuthPromptAnd0600Write();
await testArtifactExporter();
await testBrownfieldRunWithFakeRuntime();
await testGreenfieldRunWithFakeRuntime();
await testInvalidGreenfieldArtifactsRemainPartial();

console.log("agentify core tests passed.");
