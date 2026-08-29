import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  checkpointExplorerConcernEvidence,
} from "../../src/core/audit/explorer-receipts.ts";
import { loadCanonicalMapAt, writeCanonicalMap } from "../../src/core/audit/map-storage.ts";
import {
  createConcernSubmissionTool,
  parseStructuredConcernReport,
  shouldForceConcernSubmission,
} from "../../src/core/audit/spawn-explorer-tool.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";

const REPORT = `## Report
\`\`\`json
{
  "concern": "Request extraction and rejection contracts",
  "one_line": "Owns converting request parts and bodies into typed handler inputs.",
  "covers": "Parts-first extraction, one body consumer, and typed rejection conversion.",
  "excludes": "Route matching and response rendering after successful extraction.",
  "flows": [{
    "name": "extract handler arguments",
    "description": "Request parts are extracted before one body-consuming extractor.",
    "steps": [
      { "path": "src/extract/mod.rs", "what_happens": "Runs parts-only extractors." },
      { "path": "src/extract/rejection.rs", "what_happens": "Converts failures into typed rejections." }
    ]
  }],
  "touchpoints": [
    { "path": "src/extract/mod.rs", "symbol": "FromRequest", "role": "Defines extraction ordering.", "line_range": null, "centrality": "core" },
    { "path": "src/extract/rejection.rs", "symbol": "rejections", "role": "Defines public failure behavior.", "line_range": null, "centrality": "core" }
  ],
  "invariants": [{ "rule": "Only one extractor consumes the body.", "why": "The body stream is not replayable.", "reference": "src/extract/mod.rs" }],
  "pitfalls": [{ "risk": "A parts extractor reads the body.", "consequence": "Later extraction fails.", "reference": "src/extract/mod.rs" }],
  "entry_questions": ["Does this change consume the request body?"],
  "validation": [],
  "spans_subtrees": ["src"],
  "stability": "high",
  "recurrence": "high",
  "confidence": "high",
  "adjacent_concerns": ["routing"],
  "blocker_reason": null
}
\`\`\``;

test("the simple tracer envelope retains the complete nested concern contract", () => {
  const prompt = fs.readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../src/core/audit/prompts/explorers/concern_tracer.md",
    ),
    "utf8",
  );
  for (const field of [
    '"one_line": string',
    '"covers": string',
    '"excludes": string',
    '"line_range": [number, number] | null',
    '"what_happens": string',
    '"validation": string[]',
  ]) {
    assert.ok(prompt.includes(field), `tracer prompt is missing ${field}`);
  }
});

test("a tracer must submit as soon as its repository-read budget is exhausted", () => {
  assert.equal(shouldForceConcernSubmission(4, 8, 5, 6), false);
  assert.equal(shouldForceConcernSubmission(4, 8, 6, 6), true);
  assert.equal(shouldForceConcernSubmission(6, 8, 2, 6), true);
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("a valid structured tracer report is checkpointed without parent retranscription", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-concern-checkpoint-"));
  try {
    fs.mkdirSync(path.join(cwd, "src/extract"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "README.md"), "fixture\n");
    fs.writeFileSync(path.join(cwd, "src/extract/mod.rs"), "pub trait FromRequest {}\n");
    fs.writeFileSync(path.join(cwd, "src/extract/rejection.rs"), "pub enum Rejection {}\n");
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "fixture");
    const map = makeValidCodebaseMap({ concern_evidence: { concerns: [], not_concerns: [] }, expert_evidence: undefined });
    writeCanonicalMap(cwd, map, { stateDir: ".agentify/runtime/audit", mapFilename: "codebase_map.json" });

    const concern = parseStructuredConcernReport(REPORT, "2026-08-29T00:00:00.000Z");
    assert.equal(concern?.concern, "Request extraction and rejection contracts");
    assert.equal(concern?.last_updated, "2026-08-29T00:00:00.000Z");
    checkpointExplorerConcernEvidence(cwd, ".agentify/runtime/audit", {
      type: "tool_execution_end",
      toolName: "spawn_explorer",
      details: { mode: "concern_tracer", structured_concern: concern },
    });

    const persisted = loadCanonicalMapAt(cwd, ".agentify/runtime/audit");
    assert.equal(persisted?.concern_evidence?.concerns.length, 1);
    assert.deepEqual(persisted?.concern_evidence?.concerns[0], concern);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("blocked and malformed tracer reports remain unresolved", () => {
  assert.equal(parseStructuredConcernReport(
    REPORT.replace('"blocker_reason": null', '"blocker_reason": "The implementation is untracked."'),
    "2026-08-29T00:00:00.000Z",
  ), null);
  assert.equal(parseStructuredConcernReport("## Report\nnot json", "2026-08-29T00:00:00.000Z"), null);
});

test("tracked touchpoints deterministically supply omitted subtree metadata", () => {
  const concern = parseStructuredConcernReport(
    REPORT.replace('  "spans_subtrees": ["src"],\n', ""),
    "2026-08-29T00:00:00.000Z",
  );
  assert.deepEqual(concern?.spans_subtrees, ["src"]);
});

test("the tracer submits its concern through an application-owned typed tool", async () => {
  let submitted: ReturnType<typeof parseStructuredConcernReport> = null;
  const parsed = JSON.parse(REPORT.match(/```json\s*([\s\S]*?)```/u)?.[1] ?? "null") as Record<string, unknown>;
  delete parsed.spans_subtrees;
  delete parsed.adjacent_concerns;
  delete parsed.blocker_reason;
  const tool = createConcernSubmissionTool("2026-08-29T00:00:00.000Z", (concern) => {
    submitted = concern;
  });
  const parameters = tool.parameters as {
    properties?: Record<string, { maxLength?: number }>;
  };
  assert.deepEqual(
    Object.keys(parameters.properties ?? {}),
    ["report_json"],
    "provider-facing submission must stay a simple bounded envelope",
  );
  assert.equal(
    parameters.properties?.report_json?.maxLength,
    32_768,
    "transport must admit one bounded retry body so Agentify can enforce its smaller canonical artifact cap",
  );
  const result = await tool.execute(
    "submit",
    { report_json: JSON.stringify(parsed) } as never,
    undefined,
    undefined,
    {} as never,
  );
  assert.equal((result as { isError?: boolean }).isError, undefined);
  const concern = submitted as unknown as { concern: string; spans_subtrees: string[] };
  assert.equal(concern.concern, "Request extraction and rejection contracts");
  assert.deepEqual(concern.spans_subtrees, ["src"]);
});

test("the tracer envelope rejects malformed and oversized JSON before recording", async () => {
  let submissions = 0;
  const tool = createConcernSubmissionTool("2026-08-29T00:00:00.000Z", () => {
    submissions += 1;
  });
  const malformed = await tool.execute(
    "submit",
    { report_json: "{" } as never,
    undefined,
    undefined,
    {} as never,
  );
  assert.equal((malformed as { isError?: boolean }).isError, true);

  const parsed = JSON.parse(REPORT.match(/```json\s*([\s\S]*?)```/u)?.[1] ?? "null") as Record<string, unknown>;
  parsed.covers = "evidence ".repeat(3_000);
  const oversized = await tool.execute(
    "submit",
    { report_json: JSON.stringify(parsed) } as never,
    undefined,
    undefined,
    {} as never,
  );
  assert.equal((oversized as { isError?: boolean }).isError, true);
  assert.equal(submissions, 0);
});

test("the tracer normalizes domain-locked absolute evidence paths", async () => {
  let submitted: ReturnType<typeof parseStructuredConcernReport> = null;
  const parsed = JSON.parse(REPORT.match(/```json\s*([\s\S]*?)```/u)?.[1] ?? "null") as {
    touchpoints: Array<{ path: string }>;
  };
  parsed.touchpoints[0]!.path = "/repo/src/extract/mod.rs";
  const factory = createConcernSubmissionTool as unknown as (
    observedAt: string,
    onSubmit: (concern: NonNullable<typeof submitted>) => void,
    repositoryRoot: string,
  ) => ReturnType<typeof createConcernSubmissionTool>;
  const tool = factory("2026-08-29T00:00:00.000Z", (concern) => {
    submitted = concern;
  }, "/repo");
  const result = await tool.execute(
    "submit",
    { report_json: JSON.stringify(parsed) } as never,
    undefined,
    undefined,
    {} as never,
  );
  assert.equal((result as { isError?: boolean }).isError, undefined);
  assert.equal((submitted as unknown as { touchpoints: Array<{ path: string }> }).touchpoints[0]?.path, "src/extract/mod.rs");

  parsed.touchpoints[0]!.path = "/outside/src/extract/mod.rs";
  const outside = await tool.execute(
    "submit",
    { report_json: JSON.stringify(parsed) } as never,
    undefined,
    undefined,
    {} as never,
  );
  assert.equal((outside as { isError?: boolean }).isError, true);
});

test("the tracer reports exact validation locations and normalizes tracked path references", async () => {
  let submitted: ReturnType<typeof parseStructuredConcernReport> = null;
  const parsed = JSON.parse(REPORT.match(/```json\s*([\s\S]*?)```/u)?.[1] ?? "null") as {
    flows: Array<{ steps: unknown[] }>;
    invariants: Array<{ reference: string }>;
  };
  parsed.flows[0]!.steps = parsed.flows[0]!.steps.slice(0, 1);
  const tool = createConcernSubmissionTool("2026-08-29T00:00:00.000Z", (concern) => {
    submitted = concern;
  }, "/repo");
  const invalid = await tool.execute(
    "submit",
    { report_json: JSON.stringify(parsed) } as never,
    undefined,
    undefined,
    {} as never,
  ) as { content: Array<{ type: string; text: string }>; isError?: boolean };
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0]?.text ?? "", /\/flows\/0\/steps/u);

  parsed.flows[0]!.steps = [
    { path: "src/extract/mod.rs", what_happens: "Runs parts-only extractors." },
    { path: "src/extract/rejection.rs", what_happens: "Converts failures into typed rejections." },
  ];
  parsed.invariants[0]!.reference = "src/extract/mod.rs FromRequest";
  const valid = await tool.execute(
    "submit",
    { report_json: JSON.stringify(parsed) } as never,
    undefined,
    undefined,
    {} as never,
  );
  assert.equal((valid as { isError?: boolean }).isError, undefined);
  assert.equal(
    (submitted as unknown as { invariants: Array<{ reference: string }> }).invariants[0]?.reference,
    "src/extract/mod.rs",
  );

  parsed.invariants[0]!.reference = "src/other.rs OtherSymbol";
  const unrelated = await tool.execute(
    "submit",
    { report_json: JSON.stringify(parsed) } as never,
    undefined,
    undefined,
    {} as never,
  );
  assert.equal((unrelated as { isError?: boolean }).isError, true);
});
