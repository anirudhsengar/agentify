import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createWriteMapTools, loadCanonicalMapAt } from "../../src/core/audit/write-map-tool.ts";
import { COVERAGE_DIMENSIONS, specialistEvidenceRecorded } from "../../src/core/audit/schema.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";

for (const toolName of ["write_map", "write_map_delta"] as const) {
  for (const covered of [false, true]) {
    test(`${toolName} specialist feedback preserves ${covered ? "closed" : "unresolved"} coverage obligations`, async () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-map-feedback-"));
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
          ["add", "."], ["commit", "-qm", "map feedback fixture"],
        ]) execFileSync("git", args, { cwd, stdio: "pipe" });
        const map = makeValidCodebaseMap();
        map.type_contract_surface.typescript_interfaces = [
          { path: "src/types.ts", name: "Config", fields: ["enabled"] },
        ];
        if (!covered) for (const dimension of COVERAGE_DIMENSIONS) {
          map.coverage[dimension] = {
            status: "gap", confidence: "low", evidence_summary: "Not explored yet.", evidence: [],
          };
        }
        assert.equal(specialistEvidenceRecorded(map), false);
        const tools = createWriteMapTools({ stateDir });
        const initial = await tools.writeMapTool.execute("feedback-seed", { map } as never,
          undefined, undefined, { cwd } as never);
        assert.notEqual((initial as { isError?: boolean }).isError, true, JSON.stringify(initial));
        const result = toolName === "write_map" ? initial
          : await tools.writeMapDeltaTool.execute("feedback-delta", {
            delta: { open_questions: ["Specialist discovery remains required."] },
          } as never, undefined, undefined, { cwd } as never);
        assert.notEqual((result as { isError?: boolean }).isError, true, JSON.stringify(result));
        const text = result.content.filter((part) => part.type === "text")
          .map((part) => part.text).join("\n");
        const details = result.details as { coverage_summary: { covered: string[]; gap: string[] } };
        assert.deepEqual(details.coverage_summary.gap, covered ? [] : [...COVERAGE_DIMENSIONS]);
        assert.deepEqual(details.coverage_summary.covered, covered ? [...COVERAGE_DIMENSIONS] : []);
        assert.match(text, /Concern evidence is not recorded yet/);
        assert.doesNotMatch(text, /they are already covered/);
        if (covered) {
          assert.match(text, /All coverage dimensions are closed; preserve that evidence/);
          assert.doesNotMatch(text, /Coverage remains unresolved for/);
        } else {
          assert.match(text, /Coverage remains unresolved for/);
          assert.match(text, /Continue recording source-backed evidence for these dimensions/);
          assert.doesNotMatch(text, /All coverage dimensions are closed/);
          for (const dimension of COVERAGE_DIMENSIONS) assert.ok(text.includes(dimension));
        }
        const persisted = loadCanonicalMapAt(cwd, stateDir);
        assert.ok(persisted);
        assert.equal(specialistEvidenceRecorded(persisted), false, "feedback must not manufacture specialist evidence");
        for (const dimension of COVERAGE_DIMENSIONS) {
          assert.equal(persisted.coverage[dimension].status, covered ? "covered" : "gap",
            "feedback must not promote gaps or discard closed coverage");
        }
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
}
