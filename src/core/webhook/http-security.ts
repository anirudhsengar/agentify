import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { Trigger } from "./state.ts";

export interface FixedWindowRateLimit {
  requests: number;
  windowSeconds: number;
}

export interface FixedWindowLimiter {
  buckets: Map<string, { count: number; windowStartedAt: number }>;
}

export interface ReplayCache {
  entries: Map<string, number>;
}

export function createFixedWindowLimiter(): FixedWindowLimiter {
  return { buckets: new Map() };
}

export function createReplayCache(): ReplayCache {
  return { entries: new Map() };
}

export function allowFixedWindowRequest(
  limiter: FixedWindowLimiter,
  key: string,
  limit: FixedWindowRateLimit,
  now = Date.now(),
): boolean {
  if (!Number.isFinite(limit.requests) || limit.requests < 1) return false;
  if (!Number.isFinite(limit.windowSeconds) || limit.windowSeconds < 1) return false;

  const windowMs = limit.windowSeconds * 1000;
  const existing = limiter.buckets.get(key);
  if (!existing || now - existing.windowStartedAt >= windowMs) {
    limiter.buckets.set(key, { count: 1, windowStartedAt: now });
    return true;
  }
  if (existing.count >= limit.requests) return false;
  existing.count += 1;
  return true;
}

export function headerValue(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const value = headers[name.toLowerCase()] ?? headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  if (typeof value === "string") return value;
  return null;
}

export function constantTimeTokenEquals(actual: string | null, expected: string): boolean {
  if (actual === null) return false;
  const actualBytes = Buffer.from(actual, "utf-8");
  const expectedBytes = Buffer.from(expected, "utf-8");
  if (actualBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(actualBytes, expectedBytes);
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export function replayCacheKey(
  trigger: Trigger,
  headers: IncomingHttpHeaders,
): string {
  const deliveryId = trigger.delivery_id_header
    ? headerValue(headers, trigger.delivery_id_header)
    : null;
  const signature = headerValue(headers, trigger.signature_header) ?? "";
  const timestamp = trigger.timestamp_header
    ? headerValue(headers, trigger.timestamp_header) ?? ""
    : "";
  const material = deliveryId
    ? `${trigger.id}\ndelivery\n${deliveryId}`
    : `${trigger.id}\nsignature\n${signature}\ntimestamp\n${timestamp}`;
  return createHash("sha256").update(material).digest("hex");
}

export function isReplay(
  cache: ReplayCache,
  key: string,
  now = Date.now(),
): boolean {
  for (const [cachedKey, expiresAt] of cache.entries) {
    if (expiresAt <= now) cache.entries.delete(cachedKey);
  }
  const expiresAt = cache.entries.get(key);
  return expiresAt !== undefined && expiresAt > now;
}

export function recordReplayKey(
  cache: ReplayCache,
  key: string,
  ttlSeconds: number,
  now = Date.now(),
): void {
  const ttlMs = Math.max(1, ttlSeconds) * 1000;
  cache.entries.set(key, now + ttlMs);
}

export function bearerToken(headers: IncomingHttpHeaders): string | null {
  const authorization = headerValue(headers, "authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length);
  }
  return headerValue(headers, "x-agentify-admin-token");
}
