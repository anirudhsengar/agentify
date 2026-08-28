import assert from "node:assert/strict";
import test from "node:test";
import { discoverSpecialistPortfolio } from "../../src/core/specialists/discovery.ts";
import {
  SPECIALIST_FIXTURE_TRACKED_FILES,
  makeSpecialistFixtureMap,
} from "../fixtures/specialist-map.ts";

test("materialization preserves every verified ordered flow step", () => {
  const map = makeSpecialistFixtureMap();
  const concern = map.concern_evidence!.concerns.find((entry) =>
    entry.concern === "authentication"
  );
  assert.ok(concern);
  concern.flows[0]!.steps = [
    {
      path: "src/routes/login.ts",
      what_happens: "Accepts the credential payload.",
    },
    {
      path: "src/auth/lookup.ts",
      what_happens: "Loads the account and its credential state.",
    },
    {
      path: "src/auth/verify.ts",
      what_happens: "Compares the hash and issues a session.",
    },
    {
      path: "src/middleware/session.ts",
      what_happens: "Stores the session for later requests.",
    },
  ];

  const portfolio = discoverSpecialistPortfolio(
    map,
    "a".repeat(40),
    [...SPECIALIST_FIXTURE_TRACKED_FILES, "src/auth/lookup.ts"],
  );
  const specialist = portfolio.specialists.find((entry) =>
    entry.concern === "authentication"
  );
  assert.ok(specialist);
  assert.deepEqual(
    specialist.flows[0]?.steps.map((step) => step.path),
    [
      "src/routes/login.ts",
      "src/auth/lookup.ts",
      "src/auth/verify.ts",
      "src/middleware/session.ts",
    ],
  );
  assert.ok(specialist.context_paths.includes("src/auth/lookup.ts"));
  assert.ok(specialist.touchpoints.some((touchpoint) =>
    touchpoint.path === "src/auth/lookup.ts"
    && touchpoint.role.includes("Loads the account")
  ));
});
