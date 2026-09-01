import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import { discoverSpecialistPortfolio } from "../../src/core/specialists/index.ts";
import {
  SPECIALIST_FIXTURE_TRACKED_FILES,
  makeSpecialistFixtureMap,
} from "../fixtures/specialist-map.ts";

const COMMIT = "a".repeat(40);

test("every evidence-backed concern becomes a specialist without an arbitrary portfolio cap", () => {
  const map = makeSpecialistFixtureMap();
  const template = map.concern_evidence!.concerns[0]!;
  map.concern_evidence!.concerns = Array.from({ length: 12 }, (_, index) => ({
    ...structuredClone(template),
    concern: `repository specialty ${index + 1}`,
    one_line: `Owns repository specialty ${index + 1}.`,
  }));

  const portfolio = discoverSpecialistPortfolio(
    map,
    COMMIT,
    SPECIALIST_FIXTURE_TRACKED_FILES,
  );

  assert.equal(portfolio.specialists.length, 12);
  assert.deepEqual(
    portfolio.specialists.map((specialist) => specialist.concern).sort(),
    Array.from({ length: 12 }, (_, index) => `repository specialty ${index + 1}`).sort(),
  );
  assert.ok(!portfolio.warnings.some((warning) => /strongest .* retained/i.test(warning)));
});

test("the concern scout derives portfolio size from evidence rather than a target range", () => {
  const prompt = fs.readFileSync(
    new URL("../../src/core/audit/prompts/explorers/concern_scout.md", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(prompt, /Aim for 3[–-]8 concerns/i);
  assert.match(prompt, /Do not target a numeric range/i);
});

test("concern discovery rejects generic catalogs built from unrelated behaviors", () => {
  const scout = fs.readFileSync(
    new URL("../../src/core/audit/prompts/explorers/concern_scout.md", import.meta.url),
    "utf8",
  );
  const tracer = fs.readFileSync(
    new URL("../../src/core/audit/prompts/explorers/concern_tracer.md", import.meta.url),
    "utf8",
  );
  const builder = fs.readFileSync(
    new URL("../../src/core/audit/prompts/builder.md", import.meta.url),
    "utf8",
  );

  assert.match(
    scout,
    /catalog.*framework layer.*unrelated failure domains.*shared (?:API|subtree)/is,
  );
  assert.match(
    builder,
    /reject.*catalog.*unrelated failure domains.*shared (?:integration )?(?:API|subtree)/is,
  );
  assert.match(
    tracer,
    /never mark a shared integration file `core` while behavior-specific implementations are only `supporting`/i,
  );
});

test("concern discovery retains coherent strategy and operational-outcome families", () => {
  const scout = fs.readFileSync(
    new URL("../../src/core/audit/prompts/explorers/concern_scout.md", import.meta.url),
    "utf8",
  );
  const tracer = fs.readFileSync(
    new URL("../../src/core/audit/prompts/explorers/concern_tracer.md", import.meta.url),
    "utf8",
  );
  const builder = fs.readFileSync(
    new URL("../../src/core/audit/prompts/builder.md", import.meta.url),
    "utf8",
  );

  for (const prompt of [scout, tracer, builder]) {
    assert.match(prompt, /substitutable implementations.*public behavioral contract.*selection|selection.*substitutable implementations.*public behavioral contract/is,
      "router and matcher strategy families must not be split into implementation-shaped specialists");
    assert.match(prompt, /components.*one repository-owned operational outcome.*joint invariant/is,
      "configuration and runtime mechanisms may form one operational body of knowledge");
    assert.match(prompt, /shared (?:theme|directory|API).*alone.*insufficient/is,
      "the exception must not admit generic framework catalogs");
  }
});

test("specialist discovery does not mistake local public behavior for generic mechanics", () => {
  const scout = fs.readFileSync(
    new URL("../../src/core/audit/prompts/explorers/concern_scout.md", import.meta.url), "utf8",
  );
  const builder = fs.readFileSync(
    new URL("../../src/core/audit/prompts/builder.md", import.meta.url), "utf8",
  );
  assert.doesNotMatch(scout, /two unrelated top-level areas|Names that appear in exactly one.*usually modules/s);
  assert.match(scout, /single (?:file|subtree).*independent.*invariants/is);
  assert.match(scout, /public.*(?:lifecycle|continuation).*product behavior/is);
  assert.match(builder, /review.*scout.*rejections.*(?:size|locality).*not.*rejection/is);
});
