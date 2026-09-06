import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createWriteMapTools, loadCanonicalMapAt } from "../../src/core/audit/write-map-tool.ts";
import { COVERAGE_DIMENSIONS, specialistEvidenceRecorded } from "../../src/core/audit/schema.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";

for (const scenario of ["closed-focus", "unresolved-focus", "fully-closed"] as const) {
  test(`delta repair guidance matches trusted closure: ${scenario}`, async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-repair-focus-"));
    const stateDir = ".agentify/runtime/audit";
    try {
      fs.mkdirSync(path.join(cwd, "src"));
      fs.writeFileSync(path.join(cwd, "README.md"), "Test fixture evidence citation.\n");
      fs.writeFileSync(path.join(cwd, "src/index.ts"), 'export { enabled } from "./lib.ts";\n');
      fs.writeFileSync(path.join(cwd, "src/lib.ts"), "export const enabled = true;\n");
      fs.writeFileSync(path.join(cwd, "src/types.ts"), "export interface Config { enabled: boolean }\n");
      for (const args of [
        ["init", "-q"], ["config", "user.name", "Agentify Test"],
        ["config", "user.email", "agentify@example.invalid"],
        ["add", "."], ["commit", "-qm", "repair focus fixture"],
      ]) execFileSync("git", args, { cwd, stdio: "pipe" });
      const map = makeValidCodebaseMap();
      delete map.expert_evidence;
      delete map.concern_evidence;
      map.type_contract_surface.typescript_interfaces = [
        { path: "src/types.ts", name: "Config", fields: ["enabled"] },
      ];
      const gaps = scenario === "fully-closed" ? [] : ["D2_module_boundaries", "D3_type_contract"] as const;
      for (const dimension of gaps) {
        map.coverage[dimension] = {
          status: "gap", confidence: "low", evidence_summary: "Not explored yet.", evidence: [],
        };
      }
      const tools = createWriteMapTools({ stateDir });
      const initial = await tools.writeMapTool.execute("repair-seed", { map } as never,
        undefined, undefined, { cwd } as never);
      assert.notEqual((initial as { isError?: boolean }).isError, true, JSON.stringify(initial));
      const seeded = initial.details as { coverage_summary: { gap: string[] } };
      assert.deepEqual(seeded.coverage_summary.gap, [...gaps], "fixture must establish the intended closure");
      const dimension = scenario === "unresolved-focus" ? "D3_type_contract" : "D1_topography";
      const result = await tools.writeMapDeltaTool.execute("repair-delta", {
        dimension,
        merge_strategy: "deep_merge",
        delta: { open_questions: ["Specialist discovery remains required."] },
        ...(scenario === "unresolved-focus" ? { evidence: [] } : {}),
      } as never, undefined, undefined, { cwd } as never);
      assert.notEqual((result as { isError?: boolean }).isError, true, JSON.stringify(result));
      const details = result.details as { coverage_summary: { covered: string[]; gap: string[] } };
      assert.deepEqual(details.coverage_summary.gap, [...gaps]);
      assert.ok(details.coverage_summary.covered.includes("D1_topography"));
      const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      const guidance = / Repair guidance: (.*?)(?= Concern evidence|$)/s.exec(text)?.[1];
      if (scenario === "fully-closed") {
        assert.equal(guidance, undefined, "a closed map has no coverage repairs");
      } else {
        assert.ok(guidance, "remaining gaps must retain repair guidance");
        assert.doesNotMatch(guidance, /D1_topography:/, "closed focus must not be reintroduced as a gap");
        for (const gap of gaps) assert.equal(guidance.split(`${gap}:`).length - 1, 1);
        if (scenario === "unresolved-focus") {
          assert.match(guidance, /^D3_type_contract:/, "a still-unresolved focus stays first");
        } else {
          assert.match(guidance, /^D2_module_boundaries:/, "otherwise retain trusted unresolved order");
        }
      }
      const persisted = loadCanonicalMapAt(cwd, stateDir);
      assert.ok(persisted);
      assert.equal(specialistEvidenceRecorded(persisted), false);
      for (const name of COVERAGE_DIMENSIONS) {
        assert.equal(persisted.coverage[name].status, gaps.some((gap) => gap === name) ? "gap" : "covered",
          "feedback must not promote unsupported evidence or reopen closed coverage");
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}
