import assert from "node:assert/strict";
import test from "node:test";
import { alongsidePathFor } from "../src/core/apply-policy.ts";

test("alongside paths stay beside the canonical file", () => {
  assert.equal(alongsidePathFor("AGENTS.md"), "AGENTS.agentify.md");
  assert.equal(alongsidePathFor("specs/README.md"), "specs/README.agentify.md");
  assert.equal(alongsidePathFor("Dockerfile"), "Dockerfile.agentify");
  assert.equal(alongsidePathFor(".env"), ".env.agentify");
  assert.equal(alongsidePathFor("nested\\file.txt"), "nested/file.agentify.txt");
});
