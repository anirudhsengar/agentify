import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_SKILL_TIER,
  MANUAL_OPT_IN,
  parseSkillFrontmatter,
  readPackagedSkillTiers,
  skillsForClassification,
  type SkillFrontmatter,
} from "../src/core/skill-curation.ts";

const tests: Array<{ name: string; fn: () => Promise<void> | void }> = [];

/**
 * Build a temp directory with the skill layout agentify expects:
 * `<tmp>/packaged/skills/<name>/SKILL.md`.
 */
function makePackagedRoot(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-skill-curation-"));
  const skillsDir = path.join(root, "packaged", "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const dir = path.join(skillsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), body);
  }
  return root;
}

function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

// ---------- parseSkillFrontmatter ----------

tests.push({
  name: "parseSkillFrontmatterParsesCompleteBlock",
  fn: () => {
    const raw = `---
name: scout
description: Read-only codebase recon.
disable-model-invocation: true
tier: opt-in
---

# Scout
`;
    const fm = parseSkillFrontmatter(raw);
    assert.equal(fm.name, "scout");
    assert.equal(fm.description, "Read-only codebase recon.");
    assert.equal(fm.disableModelInvocation, true);
    assert.equal(fm.tier, "opt-in");
  },
});

tests.push({
  name: "parseSkillFrontmatterDefaultsTierToCore",
  fn: () => {
    const raw = `---
name: fix
description: Apply a patch.
disable-model-invocation: true
---
`;
    const fm = parseSkillFrontmatter(raw);
    assert.equal(fm.tier, DEFAULT_SKILL_TIER);
    assert.equal(fm.tier, "core");
  },
});

tests.push({
  name: "parseSkillFrontmatterDefaultsDisableModelInvocationToFalse",
  fn: () => {
    const raw = `---
name: tdd
description: Red-green-refactor.
---
`;
    const fm = parseSkillFrontmatter(raw);
    assert.equal(fm.disableModelInvocation, false);
  },
});

tests.push({
  name: "parseSkillFrontmatterRejectsNoFrontmatterBlock",
  fn: () => {
    assert.throws(
      () => parseSkillFrontmatter("# Scout\n\nSome body."),
      /missing a YAML frontmatter block/,
    );
  },
});

tests.push({
  name: "parseSkillFrontmatterRejectsMissingName",
  fn: () => {
    const raw = `---
description: nameless
---
`;
    assert.throws(() => parseSkillFrontmatter(raw), /missing required `name:` field/);
  },
});

tests.push({
  name: "parseSkillFrontmatterRejectsMissingDescription",
  fn: () => {
    const raw = `---
name: nameless
---
`;
    assert.throws(
      () => parseSkillFrontmatter(raw),
      /missing required `description:` field/,
    );
  },
});

tests.push({
  name: "parseSkillFrontmatterRejectsInvalidTierValue",
  fn: () => {
    const raw = `---
name: bad
description: bad tier
tier: optional
---
`;
    assert.throws(() => parseSkillFrontmatter(raw), /invalid `tier:` value "optional"/);
  },
});

// ---------- readPackagedSkillTiers ----------

tests.push({
  name: "readPackagedSkillTiersReturnsEmptyMapWhenSkillsDirMissing",
  fn: () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-empty-"));
    try {
      const tiers = readPackagedSkillTiers(root);
      assert.deepEqual([...tiers.entries()], []);
    } finally {
      cleanup(root);
    }
  },
});

tests.push({
  name: "readPackagedSkillTiersReadsAllTiers",
  fn: () => {
    const root = makePackagedRoot({
      "core-skill": "---\nname: core-skill\ndescription: x\ntier: core\n---\n",
      "opt-in-skill": "---\nname: opt-in-skill\ndescription: y\ntier: opt-in\n---\n",
      "default-skill": "---\nname: default-skill\ndescription: z\n---\n",
    });
    try {
      const tiers = readPackagedSkillTiers(root);
      assert.equal(tiers.size, 3);
      assert.equal(tiers.get("core-skill"), "core");
      assert.equal(tiers.get("opt-in-skill"), "opt-in");
      assert.equal(tiers.get("default-skill"), "core"); // defaulted
    } finally {
      cleanup(root);
    }
  },
});

tests.push({
  name: "readPackagedSkillTiersDefaultsBrokenSkillsToCore",
  fn: () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-noskillmd-"));
    const skillsDir = path.join(root, "packaged", "skills");
    fs.mkdirSync(path.join(skillsDir, "good"), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, "good", "SKILL.md"),
      "---\nname: good\ndescription: x\ntier: core\n---\n",
    );
    fs.mkdirSync(path.join(skillsDir, "broken"), { recursive: true });
    try {
      const tiers = readPackagedSkillTiers(root);
      assert.equal(tiers.get("good"), "core");
      assert.equal(tiers.get("broken"), "core");
    } finally {
      cleanup(root);
    }
  },
});

// ---------- skillsForClassification ----------

const SAMPLE_TIERS = new Map<string, "core" | "opt-in">([
  ["codebase-design", "core"],
  ["drill-me", "core"],
  ["spec", "core"],
  ["prototype", "opt-in"],
  ["scaffold-ci", "opt-in"],
  ["refresh-surface", "opt-in"],
  ["improve-codebase-architecture", "opt-in"],
  ["scout-then-plan", "opt-in"],
  ["handoff", "opt-in"],
  ["writing-great-skills", "opt-in"],
]);

tests.push({
  name: "skillsForClassificationGreenfieldHighShipsPrototype",
  fn: () => {
    const result = skillsForClassification(
      { kind: "greenfield", confidence: "high", reasons: [] },
      SAMPLE_TIERS,
    );
    assert.ok(result.shipped.has("codebase-design"));
    assert.ok(result.shipped.has("prototype"));
    assert.ok(!result.shipped.has("scaffold-ci"));
    assert.ok(!result.shipped.has("handoff"));
    assert.equal(result.shipped.size, 4); // 3 core + prototype
  },
});

tests.push({
  name: "skillsForClassificationBrownfieldHighShipsAllBrownfieldOptIns",
  fn: () => {
    const result = skillsForClassification(
      { kind: "brownfield", confidence: "high", reasons: [] },
      SAMPLE_TIERS,
    );
    assert.ok(result.shipped.has("codebase-design"));
    assert.ok(result.shipped.has("scaffold-ci"));
    assert.ok(result.shipped.has("refresh-surface"));
    assert.ok(result.shipped.has("improve-codebase-architecture"));
    assert.ok(result.shipped.has("scout-then-plan"));
    assert.ok(!result.shipped.has("prototype")); // greenfield-only
    assert.ok(!result.shipped.has("handoff"));
    assert.equal(result.shipped.size, 7); // 3 core + 4 brownfield
  },
});

tests.push({
  name: "skillsForClassificationAmbiguousShipsCoreOnly",
  fn: () => {
    const high = skillsForClassification(
      { kind: "ambiguous", confidence: "high", reasons: [] },
      SAMPLE_TIERS,
    );
    const low = skillsForClassification(
      { kind: "ambiguous", confidence: "low", reasons: [] },
      SAMPLE_TIERS,
    );
    assert.equal(high.shipped.size, 3);
    assert.equal(low.shipped.size, 3);
  },
});

tests.push({
  name: "skillsForClassificationMediumOrLowConfidenceSkipsOptIns",
  fn: () => {
    const greenfieldMedium = skillsForClassification(
      { kind: "greenfield", confidence: "medium", reasons: [] },
      SAMPLE_TIERS,
    );
    const brownfieldLow = skillsForClassification(
      { kind: "brownfield", confidence: "low", reasons: [] },
      SAMPLE_TIERS,
    );
    assert.ok(!greenfieldMedium.shipped.has("prototype"));
    assert.ok(!brownfieldLow.shipped.has("scaffold-ci"));
    assert.equal(greenfieldMedium.optIn.size, 0);
    assert.equal(brownfieldLow.optIn.size, 0);
  },
});

tests.push({
  name: "skillsForClassificationManualOptInsNeverShip",
  fn: () => {
    const result = skillsForClassification(
      { kind: "brownfield", confidence: "high", reasons: [] },
      SAMPLE_TIERS,
    );
    for (const name of MANUAL_OPT_IN) {
      assert.ok(!result.shipped.has(name), `${name} must not auto-ship`);
    }
  },
});

tests.push({
  name: "skillsForClassificationReturnsCoreSetContainingAllCoreSkills",
  fn: () => {
    const result = skillsForClassification(
      { kind: "ambiguous", confidence: "high", reasons: [] },
      SAMPLE_TIERS,
    );
    assert.deepEqual([...result.core].sort(), ["codebase-design", "drill-me", "spec"]);
  },
});

tests.push({
  name: "skillsForClassificationOptInSetContainsOnlyRecommended",
  fn: () => {
    const result = skillsForClassification(
      { kind: "brownfield", confidence: "high", reasons: [] },
      SAMPLE_TIERS,
    );
    assert.deepEqual(
      [...result.optIn].sort(),
      ["improve-codebase-architecture", "refresh-surface", "scaffold-ci", "scout-then-plan"],
    );
  },
});

tests.push({
  name: "skillsForClassificationIgnoresUnrecommendedOptInNames",
  fn: () => {
    const smallTiers = new Map<string, "core" | "opt-in">([
      ["codebase-design", "core"],
      ["never-recommended", "opt-in"],
    ]);
    const result = skillsForClassification(
      { kind: "greenfield", confidence: "high", reasons: [] },
      smallTiers,
    );
    assert.ok(result.shipped.has("codebase-design"));
    assert.ok(!result.shipped.has("never-recommended"));
  },
});

// ---------- end-to-end: real packaged/skills/ ----------

tests.push({
  name: "readPackagedSkillTiersRealTreeHasExpectedCoreCount",
  fn: () => {
    const root = path.resolve(".");
    const tiers = readPackagedSkillTiers(root);
    assert.ok(tiers.size >= 24, `expected at least 24 skills, got ${tiers.size}`);
    for (const [name, tier] of tiers) {
      assert.ok(
        tier === "core" || tier === "opt-in",
        `skill ${name} has unrecognized tier ${tier}`,
      );
    }
    const cores = [...tiers.entries()].filter(([, t]) => t === "core").map(([n]) => n);
    assert.equal(
      cores.length,
      18,
      `expected 18 core skills, got ${cores.length}: ${cores.join(", ")}`,
    );
  },
});

tests.push({
  name: "everyRealPackagedSkillFrontmatterMatchesDirname",
  fn: () => {
    const root = path.resolve(".");
    const skillsDir = path.join(root, "packaged", "skills");
    for (const name of fs.readdirSync(skillsDir)) {
      const skillPath = path.join(skillsDir, name, "SKILL.md");
      if (!fs.statSync(skillPath).isFile()) continue;
      const raw = fs.readFileSync(skillPath, "utf-8");
      const fm: SkillFrontmatter = parseSkillFrontmatter(raw);
      assert.equal(fm.name, name, `${name}/SKILL.md has mismatched name field`);
    }
  },
});

// ---------- runner ----------

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    passed += 1;
    console.log(`  ok ${t.name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${t.name}: ${(err as Error).message}`);
    if ((err as Error).stack) console.error((err as Error).stack);
  }
}
if (failed > 0) {
  console.error(`skill-curation tests FAILED (${passed} passed, ${failed} failed).`);
  process.exit(1);
}
console.log(`skill-curation tests passed (${passed}/${tests.length}).`);