---
name: scaffold-ci
description: Stamp agentify's GitHub Actions runtime (the autonomous implement/review/fix loop + labeled-issue drilling) into the current repository. Use in a brownfield repo that has agentify installed but no CI runtime yet.
disable-model-invocation: true
tier: opt-in

---

# Scaffold CI

Stamp the agentify CI runtime into **this** repo so issues labeled `agent:implement`
get implemented, reviewed, and fixed by agents, and post-launch drilling runs through
labeled GitHub issues ([ADR-0007](../../../docs/adr/0007-pi-as-the-ci-coding-harness.md),
[ADR-0012](../../../docs/adr/0012-evolution-loop.md)).

Skip this in a repo created from the agentify template — the runtime is already stamped.
This is for the brownfield-install case (`pi install agentify`).

## Workflow

1. **Locate the agentify package's `scaffold/` directory.** It ships with the package;
   search the likely roots:

   ```bash
   find ~/.pi /usr/local/lib/node_modules ./node_modules -maxdepth 6 \
     -type d -path '*agentify*/scaffold/.github' 2>/dev/null | head -1
   ```

   If nothing is found, ask the user for the path to their agentify checkout and use its
   `scaffold/` directory.

2. **Stamp the payload into the repo root**, without clobbering anything the user already
   has (skip files that already exist; report each skip):
   - `scaffold/.github/` → `./.github/`
   - `scaffold/tests/` → `./tests/`
   - `scaffold/SETUP.md` → `./SETUP.md`
   - Append the lines in `scaffold/.gitignore` to `./.gitignore` (create it if missing).

3. **Verify** the stamped runtime parses: `bash tests/run.sh`. The contract tests check
   skill/lock/label/workflow-security/drill-me invariants. Fix any failure before
   handing back.

4. **Point the user at `SETUP.md`** for the one-time configuration agents need: the
   `agent:*` + `artifact:prd` labels, the `PI_*` Actions variables, the `PI_API_KEY` /
   `AGENT_PAT` secrets, and the `agent:drill-me` label. The runtime cannot run
   until those exist.

## Rules

- **MUST NOT** overwrite existing workflows, scripts, or `SETUP.md` — agents-owned CI is
  the user's; merge, report skips, never clobber.
- **MUST NOT** commit or push — the user reviews the stamped files and commits.
- The runtime is committed into this repo and lives independently of agentify
  ([ADR-0008](../../../docs/adr/0008-one-package-two-entry-modes.md)); CI calls `pi`
  directly against the stamped skills and never loads the extension.
