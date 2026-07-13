import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import {
  LEGACY_PI_STATE_RELATIVE_DIR,
  resolveCanonicalStateDir,
  resolveStateDir,
} from "../../src/core/state-dir.ts";
import type { AgentifyTarget } from "../../src/core/types.ts";
import { makeParityTempDir } from "./helpers/generated-tree.ts";

interface StateMatrixCase {
  name: string;
  targets: readonly AgentifyTarget[];
  additionalAgents?: readonly string[];
  provider: "claude" | "codex" | "pi" | "universal";
  relativeDir: string;
}

const STATE_MATRIX: readonly StateMatrixCase[] = [
  {
    name: "Claude wins mixed premium selections",
    targets: ["codex", "pi", "claude"],
    additionalAgents: ["cursor"],
    provider: "claude",
    relativeDir: ".claude/agentify",
  },
  {
    name: "Codex wins when Claude is absent",
    targets: ["pi", "codex"],
    provider: "codex",
    relativeDir: ".agents/agentify",
  },
  {
    name: "Pi owns state when it is the only premium target",
    targets: ["pi"],
    provider: "pi",
    relativeDir: ".pi/agentify",
  },
  {
    name: "non-premium-only selection uses the universal agents directory",
    targets: [],
    additionalAgents: ["cursor", "opencode"],
    provider: "universal",
    relativeDir: ".agents/agentify",
  },
];

for (const scenario of STATE_MATRIX) {
  test(`state directory matrix: ${scenario.name}`, () => {
    assert.deepEqual(
      resolveStateDir(scenario.targets, scenario.additionalAgents),
      {
        provider: scenario.provider,
        relativeDir: scenario.relativeDir,
      },
    );
  });
}

test("fresh repositories resolve to the provider-selected path", () => {
  for (const scenario of STATE_MATRIX) {
    const cwd = makeParityTempDir("agentify-parity-state-fresh-");
    try {
      const resolved = resolveCanonicalStateDir(
        cwd,
        scenario.targets,
        scenario.additionalAgents,
      );
      assert.equal(resolved.provider, scenario.provider);
      assert.equal(resolved.relativeDir, scenario.relativeDir);
      assert.equal(resolved.destinationRelativeDir, scenario.relativeDir);
      assert.equal(resolved.absoluteDir, path.join(cwd, scenario.relativeDir));
      assert.equal(resolved.layout.fallback, false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test("legacy Pi state remains the active compatibility source", () => {
  for (const scenario of STATE_MATRIX.filter((entry) => entry.provider !== "pi")) {
    const cwd = makeParityTempDir("agentify-parity-state-legacy-");
    try {
      fs.mkdirSync(path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR), { recursive: true });
      const resolved = resolveCanonicalStateDir(
        cwd,
        scenario.targets,
        scenario.additionalAgents,
      );
      assert.equal(resolved.provider, scenario.provider);
      assert.equal(resolved.relativeDir, LEGACY_PI_STATE_RELATIVE_DIR);
      assert.equal(resolved.sourceRelativeDir, LEGACY_PI_STATE_RELATIVE_DIR);
      assert.equal(resolved.destinationRelativeDir, scenario.relativeDir);
      assert.equal(resolved.absoluteDir, path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR));
      assert.equal(resolved.layout.fallback, true);
      assert.match(resolved.guidance[0]!, /Compatibility mode remains active/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test("identical provider-selected and legacy paths use canonical without deletion", () => {
  for (const scenario of STATE_MATRIX.filter((entry) => entry.provider !== "pi")) {
    const cwd = makeParityTempDir("agentify-parity-state-existing-");
    try {
      fs.mkdirSync(path.join(cwd, scenario.relativeDir), { recursive: true });
      fs.mkdirSync(path.join(cwd, LEGACY_PI_STATE_RELATIVE_DIR), { recursive: true });
      const resolved = resolveCanonicalStateDir(
        cwd,
        scenario.targets,
        scenario.additionalAgents,
      );
      assert.equal(resolved.absoluteDir, path.join(cwd, scenario.relativeDir));
      assert.equal(resolved.layout.kind, "dual_identical");
      assert.equal(resolved.layout.fallback, false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
});
