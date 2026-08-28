import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

interface AcceptanceCase {
  repository: string;
  failureClasses: string[];
  enforcedBy: string[];
}

const CORPUS: AcceptanceCase[] = [
  {
    repository: "commander.js",
    failureClasses: ["bounded-output", "portfolio-cardinality", "repository-specific-specialists"],
    enforcedBy: [
      "tests/specialists/specialist-discovery.test.ts",
      "tests/package/exact-artifact-qualification.mjs",
    ],
  },
  {
    repository: "aqa-tests",
    failureClasses: ["tracked-evidence-only", "extensionless-orchestration", "generated-path-rejection"],
    enforcedBy: ["tests/audit/tracked-specialist-closure.test.ts"],
  },
  {
    repository: "click",
    failureClasses: ["locality-aware-clustering", "executable-command-contracts"],
    enforcedBy: [
      "tests/audit/locality-aware-semantic-closure.test.ts",
      "tests/specialists/command-contracts.test.ts",
    ],
  },
  {
    repository: "hono",
    failureClasses: ["locality-aware-clustering", "progress-based-repair", "single-terminal-audit"],
    enforcedBy: [
      "tests/audit/locality-aware-semantic-closure.test.ts",
      "tests/audit/tracked-specialist-closure.test.ts",
    ],
  },
  {
    repository: "gin",
    failureClasses: ["uncapped-specialist-portfolio", "exclusion-aware-ownership", "core-behavior-ownership"],
    enforcedBy: [
      "tests/audit/exclusion-aware-semantic-closure.test.ts",
      "tests/specialists/specialist-discovery.test.ts",
    ],
  },
  {
    repository: "axum",
    failureClasses: ["workspace-public-surfaces", "attested-explorer-receipts", "complete-flow-materialization"],
    enforcedBy: [
      "tests/audit/workspace-public-surface-closure.test.ts",
      "tests/audit/explorer-receipts.test.ts",
      "tests/specialists/flow-preservation.test.ts",
    ],
  },
  {
    repository: "spring-petclinic",
    failureClasses: ["post-normalization-validation", "idempotent-compilation", "atomic-installation"],
    enforcedBy: [
      "tests/audit/specialist-compiler.test.ts",
      "tests/installer/atomic-installation-boundary.test.ts",
    ],
  },
];

test("the stabilization acceptance corpus permanently covers every live repository failure class", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  assert.equal(
    new Set(CORPUS.map((entry) => entry.repository)).size,
    CORPUS.length,
    "acceptance repositories must be unique",
  );

  const requiredFailureClasses = new Set([
    "bounded-output",
    "tracked-evidence-only",
    "locality-aware-clustering",
    "exclusion-aware-ownership",
    "workspace-public-surfaces",
    "attested-explorer-receipts",
    "post-normalization-validation",
    "idempotent-compilation",
    "atomic-installation",
  ]);
  const coveredFailureClasses = new Set(
    CORPUS.flatMap((entry) => entry.failureClasses),
  );
  for (const failureClass of requiredFailureClasses) {
    assert.ok(
      coveredFailureClasses.has(failureClass),
      `missing acceptance coverage for ${failureClass}`,
    );
  }

  for (const entry of CORPUS) {
    assert.ok(entry.enforcedBy.length > 0, `${entry.repository} has no executable acceptance test`);
    for (const relativePath of entry.enforcedBy) {
      assert.ok(
        fs.existsSync(path.join(root, ...relativePath.split("/"))),
        `${entry.repository} acceptance evidence is missing: ${relativePath}`,
      );
    }
  }
});
