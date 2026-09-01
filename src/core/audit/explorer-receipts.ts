import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import type {
  CodebaseMap,
  ExplorerReceiptAttestation,
  ExplorerReceiptRecord,
} from "./schema/index.ts";
import { isSubstantiveConcernRejection } from "./concern-rejection.ts";
import { mergeEvidenceIntoMap } from "./map-draft.ts";
import { loadCanonicalMapAt, writeCanonicalMap } from "./map-storage.ts";
import { stableMapValueIdentity } from "./map-delta.ts";
import { concernEvidencePaths, removeTrustedInferredAttachments } from "./specialist-completion.ts";

type ExplorerMode = "concern_scout" | "concern_tracer";

interface ExplorerReceipt {
  sequence: number;
  mode: ExplorerMode;
  success: boolean;
  targetPath: string;
  focus: string | null;
  expectedConcern: string | null;
  reportConcern: string | null;
  failureKind: string | null;
  proposedConcerns: string[];
  sourceRunId: string | null;
  observedPaths: string[];
}

export interface ExplorerReceiptAssessment {
  complete: boolean;
  reasons: string[];
  successful_scouts: number;
  successful_tracers: string[];
  unresolved_tracer_failures: string[];
  missing_concern_tracers: string[];
  unresolved_scout_proposals: string[];
}

export interface ExplorerReceiptAssessmentOptions {
  requireScout?: boolean;
  requiredConcerns?: ReadonlyArray<string>;
}

const SEMANTIC_STOP_WORDS = new Set([
  "and",
  "candidate",
  "concern",
  "for",
  "from",
  "implementation",
  "paths",
  "seed",
  "specialist",
  "subsystem",
  "the",
  "trace",
  "tracer",
  "with",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resultText(result: unknown): string {
  if (!isRecord(result)) return "";
  if (typeof result.resultText === "string") return result.resultText;
  if (!Array.isArray(result.content)) return "";
  return result.content
    .filter((block): block is { type?: unknown; text?: unknown } => isRecord(block))
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

function modeFromResult(result: unknown, text: string): ExplorerMode | null {
  if (isRecord(result) && isRecord(result.details)) {
    const mode = stringField(result.details.mode);
    if (mode === "concern_scout" || mode === "concern_tracer") return mode;
  }
  const match = text.match(/\bmode=(concern_scout|concern_tracer)\b/i);
  const mode = match?.[1]?.toLowerCase();
  return mode === "concern_scout" || mode === "concern_tracer" ? mode : null;
}

function focusFromText(text: string): string | null {
  const quoted = text.match(/\bfocus=(?:"([^"]+)"|'([^']+)')/i);
  if (quoted !== null) return quoted[1]?.trim() || quoted[2]?.trim() || null;
  const plain = text.match(/\bfocus=([^;\r\n]+)/i);
  return plain?.[1]?.trim() || null;
}

function reportConcernFromText(text: string): string | null {
  const match = text.match(/(?:^|\n)\s*concern:\s*([^\r\n]+)/i);
  return match?.[1]?.trim() || null;
}

const SCOUT_PROPOSAL_MAX_LENGTH = 256;
const SCOUT_PROPOSAL_SUFFIX = /\s+(?:one[_ -]?line|covers|seed[_ -]?paths?|rationale)\s*:/i;

export function normalizeScoutConcernProposal(value: string): string | null {
  const structuredBoundary = value.search(SCOUT_PROPOSAL_SUFFIX);
  const proposal = (structuredBoundary >= 0 ? value.slice(0, structuredBoundary) : value).trim();
  return proposal.length > 0 && proposal.length <= SCOUT_PROPOSAL_MAX_LENGTH
    ? proposal
    : null;
}

function scoutConcernsFromText(text: string): string[] {
  const concerns: string[] = [];
  const pattern = /^\s*-\s*concern:\s*([^\r\n]+)/gim;
  for (const match of text.matchAll(pattern)) {
    const concern = match[1] === undefined
      ? null
      : normalizeScoutConcernProposal(match[1]);
    if (concern && !concerns.includes(concern)) concerns.push(concern);
  }
  return concerns.slice(0, 128);
}

function semanticTokens(value: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of value.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (raw.length < 3 || SEMANTIC_STOP_WORDS.has(raw)) continue;
    const normalized = raw.length > 4 && raw.endsWith("s") ? raw.slice(0, -1) : raw;
    tokens.add(normalized);
  }
  return tokens;
}

function tokenRelated(left: string, right: string): boolean {
  return left === right
    || (Math.min(left.length, right.length) >= 5
      && (left.startsWith(right) || right.startsWith(left)));
}

function semanticallyRelated(left: string, right: string): boolean {
  const normalizedLeft = left.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const normalizedRight = right.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!normalizedLeft || !normalizedRight) return false;
  if (
    normalizedLeft === normalizedRight
    || normalizedLeft.includes(normalizedRight)
    || normalizedRight.includes(normalizedLeft)
  ) {
    return true;
  }

  const leftTokens = semanticTokens(left);
  const rightTokens = semanticTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return false;
  let matches = 0;
  for (const token of leftTokens) {
    if ([...rightTokens].some((other) => tokenRelated(token, other))) matches += 1;
  }
  const minimum = Math.min(leftTokens.size, rightTokens.size);
  return matches >= 2 || (matches >= 1 && matches / minimum >= 0.6);
}

function receiptIdentity(receipt: ExplorerReceipt): string {
  return receipt.expectedConcern ?? receipt.reportConcern ?? receipt.focus ?? receipt.targetPath;
}

function failureDescription(receipt: ExplorerReceipt): string {
  const identity = receiptIdentity(receipt);
  return receipt.failureKind === "timeout"
    ? `${identity} (timed out)`
    : identity;
}

export class ExplorerReceiptTracker {
  readonly #receipts: ExplorerReceipt[] = [];
  #sequence = 0;

  observe(event: unknown): void {
    if (!isRecord(event) || event.type !== "tool_execution_end") return;
    const toolName = stringField(event.toolName) ?? stringField(event.tool_name);
    if (toolName !== "spawn_explorer") return;

    const nestedResult = isRecord(event.result) ? event.result : null;
    const result = nestedResult ?? event;
    const text = resultText(result);
    const mode = modeFromResult(result, text);
    if (mode === null) return;
    const details = isRecord(result.details)
      ? result.details
      : isRecord(event.details) ? event.details : {};
    const targetPath = stringField(details.target_path)
      ?? text.match(/\b(?:explored|for)\s+(.+?)\s+(?:in\s+\d+ms|failed:)/i)?.[1]?.trim()
      ?? ".";
    const focus = stringField(details.focus) ?? focusFromText(text);
    const expectedConcern = stringField(details.expected_concern);
    const reportConcern = stringField(details.report_concern)
      ?? (mode === "concern_tracer" ? reportConcernFromText(text) : null);
    const success = event.isError !== true
      && !(nestedResult !== null && nestedResult.isError === true);
    const failureKind = success
      ? null
      : stringField(details.failure_kind)
        ?? (/timeout|timed out/i.test(text) ? "timeout" : "error");

    this.#sequence += 1;
    this.#receipts.push({
      sequence: this.#sequence,
      mode,
      success,
      targetPath,
      focus,
      expectedConcern,
      reportConcern,
      failureKind,
      proposedConcerns: mode === "concern_scout" && success
        ? scoutConcernsFromText(text)
        : [],
      sourceRunId: null,
      observedPaths: Array.isArray(details.observed_paths)
        ? details.observed_paths.filter((candidate): candidate is string => typeof candidate === "string").slice(0, 512)
        : [],
    });
  }

  attestation(repositoryCommit: string, runId: string): ExplorerReceiptAttestation {
    return {
      repository_commit: repositoryCommit,
      run_id: runId,
      receipts: this.#receipts.map((receipt): ExplorerReceiptRecord => ({
        sequence: receipt.sequence,
        mode: receipt.mode,
        success: receipt.success,
        target_path: receipt.targetPath,
        focus: receipt.focus,
        ...(receipt.expectedConcern === null ? {} : { expected_concern: receipt.expectedConcern }),
        report_concern: receipt.reportConcern,
        failure_kind: receipt.failureKind,
        ...(receipt.proposedConcerns.length > 0
          ? { proposed_concerns: receipt.proposedConcerns }
          : {}),
        source_run_id: receipt.sourceRunId ?? runId,
        ...(receipt.observedPaths.length > 0 ? { observed_paths: receipt.observedPaths } : {}),
      })),
    };
  }

  loadAttestation(attestation: ExplorerReceiptAttestation): void {
    for (const receipt of [...attestation.receipts].sort((left, right) => left.sequence - right.sequence)) {
      this.#sequence += 1;
      this.#receipts.push({
        sequence: this.#sequence,
        mode: receipt.mode,
        success: receipt.success,
        targetPath: receipt.target_path,
        focus: receipt.focus,
        expectedConcern: receipt.expected_concern ?? null,
        reportConcern: receipt.report_concern,
        failureKind: receipt.failure_kind,
        proposedConcerns: [...(receipt.proposed_concerns ?? [])],
        sourceRunId: receipt.source_run_id ?? attestation.run_id,
        observedPaths: [...(receipt.observed_paths ?? [])],
      });
    }
  }

  assess(
    map: CodebaseMap | null,
    options: ExplorerReceiptAssessmentOptions = {},
  ): ExplorerReceiptAssessment {
    const requireScout = options.requireScout ?? true;
    const requiredConcerns = options.requiredConcerns
      ?? map?.concern_evidence?.concerns.map((concern) => concern.concern)
      ?? [];
    const scouts = this.#receipts.filter((receipt) =>
      receipt.mode === "concern_scout" && receipt.success
    );
    const successfulTracers = this.#receipts.filter((receipt) =>
      receipt.mode === "concern_tracer" && receipt.success && receipt.observedPaths.length > 0
    );
    const failedTracers = this.#receipts.filter((receipt) =>
      receipt.mode === "concern_tracer" && !receipt.success
    );

    const missingConcernTracers = requiredConcerns.filter((concern) =>
      !successfulTracers.some((receipt) =>
        semanticallyRelated(concern, receiptIdentity(receipt))
      )
    );
    const unresolvedFailures = failedTracers.filter((failure) =>
      !successfulTracers.some((success) =>
        success.sequence > failure.sequence
        && semanticallyRelated(receiptIdentity(failure), receiptIdentity(success))
      )
    );
    const rejectedCandidates = map?.concern_evidence?.not_concerns
      .filter((candidate) => isSubstantiveConcernRejection(candidate.why_rejected))
      .map((candidate) => candidate.candidate) ?? [];
    const persistedConcerns = map?.concern_evidence?.concerns
      .map((concern) => concern.concern) ?? [];
    const persistedSuccessfulTracers = successfulTracers.filter((receipt) =>
      persistedConcerns.some((concern) =>
        semanticallyRelated(concern, receiptIdentity(receipt))
      )
    );
    const unpersistedSuccessfulTracers = successfulTracers.filter((receipt) =>
      !persistedSuccessfulTracers.includes(receipt)
      && !rejectedCandidates.some((candidate) =>
        semanticallyRelated(candidate, receiptIdentity(receipt))
      )
    );
    const unresolvedScoutProposals = [...new Set(
      scouts.flatMap((scout) => scout.proposedConcerns),
    )].filter((proposal) =>
      !persistedSuccessfulTracers.some((receipt) =>
        semanticallyRelated(proposal, receiptIdentity(receipt))
      )
      && !rejectedCandidates.some((candidate) => semanticallyRelated(proposal, candidate))
    );

    const reasons: string[] = [];
    const observedPaths = new Set(successfulTracers.flatMap((receipt) => receipt.observedPaths));
    // Normalization may attach dependencies proven from immutable source, or
    // combine already-traced bodies. Neither invents a new model observation.
    const authored = map === null ? null : removeTrustedInferredAttachments(map);
    for (const concern of authored?.concern_evidence?.concerns ?? []) {
      const unobserved = concernEvidencePaths(concern).filter((candidate) => !observedPaths.has(candidate));
      if (unobserved.length > 0) {
        reasons.push(`concern "${concern.concern}" cites source without an observed read/grep receipt: ${unobserved.slice(0, 12).join(", ")}; retrace the missing evidence`);
      }
    }
    if (requireScout && scouts.length === 0) {
      reasons.push("successful concern_scout receipt is missing");
    }
    for (const concern of missingConcernTracers) {
      reasons.push(`accepted concern "${concern}" has no successful concern_tracer receipt`);
    }
    for (const failure of unresolvedFailures) {
      reasons.push(
        `concern_tracer for "${failureDescription(failure)}" failed and was not successfully retraced`,
      );
    }
    for (const receipt of unpersistedSuccessfulTracers) {
      reasons.push(
        `successful concern_tracer receipt for "${receiptIdentity(receipt)}" has no matching persisted concern evidence; retrace it narrowly and checkpoint the complete concern body`,
      );
    }
    for (const proposal of unresolvedScoutProposals) {
      reasons.push(`scout proposal "${proposal}" was neither successfully traced nor substantively rejected`);
    }

    return {
      complete: reasons.length === 0,
      reasons,
      successful_scouts: scouts.length,
      successful_tracers: persistedSuccessfulTracers.map(receiptIdentity),
      unresolved_tracer_failures: unresolvedFailures.map(failureDescription),
      missing_concern_tracers: missingConcernTracers,
      unresolved_scout_proposals: unresolvedScoutProposals,
    };
  }
}

/** Persist one application-validated tracer body before its receipt is attested. */
export function checkpointExplorerConcernEvidence(
  cwd: string,
  stateDir: string,
  event: unknown,
): boolean {
  if (!isRecord(event) || event.type !== "tool_execution_end" || event.isError === true) return false;
  const toolName = stringField(event.toolName) ?? stringField(event.tool_name);
  if (toolName !== "spawn_explorer") return false;
  const nestedResult = isRecord(event.result) ? event.result : null;
  if (nestedResult?.isError === true) return false;
  const details = nestedResult && isRecord(nestedResult.details)
    ? nestedResult.details
    : isRecord(event.details) ? event.details : null;
  if (!details || details.mode !== "concern_tracer") return false;
  const map = loadCanonicalMapAt(cwd, stateDir);
  if (!map) return false;
  if (isRecord(details.structured_rejection)) {
    const candidate = stringField(details.structured_rejection.candidate);
    const whyRejected = stringField(details.structured_rejection.why_rejected);
    if (!candidate || !whyRejected || !isSubstantiveConcernRejection(whyRejected)
      || map.concern_evidence?.concerns.some((concern) => concern.concern.trim().toLowerCase() === candidate.toLowerCase())) {
      return false;
    }
    const evidence = map.concern_evidence ?? { concerns: [], not_concerns: [] };
    writeCanonicalMap(cwd, {
      ...map,
      concern_evidence: {
        ...evidence,
        not_concerns: [
          ...evidence.not_concerns.filter((entry) => entry.candidate.trim().toLowerCase() !== candidate.toLowerCase()),
          { candidate, why_rejected: whyRejected },
        ],
      },
    }, { stateDir, mapFilename: "codebase_map.json" });
    return true;
  }
  if (!isRecord(details.structured_concern)) return false;
  const concern = details.structured_concern;
  const concernName = stringField(concern.concern);
  if (!concernName) return false;
  const identity = concernName.toLowerCase();
  const replacesConcern = stringField(details.replaces_concern);
  const replacedBody = replacesConcern === null ? null : map.concern_evidence?.concerns.find(candidate =>
    candidate.concern === replacesConcern);
  const replacedDigest = replacedBody === null || replacedBody === undefined ? null
    : createHash("sha256").update(stableMapValueIdentity(replacedBody)).digest("hex");
  const replacementFinding = replacesConcern === null ? null : map.specialist_reviews?.records.find(record =>
    map.specialist_reviews?.repository_commit === currentRepositoryCommit(cwd)
    && record.concern === replacesConcern && record.digest === replacedDigest
    && record.retryable === false && record.finding?.claim === "concern");
  const mergedWithConcern = mergeExplorerConcernEvidence(map, concern);
  const merged: CodebaseMap = !replacesConcern || replacesConcern.toLowerCase() === identity || !replacementFinding
    ? mergedWithConcern
    : {
      ...mergedWithConcern,
      concern_evidence: {
        concerns: (mergedWithConcern.concern_evidence?.concerns ?? [])
          .filter(candidate => candidate.concern !== replacesConcern),
        not_concerns: [
          ...(mergedWithConcern.concern_evidence?.not_concerns ?? [])
            .filter(candidate => candidate.candidate !== replacesConcern),
          { candidate: replacesConcern, grouped_into: concernName,
            why_rejected: `Corrected to ${concernName}: ${replacementFinding.finding!.reason}` },
        ],
      },
    };
  if (!merged.concern_evidence?.concerns.some((candidate) => candidate.concern.trim().toLowerCase() === identity)) {
    return false;
  }
  writeCanonicalMap(cwd, merged, { stateDir, mapFilename: "codebase_map.json" });
  return true;
}

/** Shared prospective merge for compiler feedback and the trusted checkpoint. */
export function mergeExplorerConcernEvidence(map: CodebaseMap, concern: Record<string, unknown>): CodebaseMap {
  const identity = stringField(concern.concern)?.toLowerCase();
  if (!identity) return map;
  const current = map.concern_evidence ?? { concerns: [], not_concerns: [] };
  return mergeEvidenceIntoMap({
    concern_evidence: {
      concerns: [
        ...current.concerns.filter((candidate) => candidate.concern.trim().toLowerCase() !== identity),
        concern,
      ],
      not_concerns: current.not_concerns.filter((candidate) => candidate.candidate.trim().toLowerCase() !== identity),
    },
  }, map);
}

function trackerFromAttestation(attestation: ExplorerReceiptAttestation): ExplorerReceiptTracker {
  const tracker = new ExplorerReceiptTracker();
  tracker.loadAttestation(attestation);
  return tracker;
}

export function currentRepositoryCommit(cwd: string): string | null {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--verify", "HEAD^{commit}"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const commit = result.status === 0 ? result.stdout.trim().toLowerCase() : "";
  return /^[0-9a-f]{40,64}$/.test(commit) ? commit : null;
}

export function assessExplorerReceiptAttestation(
  map: CodebaseMap | null,
  cwd: string,
  options: ExplorerReceiptAssessmentOptions = {},
): ExplorerReceiptAssessment {
  const attestation = map?.explorer_receipts;
  if (attestation === undefined) {
    return {
      complete: false,
      reasons: ["application-attested explorer receipt ledger is missing"],
      successful_scouts: 0,
      successful_tracers: [],
      unresolved_tracer_failures: [],
      missing_concern_tracers: map?.concern_evidence?.concerns.map((concern) => concern.concern) ?? [],
      unresolved_scout_proposals: [],
    };
  }
  const currentCommit = currentRepositoryCommit(cwd);
  if (currentCommit === null || attestation.repository_commit !== currentCommit) {
    return {
      complete: false,
      reasons: [
        currentCommit === null
          ? "current repository commit cannot be verified for explorer receipts"
          : `explorer receipts attest ${attestation.repository_commit}, not current HEAD ${currentCommit}`,
      ],
      successful_scouts: 0,
      successful_tracers: [],
      unresolved_tracer_failures: [],
      missing_concern_tracers: map?.concern_evidence?.concerns.map((concern) => concern.concern) ?? [],
      unresolved_scout_proposals: [],
    };
  }
  return trackerFromAttestation(attestation).assess(map, options);
}
