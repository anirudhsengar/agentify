// A complete, schema-valid codebase map for tests. Fake runtimes write
// this to .pi/agentify/codebase_map.json so the code-enforced coverage
// gate sees a real, fully-covered map — mirroring what a successful
// builder run produces. The module self-checks at import.

import { Value } from "typebox/value";
import {
  CodebaseMapSchema,
  COVERAGE_DIMENSIONS,
  type CodebaseMap,
} from "../../src/core/audit/schema.ts";

function coveredMatrix(): CodebaseMap["coverage"] {
  const entry = {
    status: "covered" as const,
    confidence: "high" as const,
    evidence_summary: "Explored for this test fixture.",
  };
  const matrix = {} as Record<string, typeof entry>;
  for (const dim of COVERAGE_DIMENSIONS) matrix[dim] = { ...entry };
  return matrix as CodebaseMap["coverage"];
}

export function makeValidCodebaseMap(
  overrides: Partial<CodebaseMap> = {},
): CodebaseMap {
  const map: CodebaseMap = {
    schema_version: "1",
    generated_at: new Date().toISOString(),
    meta: {
      project_type: "test-fixture",
      languages: ["typescript"],
      frameworks: [],
      domain_hypothesis: "A synthetic repository used by agentify tests.",
      lifecycle: {
        sdlc_model: "plan->build->review",
        issue_types: ["feature", "bug"],
        review_loop: { present: true, kind: "pr_review" },
        documentation_loop: { present: true, kind: "ai_docs" },
        conditional_docs: {
          present: false,
          path: null,
          last_updated: null,
          entries_count: 0,
        },
        aiw_scripts: [],
        agent_definitions: { count: 0, paths: [] },
      },
      documentation: {
        agents_md: "AGENTS.md",
        agents_md_line_count: 10,
        has_ai_docs: true,
        has_app_docs: false,
        has_specs: true,
        conditional_docs_path: null,
        readme_metrics: { present: true, line_count: 20, section_count: 3 },
        ai_docs_freshness: { last_updated: null, file_count: 1 },
        specs_archive: { present: true, file_count: 1, date_range: null },
        postmortems_dir: null,
        changelog_present: false,
      },
      suggested_subagent_domains: ["payments"],
    },
    skeleton: {
      top_level_tree: ["src/", "tests/"],
      entry_points: [
        { path: "src/index.ts", role: "cli", language: "typescript", run_command: "node src/index.ts" },
      ],
      code_test_mirror: { observed: true, pattern: "tests/ mirrors src/" },
      first_5_files_for_fresh_agent: [
        { path: "src/index.ts", why: "Entry point." },
      ],
      app_vs_agentic_layer: {
        app_layer: "src/",
        agentic_layer: null,
        bleed_risk_paths: [],
      },
    },
    module_graph: {
      edges: [{ from: "src/index.ts", to: "src/lib.ts", kind: "import" }],
      parallelizable_subtrees: [],
      shared_state: [],
      client_server_split: null,
      shared_abstractions: [],
    },
    type_contract_surface: {
      pydantic_models: [],
      typescript_interfaces: [],
      db_models: [],
      idks: ["Config"],
      stable_types: [],
      volatile_types: [],
      one_type_trace: null,
    },
    conventions: {
      naming: {
        files: "kebab-case.ts",
        classes: "PascalCase",
        functions: "camelCase",
        branches: "feature/*",
        commits: "imperative",
      },
      error_handling: {
        raise_vs_return: "raise",
        custom_exceptions: false,
        log_then_throw: false,
      },
      logging: { pattern: "console", observed: true },
      state_passing: "constructor_injection",
      file_size: { observed_avg: 100, observed_max: 400 },
      patterns: [],
    },
    pitfalls: [
      {
        module: "src/index.ts",
        what: "Fixture pitfall for coverage substance check.",
        consequence: "None; test fixture only.",
        line_ref: 1,
      },
    ],
    validation_surface: {
      test_command: "npm test",
      test_runtime_seconds_estimate: 10,
      lint_command: null,
      typecheck_command: "tsc --noEmit",
      e2e_command: null,
      spec_compliance_evidence: [],
      severity_taxonomy: [],
      per_change_type: {
        chore: { mandatory: ["npm test"], optional: [] },
        bug: { mandatory: ["npm test"], optional: [] },
        feature: { mandatory: ["npm test"], optional: [] },
      },
    },
    operational_surface: {
      build: { command: "npm run build", recipe_file: "package.json" },
      run: {
        command: "node src/index.ts",
        env_vars_required: [],
        ports: [],
        services: [],
        dependencies: [],
      },
      deploy: null,
      env_vars: [],
      ci_cd: { triggers: ["push"], gates: ["test"], artifacts: [] },
      git_workflow: {
        main_branch: "main",
        branch_naming: "feature/*",
        worktree_pattern: "none",
        cleanup: "delete branch on merge",
      },
      port_ranges: { dev: "3000-3999" },
      shutdown_procedure: { script: null, commands: [] },
      spawned_subprocesses: [],
    },
    security_surface: {
      paths: {
        zero_access: [".env"],
        read_only: [],
        no_delete: [],
        fully_writable: ["src/"],
      },
      bash_safe_patterns: ["npm test"],
      bash_blocked_patterns: ["rm -rf"],
      banned_interpreters: ["python", "node"],
      env_allowlist: [],
      production_credentials: [],
      damage_control_rules: ["no destructive git"],
      security_checklist: {
        tools: ["read"],
        commands: [],
        paths: [],
        env: [],
        blocks: [],
        logs: [],
      },
    },
    coverage: coveredMatrix(),
    open_questions: [],
    exploration_log: [
      {
        ts: new Date().toISOString(),
        action: "fixture",
        target: "src/",
        observation: "Synthetic map for tests.",
      },
    ],
    ...overrides,
  };
  return map;
}

// Self-check at import so a schema change that invalidates the fixture
// fails loudly in the suite that uses it.
{
  const map = makeValidCodebaseMap();
  if (!Value.Check(CodebaseMapSchema, map)) {
    const errors = [...Value.Errors(CodebaseMapSchema, map)]
      .slice(0, 5)
      .map((e) => `${(e as { path?: string }).path ?? "?"}: ${e.message}`)
      .join("; ");
    throw new Error(`test fixture codebase map is invalid: ${errors}`);
  }
}
