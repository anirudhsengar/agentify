import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createWriteMapTools } from "../../src/core/audit/write-map-tool.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentify-draft-transport-"));
}

function oversizedMap(label: string) {
  const map = makeValidCodebaseMap();
  map.meta.domain_hypothesis = `${label}:${"x".repeat(110_000)}`;
  return map;
}

async function execute(
  tools: ReturnType<typeof createWriteMapTools>,
  cwd: string,
  label: string,
) {
  return tools.writeMapTool.execute(
    `draft-${label}`,
    { map: oversizedMap(label), mode: "auto" } as never,
    undefined,
    undefined,
    { cwd } as never,
  );
}

const cwd = tempDir();
fs.writeFileSync(path.join(cwd, "README.md"), "Test fixture evidence citation.");
try {
  const first = createWriteMapTools({ stateDir: ".agentify/runtime/audit-a" });
  const second = createWriteMapTools({ stateDir: ".agentify/runtime/audit-b" });
  const [firstResult, secondResult] = await Promise.all([
    execute(first, cwd, "first"),
    execute(second, cwd, "second"),
  ]);
  assert.equal((firstResult as { isError?: boolean }).isError, undefined);
  assert.equal((secondResult as { isError?: boolean }).isError, undefined);
  const firstDraft = path.join(cwd, first.draftPathRelative);
  const secondDraft = path.join(cwd, second.draftPathRelative);
  assert.match(fs.readFileSync(firstDraft, "utf-8"), /first:/);
  assert.match(fs.readFileSync(secondDraft, "utf-8"), /second:/);
  assert.notEqual(firstDraft, secondDraft);
  for (const draft of [firstDraft, secondDraft]) {
    assert.deepEqual(fs.readdirSync(path.dirname(draft)).filter((name) => name.endsWith(".tmp")), []);
  }
} finally {
  fs.rmSync(cwd, { recursive: true, force: true });
}

console.log("configured draft transport tests passed");
