import * as fs from "node:fs";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import { EngagementError } from "./errors.ts";
import { engagementArtifactPath, type EngagementArtifactName } from "./paths.ts";
import type { EngagementStateOptions } from "./state.ts";
import { writeEngagementJsonAtomic } from "./state.ts";

export function writeEngagementArtifact<T>(
  stateDir: string, engagementId: string, name: EngagementArtifactName,
  schema: TSchema, value: T, options?: EngagementStateOptions,
): T {
  if (!Value.Check(schema, value)) throw new EngagementError("invalid_artifact", `${name} failed schema validation`);
  const record = value as { engagement_id?: unknown };
  if (record.engagement_id !== engagementId) throw new EngagementError("invalid_reference", `${name} engagement ID does not match its storage path`);
  writeEngagementJsonAtomic(engagementArtifactPath(stateDir, engagementId, name), value, options);
  return value;
}

export function readEngagementArtifact<T>(stateDir: string, engagementId: string, name: EngagementArtifactName, schema: TSchema): T {
  const filePath = engagementArtifactPath(stateDir, engagementId, name);
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? "not_found" : "corrupt_state";
    throw new EngagementError(code, `cannot read engagement artifact ${name}`, { cause: error });
  }
  if (!Value.Check(schema, parsed)) throw new EngagementError("corrupt_state", `engagement artifact ${name} is schema-invalid`);
  if ((parsed as { engagement_id?: unknown }).engagement_id !== engagementId) throw new EngagementError("corrupt_state", `engagement artifact ${name} ID does not match its storage path`);
  return parsed as T;
}
