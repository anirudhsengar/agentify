import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverSpecialistPortfolio,
  validateSpecialistPortfolio,
} from "../../src/core/specialists/index.ts";
import {
  executableValidationCommands,
  isExecutableValidationCommand,
} from "../../src/core/specialists/commands.ts";
import {
  SPECIALIST_FIXTURE_TRACKED_FILES,
  makeSpecialistFixtureMap,
} from "../fixtures/specialist-map.ts";

const COMMIT = "a".repeat(40);
const INVALID_DIRECTIVES = [
  "add a regression test under tests/",
  "uv lock if dependencies changed",
  "uv run --locked --no-default-groups --group dev tox run -e typing for typed surface",
];

test("validation command contracts accept argv-like commands and reject prose", () => {
  for (const command of [
    "pytest tests/test_shell_completion.py",
    "NODE_ENV=test npm test",
    "python -c \"for x in range(2): print(x)\"",
    "./scripts/check.sh --focused",
    "C:\\Python312\\python.exe -m pytest",
  ]) assert.equal(isExecutableValidationCommand(command), true, command);

  for (const directive of [
    ...INVALID_DIRECTIVES,
    "pytest tests/a.py && pytest tests/b.py",
    "pytest $(cat test-list.txt)",
    "'pytest' tests/test_basic.py",
  ]) assert.equal(isExecutableValidationCommand(directive), false, directive);

  assert.deepEqual(executableValidationCommands([
    "pytest tests/test_basic.py",
    ...INVALID_DIRECTIVES,
  ]), {
    commands: ["pytest tests/test_basic.py"],
    rejected: [...INVALID_DIRECTIVES].sort((left, right) => left.localeCompare(right)),
  });
});

test("specialist discovery never persists model prose as executable commands", () => {
  const map = makeSpecialistFixtureMap();
  map.concern_evidence!.concerns[0]!.validation.push(...INVALID_DIRECTIVES);
  map.validation_surface.per_change_type.feature.mandatory.push(
    "review the public API when changed",
  );

  const portfolio = discoverSpecialistPortfolio(
    map,
    COMMIT,
    SPECIALIST_FIXTURE_TRACKED_FILES,
  );
  validateSpecialistPortfolio(portfolio);

  const persistedCommands = [
    ...portfolio.specialists.flatMap((specialist) => specialist.validation_commands),
    ...portfolio.procedures.flatMap((procedure) => [
      ...procedure.allowed_commands,
      ...procedure.validation_commands,
    ]),
  ];
  assert.ok(persistedCommands.length > 0);
  assert.ok(persistedCommands.every(isExecutableValidationCommand));
  for (const directive of INVALID_DIRECTIVES) {
    assert.ok(!persistedCommands.includes(directive));
    assert.ok(portfolio.warnings.some((warning) => warning.includes(JSON.stringify(directive))));
  }

  const invalid = structuredClone(portfolio);
  assert.ok(invalid.procedures[0]);
  invalid.procedures[0]!.allowed_commands = [INVALID_DIRECTIVES[0]!];
  assert.throws(
    () => validateSpecialistPortfolio(invalid),
    /non-executable allowed command/,
  );
});
