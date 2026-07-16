import { spawnSync } from "node:child_process";

export interface GitSyncStatus {
  kind: "not_git" | "no_upstream" | "up_to_date" | "behind" | "ahead" | "diverged" | "unavailable";
  branch: string | null;
  upstream: string | null;
  behind: number;
  ahead: number;
}

function git(cwd: string, args: ReadonlyArray<string>) {
  return spawnSync("git", [...args], { cwd, encoding: "utf-8" });
}

export function inspectGitSyncStatus(cwd: string): GitSyncStatus {
  const notGit: GitSyncStatus = {
    kind: "not_git", branch: null, upstream: null, behind: 0, ahead: 0,
  };
  if (git(cwd, ["rev-parse", "--is-inside-work-tree"]).status !== 0) return notGit;
  const branchResult = git(cwd, ["branch", "--show-current"]);
  const branch = branchResult.status === 0 ? branchResult.stdout.trim() || null : null;
  const upstreamResult = git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
  if (upstreamResult.status !== 0) {
    return { kind: "no_upstream", branch, upstream: null, behind: 0, ahead: 0 };
  }
  const upstream = upstreamResult.stdout.trim();

  // Refresh remote-tracking refs before deciding whether the user is behind.
  // A fetch failure is non-fatal: Agentify can still run against local state.
  if (git(cwd, ["fetch", "--quiet"]).status !== 0) {
    return { kind: "unavailable", branch, upstream, behind: 0, ahead: 0 };
  }
  const counts = git(cwd, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
  if (counts.status !== 0) {
    return { kind: "unavailable", branch, upstream, behind: 0, ahead: 0 };
  }
  const [behindRaw, aheadRaw] = counts.stdout.trim().split(/\s+/);
  const behind = Number.parseInt(behindRaw ?? "", 10);
  const ahead = Number.parseInt(aheadRaw ?? "", 10);
  if (!Number.isSafeInteger(behind) || !Number.isSafeInteger(ahead)) {
    return { kind: "unavailable", branch, upstream, behind: 0, ahead: 0 };
  }
  const kind = behind === 0 && ahead === 0
    ? "up_to_date"
    : behind > 0 && ahead === 0
      ? "behind"
      : behind === 0
        ? "ahead"
        : "diverged";
  return { kind, branch, upstream, behind, ahead };
}

export function pullLatestBranch(cwd: string): { ok: boolean; message: string } {
  const result = git(cwd, ["pull", "--ff-only"]);
  if (result.status === 0) return { ok: true, message: result.stdout.trim() };
  const detail = result.stderr.trim() || result.stdout.trim() || "git pull --ff-only failed";
  return { ok: false, message: detail };
}
