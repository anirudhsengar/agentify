import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { MAX_MAP_FILE_BYTES } from "../../src/core/audit/map-input.ts";
import { writeCanonicalMap } from "../../src/core/audit/map-storage.ts";
import { makeValidCodebaseMap } from "../fixtures/codebase-map.ts";

test("application-authored canonical map writes enforce the output cap before mutation", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-map-output-cap-"));
  try {
    const map = makeValidCodebaseMap();
    map.meta.domain_hypothesis = "x".repeat(MAX_MAP_FILE_BYTES);
    assert.throws(
      () => writeCanonicalMap(cwd, map, {
        stateDir: ".agentify/runtime/audit",
        mapFilename: "codebase_map.json",
      }),
      new RegExp(`exceeds ${MAX_MAP_FILE_BYTES} byte cap`),
    );
    assert.equal(
      fs.existsSync(path.join(cwd, ".agentify")),
      false,
      "oversized output must fail before creating Agentify state",
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
