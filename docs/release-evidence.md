# Release Evidence Ledger

Use this ledger for every external beta or public npm release candidate. The
goal is to preserve the evidence that the local test surface, stamped GitHub
runtime, model-backed workflows, and expert loop were exercised against a real
repository.

Do not mark a release candidate qualified from memory. Fill this file or copy
this template into a dated release note before publishing.

## Release Candidate

| Field | Value |
|---|---|
| Version | |
| Candidate commit | |
| Date | |
| Operator | |
| Staged repository | |
| Pi version | |
| Provider/model | |

## Local Gates

| Gate | Command | Result | Evidence |
|---|---|---|---|
| Typecheck | `npm run typecheck` | | |
| Generated output | `npm run test:generated-output` | | |
| Scaffold e2e | `npm run test:scaffold-e2e` | | |
| Release check | `npm run release:check` | | |

## Live GitHub Runtime Gates

Run these from the staged repository after `agentify` has stamped the scaffold
and Actions secrets/variables are configured.

| Gate | Command | Result | Evidence |
|---|---|---|---|
| Implement preflight | `bash .github/scripts/smoke-github-runtime.sh --evidence-file docs/release/smoke-implement-preflight.json` | | Evidence JSON |
| Drill preflight | `bash .github/scripts/smoke-drill-github-runtime.sh --evidence-file docs/release/smoke-drill-preflight.json` | | Evidence JSON |
| Retry command | `bash .github/scripts/smoke-retry-github-runtime.sh --evidence-file docs/release/smoke-retry.json` | | Evidence JSON |
| Model implementation | `bash .github/scripts/smoke-model-github-runtime.sh --confirm-model-run --evidence-file docs/release/smoke-model-implement.json` | | Evidence JSON |
| Model review | `bash .github/scripts/smoke-review-github-runtime.sh --confirm-model-run --pr <number> --evidence-file docs/release/smoke-review.json` | | Evidence JSON |
| Model refresh | `bash .github/scripts/smoke-refresh-github-runtime.sh --confirm-model-run --evidence-file docs/release/smoke-refresh.json` | | Evidence JSON |

Each smoke script writes `agentify.smoke-evidence.v1` JSON when
`--evidence-file <path>` is provided. The file records the gate name,
repository, candidate commit SHA, pass result, completion time, and the issue,
PR, and workflow URL that prove the run. Workflow run lookup is time-bounded to
runs created after the smoke starts, so a candidate cannot reuse stale Actions
runs from earlier smokes. The commit is read from `AGENTIFY_SMOKE_COMMIT_SHA`
when set, otherwise from `git rev-parse HEAD`.

Verify the full set before qualifying a candidate:

```bash
npm run verify:smoke-evidence -- \
  docs/release/smoke-implement-preflight.json \
  docs/release/smoke-drill-preflight.json \
  docs/release/smoke-retry.json \
  docs/release/smoke-model-implement.json \
  docs/release/smoke-review.json \
  docs/release/smoke-refresh.json
```

The verifier fails when a required gate is missing, a gate appears more than
once, a result is not `passed`, the evidence spans multiple repositories, or a
required issue, PR, or workflow URL is absent or points at a different
repository.

To verify only the no-model staged smoke gates during beta hardening, use the
explicit no-LLM profile:

```bash
npm run verify:smoke-evidence -- --profile no-llm \
  docs/release/smoke-implement-preflight.json \
  docs/release/smoke-drill-preflight.json \
  docs/release/smoke-retry.json
```

The default profile remains the full six-gate public-release check.

For public release qualification, run the combined evidence gate after smoke
and expert transcript evidence are present:

```bash
npm run qualify:release-evidence -- \
  --repo owner/name \
  --commit <candidate-sha> \
  --since <candidate-started-at-iso> \
  --expert docs/dogfood/expert-outcomes.json \
  --smoke docs/release/smoke-implement-preflight.json \
  --smoke docs/release/smoke-drill-preflight.json \
  --smoke docs/release/smoke-retry.json \
  --smoke docs/release/smoke-model-implement.json \
  --smoke docs/release/smoke-review.json \
  --smoke docs/release/smoke-refresh.json
```

This command composes the smoke evidence verifier and the expert outcome scorer
so a release candidate cannot pass with only GitHub smoke evidence or only
expert transcript evidence. The expert manifest must include passing `plan`,
`review`, and `refresh` cases, and the smoke evidence repository must match the
explicit `--repo <owner/name>` staged repository and `--commit <sha>` candidate
commit. The expert manifest must also identify the same staged repository and
candidate commit, include the provider/model used to capture the transcripts,
and have `captured_at` on or after the explicit `--since <iso>` evidence
window. Every smoke evidence file must also have `completed_at` on or after
the same evidence window.

## Recorded Staged Evidence

### 2026-07-08 no-LLM GitHub runtime smoke

This staged run used a private disposable repository stamped from the current
`scaffold/` contents:
`anirudhsengar/agentify-staging-no-llm-20260708053113`.

Staged commit: `e20d03d47de5a8c7c1958ab51ab5077c13277ba8`.

Push-triggered scaffold validation:

| Workflow | Result | Run |
|---|---|---|
| Validate agentify | Passed | `https://github.com/anirudhsengar/agentify-staging-no-llm-20260708053113/actions/runs/28928751651` |
| Agent Refresh Surface | Passed | `https://github.com/anirudhsengar/agentify-staging-no-llm-20260708053113/actions/runs/28928751672` |

The no-LLM smoke evidence files include both the smoke issue URL and the
matching workflow run URL:

| Gate | Issue | Workflow run |
|---|---|---|
| Implement preflight | `https://github.com/anirudhsengar/agentify-staging-no-llm-20260708053113/issues/15` | `https://github.com/anirudhsengar/agentify-staging-no-llm-20260708053113/actions/runs/28928787955` |
| Drill preflight | `https://github.com/anirudhsengar/agentify-staging-no-llm-20260708053113/issues/16` | `https://github.com/anirudhsengar/agentify-staging-no-llm-20260708053113/actions/runs/28928812059` |
| Retry command | `https://github.com/anirudhsengar/agentify-staging-no-llm-20260708053113/issues/17` | `https://github.com/anirudhsengar/agentify-staging-no-llm-20260708053113/actions/runs/28928836144` |

| Gate | Result | Evidence |
|---|---|---|
| Implement preflight | Passed | `docs/release/no-llm-20260708053113/smoke-implement-preflight.json` |
| Drill preflight | Passed | `docs/release/no-llm-20260708053113/smoke-drill-preflight.json` |
| Retry command | Passed | `docs/release/no-llm-20260708053113/smoke-retry.json` |

Verification:

```bash
npm run verify:smoke-evidence -- --profile no-llm \
  docs/release/no-llm-20260708053113/smoke-implement-preflight.json \
  docs/release/no-llm-20260708053113/smoke-drill-preflight.json \
  docs/release/no-llm-20260708053113/smoke-retry.json
```

The first drill attempt timed out because `agent-drill-me-issue.yml` skipped
bot-authored events before checking the exact no-model smoke marker. The
workflow now handles the exact smoke marker before bot self-loop skipping, and
the rerun passed on issue
`https://github.com/anirudhsengar/agentify-staging-no-llm-20260708053113/issues/16`.

The staged `Validate agentify` workflow also exposed a shell pipefail/SIGPIPE
bug in GitHub list preflights when fake or real `gh` output was piped directly
into early-exiting `grep`. Smoke/setup scripts now capture list output before
matching required labels, secrets, and variables, and the regression suite
covers long variable lists. The no-LLM staging repo also confirmed that
`agent-refresh-surface.yml` skips cleanly when model runtime configuration is
absent instead of failing before setup.

The no-LLM smoke scripts now also fail evidence writing if the relevant
workflow run URL cannot be resolved. The workflow lookup is time-bounded to
runs created after the smoke starts, and the verifier requires those URLs for
the no-LLM profile.

This is not public-release qualification. Model-backed implementation, review,
refresh, and expert outcome transcript evidence are still required before a
public npm release.

## Expert Outcome Evidence

Synthetic scorer coverage is not a substitute for dogfood transcripts. Before a
public release, capture brownfield expert loops for `plan`, `review`, and
`refresh`, where the same task is run with generic context and with generated
expert context.

| Field | Value |
|---|---|
| Domain | |
| `expertise.yaml` path | |
| Baseline transcript | |
| Expert-guided transcript | |
| Baseline score | |
| Expert-guided score | |
| Delta | |
| Review/refresh follow-up | |

The expert-guided transcript should cite key files/types, patterns, pitfalls,
validation commands, and stale-knowledge handling from the generated
`expertise.yaml`.

For repeatable scoring, save transcript pairs in a manifest and run:

```bash
npm run score:expert-outcomes -- docs/dogfood/expert-outcomes.json
```

Manifest format:

```json
{
  "version": 1,
  "repo": "owner/name",
  "commit_sha": "0123456789abcdef0123456789abcdef01234567",
  "captured_at": "2026-07-07T00:00:00Z",
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "cases": [
    {
      "id": "billing-plan-2026-07-07",
      "mode": "plan",
      "expertise_path": "../../.pi/prompts/experts/billing/expertise.yaml",
      "baseline_transcript_path": "billing-plan-baseline.md",
      "expert_guided_transcript_path": "billing-plan-expert.md",
      "min_delta": 3
    },
    {
      "id": "billing-review-2026-07-07",
      "mode": "review",
      "expertise_path": "../../.pi/prompts/experts/billing/expertise.yaml",
      "baseline_transcript_path": "billing-review-baseline.md",
      "expert_guided_transcript_path": "billing-review-expert.md",
      "min_delta": 3
    },
    {
      "id": "billing-refresh-2026-07-07",
      "mode": "refresh",
      "expertise_path": "../../.pi/prompts/experts/billing/expertise.yaml",
      "baseline_transcript_path": "billing-refresh-baseline.md",
      "expert_guided_transcript_path": "billing-refresh-expert.md",
      "min_delta": 3
    }
  ]
}
```

`mode` must be `plan`, `review`, or `refresh`; public release qualification
requires at least one passing case for each mode. Top-level `repo`,
`commit_sha`, `captured_at`, `provider`, and `model` are required so public
release qualification rejects stale transcripts or transcripts captured from a
different staged repository or candidate commit than the release evidence
ledger claims, while preserving provider/model identity for review. Paths are
resolved relative to the manifest file. The command exits non-zero when any
expert-guided transcript misses required expertise checks or fails to beat the
baseline by `min_delta`.

## Release Decision

| Decision | Value |
|---|---|
| Qualified for private dogfood | |
| Qualified for external beta | |
| Qualified for public npm release | |
| Blockers | |
| Accepted limitations | |
