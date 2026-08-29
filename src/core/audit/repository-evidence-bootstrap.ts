import { spawnSync } from "node:child_process";
import * as path from "node:path";
import type { RepositoryInstallationPreflight } from "../installer/contracts.ts";
import { discoverRepositoryBuildSystem } from "../installer/command-discovery.ts";
import { createGapDraftMap } from "./map-draft.ts";
import type { CodebaseMap, CoverageDimension } from "./schema.ts";

const MAX_TRACKED_PATHS = 100_000;
const MAX_READ_BYTES = 256 * 1024;
const MAX_EXTENSIONLESS_READS = 128;
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".bash": "Shell", ".c": "C", ".cc": "C++", ".clj": "Clojure", ".cpp": "C++",
  ".cs": "C#", ".css": "CSS", ".dart": "Dart", ".erl": "Erlang", ".ex": "Elixir",
  ".exs": "Elixir", ".fs": "F#", ".go": "Go", ".groovy": "Groovy", ".h": "C",
  ".hpp": "C++", ".hrl": "Erlang", ".html": "HTML", ".java": "Java", ".js": "JavaScript",
  ".json": "JSON", ".jsx": "JavaScript", ".kt": "Kotlin", ".kts": "Kotlin", ".lua": "Lua",
  ".md": "Markdown", ".mjs": "JavaScript", ".php": "PHP", ".proto": "Protocol Buffers",
  ".py": "Python", ".rb": "Ruby", ".rs": "Rust", ".scala": "Scala", ".sh": "Shell",
  ".sql": "SQL", ".swift": "Swift", ".toml": "TOML", ".ts": "TypeScript",
  ".tsx": "TypeScript", ".xml": "XML", ".yaml": "YAML", ".yml": "YAML",
};
const STARTING_POINT = /^(?:__init__|app|cli|command|index|lib|main|mod|server)(?:\.[^.]+)?$/iu;
const APPLICATION_STARTING_POINT = /Application\.(?:java|kt|kts)$/u;
const TEST_PATH = /(?:^|\/)(?:__tests__|spec|specs|test|tests)(?:\/|$)|(?:^|[._-])(?:spec|test)\.[^/]+$/iu;
const PROGRAMMING_LANGUAGES = new Set([
  "C", "C#", "C++", "Clojure", "Dart", "Elixir", "Erlang", "F#", "Go", "Groovy",
  "Java", "JavaScript", "Kotlin", "Lua", "PHP", "Python", "Ruby", "Rust", "Scala", "Shell", "Swift", "TypeScript",
]);
const GENERIC_HEADINGS = /^(?:contents|documentation|introduction|overview|readme|welcome)$/iu;

function gitHead(cwd: string): string | null {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--verify", "HEAD^{commit}"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const commit = result.status === 0 ? result.stdout.trim().toLowerCase() : "";
  return /^[0-9a-f]{40,64}$/u.test(commit) ? commit : null;
}

interface TrackedSnapshot {
  paths: string[];
  modes: ReadonlyMap<string, string>;
}

function trackedSnapshot(cwd: string, commit: string): TrackedSnapshot {
  const result = spawnSync("git", ["-C", cwd, "ls-tree", "-r", "-z", commit], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) return { paths: [], modes: new Map() };
  const modes = new Map<string, string>();
  for (const record of result.stdout.split("\0")) {
    const separator = record.indexOf("\t");
    if (separator < 0) continue;
    const repositoryPath = record.slice(separator + 1);
    if (!repositoryPath || repositoryPath.startsWith(".agentify/") || modes.size >= MAX_TRACKED_PATHS) continue;
    modes.set(repositoryPath, record.slice(0, separator).split(" ", 1)[0] ?? "");
  }
  return { paths: [...modes.keys()], modes };
}

function readTracked(
  cwd: string,
  commit: string,
  repositoryPath: string,
  modes: ReadonlyMap<string, string>,
  depth = 0,
): string | null {
  const result = spawnSync("git", ["-C", cwd, "show", `${commit}:${repositoryPath}`], {
    encoding: "buffer",
    maxBuffer: MAX_READ_BYTES + 1,
    windowsHide: true,
  });
  if (result.status !== 0 || result.stdout.byteLength > MAX_READ_BYTES) return null;
  const content = result.stdout.toString("utf8");
  if (modes.get(repositoryPath) !== "120000") return content;
  if (depth >= 4 || content.includes("\0") || path.posix.isAbsolute(content)) return null;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(repositoryPath), content));
  if (target === ".." || target.startsWith("../") || !modes.has(target)) return null;
  return readTracked(cwd, commit, target, modes, depth + 1);
}

function readmePath(paths: ReadonlyArray<string>): string | null {
  return paths.find((entry) => /^readme(?:\.[^/]+)?$/iu.test(entry)) ?? null;
}

function sanitizeMarkdown(value: string): string {
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]+\]/gu, "$1")
    .replace(/<[^>]+>/gu, "")
    .replace(/[`*_]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function heading(content: string | null): string | null {
  const raw = content?.match(/^#\s+(.+)$/mu)?.[1];
  const match = raw ? sanitizeMarkdown(raw) : null;
  return match && match.length <= 160 ? match : null;
}

function repositorySummary(content: string | null): string | null {
  if (!content) return null;
  const withoutComments = content.replace(/<!--[\s\S]*?-->/gu, "");
  let inFence = false;
  for (const rawLine of withoutComments.split(/\r?\n/u)) {
    if (/^\s*```/u.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^\s*#/u.test(rawLine)) continue;
    const cleaned = sanitizeMarkdown(rawLine).replace(/^[>*|\s-]+|[>*|\s-]+$/gu, "").trim();
    const line = cleaned.length > 240 ? cleaned.match(/^.{24,239}?[.!?](?:\s|$)/u)?.[0]?.trim() ?? "" : cleaned;
    if (
      line.length < 24
      || /^(?:https?:\/\/|badge|build status|more information|note:|read this|see (?:the|below)|open (?:in|with)|for up-to-date)/iu.test(line)
      || /\b(?:announce|available|copyright|licensed under|release announcement|version \d)/iu.test(line)
    ) continue;
    return line;
  }
  return null;
}

function languageFor(cwd: string, commit: string, repositoryPath: string, modes: ReadonlyMap<string, string>): string | null {
  const basename = path.posix.basename(repositoryPath);
  if (/^Jenkinsfile(?:\..+)?$/u.test(basename)) return "Groovy";
  const byExtension = LANGUAGE_BY_EXTENSION[path.posix.extname(repositoryPath).toLowerCase()];
  if (byExtension) return byExtension;
  const firstLine = readTracked(cwd, commit, repositoryPath, modes)?.split(/\r?\n/u, 1)[0] ?? "";
  if (!firstLine.startsWith("#!")) return null;
  if (/\b(?:bash|sh|zsh|ksh)\b/iu.test(firstLine)) return "Shell";
  if (/\bpython\d*\b/iu.test(firstLine)) return "Python";
  if (/\b(?:node|deno|bun)\b/iu.test(firstLine)) return "JavaScript";
  if (/\bruby\b/iu.test(firstLine)) return "Ruby";
  return "Executable script";
}

function detectedLanguages(
  cwd: string,
  commit: string,
  paths: ReadonlyArray<string>,
  modes: ReadonlyMap<string, string>,
): Map<string, string> {
  const languages = new Map<string, string>();
  let extensionlessReads = 0;
  for (const repositoryPath of paths) {
    const extension = path.posix.extname(repositoryPath);
    if (!extension && extensionlessReads >= MAX_EXTENSIONLESS_READS) continue;
    const language = languageFor(cwd, commit, repositoryPath, modes);
    if (language) languages.set(repositoryPath, language);
    if (!extension) extensionlessReads += 1;
  }
  return languages;
}

function rankedLanguages(languagesByPath: ReadonlyMap<string, string>): string[] {
  const counts = new Map<string, number>();
  for (const language of languagesByPath.values()) counts.set(language, (counts.get(language) ?? 0) + 1);
  return [...counts.keys()].sort((left, right) => (
    (counts.get(right) ?? 0) - (counts.get(left) ?? 0) || left.localeCompare(right)
  ));
}

function topLevelTree(paths: ReadonlyArray<string>): string[] {
  const entries = new Set<string>();
  for (const repositoryPath of paths) {
    const [first, ...rest] = repositoryPath.split("/");
    if (first) entries.add(rest.length > 0 ? `${first}/` : first);
  }
  return [...entries].sort((left, right) => left.localeCompare(right)).slice(0, 64);
}

function entryPoints(
  paths: ReadonlyArray<string>,
  languagesByPath: ReadonlyMap<string, string>,
  runCommand: string,
): CodebaseMap["skeleton"]["entry_points"] {
  return paths
    .filter((repositoryPath) => PROGRAMMING_LANGUAGES.has(languagesByPath.get(repositoryPath) ?? "") && !TEST_PATH.test(repositoryPath))
    .map((repositoryPath) => ({
      repositoryPath,
      score: (STARTING_POINT.test(path.posix.basename(repositoryPath)) || APPLICATION_STARTING_POINT.test(path.posix.basename(repositoryPath)) ? 10 : 0)
        + (/^(?:src|lib|app|cmd|bin)\//u.test(repositoryPath) ? 4 : 0)
        + (!repositoryPath.includes("/") ? 6 : 0)
        - repositoryPath.split("/").length,
    }))
    .sort((left, right) => right.score - left.score || left.repositoryPath.localeCompare(right.repositoryPath))
    .slice(0, 5)
    .map(({ repositoryPath }) => ({
      path: repositoryPath,
      role: "Tracked implementation starting point selected from immutable repository topography.",
      language: languagesByPath.get(repositoryPath)!,
      run_command: runCommand,
    }));
}

function commandText(argv: ReadonlyArray<string>): string {
  return argv.join(" ");
}

function cover(
  map: CodebaseMap,
  dimension: CoverageDimension,
  repositoryPath: string,
  summary: string,
): void {
  map.coverage[dimension] = {
    status: "covered",
    confidence: "high",
    evidence_summary: summary,
    evidence: [{ path: repositoryPath, excerpt: summary, kind: "positive" }],
  };
}

/** Build the immutable, current-HEAD facts that precede model exploration. */
export function createRepositoryEvidenceDraft(
  cwd: string,
  preflight: RepositoryInstallationPreflight,
): CodebaseMap {
  const map = createGapDraftMap();
  const commit = gitHead(cwd);
  if (commit === null) throw new Error("immutable repository evidence requires a committed HEAD");
  if (preflight.identity && preflight.identity.current_commit !== commit) {
    throw new Error(`repository changed after installer preflight: expected ${preflight.identity.current_commit}, found ${commit}`);
  }
  const snapshot = trackedSnapshot(cwd, commit);
  const paths = snapshot.paths;
  const readme = readmePath(paths);
  const readmeContent = readme ? readTracked(cwd, commit, readme, snapshot.modes) : null;
  const title = heading(readmeContent);
  const summary = repositorySummary(readmeContent);
  const buildSystem = discoverRepositoryBuildSystem(cwd);
  const ecosystem = buildSystem.manifest?.ecosystem ?? "multi-format";
  const repositoryName = preflight.identity?.full_name.split("/").at(-1) ?? null;
  const descriptor = title && !GENERIC_HEADINGS.test(title) ? title : repositoryName;
  const languagesByPath = detectedLanguages(cwd, commit, paths, snapshot.modes);
  const languages = rankedLanguages(languagesByPath);
  const test = preflight.commands.find((command) => command.kind === "test" && command.assessment === "verified");
  const build = preflight.commands.find((command) => command.kind === "build" && command.assessment === "verified");
  const fallbackCommand = test ? commandText(test.argv) : "No verified repository run command discovered";
  const entries = entryPoints(paths, languagesByPath, fallbackCommand);
  const evidencePath = readme ?? buildSystem.manifest?.path ?? entries[0]?.path ?? null;

  map.meta.project_type = descriptor
    ? summary ? `${descriptor}: ${summary}` : `${descriptor} (${ecosystem} repository)`
    : "unknown";
  map.meta.languages = languages.length > 0 ? languages : ["unknown"];
  map.meta.frameworks = [];
  map.meta.domain_hypothesis = descriptor
    ? `${descriptor}, identified from immutable current-HEAD repository evidence${summary ? `: ${summary}` : "."}`
    : "Repository purpose remains unresolved.";
  map.meta.suggested_subagent_domains = topLevelTree(paths).filter((entry) => entry.endsWith("/")).slice(0, 5);
  map.skeleton.top_level_tree = topLevelTree(paths);
  map.skeleton.entry_points = entries;
  map.skeleton.first_5_files_for_fresh_agent = [
    ...(readme ? [{ path: readme, why: "Repository-maintained overview." }] : []),
    ...entries.map((entry) => ({ path: entry.path, why: entry.role })),
  ].filter((entry, index, all) => all.findIndex((candidate) => candidate.path === entry.path) === index).slice(0, 5);
  map.skeleton.app_vs_agentic_layer = {
    app_layer: preflight.allowed_write_paths.join(", ") || "unresolved",
    agentic_layer: null,
    bleed_risk_paths: [],
  };

  if (evidencePath && descriptor && languages.length > 0 && entries.length > 0) {
    cover(map, "D1_topography", evidencePath, "Current-HEAD tracked files establish repository identity, languages, top-level structure, and implementation starting points.");
  }

  if (test && buildSystem.manifest) {
    const testCommand = commandText(test.argv);
    map.validation_surface.test_command = testCommand;
    map.validation_surface.test_runtime_seconds_estimate = Math.ceil(test.timeout_ms / 1000);
    map.validation_surface.lint_command = preflight.commands.find((command) => command.kind === "lint" && command.assessment === "verified")?.argv.join(" ") ?? null;
    map.validation_surface.typecheck_command = preflight.commands.find((command) => command.kind === "typecheck" && command.assessment === "verified")?.argv.join(" ") ?? null;
    for (const changeType of ["chore", "bug", "feature"] as const) {
      map.validation_surface.per_change_type[changeType] = { mandatory: [testCommand], optional: [] };
    }
    cover(map, "D6_validation", buildSystem.manifest.path, "Installer preflight verified the repository-owned behavioral test command in a disposable exact-HEAD checkout.");
  }

  if (build && buildSystem.manifest) {
    map.operational_surface.build = {
      command: commandText(build.argv),
      recipe_file: buildSystem.manifest.path,
    };
  }
  if (preflight.identity) {
    map.operational_surface.git_workflow.main_branch = preflight.identity.default_branch;
  }

  if (readme && readmeContent) {
    const lines = readmeContent.split(/\r?\n/u);
    const sections = lines.filter((line) => /^#{1,6}\s+/u.test(line)).length;
    map.meta.documentation = {
      ...map.meta.documentation,
      readme_metrics: { present: true, line_count: lines.length, section_count: sections },
      agents_md: paths.includes("AGENTS.md") ? "AGENTS.md" : null,
      agents_md_line_count: paths.includes("AGENTS.md") ? readTracked(cwd, commit, "AGENTS.md", snapshot.modes)?.split(/\r?\n/u).length ?? null : null,
      changelog_present: paths.some((entry) => /^changelog(?:\.[^/]+)?$/iu.test(entry)),
    };
    if (sections > 0) {
      cover(map, "D10_documentation", readme, "Tracked README headings and line counts establish the repository documentation surface.");
    }
  }

  map.open_questions = [
    ...map.open_questions,
    "Semantic contracts, conventions, pitfalls, operational behavior, security, and process remain open until verified from repository evidence.",
  ];
  map.exploration_log.push({
    ts: map.generated_at!,
    action: "immutable_evidence_bootstrap",
    target: ".",
    observation: `Seeded ${paths.length} tracked paths and ${preflight.commands.length} classified installer commands before model exploration.`,
  });
  return map;
}
