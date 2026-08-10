# Edge-Case Validation Campaign Report

Date: 2026-08-10  
Runner repo: `C:\code\agentify`  
Session: exhaustive validation campaign (synthetic + live repos)

## Phase 1: Repository Test Gates

| Gate | Result | Notes |
| --- | --- | --- |
| `npm run typecheck` | **PASS** | Strict TS clean |
| `npm run test:unit` (64 files) | **PASS** | Includes edge-case (23) + live-repo probe (2) |
| `tests/run.sh` | **PASS** | Maintenance, boundaries, parity |
| `npm run verify:scaffold` | **PASS** | Issue + learn workflow e2e |
| `npm run verify:package` | **BLOCKED** | Requires clean git tree (expected with uncommitted campaign changes) |
| `npm run verify:security` | **PASS** | 0 high vulnerabilities |
| `npm run verify:release` | **PARTIAL** | Fails only at package gate due to dirty working tree |

### Documentation invariant fix (found during campaign)

- **Issue:** `docs/validation/live-multi-language-report.md` existed but was not indexed in `docs/README.md` or `package.json` `files`.
- **Fix:** Indexed both validation reports; added `edge-case-campaign-report.md` to package surface.
- **Disposition:** Expected maintenance gap, not product bug.

## Phase 2: Synthetic Installer Edge Cases (23 cases)

All cases run via `tests/installer/edge-case-campaign.test.ts`.

### Node.js (8)

| Case | Expected | Result |
| --- | --- | --- |
| Only `check` script | Accepted (`check` is test alias) | PASS |
| Unsafe `DATABASE_URL` in script | `unsafe_production_credentials` | PASS |
| Deploy-only script body | `unsafe_network_or_deployment` | PASS |
| Deps without lockfile | `missing_dependency_lock` | PASS |
| `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` | PASS |
| `yarn.lock` | `yarn install --frozen-lockfile` | PASS |
| Empty scripts | `missing_deterministic_validation` | PASS |
| `package.json` + Makefile | Node manifest wins | PASS |

### Python (4)

| Case | Expected | Result |
| --- | --- | --- |
| `pyproject.toml` + deps, no lock | `missing_dependency_lock` | PASS |
| `requirements.txt` only | Manifest = `requirements.txt` | PASS |
| Makefile `test` + pyproject | `make test` discovered | PASS |
| `uv.lock` + `poetry.lock` | `uv` runner preferred | PASS |

### Rust / Go / Java / Ruby (5)

| Case | Expected | Result |
| --- | --- | --- |
| `Cargo.toml` without `Cargo.lock` | `missing_dependency_lock` | PASS |
| `go.mod` without `go.sum` | `missing_dependency_lock` | PASS |
| `pom.xml` | Maven test goal | PASS |
| `build.gradle.kts` | Gradle test task | PASS |
| `Gemfile` without lock | `missing_dependency_lock` | PASS |

### Cross-ecosystem (3)

| Case | Expected | Result |
| --- | --- | --- |
| Makefile only, no test target | `missing_deterministic_validation` | PASS |
| No manifest | `unsupported_build_system` | PASS |
| Node + Python manifests | Node wins (discoverer order) | PASS |

### Resolver / config (3)

| Case | Expected | Result |
| --- | --- | --- |
| Empty `models` object | Falls back to `provider-default` | PASS |
| Only `explorer` slot set | `explicit-slot` resolution | PASS |
| Missing `models` field | `provider-default` (no throw) | PASS |

## Phase 3: Provider Probe

| Case | Result |
| --- | --- |
| `probeProviderReachable` with MINIMAX from `.env` | **PASS** (via `live-multi-ecosystem-smoke.test.ts`) |
| Secrets in output | None exposed |

## Phase 4: Live Cloned Repos

See also [live-multi-language-report.md](./live-multi-language-report.md) for prior sequential runs.

| Repo | Ecosystem | Manifest | Blockers | Required validation |
| --- | --- | --- | --- | --- |
| `pypa/sampleproject` | Python | `pyproject.toml` | `missing_dependency_lock`, env GitHub blockers | `pytest` |
| `golang/example` | Go | `go.mod` | env GitHub blockers only | `go test ./...`, `go vet ./...` |

Live probe run: `npx tsx tests/installer/live-repo-probe.test.ts` — **PASS (2/2)**.
All blockers match expected fail-closed behavior (no lock for Python sample; no GitHub auth in local probe).

## Phase 5: Bugs Found / Fixed

| ID | Severity | Description | Fix | Regression test |
| --- | --- | --- | --- | --- |
| DOC-1 | Low | Validation docs not in package index | `docs/README.md`, `package.json` | `documentation-invariants.test.ts` (existing) |
| — | — | No product logic bugs found in edge-case matrix | — | `edge-case-campaign.test.ts` (23 cases) |

## Remaining Gaps

- `verify:package` requires a clean git tree; could not complete in this session with uncommitted campaign artifacts.
- ~~Host toolchain absent on Windows runner~~ → addressed in [toolchain-verified-campaign.md](./toolchain-verified-campaign.md) (tools installed; live `runValidation=true`).
- Malformed on-disk config JSON not exercised in this session.
- Java/Ruby live clones: discovery covered; Java spawn bug found later and fixed (see toolchain report). Ruby still needs a lockfile for verified validation.
- Concurrent multi-manifest repos beyond Node+Python not tested (e.g. Rust+Java).

## Honest Assessment

**Test gates:** typecheck, full unit suite (64 files), maintenance/boundary scripts, scaffold e2e, and security audit all pass. Release gate is blocked only by dirty working tree for pack qualification — not a product defect.

**Edge cases:** 23 synthetic installer/resolver cases + 2 live clones + 6 live smoke checks — all behave per fail-closed contract. Discovery, blocker classification, lockfile policy, unsafe-script detection, manifest precedence, and model resolver fallbacks are consistent.

**Bugs fixed:** One documentation packaging gap (validation reports not indexed). No core installer/resolver logic bugs required code fixes beyond doc/package surface alignment in this edge-case pass. Follow-on toolchain campaign fixed Windows `.bat` spawning.

**Confidence:** High for discovery and blocker paths; see toolchain-verified campaign for live validation execution confidence after installing host tools.
