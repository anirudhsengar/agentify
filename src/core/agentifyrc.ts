import * as fs from "node:fs";
import * as path from "node:path";
import { defaultConfigDir } from "./agentify-config.ts";
import {
  DEFAULT_APPLY_POLICY,
  type ApplyPolicy,
  type ApplyPolicyPathOverride,
  type ConflictAction,
} from "./apply-policy.ts";

/**
 * Per-repo agentify configuration. Lives at one of three
 * locations (see `loadAgentifyRc` for discovery order). The file
 * shape is intentionally minimal: just the `apply` policy block.
 * Future top-level keys can be added without a schema migration.
 *
 * Tolerant read: missing fields default, unknown fields are
 * silently dropped, malformed JSON returns `undefined` so the
 * caller falls through to the next discovery candidate. This
 * matches the existing `loadAgentifyConfig` convention so users
 * never see a crash from a typo in their config.
 */
export interface AgentifyRc {
  schema_version: "1";
  apply?: Partial<ApplyPolicy>;
}

export const AGENTIFYRC_FILENAME = "agentifyrc.json";

/**
 * Discovery order for `.agentifyrc`:
 *
 *   1. `<cwd>/<stateDir>/agentifyrc.json` — provider-scoped,
 *      state-dir-aware. Travels with the state dir if the user
 *      moves between providers.
 *   2. `<cwd>/.agentifyrc` — project-root fallback, no extension.
 *   3. `~/.agentify/agentifyrc.json` — user-global fallback for
 *      users who want the same policy across every repo.
 *
 * The first file that exists AND parses successfully wins. A
 * malformed file at location N does NOT block discovery at
 * location N+1 — the user can fix the typo without losing their
 * global policy.
 */
const DISCOVERY_LOCATORS: ReadonlyArray<(cwd: string, stateDir: string) => string> = [
  (cwd, stateDir) => path.join(cwd, stateDir, AGENTIFYRC_FILENAME),
  (cwd) => path.join(cwd, ".agentifyrc"),
  () => path.join(defaultConfigDir(), AGENTIFYRC_FILENAME),
];

function isConflictAction(value: unknown): value is ConflictAction {
  return value === "alongside" || value === "keep" || value === "abort";
}

function isPathOverride(value: unknown): value is ApplyPolicyPathOverride {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.pattern === "string" && isConflictAction(obj.action);
}

function readApplyPolicyFromUnknown(value: unknown): Partial<ApplyPolicy> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const result: Partial<ApplyPolicy> = {};
  if (isConflictAction(obj.defaultAction)) result.defaultAction = obj.defaultAction;
  if (isConflictAction(obj.requiredAction)) result.requiredAction = obj.requiredAction;
  if (Array.isArray(obj.paths)) {
    const valid = obj.paths.filter(isPathOverride);
    if (valid.length > 0) result.paths = valid;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Locate the first parseable `.agentifyrc` and return its parsed
 * shape. Returns `undefined` when no candidate exists or every
 * candidate fails to parse. Callers should treat `undefined` as
 * "no rc file, use the default policy."
 */
export function loadAgentifyRc(cwd: string, stateDir: string): AgentifyRc | undefined {
  for (const locate of DISCOVERY_LOCATORS) {
    const filePath = locate(cwd, stateDir);
    if (!fs.existsSync(filePath)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Malformed JSON: fall through to the next candidate so a
      // typo in one location doesn't shadow a valid global file.
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const obj = parsed as Record<string, unknown>;
    if (obj.schema_version !== "1") continue; // Forward-compat: unknown versions are ignored.
    return {
      schema_version: "1",
      apply: readApplyPolicyFromUnknown(obj.apply),
    };
  }
  return undefined;
}

/**
 * Resolve the effective apply policy for a run. Starts from
 * `DEFAULT_APPLY_POLICY`, then layers the `.agentifyrc` overrides
 * on top. Pattern overrides from the rc file are placed BEFORE
 * the defaults in the `paths` array, so the first match wins for
 * rc patterns and defaults act as a fallback.
 */
export function resolveApplyPolicy(cwd: string, stateDir: string): ApplyPolicy {
  const rc = loadAgentifyRc(cwd, stateDir);
  if (!rc?.apply) return DEFAULT_APPLY_POLICY;
  return {
    defaultAction: rc.apply.defaultAction ?? DEFAULT_APPLY_POLICY.defaultAction,
    requiredAction: rc.apply.requiredAction ?? DEFAULT_APPLY_POLICY.requiredAction,
    paths: [
      ...(rc.apply.paths ?? []),
      ...DEFAULT_APPLY_POLICY.paths,
    ],
  };
}
