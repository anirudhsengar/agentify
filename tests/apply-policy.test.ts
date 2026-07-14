import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_APPLY_POLICY,
  alongsidePathFor,
  matchPattern,
  resolveActionForPath,
  type ApplyPolicy,
} from "../src/core/apply-policy.ts";
import {
  readManifestAt,
  writeManifestAt,
  sha256,
  type ManagedManifest,
  type ManagedManifestFile,
} from "../src/core/manifest.ts";
import { verifyManifestAt } from "../src/core/manifest-verification.ts";

const STATE_DIR = ".pi/agentify";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function testAlongsidePathForRootFile(): Promise<void> {
  assert.equal(alongsidePathFor("AGENTS.md"), "AGENTS.agentify.md");
  assert.equal(alongsidePathFor("SETUP.md"), "SETUP.agentify.md");
}

async function testAlongsidePathForNestedFile(): Promise<void> {
  assert.equal(alongsidePathFor("specs/README.md"), "specs/README.agentify.md");
  assert.equal(
    alongsidePathFor(".github/workflows/agent-implement.yml"),
    ".github/workflows/agent-implement.agentify.yml",
  );
}

async function testAlongsidePathForExtensionlessFile(): Promise<void> {
  assert.equal(alongsidePathFor("Dockerfile"), "Dockerfile.agentify");
  assert.equal(alongsidePathFor(".env"), ".env.agentify");
}

async function testAlongsidePathForDotfile(): Promise<void> {
  assert.equal(alongsidePathFor(".gitignore"), ".gitignore.agentify");
}

async function testAlongsidePathForAbsolutePath(): Promise<void> {
  // alongsidePathFor should be agnostic to absolute vs relative
  // input — the result is the alongside path in the same form.
  assert.equal(
    alongsidePathFor("/tmp/staging/AGENTS.md"),
    "/tmp/staging/AGENTS.agentify.md",
  );
  assert.equal(
    alongsidePathFor("/tmp/staging/specs/README.md"),
    "/tmp/staging/specs/README.agentify.md",
  );
}

async function testMatchPatternLiteral(): Promise<void> {
  assert.equal(matchPattern("AGENTS.md", "AGENTS.md"), true);
  assert.equal(matchPattern("AGENTS.md", "SETUP.md"), false);
  assert.equal(matchPattern("AGENTS.md", "specs/AGENTS.md"), false);
}

async function testMatchPatternSingleStar(): Promise<void> {
  assert.equal(matchPattern("specs/*.md", "specs/README.md"), true);
  assert.equal(matchPattern("specs/*.md", "specs/sub/README.md"), false);
  assert.equal(matchPattern("*.md", "AGENTS.md"), true);
  assert.equal(matchPattern("*.md", "specs/README.md"), false);
}

async function testMatchPatternDoubleStar(): Promise<void> {
  assert.equal(matchPattern("**/*.md", "specs/README.md"), true);
  assert.equal(matchPattern("**/*.md", ".github/workflows/agent-implement.yml"), false);
  assert.equal(matchPattern("**", ".github/workflows/agent-implement.yml"), true);
  assert.equal(matchPattern("**", "AGENTS.md"), true);
  assert.equal(matchPattern("specs/**", "specs/README.md"), true);
  assert.equal(matchPattern("specs/**", "specs/sub/deep/README.md"), true);
  assert.equal(matchPattern("specs/**", "AGENTS.md"), false);
}

async function testResolveActionForPathDefault(): Promise<void> {
  // No overrides, not required -> defaultAction
  assert.equal(
    resolveActionForPath(DEFAULT_APPLY_POLICY, "specs/README.md", false),
    "alongside",
  );
}

async function testResolveActionForPathRequired(): Promise<void> {
  // No overrides, required -> requiredAction
  assert.equal(
    resolveActionForPath(DEFAULT_APPLY_POLICY, "AGENTS.md", true),
    "alongside",
  );
  // With requiredAction: "abort"
  const policy: ApplyPolicy = { ...DEFAULT_APPLY_POLICY, requiredAction: "abort" };
  assert.equal(
    resolveActionForPath(policy, "AGENTS.md", true),
    "abort",
  );
  // Non-required still uses defaultAction
  assert.equal(
    resolveActionForPath(policy, "specs/README.md", false),
    "alongside",
  );
}

async function testResolveActionForPathOverride(): Promise<void> {
  const policy: ApplyPolicy = {
    ...DEFAULT_APPLY_POLICY,
    paths: [
      { pattern: "specs/**", action: "keep" },
      { pattern: "**/.env*", action: "abort" },
    ],
  };
  assert.equal(resolveActionForPath(policy, "specs/README.md", false), "keep");
  assert.equal(resolveActionForPath(policy, "specs/sub/deep.md", false), "keep");
  assert.equal(resolveActionForPath(policy, ".env.local", false), "abort");
  // No override -> default
  assert.equal(resolveActionForPath(policy, "AGENTS.md", false), "alongside");
}

async function testResolveActionFirstMatchWins(): Promise<void> {
  const policy: ApplyPolicy = {
    ...DEFAULT_APPLY_POLICY,
    paths: [
      { pattern: "specs/**", action: "keep" },
      { pattern: "specs/README.md", action: "abort" }, // never reached
    ],
  };
  assert.equal(resolveActionForPath(policy, "specs/README.md", false), "keep");
}

async function testDefaultApplyPolicyShape(): Promise<void> {
  // Lock the public shape of the default policy. If this
  // changes, the test forces a deliberate update.
  assert.deepEqual(DEFAULT_APPLY_POLICY, {
    defaultAction: "alongside",
    paths: [],
    requiredAction: "alongside",
  });
}

async function testVerifyManifestAlongsideIsReady(): Promise<void> {
  // End-to-end: a required file that was preserved (user's
  // AGENTS.md stays, agentify's version saved alongside) must
  // NOT cause `verifyManifest` to report "partial" on the next
  // run. This is the regression that finding 1 in the adversarial
  // review caught — the skip must apply to the "exists but
  // unmanaged" branch, not just the "missing" branch.
  const cwd = tempDir("agentify-alongside-verify-");
  try {
    const userAgentsMd = "# User-authored AGENTS.md\n\nI wrote this.\n";
    const agentifyAgentsMd = "<!-- agentify:managed -->\n# Agentified AGENTS.md\n\nGenerated.\n";
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), userAgentsMd);

    const alongsidePath = "AGENTS.agentify.md";
    const alongsideFull = path.join(cwd, alongsidePath);
    fs.writeFileSync(alongsideFull, agentifyAgentsMd);

    const manifest: ManagedManifest = {
      schema_version: "2",
      agentify_version: "0.0.0",
      generated_at: "2026-07-09T00:00:00.000Z",
      mode: "brownfield",
      run_id: "test-run-id",
      files: [
        {
          path: "AGENTS.md",
          kind: "audit",
          required: true,
          marker: "<!-- agentify:managed -->",
          sha256: sha256(agentifyAgentsMd),
          source: "managed-bundle",
          alongsidePath,
          preservedSha256: sha256(userAgentsMd),
        } satisfies ManagedManifestFile,
      ],
    };
    writeManifestAt(cwd, manifest, STATE_DIR);

    const result = verifyManifestAt(cwd, STATE_DIR);
    assert.equal(result.valid, true,
      `expected verifyManifest to be valid for deliberate alongside; got ${JSON.stringify(result)}`);
    assert.equal(result.missing.length, 0);
    assert.equal(result.mismatched.length, 0);
    assert.equal(result.unmanaged.length, 0,
      `expected no unmanaged files; got ${result.unmanaged.join(", ")}`);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testVerifyManifestMissingRequiredStillFails(): Promise<void> {
  // Counter-test: a required file with no alongsidePath that
  // is genuinely missing must still be flagged. We don't want
  // the alongside-skip to accidentally mask real missing files.
  const cwd = tempDir("agentify-missing-verify-");
  try {
    const manifest: ManagedManifest = {
      schema_version: "2",
      agentify_version: "0.0.0",
      generated_at: "2026-07-09T00:00:00.000Z",
      mode: "brownfield",
      run_id: "test-run-id",
      files: [
        {
          path: "AGENTS.md",
          kind: "audit",
          required: true,
          marker: "<!-- agentify:managed -->",
          sha256: sha256("anything"),
          source: "managed-bundle",
        },
      ],
    };
    writeManifestAt(cwd, manifest, STATE_DIR);

    const result = verifyManifestAt(cwd, STATE_DIR);
    assert.equal(result.valid, false);
    assert.ok(result.missing.includes("AGENTS.md"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function testReadManifestAcceptsV2WithAlongside(): Promise<void> {
  // The manifest reader must accept v2 manifests with the new
  // optional fields. Smoke test for the type guard.
  const cwd = tempDir("agentify-read-v2-");
  try {
    const manifest: ManagedManifest = {
      schema_version: "2",
      agentify_version: "0.0.0",
      generated_at: "2026-07-09T00:00:00.000Z",
      mode: "brownfield",
      run_id: "abc-123",
      files: [
        {
          path: "AGENTS.md",
          kind: "audit",
          required: true,
          marker: "<!-- agentify:managed -->",
          sha256: "abc",
          source: "managed-bundle",
          alongsidePath: "AGENTS.agentify.md",
          preservedSha256: "xyz",
        },
      ],
    };
    writeManifestAt(cwd, manifest, STATE_DIR);

    const read = readManifestAt(cwd, STATE_DIR);
    assert.ok(read !== null);
    assert.equal(read.schema_version, "2");
    assert.equal(read.run_id, "abc-123");
    assert.equal(read.files[0].alongsidePath, "AGENTS.agentify.md");
    assert.equal(read.files[0].preservedSha256, "xyz");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [
  { name: "alongsidePathFor_rootFile", fn: testAlongsidePathForRootFile },
  { name: "alongsidePathFor_nestedFile", fn: testAlongsidePathForNestedFile },
  { name: "alongsidePathFor_extensionlessFile", fn: testAlongsidePathForExtensionlessFile },
  { name: "alongsidePathFor_dotfile", fn: testAlongsidePathForDotfile },
  { name: "alongsidePathFor_absolutePath", fn: testAlongsidePathForAbsolutePath },
  { name: "matchPattern_literal", fn: testMatchPatternLiteral },
  { name: "matchPattern_singleStar", fn: testMatchPatternSingleStar },
  { name: "matchPattern_doubleStar", fn: testMatchPatternDoubleStar },
  { name: "resolveActionForPath_default", fn: testResolveActionForPathDefault },
  { name: "resolveActionForPath_required", fn: testResolveActionForPathRequired },
  { name: "resolveActionForPath_override", fn: testResolveActionForPathOverride },
  { name: "resolveAction_firstMatchWins", fn: testResolveActionFirstMatchWins },
  { name: "defaultApplyPolicy_shape", fn: testDefaultApplyPolicyShape },
  { name: "verifyManifest_alongsideIsReady", fn: testVerifyManifestAlongsideIsReady },
  { name: "verifyManifest_missingRequiredStillFails", fn: testVerifyManifestMissingRequiredStillFails },
  { name: "readManifest_acceptsV2WithAlongside", fn: testReadManifestAcceptsV2WithAlongside },
];

let passed = 0;
for (const t of tests) {
  try {
    await t.fn();
    passed += 1;
    console.log(`  ok ${t.name}`);
  } catch (err) {
    console.error(`  FAIL ${t.name}: ${(err as Error).message}`);
    if ((err as Error).stack) console.error((err as Error).stack);
    process.exit(1);
  }
}
console.log(`apply-policy tests passed (${passed}/${tests.length}).`);
