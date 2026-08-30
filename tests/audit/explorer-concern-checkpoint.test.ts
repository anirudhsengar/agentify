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
  activeExplorerToolsAfterRead,
  concernSubmissionSteerMessage,
  createConcernSubmissionTool,
  parseStructuredConcernReport,
  shouldForceConcernSubmission,
} from "../../src/core/audit/spawn-explorer-tool.ts";
import { assessSpecialistEvidence } from "../../src/core/audit/specialist-completion.ts";
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
  assert.deepEqual(
    activeExplorerToolsAfterRead("concern_tracer", 6, 6, ["read", "grep", "submit_concern_report"]),
    ["submit_concern_report"],
  );
  assert.deepEqual(
    activeExplorerToolsAfterRead("module_graph", 10, 10, ["read", "grep"]),
    ["read", "grep"],
  );
  assert.match(
    concernSubmissionSteerMessage("concern_tracer", 6, 6) ?? "",
    /call submit_concern_report now; do not request another repository tool/iu,
  );
  assert.equal(concernSubmissionSteerMessage("concern_tracer", 5, 6), null);
  assert.equal(concernSubmissionSteerMessage("module_graph", 6, 6), null);
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

test("the tracer cannot rename its application-bound concern identity", async () => {
  let submissions = 0;
  const parsed = JSON.parse(REPORT.match(/```json\s*([\s\S]*?)```/u)?.[1] ?? "null") as Record<string, unknown>;
  const factory = createConcernSubmissionTool as unknown as (
    observedAt: string,
    onSubmit: () => void,
    repositoryRoot: string | undefined,
    expectedConcern: string,
  ) => ReturnType<typeof createConcernSubmissionTool>;
  const tool = factory("2026-08-29T00:00:00.000Z", () => {
    submissions += 1;
  }, undefined, "Request parsing and rejection contracts");
  const result = await tool.execute(
    "submit",
    { report_json: JSON.stringify(parsed) } as never,
    undefined,
    undefined,
    {} as never,
  ) as { content: Array<{ type: string; text: string }>; isError?: boolean };
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /must exactly match.*Request parsing and rejection contracts/i);
  assert.equal(submissions, 0);
});

test("a retracer cannot replace the application-bound concern scope", async () => {
  let submissions = 0;
  const parsed = JSON.parse(REPORT.match(/```json\s*([\s\S]*?)```/u)?.[1] ?? "null") as Record<string, unknown>;
  const factory = createConcernSubmissionTool as unknown as (
    observedAt: string,
    onSubmit: () => void,
    repositoryRoot: string | undefined,
    expectedConcern: string,
    requiredScopePaths: readonly string[],
  ) => ReturnType<typeof createConcernSubmissionTool>;
  const tool = factory("2026-08-29T00:00:00.000Z", () => {
    submissions += 1;
  }, undefined, "Request extraction and rejection contracts", ["src/owner/controller.ts"]);
  const replaced = await tool.execute(
    "submit-replacement",
    { report_json: JSON.stringify(parsed) } as never,
    undefined,
    undefined,
    {} as never,
  ) as { content: Array<{ type: string; text: string }>; isError?: boolean };
  assert.equal(replaced.isError, true);
  assert.match(replaced.content[0]?.text ?? "", /preserve.*application-bound.*scope/i);
  assert.equal(submissions, 0);

  const preserving = factory("2026-08-29T00:00:00.000Z", () => {
    submissions += 1;
  }, undefined, "Request extraction and rejection contracts", ["src/extract/mod.rs"]);
  const accepted = await preserving.execute(
    "submit-preserving",
    { report_json: JSON.stringify(parsed) } as never,
    undefined,
    undefined,
    {} as never,
  );
  assert.equal((accepted as { isError?: boolean }).isError, undefined);
  assert.equal(submissions, 1);
});

test("a retracer cannot trade one covered repository obligation for another", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-concern-monotonic-"));
  try {
    fs.mkdirSync(path.join(cwd, "src/extract"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "src/model"), { recursive: true });
    for (const repositoryPath of [
      "README.md",
      "src/index.ts",
      "src/lib.ts",
      "src/extract/mod.rs",
      "src/extract/rejection.rs",
      "src/model/person.rs",
    ]) {
      fs.writeFileSync(path.join(cwd, repositoryPath), "fixture\n");
    }
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "fixture");

    const currentConcern = parseStructuredConcernReport(REPORT, "2026-08-29T00:00:00.000Z");
    assert.ok(currentConcern);
    currentConcern.touchpoints.push({
      path: "src/model/person.rs",
      symbol: "Person",
      role: "Carries the previously verified request identity.",
      line_range: null,
      centrality: "supporting",
    });
    const currentMap = makeValidCodebaseMap({
      skeleton: {
        ...makeValidCodebaseMap().skeleton,
        first_5_files_for_fresh_agent: [{
          path: "src/model/person.rs",
          why: "Previously covered public request identity.",
        }],
      },
      concern_evidence: { concerns: [currentConcern], not_concerns: [] },
      expert_evidence: undefined,
    });
    assert.ok(
      assessSpecialistEvidence(currentMap, { cwd }).covered_paths.includes("src/model/person.rs"),
      "the baseline fixture must close the tracked Person obligation",
    );
    let submissions = 0;
    const parsed = JSON.parse(REPORT.match(/```json\s*([\s\S]*?)```/u)?.[1] ?? "null") as {
      touchpoints: Array<Record<string, unknown>>;
    };
    const regressiveConcern = parseStructuredConcernReport(REPORT, "2026-08-29T00:00:00.000Z");
    assert.ok(regressiveConcern);
    assert.ok(
      assessSpecialistEvidence({
        ...currentMap,
        concern_evidence: { concerns: [regressiveConcern], not_concerns: [] },
      }, { cwd }).uncovered_paths.includes("src/model/person.rs"),
      "the replacement fixture must reopen the tracked Person obligation",
    );
    const factory = createConcernSubmissionTool as unknown as (
      observedAt: string,
      onSubmit: () => void,
      repositoryRoot: string,
      expectedConcern: string,
      requiredScopePaths: readonly string[],
      existingMap: typeof currentMap,
    ) => ReturnType<typeof createConcernSubmissionTool>;
    const tool = factory("2026-08-29T00:00:00.000Z", () => {
      submissions += 1;
    }, cwd, currentConcern.concern, ["src/extract/mod.rs"], currentMap);

    const regressive = await tool.execute(
      "submit-regressive",
      { report_json: JSON.stringify(parsed) } as never,
      undefined,
      undefined,
      {} as never,
    ) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    assert.equal(regressive.isError, true);
    assert.match(regressive.content[0]?.text ?? "", /newly uncovered.*src\/model\/person\.rs/iu);
    assert.equal(submissions, 0);

    parsed.touchpoints.push({
      path: "src/model/person.rs",
      symbol: "Person",
      role: "Retains the previously verified request identity.",
      line_range: null,
      centrality: "supporting",
    });
    const monotonic = await tool.execute(
      "submit-monotonic",
      { report_json: JSON.stringify(parsed) } as never,
      undefined,
      undefined,
      {} as never,
    );
    assert.equal((monotonic as { isError?: boolean }).isError, undefined);
    assert.equal(submissions, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
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
