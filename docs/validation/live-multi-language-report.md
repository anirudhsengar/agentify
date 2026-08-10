# Live Multi-Language Validation Report (Sequential)

Date: 2026-08-10  
Runner repo: `C:\code\agentify`  
Method: clone one public repository at a time, run Agentify readiness/discovery path, classify outcome, and record issues.

## Repository Results (in order)

### 1) Python
- Repo URL: `https://github.com/pypa/sampleproject`
- Language/ecosystem: Python (`pyproject.toml`)
- Commands run:
  - `git clone --depth 1 https://github.com/pypa/sampleproject ".tmp-live/python-sampleproject"`
  - `discoverRepositoryCommands(..., runValidation=false)` via `node --import tsx --eval ...`
  - `inspectRepositoryForInstallation(..., runValidation=false)` via `node --import tsx --eval ...`
- Observed outcome: **blocked with expected blockers**
  - Discovery detected `pyproject.toml`, required validation `pytest`
  - Blocker: `missing_dependency_lock` (no Python lockfile committed)
  - Preflight blockers also included `missing_github_permission` and `unknown_branch_policy` in this environment
- Issue found: none (expected fail-closed behavior)

### 2) Go
- Repo URL: `https://github.com/golang/example`
- Language/ecosystem: Go (`go.mod`)
- Commands run:
  - `git clone --depth 1 https://github.com/golang/example ".tmp-live/go-example"`
  - readiness/discovery eval commands as above
- Observed outcome: **blocked with expected blockers**
  - Discovery detected `go.mod`, required validation `go test ./...` and `go vet ./...`
  - No ecosystem lockfile blocker for Go
  - Preflight blockers: `missing_github_permission`, `unknown_branch_policy`
- Issue found: none

### 3) Rust
- Repo URL: `https://github.com/rust-lang/rustlings`
- Language/ecosystem: Rust (`Cargo.toml`)
- Commands run:
  - `git clone --depth 1 https://github.com/rust-lang/rustlings ".tmp-live/rust-rustlings"`
  - readiness/discovery eval commands as above
- Observed outcome: **blocked with expected blockers**
  - Discovery detected `Cargo.toml`, required validation `cargo test --locked` and `cargo check --locked`
  - Preflight blockers: `missing_github_permission`, `unknown_branch_policy`
- Issue found: none

### 4) Java (Gradle)
- Repo URL: `https://github.com/spring-projects/spring-petclinic`
- Language/ecosystem: Java Gradle (`build.gradle`)
- Commands run:
  - `git clone --depth 1 https://github.com/spring-projects/spring-petclinic ".tmp-live/java-petclinic"`
  - readiness/discovery eval commands as above
- Observed outcome: **blocked with expected blockers**
  - Discovery detected `build.gradle`, required validation `gradlew.bat test` and `gradlew.bat check`
  - Preflight blockers: `missing_github_permission`, `unknown_branch_policy`
- Issue found: none

### 5) Ruby
- Repo URL: `https://github.com/ruby/rake`
- Language/ecosystem: Ruby (`Gemfile`)
- Commands run:
  - `git clone --depth 1 https://github.com/ruby/rake ".tmp-live/ruby-rake"`
  - readiness/discovery eval commands as above
- Observed outcome: **blocked with expected blockers**
  - Discovery detected `Gemfile`, required validation `bundle exec rspec`
  - Blocker: `missing_dependency_lock` (no `Gemfile.lock` committed)
  - Preflight blockers also included `missing_github_permission`, `unknown_branch_policy`
- Issue found: none (expected fail-closed behavior)

## Issues Ledger

### Issue A: Resolver crash when `config.models` is absent
- Classification: **unexpected failure**
- Repro:
  - Prior live smoke invocation (`tests/installer/live-multi-ecosystem-smoke.test.ts`) produced:
    - `TypeError: Cannot read properties of undefined (reading 'primary')`
    - stack at `src/core/models/resolver.ts` in `selectModelForRole`
- Why it failed:
  - Resolver assumed `config.models` always exists, but compatibility paths and malformed legacy state can produce configs where this field is missing at runtime.
- Fix summary (this repo):
  - `src/core/models/resolver.ts`
    - Guarded resolver with `const configuredModels = config.models ?? {}`.
    - Read explicit and primary slots from `configuredModels`.
  - `tests/audit/spawn-explorer-slot.test.ts`
    - Added regression `resolverHandlesMissingModelsFieldSafely`.
- Post-fix verification:
  - New regression passes and prevents reintroduction of this crash class.

## Notes on full installer command path

Direct full `agentify` execution in these public repos enters model-backed audit and is environment/provider dependent. For this campaign, deterministic repository compatibility/readiness was validated through installer preflight and command discovery (the compatibility and fail-closed path requested).
