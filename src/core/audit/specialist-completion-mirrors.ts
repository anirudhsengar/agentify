import { spawnSync } from "node:child_process";
import * as path from "node:path";
import type { CodebaseMap } from "./schema/index.ts";
import {
  assessCoverageClosure,
  type CoverageClosureOptions,
} from "./coverage.ts";
import {
  assessSpecialistEvidence as assessRecordedSpecialistEvidence,
  reconcileSpecialistEvidence as reconcileRecordedSpecialistEvidence,
  type AuditCompletionResult,
  type SpecialistEvidenceAssessment,
} from "./specialist-completion-base.ts";

export type {
  AuditCompletionResult,
  RejectedSpecialistConcern,
  SpecialistEvidenceAssessment,
} from "./specialist-completion-base.ts";
export { specialistEvidenceRecorded } from "./specialist-completion-base.ts";

const AGENTIFY_GENERATED_PATH = /^(?:\.agentify(?:\/|$)|\.github\/agentify(?:\/|$))/;
const PLACEHOLDER_QUESTION = /^(?:initial draft|todo|unknown|tbd|gather\b|not observed)/i;
const TEST_DIRECTORY = /^(?:tests?|specs?|__tests__)$/i;
const TEST_PREFIX = /^(?:test|spec)[._-]+/i;
const TEST_SUFFIX = /[._-]+(?:test|spec)$/i;
const GIT_TREE_MAX_BUFFER = 32 * 1024 * 1024;
const GENERIC_MIRROR_STEMS = new Set([
  "common",
  "conftest",
  "fixture",
  "fixtures",
  "helper",
  "helpers",
  "index",
  "lib",
  "main",
  "shared",
  "spec",
  "test",
  "tests",
  "util",
  "utility",
  "utils",
]);

interface RepositoryFileDescriptor {
  path: string;
  extension: string;
  stem: string;
  test: boolean;
}

function trackedRegularFilesAtHead(cwd: string): string[] | null {
  const result = spawnSync(
    "git",
    ["-C", cwd, "ls-tree", "-r", "-z", "HEAD"],
    {
      encoding: "utf8",
      maxBuffer: GIT_TREE_MAX_BUFFER,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") return null;

  const files: string[] = [];
  for (const record of result.stdout.split("\0").filter(Boolean)) {
    const separator = record.indexOf("\t");
    if (separator < 0) continue;
    const metadata = record.slice(0, separator).split(" ");
    if (metadata.length < 3 || metadata[1] !== "blob" || metadata[0] === "120000") continue;
    const repositoryPath = record.slice(separator + 1).replaceAll("\\", "/");
    if (!repositoryPath || AGENTIFY_GENERATED_PATH.test(repositoryPath)) continue;
    files.push(repositoryPath);
  }
  return [...new Set(files)].sort((left, right) => left.localeCompare(right));
}

function isTestPath(repositoryPath: string): boolean {
  const segments = repositoryPath.split("/");
  if (segments.slice(0, -1).some((segment) => TEST_DIRECTORY.test(segment))) return true;
  const basename = segments.at(-1) ?? "";
  const extension = path.posix.extname(basename);
  const withoutExtension = extension ? basename.slice(0, -extension.length) : basename;
  return TEST_PREFIX.test(withoutExtension) || TEST_SUFFIX.test(withoutExtension);
}

function repositoryFileDescriptor(repositoryPath: string): RepositoryFileDescriptor | null {
  const basename = path.posix.basename(repositoryPath);
  const extension = path.posix.extname(basename).toLowerCase();
  let stem = extension ? basename.slice(0, -extension.length) : basename;
  stem = stem.replace(TEST_PREFIX, "").replace(TEST_SUFFIX, "");
  stem = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!stem || GENERIC_MIRROR_STEMS.has(stem)) return null;
  return {
    path: repositoryPath,
    extension,
    stem,
    test: isTestPath(repositoryPath),
  };
}

function normalizedDirectorySegments(repositoryPath: string): string[] {
  const generic = new Set(["app", "apps", "lib", "src", "source", "spec", "specs", "test", "tests"]);
  return path.posix.dirname(repositoryPath)
    .split("/")
    .map((segment) => segment.toLowerCase())
    .filter((segment) => segment && !generic.has(segment));
}

function directoryAffinity(left: string, right: string): number {
  const leftSegments = normalizedDirectorySegments(left);
  const rightSegments = normalizedDirectorySegments(right);
  let score = 0;
  let leftIndex = leftSegments.length - 1;
  let rightIndex = rightSegments.length - 1;
  while (
    leftIndex >= 0
    && rightIndex >= 0
    && leftSegments[leftIndex] === rightSegments[rightIndex]
  ) {
    score += 1;
    leftIndex -= 1;
    rightIndex -= 1;
  }
  return score;
}

/**
 * Find implementation/test mirrors from the complete Git tree, rather than
 * only from paths the model happened to mention. A unique same-stem,
 * same-extension pair is a conservative, language-neutral subsystem signal.
 */
function repositoryMirrorObligations(cwd: string | undefined): string[] {
  if (cwd === undefined) return [];
  const tracked = trackedRegularFilesAtHead(cwd);
  if (tracked === null) return [];

  const descriptors = tracked
    .map(repositoryFileDescriptor)
    .filter((entry): entry is RepositoryFileDescriptor => entry !== null);
  const implementations = new Map<string, RepositoryFileDescriptor[]>();
  for (const descriptor of descriptors.filter((entry) => !entry.test)) {
    const key = `${descriptor.extension}\0${descriptor.stem}`;
    const values = implementations.get(key) ?? [];
    values.push(descriptor);
    implementations.set(key, values);
  }

  const obligations = new Set<string>();
  for (const testFile of descriptors.filter((entry) => entry.test)) {
    const key = `${testFile.extension}\0${testFile.stem}`;
    const candidates = implementations.get(key) ?? [];
    if (candidates.length === 0) continue;

    let implementation: RepositoryFileDescriptor | null = null;
    if (candidates.length === 1) {
      implementation = candidates[0]!;
    } else {
      const ranked = candidates
        .map((candidate) => ({
          candidate,
          score: directoryAffinity(candidate.path, testFile.path),
        }))
        .sort((left, right) => {
          const byScore = right.score - left.score;
          return byScore !== 0
            ? byScore
            : left.candidate.path.localeCompare(right.candidate.path);
        });
      if (ranked[0]!.score > (ranked[1]?.score ?? -1)) implementation = ranked[0]!.candidate;
    }
    if (implementation === null) continue;
    obligations.add(implementation.path);
    obligations.add(testFile.path);
  }
  return [...obligations].sort((left, right) => left.localeCompare(right));
}

export function assessSpecialistEvidence(
  map: CodebaseMap,
  options?: CoverageClosureOptions,
): SpecialistEvidenceAssessment {
  const recorded = assessRecordedSpecialistEvidence(map, options);
  if (recorded.source !== "concern_evidence") return recorded;

  const mirrorObligations = repositoryMirrorObligations(options?.cwd);
  if (mirrorObligations.length === 0) return recorded;

  const covered = new Set(recorded.covered_paths);
  const exempted = new Set(recorded.exempted_paths);
  const mirrorUncovered = mirrorObligations.filter((repositoryPath) =>
    !covered.has(repositoryPath) && !exempted.has(repositoryPath)
  );
  const highSignal = [...new Set([
    ...recorded.high_signal_paths,
    ...mirrorObligations,
  ])].sort((left, right) => left.localeCompare(right));
  const uncovered = [...new Set([
    ...recorded.uncovered_paths,
    ...mirrorUncovered,
  ])].sort((left, right) => left.localeCompare(right));
  const reasons = [...recorded.reasons];
  if (mirrorUncovered.length > 0) {
    reasons.push(
      `tracked implementation/test subsystem mirrors are neither covered by a concern nor explicitly rejected: ${mirrorUncovered.slice(0, 12).join(", ")}${mirrorUncovered.length > 12 ? ", …" : ""}`,
    );
  }

  return {
    ...recorded,
    complete: recorded.complete && mirrorUncovered.length === 0,
    reasons,
    high_signal_paths: highSignal,
    uncovered_paths: uncovered,
  };
}

export function reconcileSpecialistEvidence(
  map: CodebaseMap,
  assessment: SpecialistEvidenceAssessment,
): CodebaseMap {
  const reconciled = reconcileRecordedSpecialistEvidence(map, assessment);
  if (!assessment.complete) return reconciled;
  const openQuestions = reconciled.open_questions.filter((question) =>
    !PLACEHOLDER_QUESTION.test(question.trim())
  );
  if (openQuestions.length === reconciled.open_questions.length) return reconciled;
  return { ...reconciled, open_questions: openQuestions };
}

export function assessAuditCompletion(
  map: CodebaseMap,
  options?: CoverageClosureOptions,
): AuditCompletionResult {
  const coverage = assessCoverageClosure(map, options);
  const specialistAssessment = assessSpecialistEvidence(map, options);
  return {
    coverage,
    specialistEvidenceRecorded: specialistAssessment.complete,
    complete: coverage.unresolved.length === 0 && specialistAssessment.complete,
  };
}
