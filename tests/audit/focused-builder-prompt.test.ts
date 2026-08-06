import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf-8");
}

test("focused audit prompt requests only operational map evidence", () => {
  const prompt = read("src/core/audit/prompts/builder.md");

  for (const required of [
    /focused\s+Agentify\s+installer/i,
    /internal\s+operational\s+state/i,
    /specialist\s+and\s+procedure\s+portfolio/i,
    /Do\s+not\s+create\s+or\s+edit\s+application\s+files/i,
    /write_map/,
    /write_map_delta/,
    /<stateDir>\/codebase_map\.json/,
  ]) {
    assert.match(prompt, required);
  }

  for (const forbidden of [
    "agentic-surface bootstrapper",
    "TypeScript renderers write",
    ".agents/skills/",
    ".pi/agents/",
    ".pi/prompts/",
    ".pi/extensions/",
    "/experts:",
    "Artifact emission",
  ]) {
    assert.ok(!prompt.includes(forbidden), `focused audit prompt must not include: ${forbidden}`);
  }
});

test("package-internal explorer templates remain absent", () => {
  const templatePath = path.join(
    REPO_ROOT,
    "src/core/audit/prompts/explorers/_template.md",
  );
  assert.equal(
    fs.existsSync(templatePath),
    false,
    "the obsolete custom explorer template must not return to source or package inputs",
  );

  const prompt = read("src/core/audit/prompts/builder.md");
  assert.match(prompt, /package-internal prompt templates/);
  assert.ok(
    !prompt.includes("_template.md"),
    "the focused prompt must use durable package-boundary language",
  );
});

test("audit fields and explorer tools remain evidence-only", () => {
  const evidence = read("src/core/audit/schema/evidence.ts");
  const intents = read("src/core/audit/schema/artifact-intents.ts");
  const writeParams = read("src/core/audit/schema/write-map-params.ts");
  const spawnExplorer = read("src/core/audit/spawn-explorer-tool.ts");
  const combined = `${evidence}\n${intents}\n${writeParams}\n${spawnExplorer}`;

  assert.match(evidence, /operational evidence only/);
  assert.match(evidence, /read-only specialists/);
  assert.match(intents, /Optional artifact evidence/);
  assert.match(intents, /installer does not render/i);
  assert.match(writeParams, /configured audit state directory/);
  assert.match(writeParams, /specialist-discovery, and task-planning code/);
  assert.match(spawnExplorer, /Self-contained inline system prompt for a custom read-only explorer/);
  assert.doesNotMatch(spawnExplorer, /system_prompt_file|allow_external_paths|max_bash_invocations/);
  assert.match(spawnExplorer, /resolveTargetPath\(params\.target_path, ctx\.cwd\)/);
  assert.match(spawnExplorer, /isPathInside\(resolvedTarget, ctx\.cwd\)/);

  for (const forbidden of [
    ".pi/extensions/",
    ".pi/skills/",
    ".pi/prompts/experts/",
    ".pi/agents/",
    ".pi/prompts/",
    "/experts:",
    "Used verbatim in AGENTS.md",
  ]) {
    assert.ok(!combined.includes(forbidden), `active audit contracts must not direct: ${forbidden}`);
  }

  for (const forbidden of [
    "_template.md",
    "wants to write the prompt to disk",
    "Compose the prompt from the 11-section template",
  ]) {
    assert.ok(!spawnExplorer.includes(forbidden), `spawn_explorer must not direct: ${forbidden}`);
  }
});
