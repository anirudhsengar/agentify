import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadCanonicalMapAt } from "../../src/core/audit/write-map-tool.ts";
import {
  LEGACY_PI_STATE_RELATIVE_DIR,
  StateLayoutError,
  resolveCanonicalStateDir,
} from "../../src/core/state-dir.ts";
import type { AgentifyTarget } from "../../src/core/types.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";

type StateLayout =
  | "empty"
  | "legacy_only"
  | "canonical_only"
  | "dual_identical"
  | "dual_divergent";

type StateProvider = "claude" | "codex" | "pi" | "universal";

interface LayoutCase {
  name: string;
  targets: AgentifyTarget[];
  additional_agents: string[];
  layout: StateLayout;
  legacy_content: string | null;
  canonical_content: string | null;
  expected_provider: StateProvider;
  expected_relative_dir: string;
  expected_current_source: string;
  expected_legacy_flag: boolean;
}

interface LayoutFixture {
  schema_version: "1";
  cases: LayoutCase[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isLayout(value: unknown): value is StateLayout {
  return value === "empty"
    || value === "legacy_only"
    || value === "canonical_only"
    || value === "dual_identical"
    || value === "dual_divergent";
}

function isProvider(value: unknown): value is StateProvider {
  return value === "claude" || value === "codex" || value === "pi" || value === "universal";
}

function isTarget(value: string): value is AgentifyTarget {
  return value === "claude" || value === "codex" || value === "pi";
}

function readFixture(): LayoutFixture {
  const fixturePath = path.resolve("tests/fixtures/legacy-state-layouts.json");
  const parsed: unknown = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  assert.ok(isRecord(parsed));
  assert.equal(parsed.schema_version, "1");
  assert.ok(Array.isArray(parsed.cases));

  const cases: LayoutCase[] = parsed.cases.map((entry) => {
    assert.ok(isRecord(entry));
    const name = entry.name;
    const rawTargets = entry.targets;
    const additionalAgents = entry.additional_agents;
    const layout = entry.layout;
    const legacyContent = entry.legacy_content;
    const canonicalContent = entry.canonical_content;
    const expectedProvider = entry.expected_provider;
    const expectedRelativeDir = entry.expected_relative_dir;
    const expectedCurrentSource = entry.expected_current_source;
    const expectedLegacyFlag = entry.expected_legacy_flag;

    assert.ok(typeof name === "string");
    assert.ok(isStringArray(rawTargets));
    const targets = rawTargets.filter(isTarget);
    assert.equal(targets.length, rawTargets.length);
    assert.ok(isStringArray(additionalAgents));
    assert.ok(isLayout(layout));
    assert.ok(legacyContent === null || typeof legacyContent === "string");
    assert.ok(canonicalContent === null || typeof canonicalContent === "string");
    assert.ok(isProvider(expectedProvider));
    assert.ok(typeof expectedRelativeDir === "string");
    assert.ok(typeof expectedCurrentSource === "string");
    assert.ok(typeof expectedLegacyFlag === "boolean");

    return {
      name,
      targets,
      additional_agents: additionalAgents,
      layout,
      legacy_content: legacyContent,
      canonical_content: canonicalContent,
      expected_provider: expectedProvider,
      expected_relative_dir: expectedRelativeDir,
      expected_current_source: expectedCurrentSource,
      expected_legacy_flag: expectedLegacyFlag,
    };
  });

  return { schema_version: "1", cases };
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeMarker(cwd: string, stateDir: string, content: string): void {
  const filePath = path.join(cwd, stateDir, "codebase_map.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ content })}\n`);
}

function relative(cwd: string, absolutePath: string): string {
  return path.relative(cwd, absolutePath).split(path.sep).join("/");
}

function characterizeResolverMatrix(): void {
  const fixture = readFixture();
  for (const scenario of fixture.cases) {
    const cwd = tempDir("agentify-legacy-layout-");
    try {
      if (scenario.legacy_content !== null) {
        writeMarker(cwd, LEGACY_PI_STATE_RELATIVE_DIR, scenario.legacy_content);
      }
      if (
        scenario.canonical_content !== null
        && scenario.expected_relative_dir !== LEGACY_PI_STATE_RELATIVE_DIR
      ) {
        writeMarker(cwd, scenario.expected_relative_dir, scenario.canonical_content);
      }

      if (scenario.layout === "dual_divergent") {
        assert.throws(
          () => resolveCanonicalStateDir(
            cwd,
            scenario.targets,
            scenario.additional_agents,
          ),
          (error: unknown) => error instanceof StateLayoutError
            && error.code === "dual_divergent"
            && /no files were changed/.test(error.message),
          scenario.name,
        );
        continue;
      }

      const resolved = resolveCanonicalStateDir(
        cwd,
        scenario.targets,
        scenario.additional_agents,
      );
      assert.equal(resolved.provider, scenario.expected_provider, scenario.name);
      assert.equal(resolved.destinationRelativeDir, scenario.expected_relative_dir, scenario.name);
      assert.equal(resolved.relativeDir, scenario.expected_current_source, scenario.name);
      assert.equal(relative(cwd, resolved.absoluteDir), scenario.expected_current_source, scenario.name);
      assert.equal(resolved.layout.fallback, scenario.expected_legacy_flag, scenario.name);
      assert.equal(resolved.layout.kind, scenario.layout, scenario.name);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
}

function writeMap(cwd: string, stateDir: string, hypothesis: string): void {
  const map = makeValidCodebaseMap();
  map.meta.domain_hypothesis = hypothesis;
  const filePath = path.join(cwd, stateDir, "codebase_map.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(map));
}

function characterizeCanonicalMapFallback(): void {
  const legacyOnly = tempDir("agentify-map-fallback-legacy-");
  try {
    writeMap(legacyOnly, LEGACY_PI_STATE_RELATIVE_DIR, "legacy fallback");
    const loaded = loadCanonicalMapAt(legacyOnly, ".claude/agentify");
    assert.equal(loaded, null, "explicit canonical reads must not probe legacy state");
  } finally {
    fs.rmSync(legacyOnly, { recursive: true, force: true });
  }

  const divergent = tempDir("agentify-map-fallback-divergent-");
  try {
    writeMap(divergent, LEGACY_PI_STATE_RELATIVE_DIR, "legacy divergent");
    writeMap(divergent, ".claude/agentify", "canonical divergent");
    const loaded = loadCanonicalMapAt(divergent, ".claude/agentify");
    assert.equal(loaded?.meta.domain_hypothesis, "canonical divergent");
  } finally {
    fs.rmSync(divergent, { recursive: true, force: true });
  }

  const invalidCanonical = tempDir("agentify-map-fallback-invalid-canonical-");
  try {
    writeMap(invalidCanonical, LEGACY_PI_STATE_RELATIVE_DIR, "valid legacy");
    const canonicalPath = path.join(invalidCanonical, ".claude/agentify/codebase_map.json");
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.writeFileSync(canonicalPath, "{ invalid");
    assert.equal(loadCanonicalMapAt(invalidCanonical, ".claude/agentify"), null);
  } finally {
    fs.rmSync(invalidCanonical, { recursive: true, force: true });
  }
}

characterizeResolverMatrix();
characterizeCanonicalMapFallback();
console.log("Phase B state layout characterization tests passed.");
