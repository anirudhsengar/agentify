import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import type { Concern } from "../../src/core/audit/schema/concerns.ts";
import {
  checkpointExplorerConcernEvidence,
  currentRepositoryCommit,
  ExplorerReceiptTracker,
} from "../../src/core/audit/explorer-receipts.ts";
import { loadCanonicalMapAt, writeCanonicalMap } from "../../src/core/audit/map-storage.ts";
import {
  activeExplorerToolsAfterRead,
  concernSubmissionSteerMessage,
  createConcernSubmissionTool,
  createSpawnExplorerTool,
  parseStructuredConcernReport,
  shouldForceConcernSubmission,
} from "../../src/core/audit/spawn-explorer-tool.ts";
import { assessSpecialistEvidence } from "../../src/core/audit/specialist-completion.ts";
import { compileSpecialistEvidence } from "../../src/core/audit/specialist-compiler.ts";
import { attestCodebaseMap, makeValidCodebaseMap } from "../fixtures/codebase-map.ts";
import { createWriteMapTools } from "../../src/core/audit/write-map-tools.ts";
import { assessSpecialistReviews } from "../../src/core/audit/specialist-review.ts";

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
    { "path": "src/extract/rejection.rs", "symbol": "Rejection", "role": "Defines public failure behavior.", "line_range": null, "centrality": "core" }
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

function groundedExtractionRepository(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-grounded-extraction-"));
  fs.mkdirSync(path.join(cwd, "src/extract"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src/extract/mod.rs"), "pub trait FromRequest {}\n");
  fs.writeFileSync(path.join(cwd, "src/extract/rejection.rs"), "pub enum Rejection {}\n");
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Agentify Test");
  git(cwd, "config", "user.email", "agentify@example.invalid");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "tracked extraction symbols");
  return cwd;
}

test("ownership-only repair preserves attested bodies without another tracer", async () => {
  const cwd = groundedExtractionRepository();
  try {
    fs.writeFileSync(path.join(cwd, "src/state.rs"), "pub struct Context {}\n");
    git(cwd, "add", "src/state.rs");
    git(cwd, "commit", "-qm", "tracked request context");
    const extraction = parseStructuredConcernReport(REPORT, "2026-08-31T00:00:00.000Z")!;
    const context: Concern = {
      ...structuredClone(extraction), concern: "Request context lifetime",
      one_line: "Owns the context acquired while extracting a request.",
      covers: "Request context acquisition and release.", excludes: "Typed rejection conversion.",
      touchpoints: [structuredClone(extraction.touchpoints[0]!), {
        path: "src/state.rs", symbol: "Context", role: "Owns request context lifetime.",
        centrality: "core", line_range: null,
      }],
      flows: [{ name: "acquire request context", description: "Extraction acquires a request context.", steps: [
        { path: "src/extract/mod.rs", what_happens: "Begins request extraction." },
        { path: "src/state.rs", what_happens: "Acquires request-local context." },
      ] }], invariants: [], pitfalls: [],
    };
    const original = attestCodebaseMap(makeValidCodebaseMap({
      expert_evidence: undefined, concern_evidence: { concerns: [extraction, context], not_concerns: [] },
    }), git(cwd, "rev-parse", "HEAD"));
    const tools = createWriteMapTools({ stateDir: ".agentify/runtime/audit" });
    const reset = () => writeCanonicalMap(cwd, original, {
      stateDir: ".agentify/runtime/audit", mapFilename: "codebase_map.json",
    });
    const resolve = (owner = extraction.concern, delta: unknown = {}) => tools.writeMapDeltaTool.execute!(
      "ownership", { delta, core_owner: { path: "src/extract/mod.rs", concern: owner } } as never,
      undefined, undefined, { cwd } as never,
    );
    reset();
    const result = await resolve();
    assert.notEqual((result as { isError?: boolean }).isError, true, JSON.stringify(result.content));
    const repaired = loadCanonicalMapAt(cwd, ".agentify/runtime/audit")!;
    const expected = structuredClone(original.concern_evidence!);
    expected.concerns[1]!.touchpoints[0]!.centrality = "supporting";
    assert.deepEqual(repaired.concern_evidence, expected);
    assert.deepEqual(repaired.explorer_receipts, original.explorer_receipts, "no fabricated retrace");
    assert.ok(assessSpecialistReviews(repaired, cwd).some(reason => reason.includes(context.concern)),
      "changed ownership must invalidate the normalized review");
    await resolve();
    assert.deepEqual(loadCanonicalMapAt(cwd, ".agentify/runtime/audit")!.concern_evidence, expected);

    for (const failure of ["stale", "unobserved", "supporting", "last-core", "no-flow", "body-change", "missing-owner", "forged-receipts"]) {
      reset();
      const input = loadCanonicalMapAt(cwd, ".agentify/runtime/audit")!;
      if (failure === "stale") input.explorer_receipts!.repository_commit = "0".repeat(40);
      if (failure === "unobserved" || failure === "forged-receipts") input.explorer_receipts!.receipts[2]!.observed_paths = ["src/state.rs"];
      if (failure === "supporting") input.concern_evidence!.concerns[0]!.touchpoints[0]!.centrality = "supporting";
      if (failure === "last-core") input.concern_evidence!.concerns[1]!.touchpoints[1]!.centrality = "supporting";
      if (failure === "no-flow") input.concern_evidence!.concerns[0]!.flows[0]!.steps = [
        { path: "src/extract/rejection.rs", what_happens: "Converts rejection." },
      ];
      writeCanonicalMap(cwd, input, { stateDir: ".agentify/runtime/audit", mapFilename: "codebase_map.json" });
      const before = fs.readFileSync(tools.canonicalMapPath(cwd), "utf8");
      const rejected = await resolve(failure === "missing-owner" ? "Unknown owner" : extraction.concern,
        failure === "body-change" ? { concern_evidence: { concerns: [{ ...extraction, covers: "Forged behavior." }] } }
          : failure === "forged-receipts" ? { explorer_receipts: original.explorer_receipts } : {});
      assert.equal((rejected as { isError?: boolean }).isError, true, failure);
      assert.equal(fs.readFileSync(tools.canonicalMapPath(cwd), "utf8"), before, failure);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

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

test("successful tracers return bounded current compiler obligations without extra model calls", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-tracer-feedback-"));
  const stateDir = ".agentify/runtime/audit";
  try {
    for (const repositoryPath of [
      "README.md", "src/extract/request.ts", "src/extract/rejection.ts", "src/extract/rejection.test.ts", "src/extract/extra.ts",
      "src/render/page.ts", "src/render/page.test.ts",
      ...Array.from({ length: 64 }, (_, index) => [
        `src/render/surface-${index}.ts`, `src/render/surface-${index}.test.ts`,
      ]).flat(),
    ]) {
      fs.mkdirSync(path.dirname(path.join(cwd, repositoryPath)), { recursive: true });
      fs.writeFileSync(path.join(cwd, repositoryPath), "// deterministic fixture\n");
    }
    fs.writeFileSync(path.join(cwd, "src/extract/request.ts"), "export interface FromRequest {}\n");
    fs.writeFileSync(path.join(cwd, "src/extract/rejection.ts"), "export class Rejection {}\n");
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "feedback fixture");
    writeCanonicalMap(cwd, makeValidCodebaseMap({
      concern_evidence: { concerns: [], not_concerns: [] }, expert_evidence: undefined,
    }), { stateDir, mapFilename: "codebase_map.json" });
    const report = REPORT.replaceAll("src/extract/mod.rs", "src/extract/request.ts")
      .replaceAll("src/extract/rejection.rs", "src/extract/rejection.ts");
    let sessions = 0;
    const tool = createSpawnExplorerTool({
      agentDir: cwd, stateDir,
      explorerModel: { id: "fixture", provider: "fixture", api: "openai-completions" } as Model<Api>,
      createSession: async (options) => {
        sessions += 1;
        const submit = options?.customTools?.find((candidate) => candidate.name === "submit_concern_report");
        assert.ok(submit);
        return { session: {
          messages: [], dispose(): void {},
          async prompt(task: string): Promise<void> {
            if (sessions === 2) {
              assert.match(task, /Prior current-HEAD attested concern/);
              assert.ok(task.includes("Request parts are extracted before one body-consuming extractor."));
            }
            const reads = sessions === 1
              ? ["src/extract/request.ts", "src/extract/rejection.ts"] : ["src/extract/extra.ts"];
            for (const repositoryPath of reads) {
              const input = { path: repositoryPath };
              const result = await createReadTool(cwd).execute("observe", input);
              for (const extension of options!.resourceLoader!.getExtensions().extensions) {
                for (const handler of extension.handlers.get("tool_result") ?? []) {
                  await handler({ type: "tool_result", toolCallId: "observe", toolName: "read", input, ...result, isError: false }, { cwd } as never);
                }
              }
            }
            const body = JSON.parse(report.match(/```json\s*([\s\S]*?)```/u)![1]!) as Concern;
            if (sessions === 2) body.touchpoints.push({ path: "src/extract/extra.ts", symbol: null,
              centrality: "supporting", role: "Provides newly observed extraction support.", line_range: null });
            const submitted = await submit.execute("submit", {
              report_json: JSON.stringify(body),
            }, undefined, undefined, { cwd } as never);
            assert.notEqual((submitted as { isError?: boolean }).isError, true);
          },
        } };
      },
    });
    const result = await tool.execute("trace", {
      mode: "concern_tracer", target_path: ".", concern: "Request extraction and rejection contracts",
    } as never, undefined, undefined, { cwd } as never);
    assert.notEqual((result as { isError?: boolean }).isError, true);
    const feedback = (result.details as { compiler_feedback?: {
      status: string; uncovered_path_count: number; uncovered_cluster_count: number;
      uncovered_paths: string[]; uncovered_clusters: unknown[];
    } }).compiler_feedback;
    assert.ok(feedback, "parent must receive fresh compiler obligations after a tracer");
    assert.equal(feedback.status, "incomplete");
    assert.ok(feedback.uncovered_paths.includes("src/render/page.ts"));
    assert.ok(!feedback.uncovered_paths.includes("src/extract/rejection.test.ts"));
    assert.ok(feedback.uncovered_cluster_count > feedback.uncovered_clusters.length);
    assert.ok(Buffer.byteLength(JSON.stringify(feedback), "utf8") <= 4_096);
    assert.ok(JSON.stringify(result.content).includes("compiler feedback"));
    assert.equal(sessions, 1, "compiler feedback must not create another model session");
    assert.equal(loadCanonicalMapAt(cwd, stateDir)?.concern_evidence?.concerns.length, 0);
    assert.equal(checkpointExplorerConcernEvidence(cwd, stateDir, {
      type: "tool_execution_end", toolName: "spawn_explorer", result,
    }), true);
    const compilation = compileSpecialistEvidence(loadCanonicalMapAt(cwd, stateDir)!, { cwd });
    assert.equal(feedback.uncovered_path_count, compilation.assessment.uncovered_paths.length);
    assert.equal(feedback.uncovered_cluster_count, compilation.assessment.uncovered_clusters.length);
    const tracker = new ExplorerReceiptTracker();
    tracker.observe({ type: "tool_execution_end", toolName: "spawn_explorer", result });
    const current = loadCanonicalMapAt(cwd, stateDir)!;
    current.explorer_receipts = tracker.attestation(currentRepositoryCommit(cwd)!, "prior-session");
    writeCanonicalMap(cwd, current, { stateDir, mapFilename: "codebase_map.json" });
    const repaired = await tool.execute("repair", {
      mode: "concern_tracer", target_path: ".", concern: "Request extraction and rejection contracts",
    } as never, undefined, undefined, { cwd } as never);
    assert.notEqual((repaired as { isError?: boolean }).isError, true, JSON.stringify(repaired.content));
    assert.deepEqual((repaired.details as { observed_paths: string[] }).observed_paths, ["src/extract/extra.ts"],
      "reused evidence must not be falsely attested as a new source observation");
    assert.equal(sessions, 2);
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

test("submission and compilation reject unsupported tracked-file symbol claims", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-symbol-grounding-"));
  try {
    fs.mkdirSync(path.join(cwd, "src"));
    fs.writeFileSync(path.join(cwd, "src/auth.ts"), "export function verify() {}\nexport function sign() {}\n");
    fs.writeFileSync(path.join(cwd, "src/index.ts"), "export { verify, sign } from './auth'\n");
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "tracked symbols");
    const original = parseStructuredConcernReport(
      REPORT.replaceAll("src/extract/mod.rs", "src/auth.ts")
        .replaceAll("src/extract/rejection.rs", "src/index.ts")
        .replace('"FromRequest"', '"verify, sign"')
        .replace('"Rejection"', '"verify / sign"'),
      "2026-08-29T00:00:00.000Z",
    );
    assert.ok(original);
    for (const scenario of ["valid", "missing-core-symbol", "missing-supporting-symbol", "untracked-step", "reexport-only-flow"]) {
      const invalid = scenario !== "valid";
      const report: Concern = structuredClone(original);
      if (scenario === "missing-core-symbol") report.touchpoints[0]!.symbol = "moduleMap";
      if (scenario === "missing-supporting-symbol") {
        report.touchpoints[1]!.symbol = "JWKRegistrar";
        report.touchpoints[1]!.centrality = "supporting";
      }
      if (scenario === "untracked-step") {
        fs.writeFileSync(path.join(cwd, "src/generated.ts"), "export function sign() {}\n");
        report.flows[0]!.steps.splice(1, 0, { path: "src/generated.ts", what_happens: "Signs the request." });
      }
      if (scenario === "reexport-only-flow") {
        report.flows[0]!.steps = [
          { path: "src/index.ts", what_happens: "Re-exports the verify entry point." },
          { path: "src/index.ts", what_happens: "Re-exports sign, allegedly completing credential validation." },
        ];
      }
      let recorded = false;
      const map = makeValidCodebaseMap({ concern_evidence: { concerns: [], not_concerns: [] }, expert_evidence: undefined });
      const tool = createConcernSubmissionTool("2026-08-29T00:00:00.000Z", () => {
        recorded = true;
      }, cwd, report.concern, [], map);
      // A dirty shadow must not make a nonexistent HEAD symbol appear grounded.
      fs.appendFileSync(path.join(cwd, "src/auth.ts"), "export const moduleMap = {}\n");
      const result = await tool.execute("submit", { report_json: JSON.stringify(report) } as never,
        undefined, undefined, {} as never) as { isError?: boolean; content: Array<{ text?: string }> };
      assert.equal(recorded, !invalid, `${scenario}: unsupported claims must never reach the receipt callback`);
      assert.equal(result.isError === true, invalid);
      if (scenario === "missing-core-symbol") assert.match(result.content[0]?.text ?? "", /moduleMap.*src\/auth\.ts|src\/auth\.ts.*moduleMap/);
      if (scenario === "reexport-only-flow") assert.match(result.content[0]?.text ?? "", /re-export.*implementation/);
      map.concern_evidence!.concerns = [report];
      const assessment = assessSpecialistEvidence(map, { cwd });
      assert.equal(assessment.accepted_concerns.includes(report.concern), !invalid,
        "compiler re-entry must enforce the same immutable symbol binding");
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("repair reuses only unchanged evidence attested at the current commit", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-attested-repair-"));
  try {
    for (const [file, source] of Object.entries({
      "src/extract/mod.rs": "pub trait FromRequest {}\n",
      "src/extract/rejection.rs": "pub enum Rejection {}\n",
      "src/fresh.rs": "pub struct Fresh;\n",
    })) {
      fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      fs.writeFileSync(path.join(cwd, file), source);
    }
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "Agentify Test");
    git(cwd, "config", "user.email", "agentify@example.invalid");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "attested repair fixture");
    const previous = parseStructuredConcernReport(REPORT, "2026-08-29T00:00:00.000Z");
    assert.ok(previous);
    for (const scenario of ["append", "centrality", "flow", "invariant", "role", "scope", "stale", "failed", "unattested", "moved-head"]) {
      const map = makeValidCodebaseMap({
        concern_evidence: { concerns: [previous], not_concerns: [] }, expert_evidence: undefined,
        explorer_receipts: {
          repository_commit: scenario === "stale" ? "0".repeat(40) : currentRepositoryCommit(cwd)!,
          run_id: "prior-trace",
          receipts: [{ sequence: 1, mode: "concern_tracer", success: scenario !== "failed",
            target_path: ".", focus: previous.concern, expected_concern: previous.concern,
            report_concern: previous.concern, failure_kind: scenario === "failed" ? "timeout" : null,
            observed_paths: ["src/extract/mod.rs", "src/extract/rejection.rs"],
          }],
        },
      });
      if (scenario === "unattested") delete map.explorer_receipts;
      const report = structuredClone(previous);
      report.touchpoints.push({ path: "src/fresh.rs", symbol: "Fresh", centrality: "supporting",
        role: "Carries the newly observed request state.", line_range: null });
      if (scenario === "centrality") report.touchpoints[1]!.centrality = "supporting";
      if (scenario === "flow") report.flows[0]!.steps[0]!.what_happens = "Invents different extraction behavior.";
      if (scenario === "invariant") report.invariants[0]!.rule = "Any extractor may consume the body twice.";
      if (scenario === "role") report.touchpoints[0]!.role = "Invents a different responsibility.";
      if (scenario === "scope") report.covers = "Invents new responsibility without observed evidence.";
      let recorded = false;
      const tool = createConcernSubmissionTool("2026-08-29T00:00:00.000Z", () => { recorded = true; },
        cwd, previous.concern, ["src/extract/mod.rs"], map, new Set(["src/fresh.rs"]));
      if (scenario === "moved-head") git(cwd, "commit", "--allow-empty", "-qm", "HEAD changed after dispatch");
      const result = await tool.execute("repair", { report_json: JSON.stringify(report) } as never,
        undefined, undefined, {} as never) as { isError?: boolean; content: Array<{ text?: string }> };
      const valid = scenario === "append" || scenario === "centrality";
      assert.equal(recorded, valid, `${scenario}: ${result.content[0]?.text}`);
      assert.equal(result.isError === true, !valid, scenario);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
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
    fs.writeFileSync(path.join(cwd, "src/extract/mod.rs"), "pub trait FromRequest {}\n");
    fs.writeFileSync(path.join(cwd, "src/extract/rejection.rs"), "pub enum Rejection {}\n");
    fs.writeFileSync(path.join(cwd, "src/model/person.rs"), "pub struct Person;\n");
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
    currentConcern.flows.push({
      name: "Previously verified rejection fallback",
      description: "A distinct verified path that shares already covered files.",
      steps: [
        {
          path: "src/extract/mod.rs",
          what_happens: "Attempts request extraction.",
        },
        {
          path: "src/extract/rejection.rs",
          what_happens: "Converts extraction failure into the public rejection.",
        },
      ],
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
      flows: Array<Record<string, unknown>>;
    };
    const preservedFlow = structuredClone(currentConcern.flows.at(-1)!);
    parsed.flows.push(preservedFlow);
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
    parsed.flows.pop();
    const flowRegressive = await tool.execute(
      "submit-monotonic",
      { report_json: JSON.stringify(parsed) } as never,
      undefined,
      undefined,
      {} as never,
    ) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    assert.equal(flowRegressive.isError, true);
    assert.match(flowRegressive.content[0]?.text ?? "", /preserve.*verified flow.*Previously verified rejection fallback/i);
    assert.equal(submissions, 0);

    parsed.flows.push(preservedFlow);
    const monotonic = await tool.execute(
      "submit-flow-monotonic",
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

test("one rejected submission explains multiple reference defects and its output cap", async () => {
  let submissions = 0;
  const tool = createConcernSubmissionTool("2026-08-29T00:00:00.000Z", () => { submissions += 1; });
  const parsed = JSON.parse(REPORT.match(/```json\s*([\s\S]*?)```/u)![1]!) as {
    invariants: Array<{ reference: string }>;
    pitfalls: Array<{ reference: string }>;
    covers: string;
  };
  parsed.invariants[0].reference = "src/extract/mod.rs:FromRequest";
  parsed.pitfalls[0].reference = "src/extract/rejection.rs Rejection";
  parsed.covers = "observed evidence ".repeat(1_100);
  const result = await tool.execute("submit", { report_json: JSON.stringify(parsed) } as never,
    undefined, undefined, {} as never);
  const feedback = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match(feedback, /\/invariants\/0\/reference/);
  assert.match(feedback, /\/pitfalls\/0\/reference/);
  assert.match(feedback, /one repository-relative file path/i);
  assert.match(feedback, /symbols.*line numbers.*prose/i);
  assert.match(feedback, /16000 bytes/);
  assert.match(feedback, new RegExp(`covers: ${Buffer.byteLength(JSON.stringify(parsed.covers))} bytes`),
    "oversized report repair needs exact section sizes, not repeated blind rewrites");
  assert.match(feedback, /remove at least [1-9][0-9]* bytes/);
  assert.ok(Buffer.byteLength(feedback) < 4_096, "repair feedback must remain bounded");
  assert.equal(submissions, 0);
});

test("schema feedback bounds large batches without accepting unresolved references", async () => {
  const tool = createConcernSubmissionTool("2026-08-29T00:00:00.000Z", () => {
    assert.fail("invalid references cannot be checkpointed");
  });
  const parsed = JSON.parse(REPORT.match(/```json\s*([\s\S]*?)```/u)![1]!) as {
    invariants: Array<{ rule: string; why: string; reference: string }>;
  };
  parsed.invariants = Array.from({ length: 100 }, () => ({
    rule: "One body consumer", why: "Streams cannot replay", reference: "src/extract/mod.rs:FromRequest",
  }));
  const result = await tool.execute("submit", { report_json: JSON.stringify(parsed) } as never,
    undefined, undefined, {} as never);
  const feedback = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match(feedback, /more/);
  assert.ok(Buffer.byteLength(feedback) < 4_096);
});

test("the tracer normalizes domain-locked absolute evidence paths", async (t) => {
  const cwd = groundedExtractionRepository();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  let submitted: ReturnType<typeof parseStructuredConcernReport> = null;
  const parsed = JSON.parse(REPORT.match(/```json\s*([\s\S]*?)```/u)?.[1] ?? "null") as {
    touchpoints: Array<{ path: string }>;
  };
  parsed.touchpoints[0]!.path = path.join(cwd, "src/extract/mod.rs");
  const factory = createConcernSubmissionTool as unknown as (
    observedAt: string,
    onSubmit: (concern: NonNullable<typeof submitted>) => void,
    repositoryRoot: string,
  ) => ReturnType<typeof createConcernSubmissionTool>;
  const tool = factory("2026-08-29T00:00:00.000Z", (concern) => {
    submitted = concern;
  }, cwd);
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

test("the tracer reports exact validation locations and normalizes tracked path references", async (t) => {
  const cwd = groundedExtractionRepository();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  let submitted: ReturnType<typeof parseStructuredConcernReport> = null;
  const parsed = JSON.parse(REPORT.match(/```json\s*([\s\S]*?)```/u)?.[1] ?? "null") as {
    flows: Array<{ steps: unknown[] }>;
    invariants: Array<{ reference: string }>;
  };
  parsed.flows[0]!.steps = parsed.flows[0]!.steps.slice(0, 1);
  const tool = createConcernSubmissionTool("2026-08-29T00:00:00.000Z", (concern) => {
    submitted = concern;
  }, cwd);
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
