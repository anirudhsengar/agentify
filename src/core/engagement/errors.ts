export type EngagementErrorCode =
  | "invalid_id"
  | "unsafe_path"
  | "invalid_charter"
  | "not_found"
  | "already_exists"
  | "revision_conflict"
  | "corrupt_state"
  | "invalid_transition"
  | "invalid_artifact"
  | "invalid_reference"
  | "duplicate_id"
  | "invalid_score"
  | "persistence_failed";

export class EngagementError extends Error {
  readonly code: EngagementErrorCode;
  readonly cause?: unknown;

  constructor(code: EngagementErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "EngagementError";
    this.code = code;
    this.cause = options?.cause;
  }
}
