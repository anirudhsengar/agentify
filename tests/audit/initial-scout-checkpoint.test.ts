import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Type } from "typebox";
import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { withInitialScoutCheckpoint } from "../../src/core/audit/initial-scout-checkpoint.ts";
import { currentRepositoryCommit, ExplorerReceiptTracker } from "../../src/core/audit/explorer-receipts.ts";
import { loadCanonicalMapAt, writeCanonicalMap } from "../../src/core/audit/map-storage.ts";
import { createWriteMapTools } from "../../src/core/audit/write-map-tools.ts";
import { COVERAGE_DIMENSIONS } from "../../src/core/audit/schema.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";

const SCENARIOS = ["once", "concurrent", "failed-write", "open-topography", "prior-success", "stale-receipt",
  "prior-failure", "scout-failure", "cancel-before", "cancel-after", "scout-throws"] as const;
for (const operation of ["write_map", "write_map_delta"] as const) for (const scenario of SCENARIOS) {
  test(`${operation} initial scout checkpoint preserves provenance and dispatch bounds: ${scenario}`, async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-initial-scout-"));
    const stateDir = ".agentify/runtime/audit";
    const controller = new AbortController();
    const events: AgentSessionEvent[] = [];
    const tracker = new ExplorerReceiptTracker();
    let calls = 0;
    let traces = 0;
    const failure = new Error("fixture scout failure");
    try {
      fs.writeFileSync(path.join(cwd, "README.md"), "Test fixture evidence citation.\n");
      fs.mkdirSync(path.join(cwd, "src"));
      fs.writeFileSync(path.join(cwd, "src/index.ts"), "export const validate = () => true;\n");
      for (const args of [
        ["init", "-q"], ["config", "user.name", "Agentify Test"],
        ["config", "user.email", "agentify@example.invalid"], ["add", "."], ["commit", "-qm", "scout checkpoint fixture"],
      ]) execFileSync("git", args, { cwd, stdio: "pipe" });
      const map = makeValidCodebaseMap({ expert_evidence: undefined });
      for (const dimension of COVERAGE_DIMENSIONS) {
        if (dimension !== "D1_topography" || scenario === "open-topography") {
          map.coverage[dimension] = { status: "gap", confidence: "low", evidence_summary: "Not observed.", evidence: [] };
        }
      }
      if (["prior-success", "prior-failure", "stale-receipt"].includes(scenario)) {
        map.explorer_receipts = {
          repository_commit: scenario === "stale-receipt" ? "0".repeat(40) : currentRepositoryCommit(cwd)!,
          run_id: "prior", receipts: [{ sequence: 1, mode: "concern_scout", success: scenario !== "prior-failure",
            target_path: ".", focus: null, report_concern: null, failure_kind: scenario === "prior-failure" ? "error" : null }],
        };
      }
      writeCanonicalMap(cwd, map, { stateDir, mapFilename: "codebase_map.json" });
      const tools = createWriteMapTools({ stateDir });
      const originalDescription = tools.writeMapDeltaTool.description;
      const scout: ToolDefinition = {
        name: "spawn_explorer", label: "Fixture scout", description: "Test-only scout implementation.",
        parameters: Type.Object({ mode: Type.String(), target_path: Type.String() }),
        async execute(_id, params, signal) {
          assert.equal(signal, controller.signal);
          const input = params as { mode: string; target_path: string; concern?: string; focus?: string };
          if (input.mode === "concern_tracer") {
            assert.equal(input.target_path, ".");
            assert.equal(input.concern, "Fixture validation");
            assert.match(input.focus ?? "", /untrusted search guidance/);
            traces += 1;
            // Scheduling a child is not successful tracing. This unit fixture
            // deliberately supplies no validated body or observed-source credit.
            return { content: [{ type: "text" as const, text: "Fixture tracer remains unresolved." }], isError: true,
              details: { mode: "concern_tracer", target_path: ".", expected_concern: input.concern } };
          }
          assert.deepEqual(params, { mode: "concern_scout", target_path: "." });
          calls += 1;
          await new Promise<void>(resolve => setTimeout(resolve, 2));
          if (scenario === "scout-throws") throw failure;
          if (scenario === "cancel-after") controller.abort();
          return { content: [{ type: "text" as const, text: "## Report\nconcerns:\n - concern: Fixture validation" }],
            details: { mode: "concern_scout", target_path: "." }, ...(scenario === "scout-failure" ? { isError: true } : {}) };
        },
      };
      const wrapped = withInitialScoutCheckpoint([tools.writeMapTool, tools.writeMapDeltaTool, scout], {
        stateDir, scout, onEvent(event) { events.push(event); tracker.observe(event); },
      });
      assert.equal(wrapped[2], scout, "unrelated tool identity is preserved");
      const write = wrapped.find(tool => tool.name === operation)!;
      if (scenario === "cancel-before") controller.abort();
      const invoke = (id: string) => write.execute(id,
        scenario === "failed-write" ? { delta: "" } : operation === "write_map"
          ? { map: loadCanonicalMapAt(cwd, stateDir) } : { delta: { open_questions: ["Trace evidence."] } },
        controller.signal, undefined, { cwd } as never);
      if (scenario === "scout-throws") {
        await assert.rejects(invoke("first"), error => error === failure, "preserve the original scout exception");
      } else if (scenario === "concurrent") {
        await Promise.all([invoke("first"), invoke("second")]);
      } else {
        const result = await invoke("first");
        if (scenario === "once") assert.ok(JSON.stringify(result.content).includes("Fixture validation"));
      }
      await invoke("last");
      const shouldLaunch = !["failed-write", "open-topography", "prior-success", "cancel-before"].includes(scenario);
      assert.equal(calls, shouldLaunch ? 1 : 0, "automatic dispatch occurs at most once, only with valid topography and no current receipt");
      const failed = ["scout-failure", "cancel-after", "scout-throws"].includes(scenario);
      assert.equal(traces, shouldLaunch && !failed ? 1 : 0, "only a successful scout hands off one distinct fixture proposal");
      assert.equal(events.length, (calls + traces) * 2, "one start and one end describe each actual scout or tracer dispatch");
      const current = loadCanonicalMapAt(cwd, stateDir)!;
      assert.equal(tracker.assess(current).successful_scouts, shouldLaunch && !failed ? 1 : 0);
      assert.equal(current.concern_evidence, undefined, "an unresolved tracer cannot fabricate a specialist body");
      assert.equal(tracker.assess(current).successful_tracers.length, 0, "dispatch alone cannot grant a successful source receipt");
      for (const dimension of COVERAGE_DIMENSIONS) {
        assert.equal(current.coverage[dimension].status, map.coverage[dimension].status,
          "scout scheduling does not change coverage truth");
      }
      assert.equal(tools.writeMapDeltaTool.description, originalDescription, "caller-owned tools are not mutated");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}
