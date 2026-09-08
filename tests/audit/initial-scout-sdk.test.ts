import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { withInitialScoutCheckpoint } from "../../src/core/audit/initial-scout-checkpoint.ts";
import { PiSdkRuntime } from "../../src/core/pi-sdk-runtime.ts";
import { AuditResourceBudget } from "../../src/core/audit/resource-budget.ts";
import { ExplorerReceiptTracker, currentRepositoryCommit, checkpointExplorerConcernEvidence } from "../../src/core/audit/explorer-receipts.ts";
import { loadCanonicalMapAt, writeCanonicalMap } from "../../src/core/audit/map-storage.ts";
import { createWriteMapTools } from "../../src/core/audit/write-map-tools.ts";
import { assessAuditCompletion, COVERAGE_DIMENSIONS } from "../../src/core/audit/schema.ts";
import { createReadOnlyExecutionPolicy } from "../../src/core/security/execution-policy.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";

test("actual SDK semantic repair refuses coverage explorers before child admission while permitting a missing scout", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-repair-scope-sdk-"));
  const stateDir = ".agentify/runtime/audit";
  const payloads: Array<Record<string, unknown>> = [];
  const outcomes: Array<{ isError: boolean; result: unknown }> = [];
  let parentCalls = 0;
  let scoutCalls = 0;
  const modes = ["topography", "gap_filler", "custom", "concern_scout"];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    payloads.push(payload);
    const scout = payload.model === "scout-fixture";
    const index = scout ? ++scoutCalls : ++parentCalls;
    const mode = modes[index - 1];
    const tool = scout ? index % 2 === 1 : index <= modes.length;
    const delta = tool ? { role: "assistant", tool_calls: [{
      index: 0, id: `${scout ? "scout" : "parent"}_${index}`, type: "function", function: {
        name: scout ? "read" : "spawn_explorer",
        arguments: JSON.stringify(scout ? { path: "README.md" } : {
          mode, target_path: mode === "concern_scout" ? "." : `${stateDir}/codebase_map.json`,
          ...(mode === "gap_filler" ? { focus: "D1_topography" } : {}),
          ...(mode === "custom" ? { system_prompt: "Read the map and repeat the topography audit." } : {}),
        }),
      },
    }] } : { role: "assistant", content: scout
      ? "## Report\ntarget_path: .\nconcerns:\n - concern: Request validation\n   seed_paths:\n    - README.md\nrejected: []"
      : "fixture complete" };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: `response_${payloads.length}`, choices: [{
      index: 0, delta, finish_reason: tool ? "tool_calls" : "stop",
    }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    fs.writeFileSync(path.join(cwd, "README.md"), "Immutable request validation fixture.\n");
    for (const args of [["init", "-q"], ["config", "user.name", "Agentify Test"],
      ["config", "user.email", "test@example.invalid"], ["add", "."], ["commit", "-qm", "repair fixture"]]) {
      execFileSync("git", args, { cwd, stdio: "pipe" });
    }
    const address = server.address();
    assert.ok(address && typeof address === "object");
    fs.writeFileSync(path.join(cwd, "models.json"), JSON.stringify({ providers: {
      openai: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions",
        apiKey: "local-test-placeholder", models: ["parent-fixture", "scout-fixture"].map(id => ({
          id, contextWindow: 32768, maxTokens: 128,
          cost: { input: 0.1, output: 0.1, cacheRead: 0.1, cacheWrite: 0.1 },
        })) },
    } }));
    const map = makeValidCodebaseMap({ expert_evidence: undefined });
    writeCanonicalMap(cwd, map, { stateDir, mapFilename: "codebase_map.json" });
    const before = fs.readFileSync(path.join(cwd, stateDir, "codebase_map.json"), "utf8");
    const budget = new AuditResourceBudget();
    const parent = budget.beginSession();
    const repairOptions = { spawnExplorerPurpose: "specialist-repair" as const };
    const result = await new PiSdkRuntime().runSession({
      cwd, configDir: cwd,
      config: { schemaVersion: 1, thinkingLevel: "off", models: {
        primary: { provider: "openai", model: "parent-fixture" },
        explorer: { provider: "openai", model: "scout-fixture" },
      } },
      systemPrompt: "Local deterministic repair transport fixture.", userPrompt: "Resolve a missing scout receipt.",
      tools: ["write_map_delta", "spawn_explorer"], customTools: [createWriteMapTools({ stateDir }).writeMapDeltaTool],
      spawnExplorerAgentDir: cwd, spawnExplorerStateDir: stateDir, ...repairOptions,
      auditResourceBudget: budget, timeoutMs: 10_000,
      onProviderRequest: reservation => budget.recordProviderRequest(parent, reservation),
      onEvent(event) {
        budget.observeParentEvent(event, parent);
        if (event.type === "tool_execution_end" && event.toolName === "spawn_explorer") outcomes.push(event);
      },
      executionPolicy: createReadOnlyExecutionPolicy({ cwd, mode: "audit-readonly", tools: [] }),
    });
    assert.equal(result.aborted, false);
    assert.equal(parentCalls, 5);
    assert.equal(scoutCalls, 2, "only the explicitly permitted scout can dispatch child model requests");
    assert.equal(budget.snapshot().explorer_spawns, 1);
    assert.equal(budget.snapshot().model_calls, 7, "refused child dispatches spend no shared request budget");
    assert.equal(budget.snapshot().unreported_calls, 0);
    assert.deepEqual(outcomes.map(outcome => outcome.isError), [true, true, true, false]);
    const parentPayload = payloads.find(payload => payload.model === "parent-fixture")!;
    const tools = parentPayload.tools as Array<{ function: { name: string; parameters: {
      properties: { mode: { enum: string[] } };
    } } }>;
    assert.deepEqual(tools.find(tool => tool.function.name === "spawn_explorer")?.function.parameters.properties.mode.enum,
      ["concern_scout", "concern_tracer"], "the model sees the same restricted modes the executor enforces");
    assert.equal(fs.readFileSync(path.join(cwd, stateDir, "codebase_map.json"), "utf8"), before,
      "refused exploration and a scout report grant neither map changes nor installation credit");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

for (const phase of ["initial", "coverage-recovery"] as const) {
test(`actual SDK launches automatic scouts only during the initial audit: ${phase}`, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-initial-scout-sdk-"));
  const stateDir = ".agentify/runtime/audit";
  const payloads: Array<Record<string, unknown>> = [];
  let parentCalls = 0;
  let scoutCalls = 0;
  let tracerCalls = 0;
  const report = "## Report\ntarget_path: .\nwhat_this_repository_does: Fixture request validation.\nconcerns:\n - concern: Request validation\n   seed_paths:\n    - README.md\nrejected: []";
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    payloads.push(payload);
    const child = payload.model === "scout-fixture";
    const trace = child && JSON.stringify(payload.tools).includes("submit_concern_report");
    const scout = child && !trace;
    const index = trace ? ++tracerCalls : scout ? ++scoutCalls : ++parentCalls;
    const tool = trace ? index <= 2 : scout ? index === 1 : index <= 2;
    const body = { concern: "Request validation", one_line: "Provides the fixture validation result.",
      covers: "The validate function and its return value.", excludes: "Transport and persistence.",
      flows: [{ name: "Validate a request", description: "Invoke validate and return its fixture result.", steps: [
        { path: "src/index.ts", what_happens: "The exported validate function is invoked." },
        { path: "src/index.ts", what_happens: "validate returns true to the caller." },
      ] }], touchpoints: [{ path: "src/index.ts", symbol: "validate", role: "Owns the fixture validation decision.",
        line_range: null, centrality: "core" }], invariants: [], pitfalls: [], entry_questions: ["Does this change the validation result?"],
      validation: [], spans_subtrees: ["src"], stability: "high", recurrence: "high", confidence: "high" };
    const delta = tool ? { role: "assistant", tool_calls: [{
      index: 0, id: `${trace ? "tracer" : scout ? "scout" : "parent"}_${index}`, type: "function", function: {
        name: trace ? index === 1 ? "read" : "submit_concern_report" : scout ? "read" : "write_map_delta",
        arguments: JSON.stringify(trace ? index === 1 ? { path: "src/index.ts" } : { report_json: JSON.stringify(body) }
          : scout ? { path: "README.md" } : {
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
      ...(phase === "coverage-recovery" ? { spawnExplorerPurpose: phase } : {}),
      auditResourceBudget: budget, timeoutMs: 10_000,
      onProviderRequest: reservation => budget.recordProviderRequest(parentBudget, reservation),
      onEvent(event) {
        budget.observeParentEvent(event, parentBudget);
        tracker.observe(event);
        checkpointExplorerConcernEvidence(cwd, stateDir, event);
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
    const expectedScouts = phase === "initial" ? 1 : 0;
    assert.equal(scoutCalls, expectedScouts * 2, "coverage recovery cannot trigger an automatic scout");
    assert.equal(tracerCalls, expectedScouts * 2, "initial tracing reads real source and submits its body before parent continuation");
    assert.equal(budget.snapshot().explorer_spawns, expectedScouts * 2);
    assert.equal(budget.snapshot().model_calls, 3 + expectedScouts * 4, "parent and child requests retain shared admission/accounting");
    assert.equal(budget.snapshot().unreported_calls, 0);
    assert.equal(events.filter(e => e.type === "tool_execution_start" && e.toolName === "spawn_explorer").length, expectedScouts * 2);
    assert.equal(events.filter(e => e.type === "tool_execution_end" && e.toolName === "spawn_explorer").length, expectedScouts * 2);
    const scouts = payloads.filter(p => p.model === "scout-fixture");
    if (phase === "initial") assert.ok(JSON.stringify(scouts[1]?.messages).includes("Test fixture evidence citation."),
      "the scout must actually receive readable repository source, not a blocked read result");
    const parents = payloads.filter(p => p.model === "parent-fixture");
    if (phase === "initial") assert.ok(JSON.stringify(parents[1]?.messages).includes("Request validation"), "parent continuation receives the real scout report");
    const finalMap = loadCanonicalMapAt(cwd, stateDir)!;
    assert.equal(tracker.assess(finalMap).successful_scouts, expectedScouts);
    if (phase === "initial") assert.equal(finalMap.explorer_receipts?.receipts[0]?.mode, "concern_scout");
    else assert.equal(finalMap.explorer_receipts, undefined, "no synthetic receipt may be created by coverage recovery");
    if (phase === "initial") {
      assert.deepEqual(finalMap.concern_evidence?.concerns.map(body => body.concern), ["Request validation"]);
      assert.deepEqual(finalMap.explorer_receipts?.receipts[1]?.observed_paths, ["src/index.ts"]);
      const tracerPayloads = payloads.filter(p => JSON.stringify(p.tools).includes("submit_concern_report"));
      assert.ok(JSON.stringify(tracerPayloads[1]?.messages).includes("export const validate = () => true;"));
    } else assert.equal(finalMap.concern_evidence, undefined, "coverage recovery cannot invent or retrace a specialist");
    assert.equal(finalMap.specialist_reviews, undefined, "actual source tracing still grants no review approval");
    assert.equal(assessAuditCompletion(finalMap, { cwd }).complete, false, "scout alone never grants installation credit");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
}


for (const scenario of ["bounded-batch", "failed-scout", "empty-scout", "cancelled-scout", "changed-head", "existing-portfolio", "failed-child", "concurrent-writes", "cancelled-child", "thrown-child", "empty-legacy"] as const) {
  test(`initial discovery traces a bounded first batch without claiming installation: ${scenario}`, async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-initial-trace-batch-"));
    const stateDir = ".agentify/runtime/audit";
    const controller = new AbortController();
    try {
      fs.writeFileSync(path.join(cwd, "README.md"), "Test fixture evidence citation.\n");
      for (const args of [["init", "-q"], ["config", "user.name", "Fixture"], ["config", "user.email", "test@example.invalid"],
        ["add", "."], ["commit", "-qm", "immutable initial discovery"]]) execFileSync("git", args, { cwd, stdio: "pipe" });
      const map = makeValidCodebaseMap({ expert_evidence: undefined });
      if (scenario === "empty-legacy") map.expert_evidence = { expert_domains: [] };
      if (scenario === "existing-portfolio") {
        const existing = makeValidCodebaseMap();
        map.concern_evidence = existing.concern_evidence;
        // A prior portfolio is not a new automatic tracing batch, even when its
        // independent missing scout still needs to execute.
        map.expert_evidence = existing.expert_evidence;
        map.concern_evidence = { concerns: [{ concern: "Existing validation", one_line: "Owns validation.",
          covers: "Fixture validation.", excludes: "Other behavior.",
          flows: [{ name: "Validate", description: "Check and return.", steps: [
            { path: "README.md", what_happens: "Defines the fixture." },
            { path: "README.md", what_happens: "Documents the validation result." },
          ] }], touchpoints: [{ path: "README.md", symbol: null, role: "Records validation.", centrality: "core", line_range: null }],
          invariants: [], pitfalls: [], entry_questions: ["What changes validation?"], validation: [], spans_subtrees: [],
          stability: "high", recurrence: "high", confidence: "high", last_updated: "2026-09-08T00:00:00.000Z",
        }], not_concerns: [] };
      }
      for (const dimension of COVERAGE_DIMENSIONS) if (dimension !== "D1_topography") {
        map.coverage[dimension] = { status: "gap", confidence: "low", evidence_summary: "Not observed.", evidence: [] };
      }
      writeCanonicalMap(cwd, map, { stateDir, mapFilename: "codebase_map.json" });
      const calls: Array<{ mode: string; concern?: string; focus?: string }> = [];
      const events: AgentSessionEvent[] = [];
      let active = 0;
      let peak = 0;
      const written = { content: [{ type: "text" as const, text: "Map checkpoint." }], details: { path: "codebase_map.json" } };
      const writer = { name: "write_map_delta", async execute() { return written; } } as unknown as ToolDefinition;
      const proposals = Array.from({ length: 7 }, (_, index) => `Concern ${index}`);
      const scout = { name: "spawn_explorer", async execute(_id: string, params: { mode: string; concern?: string; focus?: string }) {
        calls.push(params);
        if (params.mode === "concern_scout") {
          if (scenario === "cancelled-scout") controller.abort();
          if (scenario === "changed-head") execFileSync("git", ["commit", "--allow-empty", "-qm", "changed identity"], { cwd, stdio: "pipe" });
          return { content: [{ type: "text", text: scenario === "empty-scout" ? "No concern proposals." :
            "## Report\nconcerns:\n" + [...proposals, proposals[0]].map(name => ` - concern: ${name}\n   seed_paths: [README.md]`).join("\n") }],
            isError: scenario === "failed-scout", details: { mode: "concern_scout", target_path: "." } };
        }
        peak = Math.max(peak, ++active);
        await new Promise<void>(resolve => setImmediate(resolve));
        active -= 1;
        if (scenario === "cancelled-child") controller.abort();
        if (scenario === "thrown-child" && params.concern === "Concern 1") throw new Error("child dispatch failed");
        return { content: [{ type: "text", text: "An actual child disposition, not installation approval." }],
          isError: scenario === "failed-child" && params.concern === "Concern 1",
          details: { mode: "concern_tracer", target_path: ".", expected_concern: params.concern } };
      } } as unknown as ToolDefinition;
      const tools = withInitialScoutCheckpoint([writer], { stateDir, scout, onEvent: event => { events.push(event); } });
      let result: Awaited<ReturnType<ToolDefinition["execute"]>>;
      if (scenario === "thrown-child") {
        await assert.rejects(() => tools[0]!.execute("topography", {}, controller.signal, undefined, { cwd } as never),
          /child dispatch failed/);
        result = written;
      } else if (scenario === "concurrent-writes") {
        const writes = await Promise.all(["topography", "concurrent"].map(id =>
          tools[0]!.execute(id, {}, controller.signal, undefined, { cwd } as never)));
        result = writes[0]!;
      } else result = await tools[0]!.execute("topography", {}, controller.signal, undefined, { cwd } as never);
      await tools[0]!.execute("another-checkpoint", {}, controller.signal, undefined, { cwd } as never);
      const traceExpected = ["bounded-batch", "failed-child", "concurrent-writes", "cancelled-child", "thrown-child", "empty-legacy"].includes(scenario);
      const traces = calls.filter(call => call.mode === "concern_tracer");
      assert.equal(calls.filter(call => call.mode === "concern_scout").length, 1, "concurrent/later map writes cannot duplicate initial discovery");
      assert.deepEqual(traces.map(call => call.concern), traceExpected ? proposals.slice(0, 4) : []);
      assert.equal(peak, traceExpected ? 4 : 0, "only one existing four-child batch runs automatically");
      assert.ok(traces.every(call => !Object.hasOwn(call, "max_reads") && !Object.hasOwn(call, "max_total_steps")),
        "automatic work must retain the trusted per-mode budgets, not introduce overrides");
      assert.equal(events.filter(event => event.type === "tool_execution_start" && event.toolName === "spawn_explorer").length,
        traceExpected ? 5 : 1);
      assert.equal(events.filter(event => event.type === "tool_execution_end" && event.toolName === "spawn_explorer").length,
        traceExpected ? 5 : 1);
      assert.equal((result.details as { path: string }).path, "codebase_map.json");
      const final = loadCanonicalMapAt(cwd, stateDir)!;
      assert.equal(final.specialist_reviews, undefined, "dispatching discovery never fabricates narrative approval");
      assert.equal(assessAuditCompletion(final, { cwd }).complete, false);
      if (traceExpected && scenario !== "thrown-child") {
        assert.match(JSON.stringify(result.content), /remaining.*proposals|unstarted.*proposals/i,
          "the parent must retain the unstarted proposals rather than silently dropping them");
      }
      assert.equal(active, 0, "every admitted child must settle before returning or throwing");
      if (scenario === "cancelled-child") {
        const ends = events.filter(event => event.type === "tool_execution_end" && event.toolCallId.startsWith("agentify-initial-trace:"));
        assert.ok(ends.every(event => event.type === "tool_execution_end" && event.isError),
          "cancelled source results cannot become successful receipts");
      }
      if (scenario === "failed-child" || scenario === "thrown-child") assert.ok(events.some(event => event.type === "tool_execution_end"
        && event.toolName === "spawn_explorer" && event.isError === true), "failed children remain failed receipts");
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });
}
