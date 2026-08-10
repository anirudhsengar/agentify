# Toolchain-Verified Live Validation Campaign

Date: 2026-08-10  
Runner: Windows 10 / PowerShell (`C:\code\agentify`)  
Mode: `discoverRepositoryCommands(..., runValidation: true)` with installed host toolchains

## Before / after

| Aspect | Previous campaign | This campaign |
| --- | --- | --- |
| Host tools | npm present; go/cargo/make/pytest/ruby absent | Installed and verified on PATH |
| Live validation | Discovery-only (`runValidation=false`) | Real command execution |
| Confidence | Medium (toolchain-limited) | High for Node/Python/Go/Rust/Make; Java spawn fixed |

## Toolchains installed / verified

| Tool | Version | Install method |
| --- | --- | --- |
| Node.js / npm | v24.18.0 / 11.16.0 | Already present |
| Python / pytest | 3.14.6 / 9.1.1 | pytest via `pip` |
| uv | 0.11.32 | Already present |
| Go | 1.26.5 | winget `GoLang.Go` |
| Rust / cargo | 1.97.1 (default: `stable-x86_64-pc-windows-gnu`) | winget `Rustlang.Rustup` + gnu toolchain for linker |
| Make | GNU Make 4.4.1 | winget `ezwinports.make` |
| Ruby / bundler | 3.4.10 / 2.6.9 | winget `RubyInstallerTeam.Ruby.3.4` |
| Java | OpenJDK 17.0.20 | Already present |
| VS Build Tools | install started (MSVC) | winget (optional; gnu Rust used for linking) |

User PATH was updated permanently for cargo, Go, WinGet Links, Ruby, and Python Scripts.

## Synthetic live validation (`runValidation=true`)

| Case | Command(s) | Result |
| --- | --- | --- |
| Node | `npm run test` | **verified** exit 0 |
| Python+Makefile | `make test` | **verified** exit 0 |
| Python+uv.lock | `uv run pytest` | **verified** exit 0 |
| Go (+ empty `go.sum`) | `go test ./...`, `go vet ./...` | **verified** exit 0 |
| Rust (+ generated `Cargo.lock`) | `cargo test/check/clippy --locked` | **verified** exit 0 |
| Makefile-only | `make test` | **verified** exit 0 |
| MiniMax provider probe | `probeProviderReachable` | **PASS** |

Harness: `tests/installer/live-multi-ecosystem-smoke.test.ts` — **6/6 checks passed** after fixing Windows tool detection (`npm.cmd`, `go version`) and generating a real `Cargo.lock` / `go.sum`.

## Live cloned repos

| Repo | Discovery | Live validation | Notes |
| --- | --- | --- | --- |
| `python-sampleproject` | `pytest`; blocker `missing_dependency_lock` | skipped (expected) | No lock committed |
| `python-with-lock` (local uv fixture) | `uv run pytest` | **verified** exit 0 | Lock present → verified path |
| `go-example` | `go test ./...`, `go vet ./...` | **validation_failed** | Upstream Windows path-regex failures in slog-handler tests; Agentify correctly fail-closed. Vet verified. |
| `rust-rustlings` | cargo test/check/clippy `--locked` | discovery-only (suite size) | Synthetic rust crate validated instead |
| `java-petclinic` | `gradlew.bat test/check` | **ran**; **validation_failed** | Spawn fixed; 73 tests, 2 upstream failures |
| `ruby-rake` | `bundle exec rspec` | skipped | `missing_dependency_lock` (no Gemfile.lock) |

## Product bugs found and fixed

| ID | Severity | Description | Fix | Regression |
| --- | --- | --- | --- | --- |
| WIN-BAT-1 | High | Windows `spawnSync("gradlew.bat")` / `.cmd` returns `EINVAL`; Java/Maven wrappers never ran | Route `.bat`/`.cmd` through `cmd.exe /d /s /c` with cwd confinement in installer process runner and task-lifecycle validation runner | `tests/installer/windows-cmd-wrapper.test.ts`, `tests/task-lifecycle/validation-runner.test.ts` |
| SMOKE-1 | Medium (harness) | Live smoke skipped Node (`npm` ENOENT without shell) and Go (`go --version` invalid) | Detect npm via npm-cli.js / shell; use `go version`; generate real Rust lockfile; ensure `go.sum` | `live-multi-ecosystem-smoke.test.ts` |

## Remaining blockers

- `npm run verify:package` / full `verify:release` require a clean git tree; campaign changes leave the working tree dirty.
- `golang/example` and `spring-petclinic` fail some upstream tests on this host; Agentify correctly emits `validation_failed` rather than false success.
- Ruby live validated path still needs a repo with committed `Gemfile.lock`.
- MSVC Build Tools install may still be in progress; Rust validation uses the gnu toolchain.

## Honest assessment

With toolchains installed, Agentify **does execute** multi-ecosystem validation on Windows. The highest-impact product defect found was Windows `.bat`/`.cmd` spawning for Gradle/Maven wrappers; that is fixed and covered by regression tests. Discovery, lockfile fail-closed behavior, and provider probing remain consistent with prior campaigns.
