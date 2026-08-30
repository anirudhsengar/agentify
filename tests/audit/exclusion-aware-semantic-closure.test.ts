import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  assessSpecialistEvidence,
  compileSpecialistEvidence,
  type CodebaseMap,
} from "../../src/core/audit/schema.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";

type Concern = NonNullable<CodebaseMap["concern_evidence"]>["concerns"][number];

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function repository(files: readonly string[]): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-semantic-ownership-"));
  for (const repositoryPath of ["README.md", "package.json", ...files]) {
    const absolute = path.join(cwd, ...repositoryPath.split("/"));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `${repositoryPath}\n`);
  }
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Agentify Test");
  git(cwd, "config", "user.email", "agentify@example.invalid");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "semantic ownership fixture");
  return cwd;
}

function concern(input: {
  name: string;
  covers: string;
  excludes: string;
  core: string;
  test: string;
  supporting?: readonly string[];
}): Concern {
  const supporting = [...(input.supporting ?? [])];
  return {
    concern: input.name,
    one_line: `Owns ${input.name}.`,
    covers: input.covers,
    excludes: input.excludes,
    flows: [{
      name: `${input.name} flow`,
      description: `Traces ${input.name} behavior.`,
      steps: [
        { path: input.core, what_happens: `Executes ${input.name}.` },
        ...supporting.map((repositoryPath) => ({
          path: repositoryPath,
          what_happens: `Consumes ${input.name} state.`,
        })),
        { path: input.test, what_happens: `Verifies ${input.name}.` },
      ],
    }],
    touchpoints: [
      {
        path: input.core,
        symbol: null,
        role: `Core ${input.name} behavior.`,
        line_range: null,
        centrality: "core",
      },
      {
        path: input.test,
        symbol: null,
        role: `Regression coverage for ${input.name}.`,
        line_range: null,
        centrality: "supporting",
      },
      ...supporting.map((repositoryPath) => ({
        path: repositoryPath,
        symbol: null,
        role: `Supporting dependency used by ${input.name}.`,
        line_range: null,
        centrality: "supporting" as const,
      })),
    ],
    invariants: [],
    pitfalls: [],
    entry_questions: [`Does this alter ${input.name}?`],
    validation: ["npm test"],
    spans_subtrees: ["src"],
    stability: "high",
    recurrence: "high",
    confidence: "high",
    last_updated: "2026-08-27T00:00:00.000Z",
  };
}

function mapWithConcerns(
  entryPoints: readonly string[],
  concerns: Concern[],
): CodebaseMap {
  const map = makeValidCodebaseMap();
  delete map.expert_evidence;
  map.meta.project_type = "semantic ownership fixture";
  map.meta.languages = ["TypeScript"];
  map.skeleton.entry_points = entryPoints.map((repositoryPath) => ({
    path: repositoryPath,
    role: "fixture entry point",
    language: "TypeScript",
    run_command: "npm test",
  }));
  map.skeleton.first_5_files_for_fresh_agent = entryPoints.map((repositoryPath) => ({
    path: repositoryPath,
    why: "fixture behavioral entry point",
  }));
  map.module_graph.edges = [];
  map.module_graph.parallelizable_subtrees = [];
  map.module_graph.shared_abstractions = [];
  map.module_graph.shared_state = [];
  map.pitfalls = [];
  map.operational_surface.build.recipe_file = "package.json";
  map.open_questions = [];
  map.concern_evidence = { concerns, not_concerns: [] };
  return map;
}

test("excluded behavior cannot be attached to a concern as positive semantic evidence", () => {
  const cwd = repository([
    "src/decoder.ts",
    "src/decoder.test.ts",
    "src/form-mapping.ts",
    "src/form-mapping.test.ts",
  ]);
  try {
    const decoding = concern({
      name: "request decoding",
      covers: "Decoder selection and decoded request values.",
      excludes: "Form mapping internals are a separate specialty.",
      core: "src/decoder.ts",
      test: "src/decoder.test.ts",
    });
    const map = mapWithConcerns(["src/decoder.ts"], [decoding]);
    const incomplete = assessSpecialistEvidence(map, { cwd });

    assert.equal(incomplete.complete, false);
    assert.ok(incomplete.uncovered_paths.includes("src/form-mapping.ts"));
    assert.ok(incomplete.uncovered_paths.includes("src/form-mapping.test.ts"));
    assert.ok(!incomplete.attachments.some((attachment) =>
      attachment.concern === "request decoding"
      && attachment.paths.some((repositoryPath) => repositoryPath.includes("form-mapping"))
    ));

    map.concern_evidence!.concerns.push(concern({
      name: "form mapping",
      covers: "Maps form fields into typed request destinations.",
      excludes: "Decoder selection remains in request decoding.",
      core: "src/form-mapping.ts",
      test: "src/form-mapping.test.ts",
    }));
    const complete = assessSpecialistEvidence(map, { cwd });
    assert.equal(complete.complete, true, complete.reasons.join("; "));

    map.concern_evidence!.concerns.push(concern({
      name: "form mapping test suite as a specialist",
      covers: "Duplicates form-mapping behavior while assigning its tests as core ownership.",
      excludes: "Decoder selection remains in request decoding.",
      core: "src/form-mapping.test.ts",
      test: "src/decoder.test.ts",
      supporting: ["src/form-mapping.ts"],
    }));
    const testCore = assessSpecialistEvidence(map, { cwd });
    assert.equal(testCore.complete, false);
    assert.ok(
      testCore.reasons.some((reason) => /test-only core ownership.*implementation context/i.test(reason)),
      testCore.reasons.join("; "),
    );

  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a generic exclusion token does not veto a distinct mirrored behavior cluster", () => {
  const cwd = repository([
    "lib/option.js",
    "examples/options-env.js",
    "tests/options.env.test.js",
  ]);
  try {
    const options = concern({
      name: "option value resolution",
      covers: "Resolves defaults, environment values, conflicts, and implied option values.",
      excludes: "Unknown-option suggestion logic and help rendering.",
      core: "lib/option.js",
      test: "tests/options.env.test.js",
    });
    const map = mapWithConcerns(["lib/option.js"], [options]);
    const attachable = assessSpecialistEvidence(map, { cwd });
    assert.ok(attachable.attachments.some((attachment) =>
      attachment.concern === options.concern
      && attachment.paths.includes("examples/options-env.js")
      && attachment.paths.includes("tests/options.env.test.js")
    ));

    options.excludes = "Option env values are a separate specialty.";
    const excluded = assessSpecialistEvidence(map, { cwd });
    assert.ok(!excluded.attachments.some((attachment) =>
      attachment.paths.includes("examples/options-env.js")
    ));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("inferred attachments require behavioral locality instead of one generic token", () => {
  const cwd = repository([
    "src/adapter/aws/handler.ts",
    "src/adapter/aws/handler.test.ts",
    "src/adapter/bun/server.ts",
    "src/adapter/bun/server.test.ts",
    "src/adapter/vercel/handler.ts",
    "src/adapter/vercel/handler.test.ts",
    "src/auth/check.ts",
    "src/auth/check.test.ts",
    "src/client/accept.ts",
    "src/client/accept.test.ts",
    "src/jsx/dom/client.ts",
    "src/jsx/dom/client.test.ts",
    "src/jsx/dom/server.ts",
    "src/jsx/dom/server.test.ts",
  ]);
  try {
    const adapters = concern({
      name: "multi-runtime adapter system",
      covers: "Serverless runtime adapter handlers translate platform requests and responses.",
      excludes: "JSX DOM rendering and authentication are separate.",
      core: "src/adapter/aws/handler.ts",
      test: "src/adapter/aws/handler.test.ts",
    });
    const authentication = concern({
      name: "authentication and access control",
      covers: "Accepts authorization headers and verifies request credentials.",
      excludes: "RPC client response helpers, JSX, and runtime adapters are separate.",
      core: "src/auth/check.ts",
      test: "src/auth/check.test.ts",
    });
    const jsx = concern({
      name: "JSX rendering",
      covers: "Client hydration and DOM rendering for JSX trees.",
      excludes: "Runtime adapters and authentication are separate.",
      core: "src/jsx/dom/client.ts",
      test: "src/jsx/dom/client.test.ts",
    });
    const map = mapWithConcerns(
      [adapters.touchpoints[0]!.path, authentication.touchpoints[0]!.path, jsx.touchpoints[0]!.path],
      [adapters, authentication, jsx],
    );
    const assessment = assessSpecialistEvidence(map, { cwd });
    const pathsFor = (name: string): readonly string[] =>
      assessment.attachments.find((attachment) => attachment.concern === name)?.paths ?? [];

    assert.ok(pathsFor(jsx.concern).includes("src/jsx/dom/server.ts"));
    assert.ok(!pathsFor(adapters.concern).includes("src/jsx/dom/server.ts"));
    assert.ok(pathsFor(adapters.concern).includes("src/adapter/bun/server.ts"));
    assert.ok(pathsFor(adapters.concern).includes("src/adapter/vercel/handler.ts"));
    assert.ok(!assessment.attachments.some((attachment) =>
      attachment.paths.includes("src/client/accept.ts")
    ));
    assert.ok(assessment.uncovered_paths.includes("src/client/accept.ts"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("direct module dependencies attach only to one non-excluded concern", () => {
  const cwd = repository([
    "src/auth/check.ts",
    "src/auth/check.test.ts",
    "src/crypto/signature.ts",
    "src/crypto/signature.test.ts",
    "src/plumbing/archive.ts",
    "src/plumbing/archive.test.ts",
    "src/plumbing/table.ts",
    "src/plumbing/table.test.ts",
    "src/preset/quick.ts",
    "src/preset/quick.test.ts",
    "src/render/response.ts",
    "src/render/response.test.ts",
    "src/router/trie.ts",
    "src/router/trie.test.ts",
    "src/shared/state.ts",
    "src/shared/state.test.ts",
  ]);
  try {
    fs.writeFileSync(path.join(cwd, "src/router/trie.ts"), [
      'import { table } from "../plumbing/table.js";',
      'import { signature } from "../crypto/signature.js";',
      'import { state } from "../shared/state.js";',
      '// import { archive } from "../plumbing/archive.js";',
      "const example = 'require(\"../plumbing/archive.js\")';",
      "export const route = () => [table, signature, state];",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(cwd, "src/auth/check.ts"), [
      'import { state } from "../shared/state.js";',
      "export const check = () => state;",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(cwd, "src/render/response.ts"), [
      'import { state } from "../shared/state.js";',
      "export const render = () => state;",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(cwd, "src/preset/quick.ts"), [
      'export { route } from "../router/trie.js";',
      "",
    ].join("\n"));
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "record module edges");

    const routing = concern({
      name: "request routing",
      covers: "Selects a route and dispatches the matched handler.",
      excludes: "Cryptographic signing in src/crypto/signature.ts is a separate specialty.",
      core: "src/router/trie.ts",
      test: "src/router/trie.test.ts",
    });
    const authentication = concern({
      name: "authentication",
      covers: "Verifies credentials and establishes authenticated request state.",
      excludes: "Token minting and response serialization are separate.",
      core: "src/auth/check.ts",
      test: "src/auth/check.test.ts",
    });
    const rendering = concern({
      name: "response rendering",
      covers: "Serializes response values and commits output.",
      excludes: "Credential verification and route matching are separate.",
      core: "src/render/response.ts",
      test: "src/render/response.test.ts",
    });
    const assessment = assessSpecialistEvidence(
      mapWithConcerns(
        [routing.touchpoints[0]!.path, authentication.touchpoints[0]!.path, rendering.touchpoints[0]!.path],
        [routing, authentication, rendering],
      ),
      { cwd },
    );
    const routingPaths = assessment.attachments
      .find((attachment) => attachment.concern === routing.concern)?.paths ?? [];

    assert.ok(routingPaths.includes("src/plumbing/table.ts"));
    assert.ok(routingPaths.includes("src/plumbing/table.test.ts"));
    assert.ok(routingPaths.includes("src/preset/quick.ts"));
    assert.ok(routingPaths.includes("src/preset/quick.test.ts"));
    assert.ok(!routingPaths.includes("src/crypto/signature.ts"));
    assert.ok(assessment.uncovered_paths.includes("src/crypto/signature.ts"));
    assert.ok(!routingPaths.includes("src/plumbing/archive.ts"));
    assert.ok(assessment.uncovered_paths.includes("src/plumbing/archive.ts"));
    assert.ok(!assessment.attachments.some((attachment) =>
      attachment.paths.includes("src/shared/state.ts")
    ), JSON.stringify(assessment.attachments));
    assert.ok(assessment.uncovered_paths.includes("src/shared/state.ts"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("test-only repositories may own their executable test behavior as core", () => {
  const cwd = repository([
    "tests/orchestration",
    "tests/orchestration.spec",
  ]);
  try {
    const map = mapWithConcerns(
      ["tests/orchestration"],
      [concern({
        name: "executable conformance orchestration",
        covers: "Runs the repository's conformance product and verifies its result contract.",
        excludes: "Package metadata and documentation.",
        core: "tests/orchestration",
        test: "tests/orchestration.spec",
      })],
    );
    const assessment = assessSpecialistEvidence(map, { cwd });
    assert.equal(assessment.complete, true, assessment.reasons.join("; "));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a supporting citation cannot compete for ownership of behavior it explicitly excludes", () => {
  const cwd = repository([
    "src/router/index.ts",
    "src/router/index.test.ts",
    "src/router/reg-exp-router/router.ts",
    "src/router/reg-exp-router/router.test.ts",
    "src/utils/url.ts",
    "src/utils/url.test.ts",
  ]);
  try {
    const routing = concern({
      name: "pluggable router backends",
      covers: "Selects routes through concrete regular-expression and trie router algorithms.",
      excludes: "URL parsing and request dispatch.",
      core: "src/router/index.ts",
      test: "src/router/index.test.ts",
      supporting: ["src/router/reg-exp-router/router.ts"],
    });
    const urls = concern({
      name: "URL parsing and path normalization",
      covers: "Parses request URLs and normalizes route paths consumed by routers.",
      excludes: "Router matching decisions and concrete router algorithms under `router/*`.",
      core: "src/utils/url.ts",
      test: "src/utils/url.test.ts",
      supporting: ["src/router/reg-exp-router/router.ts"],
    });
    const assessment = assessSpecialistEvidence(
      mapWithConcerns([routing.touchpoints[0]!.path, urls.touchpoints[0]!.path], [routing, urls]),
      { cwd },
    );

    assert.ok(!assessment.uncovered_paths.includes("src/router/reg-exp-router/router.ts"));
    assert.ok(!assessment.uncovered_paths.includes("src/router/reg-exp-router/router.test.ts"));
    assert.ok(assessment.attachments.some((attachment) =>
      attachment.concern === routing.concern
      && attachment.paths.includes("src/router/reg-exp-router/router.test.ts")
    ));
    assert.ok(!assessment.attachments.some((attachment) =>
      attachment.concern === urls.concern
      && attachment.paths.includes("src/router/reg-exp-router/router.test.ts")
    ));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("entry questions do not establish positive ownership of an unrelated cluster", () => {
  const cwd = repository([
    "src/utils/jwt/jwt.ts",
    "src/utils/jwt/jwt.test.ts",
    "src/middleware/serve-static/path.ts",
    "src/middleware/serve-static/path.test.ts",
  ]);
  try {
    const jwt = concern({
      name: "JWT signing and verification",
      covers: "Token encoding, algorithm dispatch through WebCrypto, key import, header validation, claim enforcement, and key-set verification.",
      excludes: "HTTP request dispatch and middleware integration concerns covered separately by `middleware/jwt` and `middleware/jwk`.",
      core: "src/utils/jwt/jwt.ts",
      test: "src/utils/jwt/jwt.test.ts",
    });
    jwt.entry_questions = [
      "Is this change to the JWT layer itself, or only to the `middleware/jwt` and `middleware/jwk` wrappers, and which side should carry the invariant?",
      "For sign-side changes: must the new code path preserve base64url and utf8-boundary semantics?",
    ];
    const assessment = assessSpecialistEvidence(
      mapWithConcerns([jwt.touchpoints[0]!.path], [jwt]),
      { cwd },
    );

    assert.ok(assessment.uncovered_paths.includes("src/middleware/serve-static/path.ts"));
    assert.ok(assessment.uncovered_paths.includes("src/middleware/serve-static/path.test.ts"));
    assert.ok(!assessment.attachments.some((attachment) =>
      attachment.concern === jwt.concern
      && attachment.paths.some((repositoryPath) => repositoryPath.includes("serve-static"))
    ), JSON.stringify(assessment.attachments));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("rejection explanations cannot reject cited files or suppress their mirrored tests", () => {
  const cwd = repository([
    "src/context.ts",
    "src/context.test.ts",
    "src/render.ts",
    "src/render.test.ts",
  ]);
  try {
    const context = concern({
      name: "Request context lifecycle",
      covers: "Constructs per-request state and finalizes the response.",
      excludes: "HTML rendering algorithms.",
      core: "src/context.ts",
      test: "src/context.test.ts",
    });
    context.touchpoints = context.touchpoints.filter((entry) => entry.centrality === "core");
    context.flows[0]!.steps = [
      { path: "src/context.ts", what_happens: "Creates isolated state for the incoming request." },
      { path: "src/context.ts", what_happens: "Finalizes response status and headers from that state." },
    ];
    const map = mapWithConcerns(["src/context.ts"], [context]);
    map.concern_evidence!.not_concerns = [
      {
        candidate: "variable store",
        grouped_into: context.concern,
        why_rejected: "Subsumed by Request context lifecycle: src/context.ts implements this small map-backed mechanism.",
      },
      {
        candidate: "documentation authoring",
        why_rejected: "Documentation is not an independent runtime specialty; src/render.ts is cited only as an example of the documented behavior.",
      },
    ];
    const assessment = assessSpecialistEvidence(map, { cwd });

    assert.ok(assessment.attachments.some((attachment) =>
      attachment.concern === context.concern
      && attachment.paths.includes("src/context.test.ts")
    ), JSON.stringify(assessment.attachments));
    assert.ok(!assessment.uncovered_paths.includes("src/context.test.ts"));
    assert.ok(assessment.uncovered_paths.includes("src/render.ts"));
    assert.ok(!assessment.exempted_paths.includes("src/render.ts"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("an auxiliary-only concern cannot duplicate implementation-owned behavior", () => {
  const cwd = repository([
    "src/command.ts",
    "tests/command.test.ts",
    "examples/pm-install",
    "tests/fixtures/pm-install",
  ]);
  try {
    const dispatch = concern({
      name: "subcommand dispatch and lifecycle",
      covers: "Dispatches and launches executable subcommands through the command runtime.",
      excludes: "Package installation example output.",
      core: "src/command.ts",
      test: "tests/command.test.ts",
    });
    const example = concern({
      name: "standalone executable subcommand launching",
      covers: "Demonstrates the executable subcommand launch contract in a standalone example.",
      excludes: "Parent command dispatch internals.",
      core: "examples/pm-install",
      test: "tests/fixtures/pm-install",
    });
    const duplicatedMap = mapWithConcerns(["src/command.ts"], [dispatch, example]);
    const duplicated = assessSpecialistEvidence(duplicatedMap, { cwd });

    assert.equal(duplicated.complete, false);
    assert.ok(
      duplicated.reasons.some((reason) =>
        /auxiliary-only.*standalone executable subcommand launching.*subcommand dispatch and lifecycle/i
          .test(reason)
      ),
      duplicated.reasons.join("; "),
    );
    const compiled = compileSpecialistEvidence(duplicatedMap, { cwd });
    assert.equal(compiled.complete, true, compiled.reasons.join("; "));
    assert.deepEqual(
      compiled.map.concern_evidence?.concerns.map((candidate) => candidate.concern),
      ["subcommand dispatch and lifecycle"],
    );
    assert.ok(compiled.map.concern_evidence?.not_concerns.some((candidate) =>
      candidate.candidate === "standalone executable subcommand launching"
      && candidate.why_rejected.includes("examples/pm-install")
      && candidate.why_rejected.includes("tests/fixtures/pm-install")
    ));
    const repeated = compileSpecialistEvidence(compiled.map, { cwd });
    assert.equal(repeated.complete, true, repeated.reasons.join("; "));
    assert.strictEqual(repeated.map, compiled.map);

    example.concern = "package installation example output";
    example.one_line = "Documents package installation output and failure behavior.";
    example.covers = "Package-name validation, force output, and per-package installation output.";
    const distinct = assessSpecialistEvidence(
      mapWithConcerns(["src/command.ts"], [dispatch, example]),
      { cwd },
    );
    assert.equal(distinct.complete, true, distinct.reasons.join("; "));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("normalization promotes a uniquely cited implementation out of test-only core ownership", () => {
  const cwd = repository([
    "src/parser.ts",
    "src/parser.test.ts",
  ]);
  try {
    const parser = concern({
      name: "request grammar and rejection",
      covers: "Parses request grammar and preserves rejection behavior.",
      excludes: "Transport and response rendering.",
      core: "src/parser.test.ts",
      test: "src/parser.test.ts",
      supporting: ["src/parser.ts"],
    });
    const map = mapWithConcerns(["src/parser.ts"], [parser]);
    const compilation = compileSpecialistEvidence(map, { cwd });

    assert.equal(compilation.complete, true, compilation.reasons.join("; "));
    assert.equal(
      compilation.map.concern_evidence?.concerns[0]?.touchpoints
        .find((touchpoint) => touchpoint.path === "src/parser.ts")?.centrality,
      "core",
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a shared high-signal implementation needs explicit core behavioral ownership", () => {
  const cwd = repository([
    "src/auth.ts",
    "src/auth.test.ts",
    "src/render.ts",
    "src/render.test.ts",
    "src/context.ts",
    "src/context.test.ts",
  ]);
  try {
    const map = mapWithConcerns(
      ["src/auth.ts", "src/render.ts"],
      [
        concern({
          name: "authentication",
          covers: "Credential verification and authenticated request state.",
          excludes: "Response rendering and Context lifecycle mechanics.",
          core: "src/auth.ts",
          test: "src/auth.test.ts",
          supporting: ["src/context.ts"],
        }),
        concern({
          name: "response rendering",
          covers: "Serializes response bodies and commits output.",
          excludes: "Authentication and Context lifecycle mechanics.",
          core: "src/render.ts",
          test: "src/render.test.ts",
          supporting: ["src/context.ts"],
        }),
      ],
    );

    const incomplete = assessSpecialistEvidence(map, { cwd });
    assert.equal(incomplete.complete, false);
    assert.ok(incomplete.uncovered_paths.includes("src/context.ts"));
    assert.ok(incomplete.uncovered_clusters.some((cluster) =>
      cluster.implementation_paths.includes("src/context.ts")
    ));

    map.concern_evidence!.concerns.push(concern({
      name: "request Context lifecycle",
      covers: "Handler progression, abort state, copies, errors, and request-local metadata.",
      excludes: "Credential policy and response serialization.",
      core: "src/context.ts",
      test: "src/context.test.ts",
    }));
    const complete = assessSpecialistEvidence(map, { cwd });
    assert.equal(complete.complete, true, complete.reasons.join("; "));

    map.concern_evidence!.concerns.push(concern({
      name: "Context lifecycle implementation detail",
      covers: "Duplicates the same request Context core implementation under a location-oriented label.",
      excludes: "Credential policy and response serialization.",
      core: "src/context.ts",
      test: "src/context.test.ts",
    }));
    const ambiguous = assessSpecialistEvidence(map, { cwd });
    assert.equal(ambiguous.complete, false);
    assert.ok(
      ambiguous.reasons.some((reason) =>
        /src\/context\.ts/i.test(reason) && /multiple core owners/i.test(reason)
      ),
      ambiguous.reasons.join("; "),
    );
    const ambiguousCompilation = compileSpecialistEvidence(map, { cwd });
    assert.equal(ambiguousCompilation.complete, false);
    assert.ok(ambiguousCompilation.reasons.some((reason) =>
      /src\/context\.ts/i.test(reason) && /multiple core owners/i.test(reason)
    ));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("normalization gives a shared core path to the sole concern that depends on it", () => {
  const cwd = repository([
    "src/auth.ts",
    "src/auth.test.ts",
    "src/render.ts",
    "src/render.test.ts",
    "src/context.ts",
    "src/context.test.ts",
  ]);
  try {
    const authentication = concern({
      name: "authentication",
      covers: "Credential verification through shared request context.",
      excludes: "Response rendering and Context lifecycle mechanics.",
      core: "src/auth.ts",
      test: "src/auth.test.ts",
      supporting: ["src/context.ts"],
    });
    authentication.touchpoints.find((entry) => entry.path === "src/context.ts")!.centrality = "core";
    const rendering = concern({
      name: "response rendering",
      covers: "Response serialization through shared request context.",
      excludes: "Authentication and Context lifecycle mechanics.",
      core: "src/render.ts",
      test: "src/render.test.ts",
      supporting: ["src/context.ts"],
    });
    rendering.touchpoints.find((entry) => entry.path === "src/context.ts")!.centrality = "core";
    const contextLifecycle = concern({
      name: "request Context lifecycle",
      covers: "Handler progression, abort state, copies, errors, and request-local metadata.",
      excludes: "Credential policy and response serialization.",
      core: "src/context.ts",
      test: "src/context.test.ts",
    });
    const map = mapWithConcerns(
      ["src/auth.ts", "src/render.ts", "src/context.ts"],
      [authentication, rendering, contextLifecycle],
    );

    const compiled = compileSpecialistEvidence(map, { cwd });
    assert.equal(compiled.complete, true, compiled.reasons.join("; "));
    const owners = compiled.map.concern_evidence!.concerns.filter((candidate) =>
      candidate.touchpoints.some((entry) =>
        entry.path === "src/context.ts" && entry.centrality === "core"
      )
    );
    assert.deepEqual(owners.map((entry) => entry.concern), ["request Context lifecycle"]);
    assert.ok(compiled.map.concern_evidence!.concerns
      .filter((entry) => entry.concern !== "request Context lifecycle")
      .every((entry) => entry.touchpoints.some((touchpoint) =>
        touchpoint.path === "src/context.ts" && touchpoint.centrality === "supporting"
      )));

    const repeated = compileSpecialistEvidence(compiled.map, { cwd });
    assert.equal(repeated.complete, true, repeated.reasons.join("; "));
    assert.strictEqual(repeated.map, compiled.map);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("normalization gives shared orchestration to its unique dependent supporting claimant", () => {
  const cwd = repository([
    "src/command.ts",
    "src/argument.ts",
    "src/error.ts",
    "tests/routing.test.ts",
    "tests/argument.test.ts",
    "tests/error.test.ts",
  ]);
  try {
    const routing = concern({
      name: "routing and dispatch",
      covers: "Routes commands through the shared dispatcher.",
      excludes: "Argument coercion and error formatting.",
      core: "tests/routing.test.ts",
      test: "tests/routing.test.ts",
      supporting: ["src/command.ts"],
    });
    const argumentsConcern = concern({
      name: "argument coercion",
      covers: "Coerces positional arguments through command integration.",
      excludes: "Routing and error formatting.",
      core: "src/argument.ts",
      test: "tests/argument.test.ts",
      supporting: ["src/command.ts"],
    });
    argumentsConcern.touchpoints.find((entry) => entry.path === "src/command.ts")!.centrality = "core";
    const errors = concern({
      name: "error formatting",
      covers: "Formats errors through command integration.",
      excludes: "Routing and argument coercion.",
      core: "src/error.ts",
      test: "tests/error.test.ts",
      supporting: ["src/command.ts"],
    });
    errors.touchpoints.find((entry) => entry.path === "src/command.ts")!.centrality = "core";
    const map = mapWithConcerns(["src/command.ts", "src/argument.ts", "src/error.ts"], [
      routing,
      argumentsConcern,
      errors,
    ]);

    const resolved = assessSpecialistEvidence(map, { cwd });
    assert.ok(resolved.core_ownership_resolutions.some((entry) =>
      entry.path === "src/command.ts" && entry.concern === "routing and dispatch"
    ));
    assert.ok(!resolved.reasons.some((reason) => /src\/command\.ts.*multiple core owners/i.test(reason)));

    map.concern_evidence!.concerns.push(concern({
      name: "alternate routing",
      covers: "Duplicates routing through the same dispatcher.",
      excludes: "Argument coercion and error formatting.",
      core: "tests/routing.test.ts",
      test: "tests/routing.test.ts",
      supporting: ["src/command.ts"],
    }));
    const tied = assessSpecialistEvidence(map, { cwd });
    assert.ok(!tied.core_ownership_resolutions.some((entry) => entry.path === "src/command.ts"));
    assert.ok(tied.reasons.some((reason) => /src\/command\.ts.*multiple core owners/i.test(reason)));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("ownership normalization cannot cyclically remove every core implementation from a concern", () => {
  const cwd = repository([
    "src/command.ts",
    "src/cobra.ts",
    "src/lifecycle.ts",
    "tests/dispatch.test.ts",
    "tests/suggestions.test.ts",
    "tests/help.test.ts",
  ]);
  try {
    const dispatch = concern({
      name: "command dispatch lifecycle",
      covers: "Command discovery, execution, initialization, and finalization.",
      excludes: "Suggestion scoring and help rendering presentation.",
      core: "src/command.ts",
      test: "tests/dispatch.test.ts",
      supporting: ["src/cobra.ts"],
    });
    dispatch.touchpoints.find((entry) => entry.path === "src/cobra.ts")!.centrality = "core";
    const suggestions = concern({
      name: "unknown-command suggestions",
      covers: "Scores and renders typo suggestions for unknown commands.",
      excludes: "Command execution and help rendering.",
      core: "src/command.ts",
      test: "tests/suggestions.test.ts",
    });
    const help = concern({
      name: "help rendering",
      covers: "Renders command help and usage output.",
      excludes: "Command execution and suggestion scoring.",
      core: "src/cobra.ts",
      test: "tests/help.test.ts",
    });
    const map = mapWithConcerns(
      ["src/command.ts", "src/cobra.ts"],
      [dispatch, suggestions, help],
    );

    const cyclic = assessSpecialistEvidence(map, { cwd });
    assert.ok(!cyclic.core_ownership_resolutions.some((entry) =>
      entry.path === "src/command.ts" || entry.path === "src/cobra.ts"
    ));
    assert.ok(cyclic.reasons.some((reason) =>
      /src\/command\.ts.*multiple core owners/i.test(reason)
    ));
    assert.ok(cyclic.reasons.some((reason) =>
      /src\/cobra\.ts.*multiple core owners/i.test(reason)
    ));
    const compiled = compileSpecialistEvidence(map, { cwd });
    assert.ok(
      compiled.map.concern_evidence?.concerns.some((entry) => entry.concern === dispatch.concern),
      "normalization must not erase the command dispatch lifecycle",
    );

    dispatch.touchpoints.push({
      path: "src/lifecycle.ts",
      symbol: null,
      role: "Independent command initialization and finalization hooks.",
      line_range: null,
      centrality: "core",
    });
    dispatch.flows[0]!.steps.push({
      path: "src/lifecycle.ts",
      what_happens: "Runs command initialization and finalization hooks.",
    });
    map.skeleton.entry_points.push({
      path: "src/lifecycle.ts",
      role: "fixture entry point",
      language: "TypeScript",
      run_command: "npm test",
    });
    map.skeleton.first_5_files_for_fresh_agent.push({
      path: "src/lifecycle.ts",
      why: "fixture behavioral entry point",
    });
    const resolvable = assessSpecialistEvidence(map, { cwd });
    assert.ok(resolvable.core_ownership_resolutions.some((entry) =>
      entry.path === "src/command.ts" && entry.concern === suggestions.concern
    ));
    assert.ok(resolvable.core_ownership_resolutions.some((entry) =>
      entry.path === "src/cobra.ts" && entry.concern === help.concern
    ));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("normalization subsumes core-conflicting concerns only after their verified flows survive", () => {
  const cwd = repository([
    "src/command.ts",
    "src/cobra.ts",
    "tests/dispatch.test.ts",
    "tests/help.test.ts",
  ]);
  try {
    const dispatch = concern({
      name: "command dispatch lifecycle",
      covers: "Command discovery, execution, initialization, finalization, and adjacent rendering reached by dispatch.",
      excludes: "Shell completion generation.",
      core: "src/command.ts",
      test: "tests/dispatch.test.ts",
      supporting: ["src/cobra.ts"],
    });
    dispatch.touchpoints.find((entry) => entry.path === "src/cobra.ts")!.centrality = "core";
    const help = concern({
      name: "help and usage rendering",
      covers: "Help and usage templates reached by command dispatch.",
      excludes: "Shell completion generation.",
      core: "src/cobra.ts",
      test: "tests/help.test.ts",
      supporting: ["src/command.ts"],
    });
    help.touchpoints.find((entry) => entry.path === "src/command.ts")!.centrality = "core";
    const map = mapWithConcerns(["src/command.ts", "src/cobra.ts"], [dispatch, help]);
    map.concern_evidence!.not_concerns.push({
      candidate: help.concern,
      why_rejected:
        "Subsumed by the accepted command dispatch lifecycle concern because both behaviors share the same file-level implementation owner and cannot form independent specialists.",
      grouped_into: dispatch.concern,
    });

    const compiled = compileSpecialistEvidence(map, { cwd });
    assert.equal(compiled.complete, true, compiled.reasons.join("; "));
    assert.deepEqual(
      compiled.map.concern_evidence!.concerns.map((entry) => entry.concern),
      [dispatch.concern],
    );
    assert.ok(compiled.map.concern_evidence!.concerns[0]!.flows.some((flow) =>
      flow.name === help.flows[0]!.name
      && flow.steps.map((step) => step.path).join("\0")
        === help.flows[0]!.steps.map((step) => step.path).join("\0")
    ));

    const excludedDispatch = structuredClone(dispatch);
    excludedDispatch.excludes = "Help and usage rendering remains an independent adjacent concern.";
    const contradicted = mapWithConcerns(
      ["src/command.ts", "src/cobra.ts"],
      [excludedDispatch, structuredClone(help)],
    );
    contradicted.concern_evidence!.not_concerns = structuredClone(map.concern_evidence!.not_concerns);
    delete contradicted.concern_evidence!.not_concerns[0]!.grouped_into;
    const unresolved = compileSpecialistEvidence(contradicted, { cwd });
    assert.equal(unresolved.complete, false);
    assert.ok(unresolved.map.concern_evidence!.concerns.some((entry) =>
      entry.concern === help.concern
    ));

    const repeated = compileSpecialistEvidence(compiled.map, { cwd });
    assert.equal(repeated.complete, true, repeated.reasons.join("; "));
    assert.strictEqual(repeated.map, compiled.map);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
