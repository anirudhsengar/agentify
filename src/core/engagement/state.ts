import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Value } from "typebox/value";
import { EngagementError } from "./errors.ts";
import { engagementCharterPath, engagementRootPath, validateEngagementId } from "./paths.ts";
import { EngagementCharterSchema, type EngagementCharter } from "./schema/engagement-charter.ts";
import type { EngagementStatus } from "./schema/engagement-status.ts";
import { assertLegalEngagementTransition } from "./transitions.ts";

export type CreateEngagementInput = Omit<EngagementCharter,
  "schema_version" | "revision" | "engagement_id" | "created_at" | "updated_at" | "status" | "stop_reason">;
export type UpdateEngagementInput = Partial<CreateEngagementInput>;

const MUTABLE_CHARTER_FIELDS = new Set<keyof UpdateEngagementInput>([
  "repository",
  "workflow_name",
  "workflow_owner",
  "intended_users",
  "systems_involved",
  "problem_statement",
  "workflow_frequency",
  "baseline_metrics",
  "desired_primary_outcome",
  "target",
  "guardrail_metrics",
  "forbidden_actions",
  "requires_human_approval",
  "maximum_cost_usd",
  "maximum_runtime_minutes",
  "business_owner",
  "technical_owner",
  "evidence_references",
]);

export interface EngagementStateOptions {
  now?: () => Date;
  /** Test seam executed after the durable temporary write and before atomic rename. */
  beforeRename?: (temporaryPath: string, destinationPath: string) => void;
}

function validationMessage(value: unknown): string {
  return Value.Errors(EngagementCharterSchema, value)
    .slice(0, 10)
    .map((error) => {
      const detail = error as { path?: string; instancePath?: string; message: string };
      return `${detail.path || detail.instancePath || "(root)"}: ${detail.message}`;
    })
    .join("; ");
}

export function validateEngagementCharter(value: unknown): EngagementCharter {
  if (!Value.Check(EngagementCharterSchema, value)) {
    throw new EngagementError("invalid_charter", `engagement charter failed schema validation: ${validationMessage(value)}`);
  }
  return value;
}

function nowIso(options?: EngagementStateOptions): string {
  const value = (options?.now ?? (() => new Date()))().toISOString();
  return value;
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch {
    // File fsync and atomic rename remain available on platforms without directory fsync.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeCharterAtomic(filePath: string, charter: EngagementCharter, options?: EngagementStateOptions): void {
  validateEngagementCharter(charter);
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(charter, null, 2)}\n`, "utf-8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    options?.beforeRename?.(temporary, filePath);
    fs.renameSync(temporary, filePath);
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch { /* best-effort temporary cleanup */ }
    if (error instanceof EngagementError) throw error;
    throw new EngagementError("persistence_failed", `failed to persist engagement charter at ${filePath}`, { cause: error });
  }
}

export function createEngagement(
  resolvedStateDir: string,
  engagementId: string,
  input: CreateEngagementInput,
  options?: EngagementStateOptions,
): EngagementCharter {
  const filePath = engagementCharterPath(resolvedStateDir, engagementId);
  if (fs.existsSync(filePath)) {
    throw new EngagementError("already_exists", `engagement already exists: ${engagementId}`);
  }
  const timestamp = nowIso(options);
  const charter: EngagementCharter = {
    ...input,
    schema_version: "1",
    revision: 1,
    engagement_id: engagementId,
    created_at: timestamp,
    updated_at: timestamp,
    status: "draft",
    stop_reason: null,
  };
  writeCharterAtomic(filePath, charter, options);
  return charter;
}

export function readEngagement(resolvedStateDir: string, engagementId: string): EngagementCharter {
  const filePath = engagementCharterPath(resolvedStateDir, engagementId);
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new EngagementError("not_found", `engagement not found: ${engagementId}`);
    }
    throw new EngagementError("corrupt_state", `cannot read engagement state: ${engagementId}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new EngagementError("corrupt_state", `engagement charter contains invalid JSON: ${engagementId}`, { cause: error });
  }
  try {
    const charter = validateEngagementCharter(parsed);
    if (charter.engagement_id !== engagementId) {
      throw new EngagementError("corrupt_state", `engagement charter ID does not match its storage path: ${engagementId}`);
    }
    return charter;
  } catch (error) {
    if (error instanceof EngagementError && error.code === "corrupt_state") throw error;
    throw new EngagementError("corrupt_state", `engagement charter is schema-invalid: ${engagementId}`, { cause: error });
  }
}

export function listEngagements(resolvedStateDir: string): EngagementCharter[] {
  const root = engagementRootPath(resolvedStateDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new EngagementError("corrupt_state", `cannot list engagement state at ${root}`, { cause: error });
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))
    .map((engagementId) => {
      validateEngagementId(engagementId);
      return readEngagement(resolvedStateDir, engagementId);
    });
}

function persistRevision(
  resolvedStateDir: string,
  current: EngagementCharter,
  next: EngagementCharter,
  expectedRevision: number,
  options?: EngagementStateOptions,
): EngagementCharter {
  if (current.revision !== expectedRevision) {
    throw new EngagementError(
      "revision_conflict",
      `engagement ${current.engagement_id} revision conflict: expected ${expectedRevision}, found ${current.revision}`,
    );
  }
  validateEngagementCharter(next);
  writeCharterAtomic(engagementCharterPath(resolvedStateDir, current.engagement_id), next, options);
  return next;
}

export function updateEngagement(
  resolvedStateDir: string,
  engagementId: string,
  patch: UpdateEngagementInput,
  expectedRevision: number,
  options?: EngagementStateOptions,
): EngagementCharter {
  const current = readEngagement(resolvedStateDir, engagementId);
  for (const field of Object.keys(patch)) {
    if (!MUTABLE_CHARTER_FIELDS.has(field as keyof UpdateEngagementInput)) {
      throw new EngagementError(
        "invalid_charter",
        `engagement field cannot be changed through updateEngagement: ${field}`,
      );
    }
  }
  const next: EngagementCharter = {
    ...current,
    ...patch,
    revision: current.revision + 1,
    updated_at: nowIso(options),
  };
  return persistRevision(resolvedStateDir, current, next, expectedRevision, options);
}

export function transitionEngagement(
  resolvedStateDir: string,
  engagementId: string,
  status: EngagementStatus,
  expectedRevision: number,
  stopReason?: string,
  options?: EngagementStateOptions,
): EngagementCharter {
  const current = readEngagement(resolvedStateDir, engagementId);
  assertLegalEngagementTransition(current.status, status, stopReason);
  const next: EngagementCharter = {
    ...current,
    status,
    stop_reason: status === "stopped" ? stopReason!.trim() : current.stop_reason,
    revision: current.revision + 1,
    updated_at: nowIso(options),
  };
  return persistRevision(resolvedStateDir, current, next, expectedRevision, options);
}
