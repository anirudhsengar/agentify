import * as fs from "node:fs";
import * as path from "node:path";

const STORE_LOCK_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function exactEntries(directory: string, expected: ReadonlyArray<string>): boolean {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort((left, right) => left.localeCompare(right));
  return names.length === expected.length
    && names.every((name, index) => name === expected[index]);
}

/**
 * Recognize only the exact operational shape created after Agentify acquires the
 * first team-memory writer lock and before it has written an initialization
 * journal. Arbitrary runtime content is deliberately not ownership evidence.
 */
export function hasRecognizedUninitializedStoreLock(cwd: string): boolean {
  const root = path.join(path.resolve(cwd), ".agentify");
  const runtime = path.join(root, "runtime");
  const locks = path.join(runtime, "locks");
  const lockPath = path.join(locks, "store.lock");
  try {
    for (const directory of [root, runtime, locks]) {
      const stat = fs.lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    }
    if (!exactEntries(root, ["runtime"])) return false;
    if (!exactEntries(runtime, ["locks"])) return false;
    if (!exactEntries(locks, ["store.lock"])) return false;
    const stat = fs.lstatSync(lockPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4_096) return false;
    const parsed: unknown = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    return typeof record.token === "string"
      && STORE_LOCK_TOKEN.test(record.token)
      && Number.isSafeInteger(record.pid)
      && typeof record.pid === "number"
      && record.pid > 0
      && typeof record.hostname === "string"
      && record.hostname.trim().length > 0
      && typeof record.acquired_at === "string"
      && Number.isFinite(Date.parse(record.acquired_at));
  } catch {
    return false;
  }
}
