import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { PiSdkRuntime } from "../../src/core/pi-sdk-runtime.ts";
import { AuditResourceBudget } from "../../src/core/audit/resource-budget.ts";
import { ExplorerReceiptTracker, currentRepositoryCommit } from "../../src/core/audit/explorer-receipts.ts";
import { loadCanonicalMapAt, writeCanonicalMap } from "../../src/core/audit/map-storage.ts";
import { createWriteMapTools } from "../../src/core/audit/write-map-tools.ts";
import { assessAuditCompletion, COVERAGE_DIMENSIONS } from "../../src/core/audit/schema.ts";
import { createReadOnlyExecutionPolicy } from "../../src/core/security/execution-policy.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";

test("actual SDK launches an accounted scout after topography even when the parent never chooses spawn_explorer", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-initial-scout-sdk-"));
  const stateDir = ".agentify/runtime/audit";
  const payloads: Array<Record<string, unknown>> = [];
  let parentCalls = 0;
  let scoutCalls = 0;
  const report = "## Report\ntarget_path: .\nwhat_this_repository_does: Fixture request validation.\nconcerns:\n - concern: Request validation\n   seed_paths:\n    - README.md\nrejected: []";
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    payloads.push(payload);
    const scout = payload.model === "scout-fixture";
    const index = scout ? ++scoutCalls : ++parentCalls;
    const tool = scout ? index === 1 : index <= 2;
    const delta = tool ? { role: "assistant", tool_calls: [{
      index: 0, id: `${scout ? "scout" : "parent"}_${index}`, type: "function", function: {
        name: scout ? "read" : "write_map_delta",
        arguments: JSON.stringify(scout ? { path: "README.md" } : {
          delta: { open_questions: ["Complete specialist source tracing."] }, merge_strategy: "deep_merge",
        }),
      },
    }] } : { role: "assistant", content: scout ? report : "fixture complete" };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: `${scout ? "scout" : "parent"}_${index}`, choices: [{
      index: 0, delta, finish_reason: tool ? "tool_calls" : "stop",
    }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    fs.writeFileSync(path.join(cwd, "README.md"), "Test fixture evidence citation.\n");
    fs.mkdirSync(path.join(cwd, "src"));
    fs.writeFileSync(path.join(cwd, "src/index.ts"), "export const validate = () => true;\n");
    for (const args of [
      ["init", "-q"], ["config", "user.name", "Agentify Test"],
      ["config", "user.email", "agentify@example.invalid"], ["add", "."], ["commit", "-qm", "scout fixture"],
    ]) execFileSync("git", args, { cwd, stdio: "pipe" });
    fs.writeFileSync(path.join(cwd, "models.json"), JSON.stringify({ providers: {
      openai: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions",
        apiKey: "local-test-placeholder", models: ["parent-fixture", "scout-fixture"].map(id => ({
          id, contextWindow: 32768, maxTokens: 128,
          cost: { input: 0.1, output: 0.1, cacheRead: 0.1, cacheWrite: 0.1 },
        })) },
    } }));
    const map = makeValidCodebaseMap({ expert_evidence: undefined });
    for (const dimension of COVERAGE_DIMENSIONS) {
      if (dimension !== "D1_topography") {
        map.coverage[dimension] = { status: "gap", confidence: "low", evidence_summary: "Not observed.", evidence: [] };
      }
    }
    writeCanonicalMap(cwd, map, { stateDir, mapFilename: "codebase_map.json" });
    const tools = createWriteMapTools({ stateDir });
    const budget = new AuditResourceBudget();
    const parentBudget = budget.beginSession();
    const tracker = new ExplorerReceiptTracker();
    const events: Array<{ type: string; toolName?: string }> = [];
    const result = await new PiSdkRuntime().runSession({
      cwd, configDir: cwd,
      config: { schemaVersion: 1, thinkingLevel: "off", models: {
        primary: { provider: "openai", model: "parent-fixture" },
        explorer: { provider: "openai", model: "scout-fixture" },
      } },
      systemPrompt: "Local deterministic parent fixture.", userPrompt: "Record topography.",
      tools: ["read", "write_map_delta", "spawn_explorer"], customTools: [tools.writeMapDeltaTool],
      spawnExplorerAgentDir: cwd, spawnExplorerStateDir: stateDir,
      auditResourceBudget: budget, timeoutMs: 10_000,
      onProviderRequest: reservation => budget.recordProviderRequest(parentBudget, reservation),
      onEvent(event) {
        budget.observeParentEvent(event, parentBudget);
        tracker.observe(event);
        events.push(event as { type: string; toolName?: string });
        if (event.type === "tool_execution_end" && event.toolName === "spawn_explorer") {
          const current = loadCanonicalMapAt(cwd, stateDir)!;
          current.explorer_receipts = tracker.attestation(currentRepositoryCommit(cwd)!, "fixture");
          writeCanonicalMap(cwd, current, { stateDir, mapFilename: "codebase_map.json" });
        }
      },
      executionPolicy: createReadOnlyExecutionPolicy({ cwd, mode: "audit-readonly", tools: ["read"] }),
    });
    assert.equal(result.aborted, false);
    assert.equal(parentCalls, 3);
    assert.equal(scoutCalls, 2, "the real scout must read source and return its report exactly once");
    assert.equal(budget.snapshot().explorer_spawns, 1);
    assert.equal(budget.snapshot().model_calls, 5, "parent and child requests retain shared admission/accounting");
    assert.equal(budget.snapshot().unreported_calls, 0);
    assert.equal(events.filter(e => e.type === "tool_execution_start" && e.toolName === "spawn_explorer").length, 1);
    assert.equal(events.filter(e => e.type === "tool_execution_end" && e.toolName === "spawn_explorer").length, 1);
    const scouts = payloads.filter(p => p.model === "scout-fixture");
    assert.ok(JSON.stringify(scouts[1]?.messages).includes("Test fixture evidence citation."),
      "the scout must actually receive readable repository source, not a blocked read result");
    const parents = payloads.filter(p => p.model === "parent-fixture");
    assert.ok(JSON.stringify(parents[1]?.messages).includes("Request validation"), "parent continuation receives the real scout report");
    const finalMap = loadCanonicalMapAt(cwd, stateDir)!;
    assert.equal(tracker.assess(finalMap).successful_scouts, 1);
    assert.equal(finalMap.explorer_receipts?.receipts[0]?.mode, "concern_scout");
    assert.equal(finalMap.concern_evidence, undefined, "scouting cannot fabricate a traced body");
    assert.equal(assessAuditCompletion(finalMap, { cwd }).complete, false, "scout alone never grants installation credit");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
