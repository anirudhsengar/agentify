import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
// The verifier is plain JavaScript shipped into target repositories, so it has
// no declarations; the surface used here is one function returning a reason.
// @ts-expect-error -- untyped scaffold module loaded deliberately
import { verifyMemoryManifest as verifyUntyped } from "../../scaffold/.github/scripts/verify-memory-manifest.mjs";

const verifyMemoryManifest = verifyUntyped as (root: string, repository: string) => string | null;
import {
  initializeTeamMemoryStore,
  readTeamMemoryManifest,
  recordTeamMemoryActivation,
  refreshTeamMemoryManifest,
} from "../../src/core/memory/index.ts";
import { buildSpecialistEvidenceReference } from "../../src/core/specialists/evidence.ts";

const REPOSITORY = "owner/repo";

function gitFixture(): { cwd: string; commit: string } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-manifest-verify-"));
  const git = (...args: string[]): string => {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  fs.writeFileSync(path.join(cwd, "README.md"), "fixture\n");
  git("init", "-q");
  git("config", "user.name", "Agentify Test");
  git("config", "user.email", "agentify@example.invalid");
  git("add", ".");
  git("commit", "-qm", "fixture");
  return { cwd, commit: git("rev-parse", "HEAD") };
}

/** A promoted installation, exactly as the installer produces one. */
function promotedFixture(): { cwd: string } {
  const { cwd, commit } = gitFixture();
  initializeTeamMemoryStore({
    cwd,
    repositoryId: REPOSITORY,
    supportingCommit: commit,
    evidence: [buildSpecialistEvidenceReference({
      cwd,
      supportingCommit: commit,
      repositoryPath: "README.md",
      sourceType: "validated_bootstrap",
      observedAt: "2026-08-23T00:00:00.000Z",
      actor: "maintainer",
    })],
    actor: "agentify-installer",
  });
  fs.writeFileSync(
    path.join(cwd, ".agentify/installation-report.json"),
    `${JSON.stringify({
      schema_version: "1",
      disposition: "ready",
      policy_configured: true,
      agentify_enabled: true,
    }, null, 2)}\n`,
  );
  refreshTeamMemoryManifest(cwd);
  recordTeamMemoryActivation(cwd, {
    state: "promoted",
    disposition: "ready",
    promoted_at: "2026-08-23T12:00:00.000Z",
  });
  return { cwd };
}

function manifestPath(cwd: string): string {
  return path.join(cwd, ".agentify/manifest.json");
}

function mutateManifest(cwd: string, change: (manifest: Record<string, unknown>) => void): void {
  const manifest = JSON.parse(fs.readFileSync(manifestPath(cwd), "utf-8")) as Record<string, unknown>;
  change(manifest);
  fs.writeFileSync(manifestPath(cwd), `${JSON.stringify(manifest, null, 2)}\n`);
}

test("a genuinely promoted installation verifies", () => {
  const { cwd } = promotedFixture();
  try {
    assert.equal(readTeamMemoryManifest(cwd).activation?.state, "promoted");
    assert.equal(verifyMemoryManifest(cwd, REPOSITORY), null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a fabricated promotion claim does not verify", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-forged-manifest-"));
  try {
    fs.mkdirSync(path.join(cwd, ".agentify"), { recursive: true });
    // The exact document the review showed satisfying the old gate.
    fs.writeFileSync(manifestPath(cwd), `${JSON.stringify({
      repository_id: REPOSITORY,
      activation: { state: "promoted", disposition: "ready" },
    }, null, 2)}\n`);
    const failure = verifyMemoryManifest(cwd, REPOSITORY);
    assert.ok(failure, "a manifest with no format, entries, or digest must not verify");
    assert.match(failure, /format or schema version/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

const tampering: Array<{ name: string; apply: (cwd: string) => void; expect: RegExp }> = [
  {
    name: "an edited memory record",
    apply: (cwd) => {
      const manifest = JSON.parse(fs.readFileSync(manifestPath(cwd), "utf-8")) as {
        entries: Array<{ path: string }>;
      };
      const target = manifest.entries.find((entry) => entry.path.endsWith(".json"));
      assert.ok(target);
      const absolute = path.join(cwd, ...target.path.split("/"));
      fs.writeFileSync(absolute, `${fs.readFileSync(absolute, "utf-8")}\n`);
    },
    expect: /no longer matches its recorded digest/,
  },
  {
    name: "a deleted memory record",
    apply: (cwd) => {
      const manifest = JSON.parse(fs.readFileSync(manifestPath(cwd), "utf-8")) as {
        entries: Array<{ path: string }>;
      };
      const target = manifest.entries.find((entry) => entry.path.includes("/agents/"));
      assert.ok(target);
      fs.rmSync(path.join(cwd, ...target.path.split("/")));
    },
    expect: /missing from disk/,
  },
  {
    name: "an unrecorded file added to memory",
    apply: (cwd) => {
      const smuggled = path.join(cwd, ".agentify/policies/smuggled.json");
      fs.mkdirSync(path.dirname(smuggled), { recursive: true });
      fs.writeFileSync(smuggled, "{}\n");
    },
    expect: /files the manifest does not record/,
  },
  {
    name: "activation flipped to promoted without reissuing the digest",
    apply: (cwd) => {
      mutateManifest(cwd, (manifest) => {
        manifest.activation = { state: "promoted", disposition: "ready", promoted_at: "2026-01-01T00:00:00.000Z" };
      });
    },
    expect: /root digest does not match/,
  },
  {
    name: "a foreign repository identity",
    apply: (cwd) => mutateManifest(cwd, (manifest) => { manifest.repository_id = "someone/else"; }),
    expect: /belongs to someone\/else/,
  },
  {
    name: "a replaced installation report",
    apply: (cwd) => {
      fs.writeFileSync(
        path.join(cwd, ".agentify/installation-report.json"),
        `${JSON.stringify({ disposition: "ready", policy_configured: true, agentify_enabled: true, extra: 1 }, null, 2)}\n`,
      );
    },
    expect: /installation report no longer matches/,
  },
  {
    name: "a report that does not claim a completed installation",
    apply: (cwd) => {
      const reportPath = path.join(cwd, ".agentify/installation-report.json");
      const report = JSON.parse(fs.readFileSync(reportPath, "utf-8")) as Record<string, unknown>;
      report.agentify_enabled = false;
      fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      // Re-record the integrity entry so only the claim itself is wrong.
      refreshTeamMemoryManifest(cwd);
      recordTeamMemoryActivation(cwd, {
        state: "promoted",
        disposition: "ready",
        promoted_at: "2026-08-23T12:00:00.000Z",
      });
    },
    expect: /does not record a completed, enabled installation/,
  },
];

for (const { name, apply, expect } of tampering) {
  test(`verification rejects ${name}`, () => {
    const { cwd } = promotedFixture();
    try {
      assert.equal(verifyMemoryManifest(cwd, REPOSITORY), null, "the fixture must start valid");
      apply(cwd);
      const failure = verifyMemoryManifest(cwd, REPOSITORY);
      assert.ok(failure, `${name} must not verify`);
      assert.match(failure, expect);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}
