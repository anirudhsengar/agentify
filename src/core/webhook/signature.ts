// signature.ts — HMAC signature verification for webhook triggers.
//
// Supported algorithms: hmac-sha1, hmac-sha256.
// Use crypto.timingSafeEqual on the hex-decoded comparison buffers.
//
// The verification is parameterised so it can accept any HMAC-shaped
// integration. Two opt-in extensions cover integrations that deviate
// from the "raw-body + bare-hex-header" defaults:
//
//   signature_prefix          — the literal before the hex digest in
//                               the header value; everything after
//                               is the hex/base64 digest. Empty
//                               string means the header value IS the
//                               digest.
//   signature_payload_prefix  — the literal bytes prepended to the
//                               request body before HMAC. "{timestamp}"
//                               is substituted with the value of
//                               `timestamp_header`. Default: "".
//
// Replay protection: when `timestamp_header` is set, the header value
// is parsed as a Unix-seconds integer and the request is rejected if
// the delta from "now" exceeds `timestamp_max_age_seconds`.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Trigger } from "./state.ts";

export type SignatureVerifyResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Verify a request's signature against the configured HMAC scheme.
 *
 * `headerValue` is the raw header value (with optional prefix like
 * "sha256=" or "v1=" depending on the integration). `body` is the raw
 * request body as a Buffer or string. `trigger` is the resolved trigger
 * from the registry.
 *
 * Returns { ok: true } iff the signature is well-formed and matches
 * the computed HMAC. All other outcomes return { ok: false, reason }
 * with a short, non-leaky reason string suitable for logging.
 */
export function verifySignature(
  trigger: Trigger,
  headerValue: string | null | undefined,
  body: Buffer | string,
  options: {
    /** Override for testing; defaults to Date.now()/1000. */
    now?: number;
    /** Headers for timestamp-prefix interpolation. */
    headers?: Record<string, string | string[] | undefined>;
  } = {},
): SignatureVerifyResult {
  if (!headerValue) {
    return { ok: false, reason: "missing signature header" };
  }

  const secret = readSecret(trigger.secret_env);
  if (!secret) {
    return { ok: false, reason: "secret env not set" };
  }

  // Replay protection (before computing HMAC; cheaper reject).
  // Real timestamp check happens in verifySignatureWithHeaders below.
  // The verifySignature primitive is also called from signBody, which
  // doesn't have timestamp context, so we substitute "0" as a default.
  const tsForPrefix = readHeader(
    options.headers ?? {},
    trigger.timestamp_header ?? "",
  ) ?? "0";

  // Strip the configured prefix from the header value to get the digest.
  const prefix = trigger.signature_prefix ?? "";
  let digestText: string;
  if (prefix) {
    if (!headerValue.startsWith(prefix)) {
      return { ok: false, reason: "signature prefix mismatch" };
    }
    digestText = headerValue.slice(prefix.length);
  } else {
    // Tolerate a leading "sha256=" (or "sha1=") even when prefix is
    // unset, since some integrations send the SHA digest with the
    // algorithm prefix inline (GitHub's `X-Hub-Signature-256` is the
    // canonical example).
    const alt = headerValue.match(/^sha(?:1|256)=(.+)$/);
    digestText = alt ? alt[1] : headerValue;
  }
  if (!digestText) {
    return { ok: false, reason: "empty signature digest" };
  }

  const bodyBuf = typeof body === "string" ? Buffer.from(body, "utf-8") : body;
  const payloadPrefix = (trigger.signature_payload_prefix ?? "")
    .replace(/\{timestamp\}/g, tsForPrefix);
  const signedPayload = payloadPrefix
    ? Buffer.concat([Buffer.from(payloadPrefix, "utf-8"), bodyBuf])
    : bodyBuf;

  const algo = trigger.signature_algorithm ?? "hmac-sha256";
  const hmacAlgo = algo === "hmac-sha1" ? "sha1" : "sha256";
  const computed = createHmac(hmacAlgo, secret).update(signedPayload).digest("hex");

  const expected = Buffer.from(computed, "hex");
  let received: Buffer;
  try {
    received = Buffer.from(digestText, "hex");
  } catch {
    return { ok: false, reason: "signature is not valid hex" };
  }
  if (received.length !== expected.length) {
    // Wrong length can't match; short-circuit without timingSafeEqual
    // since we'd need to pad to compare.
    return { ok: false, reason: "signature length mismatch" };
  }
  if (!timingSafeEqual(received, expected)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}

/**
 * Verify with the timestamp header extracted from the full request.
 * Use this from the server; the simpler `verifySignature` is the
 * primitive used by tests and by callers that have already split the
 * timestamp from the rest.
 */
export function verifySignatureWithHeaders(
  trigger: Trigger,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer | string,
  options: { now?: number } = {},
): SignatureVerifyResult {
  const sigHeader = readHeader(headers, trigger.signature_header);
  if (!sigHeader) {
    return { ok: false, reason: `missing ${trigger.signature_header}` };
  }

  if (trigger.timestamp_header) {
    const tsHeader = readHeader(headers, trigger.timestamp_header);
    if (!tsHeader) {
      return { ok: false, reason: `missing ${trigger.timestamp_header}` };
    }
    const ts = Number.parseInt(tsHeader, 10);
    if (!Number.isFinite(ts)) {
      return { ok: false, reason: "invalid timestamp" };
    }
    const now = options.now ?? Math.floor(Date.now() / 1000);
    const maxAge = trigger.timestamp_max_age_seconds ?? 300;
    if (Math.abs(now - ts) > maxAge) {
      return { ok: false, reason: "timestamp out of range" };
    }
  }

  return verifySignature(trigger, sigHeader, body, { ...options, headers });
}

/**
 * Compute the HMAC for a body using the trigger's algorithm.
 * Exposed for tests and for the `agentify webhook test` CLI.
 */
export function signBody(
  trigger: Trigger,
  body: Buffer | string,
): string {
  const secret = readSecret(trigger.secret_env);
  if (!secret) {
    throw new Error(`secret env ${trigger.secret_env} is not set`);
  }
  const algo = trigger.signature_algorithm ?? "hmac-sha256";
  const hmacAlgo = algo === "hmac-sha1" ? "sha1" : "sha256";
  const bodyBuf = typeof body === "string" ? Buffer.from(body, "utf-8") : body;
  const payloadPrefix = trigger.signature_payload_prefix ?? "";
  const signedPayload = payloadPrefix
    ? Buffer.concat([Buffer.from(payloadPrefix, "utf-8"), bodyBuf])
    : bodyBuf;
  const hex = createHmac(hmacAlgo, secret).update(signedPayload).digest("hex");
  const prefix = trigger.signature_prefix ?? "";
  return prefix ? `${prefix}${hex}` : hex;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function readSecret(envName: string): string | null {
  const value = process.env[envName];
  if (!value || value.length === 0) return null;
  return value;
}

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const direct = headers[name.toLowerCase()];
  if (typeof direct === "string" && direct.length > 0) return direct;
  if (Array.isArray(direct) && direct.length > 0) return direct[0];
  // Tolerate case mismatches by scanning.
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name.toLowerCase()) continue;
    if (typeof value === "string" && value.length > 0) return value;
    if (Array.isArray(value) && value.length > 0) return value[0];
  }
  return null;
}