// tests/webhook/signature.test.ts — HMAC signature unit tests.
//
// Covers:
//   - happy path: hmac-sha256 with default settings
//   - hmac-sha1 (legacy GitHub)
//   - signature_prefix (generic v1= scheme)
//   - signature_payload_prefix (generic v1:<ts>: scheme)
//   - signature_prefix with sha256= fallback (GitHub-style)
//   - missing header rejected
//   - missing secret rejected
//   - bad hex rejected
//   - length mismatch rejected
//   - timingSafeEqual: wrong signature rejected (sanity)
//   - timestamp out of range rejected
//   - empty signature digest rejected
//   - unicode body round-trips
//   - large body (1 MiB) handles correctly
//   - signBody + verifySignature round-trip

import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import {
  signBody,
  verifySignature,
  verifySignatureWithHeaders,
} from "../../src/core/webhook/signature.ts";
import type { Trigger } from "../../src/core/webhook/state.ts";

function makeTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: "test",
    path: "/test",
    signature_header: "X-Signature",
    secret_env: "TEST_SECRET",
    prompt: { template: "/implement" },
    ...overrides,
  };
}

function withSecret<T>(name: string, value: string, fn: () => T): T {
  const prev = process.env[name];
  process.env[name] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

async function testHappyPathHmacSha256(): Promise<void> {
  await withSecret("TEST_SECRET", "supersecret", () => {
    const trigger = makeTrigger();
    const body = '{"action":"opened"}';
    const expected = "sha256=" + createHmac("sha256", "supersecret").update(body).digest("hex");
    const result = verifySignature(trigger, expected, body);
    assert.equal(result.ok, true);
  });
}

async function testHappyPathHmacSha1(): Promise<void> {
  await withSecret("TEST_SECRET", "supersecret", () => {
    const trigger = makeTrigger({ signature_algorithm: "hmac-sha1" });
    const body = '{"action":"opened"}';
    const expected = createHmac("sha1", "supersecret").update(body).digest("hex");
    const result = verifySignature(trigger, expected, body);
    assert.equal(result.ok, true);
  });
}

async function testGenericPrefixAndPayloadPrefix(): Promise<void> {
  // Any integration that prefixes both the signature header and the
  // signed body with a `{timestamp}` substitution slot can be modeled
  // generically — this test uses a made-up `v1=<hex>` scheme.
  await withSecret("TEST_SECRET", "supersecret", () => {
    const trigger = makeTrigger({
      signature_header: "X-Foo-Signature",
      signature_prefix: "v1=",
      signature_payload_prefix: "v1:{timestamp}:",
      timestamp_header: "X-Foo-Timestamp",
      timestamp_max_age_seconds: 300,
    });
    const body = '{"event":"ping"}';
    const ts = "1700000000";
    const signedPayload = `v1:${ts}:${body}`;
    const hex = createHmac("sha256", "supersecret").update(signedPayload).digest("hex");
    const headerValue = `v1=${hex}`;
    const headers = {
      "x-foo-signature": headerValue,
      "x-foo-timestamp": ts,
    };
    const result = verifySignatureWithHeaders(trigger, headers, body, { now: 1700000050 });
    assert.equal(result.ok, true, JSON.stringify(result));
  });
}

async function testGenericTimestampOutOfRange(): Promise<void> {
  await withSecret("TEST_SECRET", "supersecret", () => {
    const trigger = makeTrigger({
      signature_header: "X-Foo-Signature",
      signature_prefix: "v1=",
      signature_payload_prefix: "v1:1700000000:",
      timestamp_header: "X-Foo-Timestamp",
      timestamp_max_age_seconds: 300,
    });
    const body = '{"event":"ping"}';
    const ts = "1600000000"; // very old
    const signedPayload = `v1:${ts}:${body}`;
    const hex = createHmac("sha256", "supersecret").update(signedPayload).digest("hex");
    const headers = {
      "x-foo-signature": `v1=${hex}`,
      "x-foo-timestamp": ts,
    };
    const result = verifySignatureWithHeaders(trigger, headers, body, { now: 1700000050 });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.reason, /timestamp/);
  });
}

async function testShaPrefixFallback(): Promise<void> {
  await withSecret("TEST_SECRET", "supersecret", () => {
    // Generic `sha256=` prefix fallback (used by GitHub and any
    // other integration that follows the SHA-convention header
    // shape). The trigger does not configure `signature_prefix`
    // explicitly; the engine falls back to the leading `sha256=`
    // (or `sha1=`) parser.
    const trigger = makeTrigger();
    const body = '{"id":"evt_1"}';
    const expected = "sha256=" + createHmac("sha256", "supersecret").update(body).digest("hex");
    const result = verifySignature(trigger, expected, body);
    assert.equal(result.ok, true);
  });
}

async function testMissingHeader(): Promise<void> {
  await withSecret("TEST_SECRET", "supersecret", () => {
    const result = verifySignature(makeTrigger(), null, "body");
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.reason, /missing/);
  });
}

async function testMissingSecret(): Promise<void> {
  const prev = process.env["TEST_SECRET"];
  delete process.env["TEST_SECRET"];
  try {
    const result = verifySignature(makeTrigger(), "sha256=deadbeef", "body");
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.reason, /secret/);
  } finally {
    if (prev !== undefined) process.env["TEST_SECRET"] = prev;
  }
}

async function testBadHexRejected(): Promise<void> {
  await withSecret("TEST_SECRET", "supersecret", () => {
    const result = verifySignature(makeTrigger(), "sha256=notvalidhex", "body");
    assert.equal(result.ok, false);
  });
}

async function testLengthMismatch(): Promise<void> {
  await withSecret("TEST_SECRET", "supersecret", () => {
    const result = verifySignature(makeTrigger(), "sha256=ab", "body");
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.reason, /length/);
  });
}

async function testWrongSignatureRejected(): Promise<void> {
  await withSecret("TEST_SECRET", "supersecret", () => {
    const body = '{"action":"opened"}';
    // Correct length, wrong content
    const wrong = "sha256=" + createHmac("sha256", "wrong-secret").update(body).digest("hex");
    const result = verifySignature(makeTrigger(), wrong, body);
    assert.equal(result.ok, false);
  });
}

async function testEmptyDigest(): Promise<void> {
  await withSecret("TEST_SECRET", "supersecret", () => {
    const trigger = makeTrigger({ signature_prefix: "v1=" });
    const result = verifySignature(trigger, "v1=", "body");
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.reason, /empty/);
  });
}

async function testPrefixMismatch(): Promise<void> {
  await withSecret("TEST_SECRET", "supersecret", () => {
    const trigger = makeTrigger({ signature_prefix: "v1=" });
    const result = verifySignature(trigger, "sha256=ab", "body");
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.reason, /prefix/);
  });
}

async function testUnicodeBody(): Promise<void> {
  await withSecret("TEST_SECRET", "supersecret", () => {
    const trigger = makeTrigger();
    const body = '{"text":"héllo wörld 你好 🦾"}';
    const expected = "sha256=" + createHmac("sha256", "supersecret").update(body).digest("hex");
    const result = verifySignature(trigger, expected, body);
    assert.equal(result.ok, true);
  });
}

async function testLargeBody(): Promise<void> {
  await withSecret("TEST_SECRET", "supersecret", () => {
    const trigger = makeTrigger();
    const body = randomBytes(1024 * 1024).toString("base64"); // ~1 MiB
    const expected = "sha256=" + createHmac("sha256", "supersecret").update(body).digest("hex");
    const result = verifySignature(trigger, expected, body);
    assert.equal(result.ok, true);
  });
}

async function testSignBodyRoundTrip(): Promise<void> {
  await withSecret("TEST_SECRET", "supersecret", () => {
    const trigger = makeTrigger();
    const body = '{"hello":"world"}';
    const signed = signBody(trigger, body);
    const result = verifySignature(trigger, signed, body);
    assert.equal(result.ok, true);
    // Without signature_prefix set, signBody returns bare hex
    assert.equal(signed.length, 64);
    assert.match(signed, /^[0-9a-f]+$/);
  });
}

async function testSignBodyWithPrefix(): Promise<void> {
  await withSecret("TEST_SECRET", "supersecret", () => {
    const trigger = makeTrigger({ signature_prefix: "v1=" });
    const body = '{"hello":"world"}';
    const signed = signBody(trigger, body);
    assert.ok(signed.startsWith("v1="));
    const result = verifySignature(trigger, signed, body);
    assert.equal(result.ok, true);
  });
}

async function testBufferBody(): Promise<void> {
  await withSecret("TEST_SECRET", "supersecret", () => {
    const trigger = makeTrigger();
    const bodyBuf = Buffer.from('{"a":1}', "utf-8");
    const expected = "sha256=" + createHmac("sha256", "supersecret").update(bodyBuf).digest("hex");
    const result = verifySignature(trigger, expected, bodyBuf);
    assert.equal(result.ok, true);
  });
}

await testHappyPathHmacSha256();
await testHappyPathHmacSha1();
await testGenericPrefixAndPayloadPrefix();
await testGenericTimestampOutOfRange();
await testShaPrefixFallback();
await testMissingHeader();
await testMissingSecret();
await testBadHexRejected();
await testLengthMismatch();
await testWrongSignatureRejected();
await testEmptyDigest();
await testPrefixMismatch();
await testUnicodeBody();
await testLargeBody();
await testSignBodyRoundTrip();
await testSignBodyWithPrefix();
await testBufferBody();

console.log("webhook signature tests passed.");
