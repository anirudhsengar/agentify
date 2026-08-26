import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverSpecialistPortfolio,
  normalizeExecutableCommand,
} from "../../src/core/specialists/discovery.ts";
import {
  SPECIALIST_FIXTURE_TRACKED_FILES,
  makeSpecialistFixtureMap,
} from "../fixtures/specialist-map.ts";

const INVALID = [
  "add a regression test under tests/",
  "add unit tests under tests/",
  "uv lock if dependencies changed",
  "uv run --locked --no-default-groups --group dev tox run -e docs for changed public API",
  "uv run --locked --no-default-groups --group dev tox run -e typing for typed surface",
];

test("procedure commands contain executable commands, never planning prose", () => {
  for (const value of INVALID) assert.equal(normalizeExecutableCommand(value), null, value);
  assert.equal(normalizeExecutableCommand("uv run pytest tests/test_auth.py"), "uv run pytest tests/test_auth.py");
  assert.equal(normalizeExecutableCommand("python -c \"print('if dependencies changed')\""), "python -c \"print('if dependencies changed')\"");

  const map = makeSpecialistFixtureMap();
  map.validation_surface.per_change_type.feature.mandatory.push(
    ...INVALID,
    "uv run pytest",
  );
  map.concern_evidence!.concerns[0]!.validation.push(
    ...INVALID,
    "pytest tests/auth.test.ts",
  );

  const portfolio = discoverSpecialistPortfolio(
    map,
    "a".repeat(40),
    SPECIALIST_FIXTURE_TRACKED_FILES,
  );
  const commands = [
    ...portfolio.specialists.flatMap((specialist) => specialist.validation_commands),
    ...portfolio.procedures.flatMap((procedure) => [
      ...procedure.allowed_commands,
      ...procedure.validation_commands,
    ]),
  ];
  for (const value of INVALID) assert.ok(!commands.includes(value), value);
  assert.ok(commands.includes("uv run pytest"));
  assert.ok(portfolio.warnings.some((warning) =>
    /non-executable validation instruction/.test(warning)
  ));
});
