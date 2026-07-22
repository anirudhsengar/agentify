# agentify

[![npm](https://img.shields.io/npm/v/%40anirudhsengar%2Fagentify)](https://www.npmjs.com/package/@anirudhsengar/agentify)
[![license](https://img.shields.io/npm/l/%40anirudhsengar%2Fagentify)](https://github.com/anirudhsengar/agentify/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/%40anirudhsengar%2Fagentify)](https://github.com/anirudhsengar/agentify/blob/main/package.json)
[![ci](https://img.shields.io/github/actions/workflow/status/anirudhsengar/agentify/ci.yml?branch=main)](https://github.com/anirudhsengar/agentify/actions/workflows/ci.yml)
[![codeql](https://img.shields.io/github/actions/workflow/status/anirudhsengar/agentify/codeql.yml?branch=main&label=codeql)](https://github.com/anirudhsengar/agentify/actions/workflows/codeql.yml)

**One terminal command for the full life of an agentic codebase.**

`agentify` is a standalone CLI. You run it once inside a repository and
it turns that repository into an "agentic codebase": it audits the code,
generates codebase-specific agent intelligence and ships a generic skill
pack. The GitHub Actions runtime is an explicit opt-in for repositories that
want issues, comments, and PRs to drive agentic work.

## Install

Requires Node `>=22.19.0`.

```bash
npm install -g @anirudhsengar/agentify
# or run without installing:
npx @anirudhsengar/agentify
```

On first run, agentify asks for an LLM provider and API key (or reads
one from the environment) and stores configuration under `~/.agentify/`
with `0600` permissions. Nothing is written to your repository during
auth setup.

```bash
agentify
```

For CI or scripted use, pre-seed auth via a provider environment
variable (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) before running
`agentify`. The CLI will not prompt and will fail with a clear error
if a required input is missing. Pass `--mode brownfield` or
`--mode greenfield` to skip project-kind classification for
ambiguous repos:

```bash
agentify --mode brownfield
```

See [docs/README.md](docs/README.md) for the documentation index.

## What It Does

The installed `agentify` executable is the supported public runtime surface in
0.2.x, including its deliberately small `agentify engage` record-and-analysis
family. Internal runtime modules are experimental implementation details, not
package APIs or hidden command families. See
[docs/experimental-surfaces.md](docs/experimental-surfaces.md).

- **Audit/comprehension:** scan an existing codebase and generate its
  agentic surface: `AGENTS.md`, `specs/README.md`, `ai_docs/README.md`,
  feature agents, experts, and harness exports.
- **Greenfield/genesis:** start from an empty or starter repo, capture
  project intent, and move one goal at a time through PRDs, plans,
  issues, and specs.
- **Internal control plane:** orchestrators, specialists, experts, and
  workflows remain implementation machinery, not separate public command
  families.
- **FDE engagement records:** `agentify engage init|status|validate|report` and
  explicit `agentify engage promotion status|evaluate|approve|revoke`
  creates and analyzes deterministic local engagement records without invoking
  an LLM, implementing code, or claiming deployment.
- **GitHub-first async loop:** after bootstrap, issues, comments, and
  PRs are the primary out-of-loop surface.

Generated project artifacts live under the selected harness's Agentify state
directory. Compatibility paths such as `.pi/agents` are relative symlinks to
that canonical surface, rather than a second physical copy. Harness-native
exports (`.agents/skills`, `.claude/skills`, `.codex/agents`, etc.) remain in
the locations their respective tools require. The agentify package itself is
not a Pi extension.

## Existing Repo

Run agentify from the repository root:

```bash
agentify
```

On first run, the CLI asks for provider/auth configuration and stores it
under `~/.agentify/`. After auth, the CLI prompts you to pick which
coding agent(s) you're targeting — Claude Code, Codex, Pi, and ~70 others
in the registry (Cursor, OpenCode, Windsurf, GitHub Copilot, Cline,
Continue, Roo Code, Kilo Code, …). The audit writes codebase-specific
intelligence to the current repository and exports harness surfaces only
to the selected targets. Interactive runs ask before installing the optional
GitHub runtime; non-interactive runs require `--github-runtime`. Later runs attach to an initialized repo, report last
run status, installed surface counts (feature agents, workflows, experts,
and repo skills), the latest log path, and recover incomplete setup when
needed. User-owned files are reported as conflicts and left intact.

## New Repo

Run `agentify` in an empty or starter repo. The CLI starts a local-first
greenfield session. The model submits a typed formation payload through
`write_greenfield_artifacts`; its `stop_at` field is a hard checkpoint
gate, so agentify rejects PRDs, plans, issues, or specs beyond the
user-approved milestone. agentify deterministically renders `CONTEXT.md`,
`GOALS.md`, PRDs, plans, issues, and specs from that payload, records
artifact validation and resume context in `<stateDir>/greenfield-state.json`,
and can install the GitHub runtime scaffold only after the artifacts pass the
substance gate and the user explicitly opts in. The state file also includes a structured `github_handoff`
with the next issue title, body, labels, and artifact paths, so
post-bootstrap work can enter the same GitHub loop without relying on prose
alone. Approved unblocked implementation handoffs can activate the issue
explicitly, applying both `agent:queued` and `agent:implement` after the
trusted workflow checks referenced blockers; draft slices and blocked work
remain queued only. It then proceeds one selected goal/sub-goal at a time
through the same build chain. Post-launch drill issues receive that
formation resume context, and the credential-free model run can request
child, PRD, or implementation issues through structured output that the
trusted workflow applies with the right labels. Subsequent runs attach to
that initialized state instead of acting like a separate tool family.

## Engagement records

```bash
agentify engage init --input engagement.json --yes
agentify engage status --id invoice-review
agentify engage validate --id invoice-review
agentify engage report --id invoice-review --stdout
agentify engage promotion status --id invoice-review
```

`init` prompts for required facts in an interactive terminal or accepts a strict
charter-input JSON file for automation. Reports are deterministic Markdown at
`<stateDir>/engagements/<engagementId>/reports/engagement-summary.md`. This is an
engagement-record and analysis surface, not an autonomous FDE: it performs no
workflow discovery, model call, evaluation, implementation, deployment, or
implicit autonomy promotion. Promotion is recorded separately through
`agentify engage promotion status|evaluate|approve|revoke`. Only `observe` is
currently operational, and promotion records do not enable GitHub behavior.
See [the autonomy and promotion guide](docs/autonomy-and-promotion.md).

After valid shadow evidence and explicit promotion, human-approved `draft`
mode can implement in an isolated GitHub Actions checkout and publish an
unmerged draft pull request. It never merges, force-pushes, or pushes to the
default branch. See [the draft-mode operator guide](docs/github-draft-mode.md).

## FDE evaluations

```bash
agentify eval validate --id invoice-review --suite regression
agentify eval run --id invoice-review --suite regression --input trial-artifacts.json
agentify eval report --id invoice-review --suite regression --run-id <run-id> --stdout
```

Evaluation commands validate explicit tasks and suites, grade imported
structured evidence, resume completed trials, and produce deterministic release
eligibility reports. They do not expose the experimental orchestrator or execute
shell commands supplied by task files. See
[the evaluation architecture](docs/eval-architecture.md) and the
[grader-authoring guide](docs/eval-grader-authoring.md).

## Where does agentify write?

The audit's **state directory** is provider-scoped. The user picks
their harness at runtime, and the audit writes its internal state
under the matching dotdir:

| User picks                       | State dir                |
|----------------------------------|--------------------------|
| `claude-code`                    | `.claude/agentify/`      |
| `codex` (no `claude-code`)       | `.agents/agentify/`      |
| `pi` (no `claude-code`/`codex`)  | `.pi/agentify/`          |
| only non-premium agents          | `.agents/agentify/`      |

Inside that state dir agentify stores:

- `codebase_map.json` — the canonical structured audit
- `manifest.json` — the managed-file manifest (with a `state_dir` field)
- `greenfield-state.json` / `greenfield-formation.json` (greenfield only)
- `agents/`, `prompts/`, `workflows/`, `extensions/`, `skills/`,
  `experts/`, `logs/`, `history/` — the complete Agentify-owned generated
  surface for that selected harness

For compatibility with the existing Pi-shaped runtime references, Agentify
creates relative `.pi/agents`, `.pi/prompts`, `.pi/workflows`,
`.pi/extensions`, and `.pi/conditional_docs.md` symlinks to this canonical
surface when those paths are available. It never replaces an existing file or
symlink at a compatibility path.

The per-harness output dirs (`.claude/agents/`, `.codex/agents/`,
`.pi/skills/`, `.agents/skills/`, etc.) are unchanged — they
remain the registry-driven fan-out destinations.

**Migration**: repos with safe pre-provider-scoping state at `.pi/agentify/` are detected deterministically and receive exact source/destination guidance. For a non-Pi target, agentify copies the complete legacy tree into transaction-owned storage, verifies source and candidate fingerprints, and atomically installs the provider-scoped destination. The original legacy tree is retained unchanged and is never silently deleted. Interrupted migrations recover from the durable journal before attach, status, revert, brownfield, or greenfield work continues.

Provider switching is separate from automatic legacy upgrade. Switching among Claude, Codex, and Pi requires an explicit `--targets` selection together with `--migrate-state`; ambiguous, divergent, occupied, unreadable, user-owned, or symlinked layouts stop before writes. Canonical readers use only the authoritative provider-scoped state and do not probe retained cross-provider trees.

All supported runtime operations carry that resolved state directory explicitly. Deprecated singleton write-map tools, mutable renderer/write-map setters, and legacy path wrappers have been removed. Old manifest formats remain readable only through dedicated upgrade readers, and Pi continues to use `.pi/agentify/` as its canonical state.

## What Gets Written

On a successful **brownfield** audit, agentify writes into your repo:

| Path | What |
|------|------|
| `AGENTS.md` | Codebase-specific agent guide (capped at 200 lines) |
| `specs/README.md`, `ai_docs/README.md` | Always-on context artifacts |
| `<stateDir>/agents/<feature>.md` | Generated feature specialists, summarized into GitHub implement/review prompts as routing context |
| `<stateDir>/prompts/`, `<stateDir>/workflows/`, `<stateDir>/extensions/`, `<stateDir>/skills/` | Deterministically rendered prompt templates, orchestrator workflow specs that are summarized into GitHub implement prompts, expert directories summarized into implement/review prompts, extension candidates, and repo-specific skill candidates when warranted |
| `app_review/`, `app_docs/`, `app_fix_reports/`, `<stateDir>/conditional_docs.md` | Feedback-loop storage used by the shipped review, document, fix, and implementation skills; legacy `.pi` references are symlinked when safe |
| `<stateDir>/codebase_map.json`, `<stateDir>/manifest.json` | The validated audit map and managed-file manifest |
| `.agents/skills/`, `.claude/`, `.codex/`, `CLAUDE.md` | Harness exports — only to the targets you picked in the picker (or via `--targets`) |
| `SETUP.md`, `.github/workflows/*`, `.github/scripts/*` | Optional GitHub runtime scaffold (`--github-runtime` or interactive confirmation) |

On a successful **greenfield** formation, agentify writes
`CONTEXT.md`, `GOALS.md`, `docs/prds/*`, `docs/plans/*`,
`docs/issues/*`, `specs/*`, `<stateDir>/greenfield-formation.json`,
`<stateDir>/greenfield-state.json`, `<stateDir>/manifest.json`, and
the same optional GitHub runtime scaffold when selected.

Generated files carry an `agentify:managed` marker. agentify never
overwrites a pre-existing user-owned file: it reports it as a conflict,
leaves it intact, and keeps readiness `partial` when the conflict is
required. User-facing files are applied from a staged bundle only after
the audit closes every coverage dimension; a partial audit reports its
gaps and rolls back generated surface writes.

## Skill Catalog

The shipped skill pack (`packaged/skills/`) has **25 skills** organized
in two tiers. The installer picks what ships based on your project
classification — no config file required.

### Core (18, always shipped)

Six skills are model-invoked (their descriptions sit in the agent's
system prompt at every session). Twelve are user-invoked (typed by
name, no context cost).

| Skill | Invocation | Purpose |
|-------|-----------|---------|
| `codebase-design` | model | Vocabulary for designing deep modules |
| `domain-modeling` | model | Domain language discipline |
| `diagnosing-bugs` | model | Six-phase diagnosis loop for hard bugs |
| `tdd` | model | Red-green-refactor discipline |
| `review` | model | Two-axis (Standards + Spec) review |
| `resolving-merge-conflicts` | model | Resolve an in-progress merge/rebase |
| `drill-me` | user | Interview on a Goal or Sub-goal |
| `to-goals` | user | Break a wide discussion into Goals |
| `to-prd` | user | Synthesize a PRD from a conversation |
| `to-plan` | user | Interview on implementation ordering |
| `to-issues` | user | Slice a plan into tracer-bullet issues |
| `scout` | user | Read-only codebase recon |
| `spec` | user | Write one build spec |
| `plan-build` | user | The `spec → implement` chain at `depth:2 \| depth:3 \| depth:4` |
| `implement` | user | Execute a build spec test-first |
| `fix` | user | Minimal patch for one blocker |
| `test` | user | Run the validation surface |
| `document` | user | Capture a completed slice as a feature doc |

### Opt-in (7, classifier-driven)

The project classifier inspects the repo at install time and adds
opt-ins to the shipped set. Opt-ins only auto-install on **high**
classification confidence — better to under-install than push skills
that don't fit.

| Skill | Auto-installed when | Purpose |
|-------|---------------------|---------|
| `prototype` | `greenfield` (high) | Throwaway prototype for design questions |
| `scaffold-ci` | `brownfield` (high) | Stamp the AFK GitHub Actions runtime |
| `refresh-surface` | `brownfield` (high) | Re-sync the agentic surface after merges |
| `improve-codebase-architecture` | `brownfield` (high) | Scan for deepening opportunities |
| `scout-then-plan` | `brownfield` (high) | Recon with feature specialists, then write a spec |

#### Manual opt-in (never auto-installed)

These two are *always* opt-in — the agentify README is the only place
they're listed. Copy by hand from `node_modules/@anirudhsengar/agentify/packaged/skills/<name>`
(or your `agentify` checkout) into `.claude/skills/` (and any other
dotfolder you target):

| Skill | Purpose |
|-------|---------|
| `handoff` | Compact the current session into a handoff doc |
| `writing-great-skills` | Reference for writing skills well (for skill authors) |

### Tier drift

If you upgrade agentify and a previously-installed skill drops out of
the new tier (e.g. a `prototype` in a brownfield repo), the next
`agentify` run removes it from `.claude/skills/`, `.agents/skills/`,
and `.pi/skills/`. Only files carrying the `<!-- agentify:managed -->`
marker are touched — your own skill files at those paths are left
alone.

## After Bootstrap

1. Review the generated diff, then commit and push to your default
   branch — the GitHub loop only exists once these files are pushed.
2. Run `bash .github/scripts/setup-agentify.sh` to create the `agent:*`
   labels.
3. Set Actions secrets `PI_API_KEY` and `AGENT_PAT`, and variables
   `PI_VERSION` and `PI_MODEL` (details in the stamped `SETUP.md`).
4. Drive work through GitHub issues, comments, and PRs.

## Command Surface

```bash
# Runtime entry — the only public command that runs the audit/attach loop.
agentify [--mode brownfield|greenfield] [--targets <agent-ids>]
agentify --help
agentify --version

# Skip the interactive agent-target picker. Comma-separated agent
# IDs from the registry. Use `agentify` with no flags to see the
# full list. Persisted targets are NOT respected — every fresh run
# re-prompts unless `--targets` is passed.
agentify --targets claude-code,codex
agentify --targets claude-code,codex,cursor,opencode

# Config-utility subcommands — manage ~/.agentify/{config,auth}.json only;
# they never invoke the runtime.
agentify login [--provider <name>] [--key <key>]
agentify logout [--provider <name> | --all] [--yes]
agentify models list [--provider <name>]
agentify models show [--resolved]
agentify models set <provider>/<model>             # legacy: writes to provider/model
agentify models set <slot> <provider>/<model>      # slot: primary|explorer|lite
agentify models unset                                # legacy: clears provider/model
agentify models unset <slot>                         # clears that slot
```

The runtime entry (`agentify` with no positional arguments) is what
performs the brownfield audit or starts the greenfield chat. The
config-utility subcommands exist to inspect and edit `~/.agentify/`
without manually editing files. The `--mode` flag skips project-kind
classification for ambiguous repos. Internal experimental runtimes
(`webhook`, `aiw`, `orchestrator`, `coms`, `expert`) are not public
subcommands or package exports. See
[docs/experimental-surfaces.md](docs/experimental-surfaces.md) and the entry-mode
notes in `docs/README.md`.

### Model slots

agentify exposes three named model slots so you can assign different
models to different parts of the audit:

| Slot | Default consumer |
| --- | --- |
| `primary` | Brownfield/greenfield builder, orchestrator host, AIW phase, webhook task |
| `explorer` | `spawn_explorer` sub-agents |
| `lite` | Reserved for future lightweight judgment-call surfaces |

When a slot is unset, the resolver falls back to `primary` (or, if
neither slot is set, to the legacy `provider`/`model` fields).
**agentify never silently picks a "weaker" model** when you've
explicitly configured one — see the "max quality is the floor"
invariant in `docs/README.md`.

On first run, agentify prompts for a model strategy:
"Use one model for everything" (sets `primary` only) or
"Assign different models per role" (prompts for primary, then
optionally explorer/lite). The CLI lets you change this later.

## Troubleshooting

- **"Cannot prompt because stdin is not interactive"** — you ran
  agentify without a TTY and without pre-configured auth. Set a provider
  env var (e.g. `OPENAI_API_KEY`) or create `~/.agentify/auth.json`
  before running `agentify`. Pass `--mode brownfield` to skip
  classification for an ambiguous repo.
- **"audit did not complete"** — the audit did not close every coverage
  dimension, so no files were exported. agentify prints the specific
  gaps and the path to a JSONL run log under `~/.agentify/logs/agentify/`.
  Inspect it with `npm run inspect-log` (from a clone) or re-run
  `agentify` to resume.
- **GitHub loop does nothing after bootstrap** — confirm you committed
  and pushed the generated files, ran `setup-agentify.sh`, set the
  `PI_API_KEY`/`AGENT_PAT` secrets, and that the issue carries both
  `agent:queued` and `agent:implement`. Draft execution also requires valid
  shadow evidence, an active promotion to `draft`, eligible lifecycle/risk
  state, complete structured validation configuration, and the label actor's
  explicit human approval for the exact base. The implement workflow first runs
  a credential-free orchestration planner over the generated workflow,
  specialist, and expert context, then passes that route to the implementation
  agent.

Webhook, AIW, orchestrator, communications, and expert modules remain internal
experimental code. The public GitHub loop uses generated
workflow/specialist/expert context plus the orchestration-planner prompt; it does
not expose an internal host as a public command, library API, or hosted control
plane. See [docs/experimental-surfaces.md](docs/experimental-surfaces.md).

The shipped skill pack lives in `packaged/skills/` — outside
`.agents/` or `.claude/` at the repo root by design. The installer
copies it into each **target** repository at the harness's expected
locations (`.agents/skills/` for Codex/Pi, `.claude/skills/` for
Claude Code, plus `.codex/agents/`, `CLAUDE.md`, etc. as configured).
Keeping the source out of dotfolders means the maintainer's coding
agent — regardless of which harness they run — does not auto-load
the shipped build chain on every session. Those skills are generic
machinery; the audit generates only codebase-specific intelligence.

## Repository Layout

```
agentify/
├── bin/agentify.js                 # public CLI entrypoint
├── src/cli.ts                      # single public CLI entrypoint
├── src/core/agentify-app.ts        # public application seam behind `agentify`
├── src/core/audit/                 # audit prompts, schema, custom tools, defense hook
├── src/core/orchestrator/          # internal control-plane runtime
├── src/core/aiw/                   # internal workflow runtime
├── src/core/webhook/               # internal trigger/runtime adapter
├── packaged/skills/                # shipped skill pack (single source of
│                                  # truth; lives outside .agents/ or
│                                  # .claude/ so no coding harness
│                                  # auto-loads it on the maintainer's
│                                  # dev session)
├── scaffold/                       # stampable CI runtime
└── docs/                           # architecture docs
```

## Development

```bash
npm run typecheck
npm test
bash tests/run.sh
```

Useful docs:

- [docs/README.md](docs/README.md) — the documentation index.
