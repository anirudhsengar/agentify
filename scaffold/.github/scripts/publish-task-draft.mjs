#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const MAX_INPUT_BYTES = 512 * 1024;
const MAX_BODY_BYTES = 60 * 1024;
const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_BRANCH = /^agentify\/issue-([1-9][0-9]*)-[a-z0-9][a-z0-9-]{0,63}$/;
const SHA = /^[0-9a-f]{40}$/;

function fail(message) {
  throw new Error(message);
}
function readJson(filePath) {
  const absolute = path.resolve(filePath);
  const stat = fs.statSync(absolute);
  if (!stat.isFile() || stat.size < 2 || stat.size > MAX_INPUT_BYTES) fail("bounded publication input is required");
  return JSON.parse(fs.readFileSync(absolute, "utf8"));
}

function writeJson(filePath, value) {
  const absolute = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (options.allowFailure !== true && result.status !== 0) {
    fail(`${command} ${args[0] ?? ""} failed: ${(result.stderr || result.stdout || "unknown failure").slice(0, 1_000)}`);
  }
  return result;
}

function git(root, ...args) {
  return run("git", ["-C", root, ...args]).stdout.trim();
}

function changedPaths(root, base, head) {
  const entries = run("git", ["-C", root, "diff", "--name-status", "-z", "--find-renames", "--find-copies", "--find-copies-harder", `${base}...${head}`, "--"]).stdout.split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < entries.length;) {
    const status = entries[index++];
    if (status?.[0] === "R" || status?.[0] === "C") {
      const previous = entries[index++]; const current = entries[index++];
      if (!previous || !current) fail("publication Git rename or copy inventory is malformed");
      paths.push(previous, current);
    } else {
      const current = entries[index++];
      if (!status || !current) fail("publication Git path inventory is malformed");
      paths.push(current);
    }
  }
  return [...new Set(paths)];
}

function inside(candidate, scope) { return candidate === scope || candidate.startsWith(`${scope}/`); }

function ghInvocation(args) {
  const driver = process.env.AGENTIFY_GH_TEST_DRIVER?.trim();
  if (!driver) return { command: "gh", args };
  if (process.env.NODE_ENV !== "test") fail("the fake GitHub driver is restricted to test qualification");
  const resolved = path.resolve(driver);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) fail("the fake GitHub driver must be one regular non-symlink file");
  return /\.(?:cjs|mjs|js)$/i.test(resolved)
    ? { command: process.execPath, args: [resolved, ...args] }
    : { command: resolved, args };
}

function gh(args, input, allowFailure = false) {
  const invocation = ghInvocation(args);
  return run(invocation.command, invocation.args, { input, allowFailure });
}

function api(method, endpoint, body, allowFailure = false) {
  const args = ["api", "--method", method, endpoint];
  const input = body === undefined ? undefined : JSON.stringify(body);
  if (body !== undefined) args.push("--input", "-");
  const result = gh(args, input, allowFailure);
  if (result.status !== 0) return { ok: false, status: result.status, value: null, error: result.stderr };
  return { ok: true, status: 0, value: result.stdout.trim() ? JSON.parse(result.stdout) : null, error: "" };
}

function assertOwnedCommit(root, commit, taskId, issueNumber, expectedBase, planDigest) {
  const body = git(root, "show", "-s", "--format=%B", commit);
  const trailers = new Map();
  for (const line of body.split("\n")) {
    const match = /^(Agentify-[A-Za-z-]+):\s*(.+?)\s*$/.exec(line);
    if (match) trailers.set(match[1], match[2]);
  }
  if (
    trailers.get("Agentify-Task-ID") !== taskId
    || trailers.get("Agentify-Issue") !== String(issueNumber)
    || trailers.get("Agentify-Expected-Base") !== expectedBase
    || trailers.get("Agentify-Plan-Digest") !== planDigest
  ) {
    fail("remote implementation branch does not carry the expected Agentify ownership trailers");
  }
}

function matchingPullRequests(repository, branch, baseBranch) {
  const result = gh([
    "pr", "list", "--repo", repository, "--state", "all", "--head", branch, "--base", baseBranch,
    "--limit", "10", "--json", "number,url,isDraft,state,body,headRefName,baseRefName,headRefOid",
  ]);
  const parsed = JSON.parse(result.stdout || "[]");
  if (!Array.isArray(parsed)) fail("pull-request lookup returned invalid JSON");
  return parsed;
}

function recoverPullRequest(input, marker) {
  const matches = matchingPullRequests(input.repository, input.branch, input.base_branch);
  if (matches.length > 1) fail("multiple pull requests claim the owned task branch");
  if (matches.length === 0) return null;
  const pr = matches[0];
  if (
    pr.isDraft !== true
    || pr.state !== "OPEN"
    || pr.headRefName !== input.branch
    || pr.baseRefName !== input.base_branch
    || typeof pr.body !== "string"
    || !pr.body.includes(marker)
  ) {
    fail("matching pull request is closed, non-draft, or not owned by this task");
  }
  return pr;
}

function ensureDraftLabel(repository, number) {
  api("POST", `repos/${repository}/issues/${number}/labels`, { labels: ["agentify:draft"] }, true);
}

function main() {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) fail("usage: publish-task-draft.mjs INPUT.json OUTPUT.json");
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) fail("trusted GitHub token is required for publication");
  const input = readJson(inputPath);
  const root = fs.realpathSync(path.resolve(String(input.repo_root ?? ".")));
  const repository = String(input.repository ?? "");
  const branch = String(input.branch ?? "");
  const branchMatch = SAFE_BRANCH.exec(branch);
  const issueNumber = Number(input.issue_number);
  const expectedBase = String(input.expected_base_commit ?? "");
  const expectedHead = String(input.expected_head_commit ?? "");
  const baseBranch = String(input.base_branch ?? "");
  const taskId = String(input.task_id ?? "");
  const planDigest = String(input.plan_digest ?? "");
  const allowedPaths = Array.isArray(input.allowed_paths) ? input.allowed_paths.map(String) : [];
  const protectedPaths = Array.isArray(input.protected_paths) ? input.protected_paths.map(String) : [];
  const title = String(input.title ?? "").trim().slice(0, 240);
  let body = String(input.body ?? "").replaceAll("\0", "").replace(/\r\n?/g, "\n").trim();
  if (!SAFE_REPOSITORY.test(repository)) fail("publication repository is invalid");
  if (!branchMatch || Number(branchMatch[1]) !== issueNumber) fail("publication branch is not canonical for the issue");
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) fail("publication issue number is invalid");
  if (!SHA.test(expectedBase) || !SHA.test(expectedHead)) fail("publication commit binding is invalid");
  if (!taskId || !/^[A-Za-z0-9._:/-]{1,256}$/.test(taskId) || !/^[0-9a-f]{64}$/.test(planDigest)) {
    fail("publication task or plan identity is invalid");
  }
  if (!baseBranch || branch === baseBranch || !title || !body) fail("publication title, body, or base branch is invalid");
  if (allowedPaths.length === 0) fail("publication has no approved path scope");
  const marker = `<!-- agentify:task task=${taskId} issue=${issueNumber} branch=${branch} plan=${planDigest} -->`;
  if (!body.includes(marker)) body = `${body}\n\n${marker}`;
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) fail("draft pull-request body exceeds the bounded size");
  if (!body.includes(`#${issueNumber}`)) fail("draft pull-request body must link the authorized issue");

  const localHead = git(root, "rev-parse", "HEAD");
  const localBranch = git(root, "branch", "--show-current");
  if (localHead !== expectedHead || localBranch !== branch) fail("local implementation branch moved after validation");
  if (git(root, "status", "--porcelain=v1", "--untracked-files=all")) fail("publication requires a clean stable worktree");
  assertOwnedCommit(root, localHead, taskId, issueNumber, expectedBase, planDigest);
  for (const changedPath of changedPaths(root, expectedBase, expectedHead)) {
    if (!allowedPaths.some((scope) => inside(changedPath, scope))) fail(`publication commit changed out-of-scope path ${changedPath}`);
    if (protectedPaths.some((scope) => inside(changedPath, scope))) fail(`publication commit changed protected path ${changedPath}`);
  }

  const baseRef = api("GET", `repos/${repository}/git/ref/heads/${encodeURIComponent(baseBranch)}`);
  const remoteBase = baseRef.value?.object?.sha;
  if (remoteBase !== expectedBase) fail("base branch changed before publication");

  gh(["auth", "setup-git"]);
  const remoteRef = api("GET", `repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`, undefined, true);
  let remoteHead = remoteRef.ok ? remoteRef.value?.object?.sha : null;
  if (remoteHead) {
    run("git", ["-C", root, "fetch", "--no-tags", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    assertOwnedCommit(root, `refs/remotes/origin/${branch}`, taskId, issueNumber, expectedBase, planDigest);
    const ancestry = run("git", ["-C", root, "merge-base", "--is-ancestor", remoteHead, localHead], { allowFailure: true });
    if (ancestry.status !== 0) fail("owned remote task branch is not an ancestor of the validated local head");
  }

  if (remoteHead !== localHead) {
    run("git", ["-C", root, "push", "--set-upstream", "origin", branch]);
  }

  let pr = recoverPullRequest({ repository, branch, base_branch: baseBranch }, marker);
  if (pr === null) {
    const titleFile = path.join(path.dirname(path.resolve(outputPath)), "task-pr-title.txt");
    const bodyFile = path.join(path.dirname(path.resolve(outputPath)), "task-pr-body.md");
    fs.writeFileSync(titleFile, `${title}\n`, { mode: 0o600 });
    fs.writeFileSync(bodyFile, `${body}\n`, { mode: 0o600 });
    const created = gh([
      "pr", "create", "--repo", repository, "--draft", "--base", baseBranch, "--head", branch,
      "--title", title, "--body-file", bodyFile,
    ], undefined, true);
    pr = recoverPullRequest({ repository, branch, base_branch: baseBranch }, marker);
    if (pr === null) fail(`draft pull-request creation was not recoverable: ${(created.stderr || created.stdout).slice(0, 1_000)}`);
  } else {
    api("PATCH", `repos/${repository}/pulls/${pr.number}`, { title, body });
    pr = recoverPullRequest({ repository, branch, base_branch: baseBranch }, marker);
  }
  if (!pr || pr.headRefOid !== expectedHead) fail("draft pull request does not point at the validated head commit");
  ensureDraftLabel(repository, pr.number);
  writeJson(outputPath, {
    status: "draft-pr-open",
    number: pr.number,
    url: pr.url,
    head_branch: branch,
    base_branch: baseBranch,
    head_commit: expectedHead,
    draft: true,
    marker,
  });
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`agentify task publication failed: ${message.slice(0, 2_000)}`);
  process.exit(1);
}
