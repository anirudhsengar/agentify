import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createWriteMapTools,
  loadCanonicalMapAt,
} from "../../src/core/audit/write-map-tool.ts";
import { createGapDraftMap } from "../../src/core/audit/map-draft.ts";

const stateDir = ".agentify/runtime/audit";

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-d9-repair-"));
  fs.writeFileSync(path.join(dir, "README.md"), "repo");
  fs.mkdirSync(path.join(dir, ".github", "ISSUE_TEMPLATE"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".github", "ISSUE_TEMPLATE", "bug_report.md"), "---\nname: Bug report\n---\n");
  fs.writeFileSync(path.join(dir, ".github", "ISSUE_TEMPLATE", "release_tables.md"), "---\nname: Release Tables\n---\n");
  return dir;
}

async function executeTool(
  tool: ToolDefinition,
  params: unknown,
  cwd: string,
): Promise<Awaited<ReturnType<NonNullable<ToolDefinition["execute"]>>>> {
  assert.ok(tool.execute, `${tool.name} must expose execute`);
  return tool.execute(
    `d9-repair-${tool.name}`,
    params as never,
    undefined,
    undefined,
    { cwd } as never,
  );
}

const repo = tempRepo();
const tools = createWriteMapTools({ stateDir });
const draft = createGapDraftMap();
await executeTool(tools.writeMapTool, { map: draft }, repo);

const delta = {
  meta: {
    lifecycle: {
      sdlc_model: "Eclipse ECA + Grinder CI",
      issue_types: [],
    },
  },
  coverage: {
    D9_process: {
      status: "covered",
      confidence: "high",
      evidence_summary: "Issue templates observed.",
      evidence: [
        { path: ".github/ISSUE_TEMPLATE/bug_report.md", excerpt: "name: bug", kind: "positive" },
        { path: ".github/ISSUE_TEMPLATE/release_tables.md", excerpt: "name: release", kind: "positive" },
      ],
    },
  },
};

const result = await executeTool(tools.writeMapDeltaTool, { delta }, repo);
const map = loadCanonicalMapAt(repo, stateDir);

assert.notEqual((result as { isError?: boolean }).isError, true, `unexpected tool error: ${JSON.stringify(result)}`);
assert.ok(map, "map should be persisted");
assert.deepEqual(map.meta.lifecycle.issue_types, ["bug_report", "release_tables"], "issue_types should be inferred");
assert.equal(map.coverage.D9_process.status, "covered", "D9 should remain covered");
