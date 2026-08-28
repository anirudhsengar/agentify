import { spawnSync } from "node:child_process";
import type {
  CodebaseMap,
  ExplorerReceiptAttestation,
  ExplorerReceiptRecord,
} from "./schema/index.ts";

type ExplorerMode = "concern_scout" | "concern_tracer";

interface ExplorerReceipt {
  sequence: number;
  mode: ExplorerMode;
  success: boolean;
  targetPath: string;
  focus: string | null;
  reportConcern: string | null;
  failureKind: string | null;
  proposedConcerns: string[];
  sourceRunId: string | null;
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

function scoutConcernsFromText(text: string): string[] {
  const concerns: string[] = [];
  const pattern = /^\s*-\s*concern:\s*([^\r\n]+)/gim;
  for (const match of text.matchAll(pattern)) {
    const concern = match[1]?.trim();
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
  return receipt.reportConcern ?? receipt.focus ?? receipt.targetPath;
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
      reportConcern,
      failureKind,
      proposedConcerns: mode === "concern_scout" && success
        ? scoutConcernsFromText(text)
        : [],
      sourceRunId: null,
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
        report_concern: receipt.reportConcern,
        failure_kind: receipt.failureKind,
        ...(receipt.proposedConcerns.length > 0
          ? { proposed_concerns: receipt.proposedConcerns }
          : {}),
        source_run_id: receipt.sourceRunId ?? runId,
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
        reportConcern: receipt.report_concern,
        failureKind: receipt.failure_kind,
        proposedConcerns: [...(receipt.proposed_concerns ?? [])],
        sourceRunId: receipt.source_run_id ?? attestation.run_id,
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
      receipt.mode === "concern_tracer" && receipt.success
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
      .map((candidate) => candidate.candidate) ?? [];
    const unresolvedScoutProposals = [...new Set(
      scouts.flatMap((scout) => scout.proposedConcerns),
    )].filter((proposal) =>
      !successfulTracers.some((receipt) => semanticallyRelated(proposal, receiptIdentity(receipt)))
      && !rejectedCandidates.some((candidate) => semanticallyRelated(proposal, candidate))
    );

    const reasons: string[] = [];
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
    for (const proposal of unresolvedScoutProposals) {
      reasons.push(`scout proposal "${proposal}" was neither successfully traced nor substantively rejected`);
    }

    return {
      complete: reasons.length === 0,
      reasons,
      successful_scouts: scouts.length,
      successful_tracers: successfulTracers.map(receiptIdentity),
      unresolved_tracer_failures: unresolvedFailures.map(failureDescription),
      missing_concern_tracers: missingConcernTracers,
      unresolved_scout_proposals: unresolvedScoutProposals,
    };
  }
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
