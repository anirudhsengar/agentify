// coms/registry.ts — file-based peer registry for Pi-to-Pi.
//
// Each peer writes a JSON file at
// `<coms_root>/projects/<project_hash>/agents/<name>.json`.
// Discovery is `readdirSync` of that directory; liveness is
// checked via `process.kill(pid, 0)` (the same idiom used by
// LESSONS/PI_MASTERY.md § 11.7).
//
// Writes are atomic via `.tmp + rename` (POSIX guarantee for
// `rename(2)`); this prevents partial reads when two peers
// upsert concurrently.
//
// Source of truth: `LESSONS/PI_MASTERY.md` § 11.7 ("atomic
// writes via .tmp + rename to prevent partial reads"; "PID
// liveness check on every list").

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  DEFAULT_COMS_ROOT,
  type PeerEntry,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Resolve `~` to the user's home directory. Mirrors the
 * `~/.pi/...` convention used throughout the agentic layer.
 */
export function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
    if (p === "~") return home;
    return path.join(home, p.slice(2));
  }
  return p;
}

/**
 * Hash a cwd (or any string) to a 16-char hex project identifier.
 * Mirrors LEARNINGS3.md § 11.7 ("discovery via file registry at
 * ~/.pi/coms/projects/<project>/agents/*.json" where `<project>`
 * is a hash of the cwd).
 */
export function projectHash(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

/**
 * The default project root: `<coms_root>/projects/<project>`.
 */
export function projectRoot(registryDir: string, project: string): string {
  return path.join(registryDir, "projects", project);
}

/**
 * The agents subdirectory where peer entries live.
 */
export function agentsDir(registryDir: string, project: string): string {
  return path.join(projectRoot(registryDir, project), "agents");
}

/**
 * Path to a single peer entry.
 */
export function peerEntryPath(registryDir: string, project: string, name: string): string {
  return path.join(agentsDir(registryDir, project), `${sanitizeName(name)}.json`);
}

// ---------------------------------------------------------------------------
// Name sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize a peer name for use as a filename. Per LEARNINGS3.md
 * § 11.7 the convention is `name` (whatever the user passes via
 * `--cname` or frontmatter); we strip characters that are
 * unsafe in filenames and clamp length.
 */
export function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "peer";
}

// ---------------------------------------------------------------------------
// Liveness check
// ---------------------------------------------------------------------------

/**
 * `process.kill(pid, 0)` throws ESRCH if the pid is dead. We
 * also tolerate EPERM (another user owns the pid; on the same
 * machine this never happens for our own socket, but be safe).
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true; // alive but not ours
    return false; // ESRCH or any other error
  }
}

// ---------------------------------------------------------------------------
// PeerRegistry
// ---------------------------------------------------------------------------

export interface PeerRegistryOptions {
  /** Root directory for the registry. Default: ~/.pi/coms. */
  registryDir?: string;
  /** Project hash. If omitted, computed from cwd. */
  project?: string;
}

/**
 * File-backed peer registry. Each instance is bound to a single
 * project; cross-project discovery is supported via separate
 * instances (or a wrapping ComsClient that loops over projects).
 *
 * Thread-safety: atomic writes (`.tmp + rename`); `readdirSync`
 * is the cross-process race we accept (a peer that upserts
 * between two reads may be missed by one list call; the next
 * list sees it). The pool widget re-renders on every event so
 * brief inconsistency is invisible to the user.
 */
export class PeerRegistry {
  readonly registryDir: string;
  readonly project: string;
  private readonly agentsDirPath: string;

  constructor(opts: PeerRegistryOptions = {}) {
    this.registryDir = expandHome(opts.registryDir ?? DEFAULT_COMS_ROOT);
    this.project = opts.project ?? projectHash(process.cwd());
    this.agentsDirPath = agentsDir(this.registryDir, this.project);
    fs.mkdirSync(this.agentsDirPath, { recursive: true, mode: 0o700 });
  }

  /**
   * Insert or update a peer entry. Atomic write.
   */
  upsert(entry: PeerEntry): void {
    if (entry.project !== this.project) {
      throw new Error(
        `registry: project mismatch (entry=${entry.project}, registry=${this.project})`,
      );
    }
    const finalPath = peerEntryPath(this.registryDir, this.project, entry.name);
    const tmp = `${finalPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entry, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, finalPath);
  }

  /**
   * Remove a peer entry. Idempotent.
   */
  remove(name: string): void {
    const finalPath = peerEntryPath(this.registryDir, this.project, name);
    try {
      fs.unlinkSync(finalPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
  }

  /**
   * Read a single peer entry. Returns null if absent.
   */
  get(name: string): PeerEntry | null {
    const finalPath = peerEntryPath(this.registryDir, this.project, name);
    if (!fs.existsSync(finalPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(finalPath, "utf-8")) as PeerEntry;
    } catch {
      return null;
    }
  }

  /**
   * List all live peers. Prunes dead PIDs (returns the removed
   * list so the caller can log them; also writes `removed` to
   * a side channel if needed).
   *
   * `staleMs` (default 60_000): entries with `lastHeartbeat`
   * older than this AND a live PID are kept (they may be busy);
   * entries with a dead PID are always pruned.
   */
  list(_staleMs = 60_000): { live: PeerEntry[]; pruned: PeerEntry[] } {
    const live: PeerEntry[] = [];
    const pruned: PeerEntry[] = [];
    if (!fs.existsSync(this.agentsDirPath)) return { live, pruned };
    for (const name of fs.readdirSync(this.agentsDirPath)) {
      if (!name.endsWith(".json")) continue;
      const finalPath = path.join(this.agentsDirPath, name);
      let entry: PeerEntry;
      try {
        entry = JSON.parse(fs.readFileSync(finalPath, "utf-8")) as PeerEntry;
      } catch {
        // Corrupt entry — prune it.
        try { fs.unlinkSync(finalPath); } catch { /* ignore */ }
        continue;
      }
      if (!isPidAlive(entry.pid)) {
        // Dead PID — prune.
        try { fs.unlinkSync(finalPath); } catch { /* ignore */ }
        pruned.push(entry);
        continue;
      }
      live.push(entry);
    }
    return { live, pruned };
  }
}