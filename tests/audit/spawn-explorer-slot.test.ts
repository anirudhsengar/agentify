import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createSpawnExplorerTool } from "../../src/core/audit/spawn-explorer-tool.ts";
import { selectModelForRole } from "../../src/core/models/resolver.ts";
import type { AgentifyConfig } from "../../src/core/types.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Build a stub Model<Api> for testing. */
function stubModel(provider: string, id: string): Model<Api> {
  return {
    id,
    name: id,
    api: "anthropic-messages",
    provider,
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 8000,
  } as unknown as Model<Api>;
}

/** Stub registry: find() looks up by provider+id, getAvailable() returns all. */
function stubRegistry(models: ReadonlyArray<Model<Api>>): ModelRegistry {
  return {
    find: (provider: string, id: string) =>
      models.find((m) => m.provider === provider && m.id === id),
    getAvailable: () => [...models],
    getAll: () => [...models],
  } as unknown as ModelRegistry;
}

async function spawnExplorerUsesExplorerSlotNotParentModel(): Promise<void> {
  const cwd = tempDir("spawn-slot-explorer-");
  try {
    const parentModel = stubModel("openai", "gpt-4o");
    const explorerModel = stubModel("anthropic", "claude-haiku-4-5-20251001");
    const liteModel = stubModel("openai", "gpt-4o-mini");
    const registry = stubRegistry([parentModel, explorerModel, liteModel]);
    const config: AgentifyConfig = {
      provider: "openai",
      model: "gpt-4o",
      thinkingLevel: "high",
      modelsByRole: {
        primary: { provider: "openai", model: "gpt-4o" },
        explorer: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
        lite: { provider: "openai", model: "gpt-4o-mini" },
      },
    };

    // Verify the resolver picks the explorer slot, not the parent.
    const resolved = selectModelForRole(registry, config, "explorer");
    assert.ok(resolved, "resolver must produce a model for explorer");
    assert.equal(resolved.model.provider, "anthropic");
    assert.equal(resolved.model.id, "claude-haiku-4-5-20251001");
    assert.equal(resolved.source, "explicit-slot");

    // Verify the tool is built with the explorer model.
    let capturedModel: Model<Api> | undefined;
    const tool = createSpawnExplorerTool({
      agentDir: cwd,
      stateDir: ".pi/agentify",
      explorerModel,
      modelRegistry: registry,
      createSession: async (sessionOptions) => {
        capturedModel = sessionOptions!.model as Model<Api>;
        return {
          session: {
            messages: [],
            async prompt(): Promise<void> {},
            dispose(): void {},
          },
        };
      },
    });

    await tool.execute(
      "test-spawn-slot-explorer",
      { mode: "topography", target_path: "." } as never,
      undefined,
      undefined,
      { cwd } as never,
    );

    assert.ok(capturedModel, "createSession must be invoked");
    assert.equal(capturedModel.provider, "anthropic", "explorer sub-agent must run on the explorer slot");
    assert.equal(capturedModel.id, "claude-haiku-4-5-20251001");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function spawnExplorerExplicitModelLiteralMapsToRegistryModel(): Promise<void> {
  const cwd = tempDir("spawn-slot-literal-");
  try {
    const haiku = stubModel("anthropic", "claude-haiku-4-5-20251001");
    const sonnet = stubModel("anthropic", "claude-sonnet-4-6");
    const registry = stubRegistry([haiku, sonnet]);

    let capturedModel: Model<Api> | undefined;
    const tool = createSpawnExplorerTool({
      agentDir: cwd,
      stateDir: ".pi/agentify",
      explorerModel: haiku,
      modelRegistry: registry,
      createSession: async (sessionOptions) => {
        capturedModel = sessionOptions!.model as Model<Api>;
        return {
          session: {
            messages: [],
            async prompt(): Promise<void> {},
            dispose(): void {},
          },
        };
      },
    });

    await tool.execute(
      "test-spawn-slot-literal",
      { mode: "topography", target_path: ".", model: "sonnet" } as never,
      undefined,
      undefined,
      { cwd } as never,
    );

    assert.ok(capturedModel);
    assert.equal(capturedModel.id, "claude-sonnet-4-6", "literal 'sonnet' must resolve to sonnet in registry");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function spawnExplorerInheritWithoutExplorerSlotUsesParent(): Promise<void> {
  const cwd = tempDir("spawn-slot-inherit-");
  try {
    const parentModel = stubModel("openai", "gpt-4o");
    const registry = stubRegistry([parentModel]);
    const config: AgentifyConfig = {
      provider: "openai",
      model: "gpt-4o",
      thinkingLevel: "high",
      // No modelsByRole.explorer — unset.
    };

    // Resolver: explorer unset → inherit primary via legacy fields
    // (treated as the implicit primary for inheritance).
    const resolved = selectModelForRole(registry, config, "explorer");
    assert.ok(resolved, "resolver must produce a model for explorer via inheritance");
    assert.equal(resolved.source, "inherited-primary");
    assert.equal(resolved.model.provider, "openai");
    assert.equal(resolved.model.id, "gpt-4o");

    let capturedModel: Model<Api> | undefined;
    const tool = createSpawnExplorerTool({
      agentDir: cwd,
      stateDir: ".pi/agentify",
      // explorerModel defaults to parent's resolved model.
      explorerModel: resolved.model,
      modelRegistry: registry,
      createSession: async (sessionOptions) => {
        capturedModel = sessionOptions!.model as Model<Api>;
        return {
          session: {
            messages: [],
            async prompt(): Promise<void> {},
            dispose(): void {},
          },
        };
      },
    });

    await tool.execute(
      "test-spawn-slot-inherit",
      { mode: "topography", target_path: ".", model: "inherit" } as never,
      undefined,
      undefined,
      { cwd } as never,
    );

    assert.ok(capturedModel);
    assert.equal(capturedModel.provider, "openai");
    assert.equal(capturedModel.id, "gpt-4o");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "spawnExplorerUsesExplorerSlotNotParentModel", fn: spawnExplorerUsesExplorerSlotNotParentModel },
  { name: "spawnExplorerExplicitModelLiteralMapsToRegistryModel", fn: spawnExplorerExplicitModelLiteralMapsToRegistryModel },
  { name: "spawnExplorerInheritWithoutExplorerSlotUsesParent", fn: spawnExplorerInheritWithoutExplorerSlotUsesParent },
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
console.log(`spawn-explorer slot tests passed (${passed}/${tests.length}).`);