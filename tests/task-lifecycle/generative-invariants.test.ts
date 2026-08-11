import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { RepositoryInstallationPreflight } from "../../src/core/installer/contracts.ts";
import {
  createRepositoryValidationApproval,
  repositoryValidationApprovalCurrent,
} from "../../src/core/installer/task-policy.ts";
import type {
  DurableTaskState,
  TaskLifecyclePolicy,
  TaskLifecycleState,
} from "../../src/core/task-lifecycle/contracts.ts";
import {
  canonicalTaskJson,
  digestTaskValue,
  normalizeTaskPath,
  pathWithinTaskScope,
} from "../../src/core/task-lifecycle/serialization.ts";
import {
  applyTaskStateMutation,
  makeInitialTaskState,
  makeTaskApproval,
  TaskLifecycleError,
} from "../../src/core/task-lifecycle/state-machine.ts";

const NOW = "2026-08-05T00:00:00.000Z";
const ALL_STATES: readonly TaskLifecycleState[] = [
  "new",
  "needs-information",
  "ready",
  "planned",
  "awaiting-approval",
  "approved",
  "implementing",
  "validating",
  "reviewing",
  "fixing",
  "draft-pr-open",
  "completed",
  "stopped",
  "refused",
  "blocked",
  "stale-base",
  "budget-exhausted",
  "failed",
  "recovering",
] as const;
const INITIAL_TRANSITIONS = new Set<TaskLifecycleState>([
  "new",
  "needs-information",
  "ready",
  "refused",
  "blocked",
  "budget-exhausted",
  "stopped",
  "failed",
  "recovering",
]);

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function seededToken(seed: number, length: number): string {
  const random = seededRandom(seed);
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789_-";
  return Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
}

function seededHex(seed: number, length: number): string {
  const random = seededRandom(seed);
  return Array.from({ length }, () => Math.floor(random() * 16).toString(16)).join("");
}

function policy(): TaskLifecyclePolicy {
  const draft: TaskLifecyclePolicy = {
    policy_digest: "",
    approval_required: true,
    approval_ttl_ms: 60_000,
    maximum_cost_usd: 5,
    maximum_runtime_ms: 60_000,
    maximum_model_calls: 12,
    maximum_fix_cycles: 2,
    protected_paths: [".github"],
    allowed_write_paths: ["src", "tests"],
    validation_commands: [{
      command_id: "test",
      argv: ["npm", "test"],
      cwd: ".",
      timeout_ms: 30_000,
      required: true,
      mutation_allowed: false,
      source: "repository-policy",
    }],
    forbidden_actions: ["merge", "deployment"],
  };
  return {
    ...draft,
    policy_digest: digestTaskValue({ ...draft, policy_digest: undefined }),
  };
}

function initialState(seed: number): DurableTaskState {
  return makeInitialTaskState({
    repository: { repository_id: "123", full_name: "owner/repo", default_branch: "main" },
    issue_number: seed + 1,
    expected_base_commit: "a".repeat(40),
    policy: policy(),
    event_id: `create-${seed}`,
    now: NOW,
    actor: "maintainer",
  });
}

function applyState(
  state: DurableTaskState,
  seed: number,
  transitionTo: TaskLifecycleState,
  patch: Parameters<typeof applyTaskStateMutation>[1]["patch"] = undefined,
): DurableTaskState {
  const result = applyTaskStateMutation(state, {
    expected_revision: state.revision,
    expected_current_state: state.current_state,
    event_id: `event-${seed}-${state.revision}`,
    actor: "maintainer",
    transition_to: transitionTo,
    reason: `seeded transition ${seed}`,
    now: new Date(Date.parse(NOW) + state.revision * 1_000).toISOString(),
    patch,
  });
  assert.equal(result.status, "applied");
  return result.state;
}

function approvedState(seed: number): DurableTaskState {
  let state = initialState(seed);
  state = applyState(state, seed, "ready");
  state = applyState(state, seed, "planned", { plan_digest: seededHex(seed + 100, 64) });
  const approval = makeTaskApproval({
    state,
    approver: "maintainer",
    approved_at: new Date(Date.parse(NOW) + 3_000).toISOString(),
    approval_ttl_ms: 30_000,
  });
  return applyState(state, seed, "approved", { approval });
}

function preflight(seed: number): RepositoryInstallationPreflight {
  return {
    disposition: "ready",
    analysis_allowed: true,
    identity: {
      repository_id: "123",
      full_name: "owner/repo",
      default_branch: "main",
      current_commit: "a".repeat(40),
      current_branch: "main",
      origin_url: "https://github.com/owner/repo.git",
      actor_login: "maintainer",
      actor_permission: "admin",
      default_branch_policy: "protected",
    },
    commands: [{
      command_id: "test",
      kind: "test",
      argv: ["npm", "run", `test:${seed}`],
      cwd: ".",
      timeout_ms: 30_000,
      required: true,
      assessment: "verified",
      exit_code: 0,
      output_digest: seededHex(seed, 64),
      detail: "seeded validation command",
    }],
    allowed_write_paths: ["src", "tests"],
    protected_paths: [".github"],
    blockers: [],
  };
}

test("seeded repository paths normalize portably and reject every escape form", () => {
  for (let seed = 1; seed <= 128; seed += 1) {
    const random = seededRandom(seed);
    const segments = Array.from(
      { length: 1 + Math.floor(random() * 5) },
      (_, index) => seededToken(seed * 17 + index, 1 + Math.floor(random() * 12)),
    );
    const expected = segments.join("/");
    const separator = seed % 2 === 0 ? "/" : "\\";
    const candidate = `${seed % 3 === 0 ? `.${separator}` : ""}${segments.join(separator)}`;
    assert.equal(normalizeTaskPath(` ${candidate} `), expected, `seed ${seed}`);
    assert.equal(pathWithinTaskScope(`${expected}/child.ts`, expected), true, `seed ${seed}`);
    assert.equal(pathWithinTaskScope(`${expected}-sibling/child.ts`, expected), false, `seed ${seed}`);

    for (const unsafe of [
      `../${expected}`,
      `${expected}/../outside`,
      `${expected}//child`,
      `${expected}/./child`,
      `/${expected}`,
      `C:/${expected}`,
      `${expected}\0child`,
      `${expected}\nchild`,
    ]) {
      assert.throws(
        () => normalizeTaskPath(unsafe),
        (error: unknown) => error instanceof TaskLifecycleError && error.code === "invalid_input",
        `seed ${seed} accepted unsafe path ${JSON.stringify(unsafe)}`,
      );
    }
  }
});

test("directory-style issue paths with trailing slashes normalize to their scope root", () => {
  // The documented issue template uses directory paths such as `.github/` in
  // `## Scope` / `## Out of scope`. These must normalize to the same scope
  // root instead of failing closed on the empty trailing segment.
  assert.equal(normalizeTaskPath(".github/"), ".github");
  assert.equal(normalizeTaskPath("src/example/"), "src/example");
  assert.equal(normalizeTaskPath("./docs/"), "docs");
  assert.equal(pathWithinTaskScope(".github/workflows/ci.yml", ".github/"), true);
  assert.throws(() => normalizeTaskPath(".github//workflows"));
  assert.throws(() => normalizeTaskPath("/"));
});

test("seeded JSON key permutations retain canonical bytes and digests", () => {
  for (let seed = 1; seed <= 128; seed += 1) {
    const entries = Array.from({ length: 3 + seed % 7 }, (_, index) => [
      `key_${seededToken(seed * 31 + index, 8)}_${index}`,
      {
        enabled: (seed + index) % 2 === 0,
        index,
        values: [seed, index, seededToken(seed + index, 5)],
      },
    ] as const);
    const forward = Object.fromEntries(entries);
    const reverse = Object.fromEntries([...entries].reverse());
    assert.equal(canonicalTaskJson(forward), canonicalTaskJson(reverse), `seed ${seed}`);
    assert.equal(digestTaskValue(forward), digestTaskValue(reverse), `seed ${seed}`);
    assert.notEqual(digestTaskValue([seed, seed + 1]), digestTaskValue([seed + 1, seed]), `seed ${seed}`);
  }
});

test("every initial-state transition is accepted or rejected by the explicit lifecycle matrix", () => {
  for (const [index, target] of ALL_STATES.entries()) {
    const state = initialState(index + 1_000);
    const mutate = () => applyState(state, index + 1_000, target);
    if (INITIAL_TRANSITIONS.has(target)) {
      assert.equal(mutate().current_state, target);
    } else {
      assert.throws(
        mutate,
        (error: unknown) => error instanceof TaskLifecycleError && error.code === "invalid_transition",
        `new -> ${target} must fail closed`,
      );
    }
  }
});

test("seeded task approval bindings invalidate on every bound-field change", () => {
  for (let seed = 1; seed <= 72; seed += 1) {
    const state = approvedState(seed + 2_000);
    const variant = seed % 3;
    const patch = variant === 0
      ? { plan_digest: seededHex(seed + 3_000, 64) }
      : variant === 1
        ? { expected_base_commit: seededHex(seed + 4_000, 40) }
        : { policy_digest: seededHex(seed + 5_000, 64) };
    const changed = applyState(state, seed + 2_000, "ready", patch);
    assert.equal(changed.approval, null, `seed ${seed} retained a stale approval`);

    const control = approvedState(seed + 6_000);
    const unbound = applyState(control, seed + 6_000, "ready", {
      selected_specialist_ids: [`specialist-${seed}`],
    });
    assert.deepEqual(unbound.approval, control.approval, `seed ${seed} discarded unchanged approval bindings`);
  }
});

test("seeded manifest, lockfile, and command drift invalidate validation approval", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-generative-approval-"));
  const packagePath = path.join(cwd, "package.json");
  const lockPath = path.join(cwd, "package-lock.json");
  const packageBytes = `${JSON.stringify({ name: "fixture", scripts: { test: "node --test" } }, null, 2)}\n`;
  const lockBytes = `${JSON.stringify({ lockfileVersion: 3 }, null, 2)}\n`;
  try {
    fs.writeFileSync(packagePath, packageBytes);
    fs.writeFileSync(lockPath, lockBytes);
    const baseline = preflight(1);
    const approval = createRepositoryValidationApproval({
      cwd,
      preflight: baseline,
      approvedBy: "maintainer",
      approvedAt: NOW,
    });
    assert.equal(repositoryValidationApprovalCurrent({ cwd, preflight: baseline, approval }), true);

    for (let seed = 1; seed <= 96; seed += 1) {
      fs.writeFileSync(packagePath, packageBytes);
      fs.writeFileSync(lockPath, lockBytes);
      const changed = structuredClone(baseline);
      switch (seed % 6) {
        case 0:
          fs.writeFileSync(packagePath, `${packageBytes.trimEnd()} ${seed}\n`);
          break;
        case 1:
          fs.writeFileSync(lockPath, `${lockBytes.trimEnd()} ${seed}\n`);
          break;
        case 2:
          changed.commands[0].argv.push(`--seed=${seed}`);
          break;
        case 3:
          changed.commands[0].cwd = `packages/${seed}`;
          break;
        case 4:
          changed.commands[0].timeout_ms += seed;
          break;
        default:
          changed.commands[0].command_id = `test-${seed}`;
      }
      assert.equal(
        repositoryValidationApprovalCurrent({ cwd, preflight: changed, approval }),
        false,
        `seed ${seed} retained approval after drift`,
      );
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
