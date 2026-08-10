#!/usr/bin/env node

// Trusted issue-to-draft-PR controller. This file is installed from the
// protected default branch and never executes issue-supplied workflow code.
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_COMMENT_BYTES = 12_000;
const SHA = /^[0-9a-f]{40}$/;
const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SENSITIVE_ENVIRONMENT = /(?:^|_)(?:API_?KEY|AUTH|CREDENTIAL|PASSWORD|PRIVATE_?KEY|SECRET|TOKEN)(?:$|_)/i;

function fail(message) {
  throw new Error(String(message).slice(0, 2_000));
}

function nowIso() {
  return new Date().toISOString();
}

function stable(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, stable(value[key])]));
  }
  fail(`unsupported ${typeof value} value in trusted JSON`);
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function fileDigest(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function validationApprovalCurrent(root, configuration) {
  const approval = configuration?.validation_approval;
  if (
    configuration?.schema_version !== "2"
    || configuration?.validation_execution?.mode !== "maintainer-approved-unsandboxed"
    || approval?.mode !== "maintainer-approved-unsandboxed"
    || typeof approval.package_json_sha256 !== "string"
    || typeof approval.commands_sha256 !== "string"
  ) return false;
  const manifestPath = typeof approval.manifest_path === "string" && approval.manifest_path.trim()
    ? approval.manifest_path.trim()
    : "package.json";
  const manifest = path.join(root, manifestPath);
  if (!fs.existsSync(manifest) || fileDigest(manifest) !== approval.package_json_sha256) return false;
  const lockNames = [
    "npm-shrinkwrap.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "poetry.lock",
    "uv.lock",
    "Pipfile.lock",
    "Cargo.lock",
    "go.sum",
    "Gemfile.lock",
    "gradle.lockfile",
  ];
  const lockName = lockNames.find((name) => fs.existsSync(path.join(root, name))) ?? null;
  if (lockName !== (approval.lockfile?.path ?? null)) return false;
  if (lockName && fileDigest(path.join(root, lockName)) !== approval.lockfile.sha256) return false;
  return digest(configuration.policy?.validation_commands ?? []) === approval.commands_sha256;
}

function readBoundedJson(filePath, label, maximum = MAX_JSON_BYTES) {
  const absolute = path.resolve(filePath);
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    fail(`${label} is missing`);
  }
  if (!stat.isFile() || stat.size < 2 || stat.size > maximum) fail(`${label} must be one bounded regular JSON file`);
  try {
    return JSON.parse(fs.readFileSync(absolute, "utf8"));
  } catch (error) {
    fail(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeJson(filePath, value) {
  const absolute = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  fs.writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function writeText(filePath, value) {
  const absolute = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  fs.writeFileSync(absolute, String(value), { mode: 0o600 });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    timeout: options.timeout,
  });
  if (result.error && options.allowFailure !== true) throw result.error;
  if (result.status !== 0 && options.allowFailure !== true) {
    fail(`${command} ${args[0] ?? ""} failed: ${(result.stderr || result.stdout || "unknown failure").slice(0, 2_000)}`);
  }
  return result;
}

function git(root, ...args) {
  return run("git", ["-C", root, ...args]).stdout.trim();
}

function gitAllowFailure(root, ...args) {
  return run("git", ["-C", root, ...args], { allowFailure: true });
}

function gh(args, input, allowFailure = false) {
  return run("gh", args, { input, allowFailure });
}

function api(method, endpoint, body, allowFailure = false) {
  const args = ["api", "--method", method, endpoint];
  const input = body === undefined ? undefined : JSON.stringify(body);
  if (body !== undefined) args.push("--input", "-");
  const result = gh(args, input, allowFailure);
  if (result.status !== 0) return { ok: false, value: null, error: result.stderr || result.stdout };
  return { ok: true, value: result.stdout.trim() ? JSON.parse(result.stdout) : null, error: "" };
}

function modelEnvironment() {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "GITHUB_TOKEN" || key === "GH_TOKEN" || key === "AGENT_PAT" || SENSITIVE_ENVIRONMENT.test(key)) continue;
    environment[key] = value;
  }
  environment.CI = "true";
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}

function trustedGitHubEnvironment() {
  const environment = modelEnvironment();
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) {
    environment.GITHUB_TOKEN = token;
    environment.GH_TOKEN = token;
  }
  return environment;
}

function trustedPublicationEnvironment() {
  const environment = trustedGitHubEnvironment();
  const publicationToken = process.env.AGENTIFY_PR_TOKEN;
  if (publicationToken) {
    environment.GITHUB_TOKEN = publicationToken;
    environment.GH_TOKEN = publicationToken;
  }
  return environment;
}

function parseNul(bufferOrString) {
  return String(bufferOrString ?? "").split("\0").filter(Boolean);
}

function parseNameStatusPaths(bufferOrString) {
  const entries = parseNul(bufferOrString);
  const paths = [];
  for (let index = 0; index < entries.length;) {
    const status = entries[index++];
    const kind = status?.[0];
    if (!kind) fail("Git returned a malformed changed-path status");
    if (kind === "R" || kind === "C") {
      const previous = entries[index++];
      const current = entries[index++];
      if (!previous || !current) fail("Git returned a malformed rename or copy status");
      paths.push(previous, current);
    } else {
      const current = entries[index++];
      if (!current) fail("Git returned a malformed changed-path status");
      paths.push(current);
    }
  }
  return paths;
}

function normalizeRepoPath(value) {
  const portable = String(value).replaceAll("\\", "/").replace(/^\.\//, "");
  if (!portable || portable.startsWith("/") || portable.includes("\0") || /[\r\n]/.test(portable)) fail(`unsafe repository path '${portable}'`);
  const segments = portable.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) fail(`unsafe repository path '${portable}'`);
  return segments.join("/");
}

function pathInside(candidate, scope) {
  const file = normalizeRepoPath(candidate);
  const root = normalizeRepoPath(scope);
  return file === root || file.startsWith(`${root}/`);
}

function riskCategory(text, paths) {
  const value = `${text}\n${paths.join("\n")}`.toLowerCase();
  if (/credential|secret|permission|authorization|authentication|security|migration|database|infrastructure|production|deploy|release|workflow|dependency|lockfile/.test(value)) return "high";
  if (paths.length > 8 || /api|contract|schema|billing|payment/.test(value)) return "medium";
  return "low";
}

function publicError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\bgh[opsu]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    .replace(/\n\s*at .*/gs, "")
    .slice(0, 1_500);
}

class Controller {
  constructor() {
    this.root = fs.realpathSync(path.resolve(process.env.GITHUB_WORKSPACE ?? "."));
    this.runtimeRoot = fs.realpathSync(path.resolve(process.env.AGENTIFY_RUNTIME_ROOT ?? "."));
    this.taskRuntime = path.join(this.runtimeRoot, ".github", "agentify", "task-runtime.mjs");
    this.stateScript = path.join(this.runtimeRoot, ".github", "scripts", "task-state-github.mjs");
    this.publisher = path.join(this.runtimeRoot, ".github", "scripts", "publish-task-draft.mjs");
    this.policyPath = path.resolve(this.root, process.env.AGENTIFY_TASK_POLICY ?? ".github/agentify-task-policy.json");
    this.eventPath = path.resolve(process.env.GITHUB_EVENT_PATH ?? "");
    this.repository = process.env.GITHUB_REPOSITORY ?? "";
    this.repositoryId = String(process.env.GITHUB_REPOSITORY_ID ?? "");
    this.runId = String(process.env.GITHUB_RUN_ID ?? "local");
    this.runAttempt = String(process.env.GITHUB_RUN_ATTEMPT ?? "1");
    this.outputDirectory = path.resolve(process.env.AGENTIFY_TASK_OUTPUT_DIR ?? path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), "agentify-task-output"));
    this.temp = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), "agentify-task-controller-"));
    this.state = null;
    this.plan = null;
    this.specialists = [];
    this.builder = null;
    this.validation = null;
    this.review = null;
    this.issue = null;
    this.command = null;
    this.policyConfig = null;
    this.policy = null;
    this.event = null;
    if (!SAFE_REPOSITORY.test(this.repository)) fail("trusted GitHub repository identity is missing");
    for (const required of [this.taskRuntime, this.stateScript, this.publisher]) {
      if (!fs.statSync(required).isFile()) fail(`installed trusted runtime is missing: ${required}`);
    }
    fs.mkdirSync(this.outputDirectory, { recursive: true, mode: 0o700 });
  }

  cleanup() {
    fs.rmSync(this.temp, { recursive: true, force: true });
  }

  runtime(command, value, options = {}) {
    const input = path.join(this.temp, `${command}-${crypto.randomUUID()}.input.json`);
    const output = path.join(this.temp, `${command}-${crypto.randomUUID()}.output.json`);
    writeJson(input, value);
    const env = modelEnvironment();
    env.AGENTIFY_TASK_RUNTIME = this.taskRuntime;
    const result = run(process.execPath, [this.taskRuntime, command, input, output], {
      cwd: this.root,
      env,
      allowFailure: options.allowFailure === true,
      timeout: options.timeout,
    });
    if (result.status !== 0) {
      return { ok: false, error: (result.stderr || result.stdout || `${command} failed`).slice(0, 2_000), value: null };
    }
    return { ok: true, error: "", value: readBoundedJson(output, `${command} output`) };
  }

  requireRuntime(command, value, options = {}) {
    const result = this.runtime(command, value, options);
    if (!result.ok) fail(result.error);
    return result.value;
  }

  stateCommand(command, args) {
    const output = path.join(this.temp, `${command}-${crypto.randomUUID()}.json`);
    const environment = {
      ...trustedGitHubEnvironment(),
      AGENTIFY_TASK_RUNTIME: this.taskRuntime,
      GITHUB_REPOSITORY: this.repository,
    };
    run(process.execPath, [this.stateScript, command, String(this.issue.number), ...args, output], {
      cwd: this.root,
      env: environment,
    });
    return readBoundedJson(output, `${command} output`);
  }

  readState() {
    const result = this.stateCommand("state-read", []);
    this.state = result?.state ?? null;
    return this.state;
  }

  writeState(next) {
    const stateFile = path.join(this.temp, `state-${next.revision}.json`);
    writeJson(stateFile, next);
    const result = this.stateCommand("state-write", [stateFile]);
    this.state = result.state;
    return this.state;
  }

  writeRecord(type, key, value) {
    const file = path.join(this.temp, `${type}-${digest(key)}.json`);
    writeJson(file, value);
    return this.stateCommand("record-write", [type, key, file]);
  }

  readRecord(type, key) {
    return this.stateCommand("record-read", [type, key])?.value ?? null;
  }

  comment(body) {
    const text = String(body).replaceAll("\0", "").trim().slice(0, MAX_COMMENT_BYTES);
    if (!text) return null;
    const file = path.join(this.temp, `comment-${crypto.randomUUID()}.md`);
    writeText(file, `${text}\n`);
    return this.stateCommand("comment", [file]);
  }

  output(value) {
    const output = path.join(this.outputDirectory, "lifecycle-result.json");
    writeJson(output, value);
    const githubOutput = process.env.GITHUB_OUTPUT;
    if (githubOutput) {
      const lines = [];
      for (const [key, item] of Object.entries(value)) {
        if (item === null || typeof item === "object") continue;
        lines.push(`${key}=${String(item).replace(/[\r\n]/g, " ")}`);
      }
      if (lines.length > 0) fs.appendFileSync(githubOutput, `${lines.join("\n")}\n`);
    }
    return value;
  }

  loadEvent() {
    this.event = readBoundedJson(this.eventPath, "GitHub event", MAX_EVENT_BYTES);
    const issue = this.event.issue;
    if (!issue || !Number.isSafeInteger(issue.number) || issue.number < 1) fail("trusted GitHub event has no issue identity");
    this.issue = issue;
    if (issue.pull_request) {
      this.output({ status: "ignored", reason: "pull request comments do not mutate issue tasks" });
      return false;
    }
    if (String(this.event.repository?.id ?? "") !== this.repositoryId) fail("GitHub event repository ID does not match workflow identity");
    return true;
  }

  actorPermission(login) {
    const result = api("GET", `repos/${this.repository}/collaborators/${encodeURIComponent(login)}/permission`, undefined, true);
    if (!result.ok) return "none";
    const permission = String(result.value?.permission ?? "none");
    return ["none", "read", "triage", "write", "maintain", "admin"].includes(permission) ? permission : "none";
  }

  trustedEvent() {
    const isComment = process.env.GITHUB_EVENT_NAME === "issue_comment";
    const comment = isComment ? this.event.comment : null;
    const actor = this.event.sender ?? {};
    const label = this.event.label?.name ?? null;
    const receivedAt = nowIso();
    const deliveryIdentity = {
      repository_id: this.repositoryId,
      issue_number: this.issue.number,
      event_name: isComment ? "issue_comment" : "issues",
      action: this.event.action ?? "other",
      label_name: label,
      comment_id: comment?.id ?? null,
      comment_created_at: comment?.created_at ?? null,
      issue_updated_at: this.issue.updated_at ?? null,
      sender_id: actor.id ?? null,
    };
    return {
      schema_version: "1",
      delivery_id: String(process.env.GITHUB_DELIVERY ?? `github-${digest(deliveryIdentity).slice(0, 48)}`),
      event_name: isComment ? "issue_comment" : "issues",
      action: ["labeled", "created", "edited", "deleted"].includes(this.event.action) ? this.event.action : "other",
      repository: {
        repository_id: this.repositoryId,
        full_name: this.repository,
        default_branch: String(this.event.repository.default_branch ?? ""),
      },
      installation_repository_id: String(this.event.repository.id ?? ""),
      issue_number: this.issue.number,
      issue_state: this.issue.state === "open" ? "open" : "closed",
      issue_is_pull_request: Boolean(this.issue.pull_request),
      issue_title: String(this.issue.title ?? "").slice(0, 8_000),
      issue_body: String(this.issue.body ?? "").slice(0, 64_000),
      actor: {
        login: String(actor.login ?? ""),
        type: ["User", "Bot", "Organization"].includes(actor.type) ? actor.type : "Unknown",
        permission: this.actorPermission(String(actor.login ?? "")),
      },
      label_name: label === null ? null : String(label),
      comment_id: comment?.id === undefined ? null : Number(comment.id),
      comment_body: comment?.body === undefined ? null : String(comment.body).slice(0, 16_000),
      comment_created_at: comment?.created_at ?? null,
      comment_updated_at: comment?.updated_at ?? null,
      received_at: receivedAt,
    };
  }

  loadPolicy() {
    this.policyConfig = readBoundedJson(this.policyPath, "Agentify task policy");
    if (this.policyConfig?.format !== "agentify_task_policy_configuration") {
      fail("Agentify task policy configuration marker is invalid");
    }
    if (this.policyConfig.schema_version !== "2") {
      this.comment(
        "Agentify refused to start implementation because the installed task policy predates explicit validation approval. "
        + "Run `agentify` interactively and approve the displayed unsandboxed repository validation commands."
      );
      this.output({ status: "blocked", reason: "validation_policy_stale" });
      return false;
    }
    if (this.policyConfig.configured !== true || !this.policyConfig.policy) {
      this.comment(
        "Agentify refused to start implementation because the repository-specific task policy has not been configured by the one-time installer. "
        + "No branch, model call, or application mutation was created."
      );
      this.output({
        status: "blocked",
        reason: this.policyConfig.validation_approval ? "task_policy_unconfigured" : "validation_consent_required",
      });
      return false;
    }
    if (!validationApprovalCurrent(this.root, this.policyConfig)) {
      this.comment(
        "Agentify refused to start implementation because the approved package manifest, lockfile, or validation commands changed. "
        + "Run `agentify` interactively to review and approve the current validation inputs."
      );
      this.output({ status: "blocked", reason: "validation_policy_stale" });
      return false;
    }
    if (this.policyConfig.repository_id !== undefined && String(this.policyConfig.repository_id) !== this.repositoryId) {
      fail("Agentify task policy belongs to a different repository identity");
    }
    this.requireRuntime("validate-policy", this.policyConfig.policy);
    this.policy = this.policyConfig.policy;
    return true;
  }

  defaultBranch() {
    return String(this.event.repository.default_branch ?? "");
  }

  currentBase() {
    const branch = git(this.root, "branch", "--show-current");
    if (branch !== this.defaultBranch()) fail(`trusted checkout is on ${branch}, expected default branch ${this.defaultBranch()}`);
    const head = git(this.root, "rev-parse", "HEAD");
    if (!SHA.test(head)) fail("trusted default-branch checkout has an invalid HEAD");
    return head;
  }

  openPullRequests() {
    const result = gh([
      "pr", "list", "--repo", this.repository, "--state", "open", "--limit", "1000",
      "--json", "number,url,isDraft,body,headRefName,baseRefName,headRefOid",
    ]);
    const values = JSON.parse(result.stdout || "[]");
    if (!Array.isArray(values)) fail("open pull-request lookup returned invalid JSON");
    if (values.length >= 1000) fail("open pull-request inventory exceeds the bounded conflict scan");
    return values;
  }

  issuePullRequestConflict(branch = null, taskId = null, planDigest = null) {
    const issueMarker = new RegExp(`issue=${this.issue.number}(?:\\s|-->|$)`);
    const implementsIssue = new RegExp(`(?:^|\n)Implements #${this.issue.number}(?![0-9])`, "m");
    const matches = this.openPullRequests().filter((pr) => {
      const body = String(pr.body ?? "");
      return (branch && pr.headRefName === branch)
        || issueMarker.test(body)
        || implementsIssue.test(body);
    });
    if (matches.length === 0) return null;
    if (matches.length === 1 && branch && taskId && planDigest) {
      const marker = `<!-- agentify:task task=${taskId} issue=${this.issue.number} branch=${branch} plan=${planDigest} -->`;
      if (matches[0].isDraft === true && String(matches[0].body ?? "").includes(marker)) return null;
    }
    return Number(matches[0].number);
  }

  remoteBranchSha(branch) {
    const result = api("GET", `repos/${this.repository}/git/ref/heads/${encodeURIComponent(branch)}`, undefined, true);
    if (!result.ok) return null;
    const sha = String(result.value?.object?.sha ?? "");
    return SHA.test(sha) ? sha : null;
  }

  commitTrailers(commit) {
    const body = git(this.root, "show", "-s", "--format=%B", commit);
    const trailers = new Map();
    for (const line of body.split("\n")) {
      const match = /^(Agentify-[A-Za-z-]+):\s*(.+?)\s*$/.exec(line);
      if (match) trailers.set(match[1], match[2]);
    }
    return trailers;
  }

  assertCommitOwnership(commit, taskId, expectedBase, planDigest = this.plan?.plan_digest ?? this.state?.plan_digest) {
    const trailers = this.commitTrailers(commit);
    if (
      trailers.get("Agentify-Task-ID") !== taskId
      || trailers.get("Agentify-Issue") !== String(this.issue.number)
      || trailers.get("Agentify-Expected-Base") !== expectedBase
      || !planDigest
      || trailers.get("Agentify-Plan-Digest") !== planDigest
    ) {
      fail("existing implementation commit is not owned by this task");
    }
  }

  assertBuilderCommitOwnership(commit, fixCycle) {
    this.assertCommitOwnership(commit, this.state.task_id, this.state.expected_base_commit, this.plan.plan_digest);
    const trailers = this.commitTrailers(commit);
    if (trailers.get("Agentify-Branch-Reservation") === "true") {
      fail("branch reservation is not a recoverable builder commit");
    }
    if (trailers.get("Agentify-Builder") !== "builder") {
      fail("recoverable source commit was not authored by the one writable builder role");
    }
    if (trailers.get("Agentify-Fix-Cycle") !== String(fixCycle)) {
      fail("recoverable builder commit belongs to a different fix cycle");
    }
  }

  checkoutOwnedBranch(branch, expectedBase, taskId) {
    const remote = this.remoteBranchSha(branch);
    run("gh", ["auth", "setup-git"]);
    if (remote === null) {
      run("git", ["-C", this.root, "checkout", "-b", branch, expectedBase]);
      run("git", ["-C", this.root, "config", "user.name", "agentify-runtime[bot]"]);
      run("git", ["-C", this.root, "config", "user.email", "agentify-runtime[bot]@users.noreply.github.com"]);
      const message = [
        `agentify: reserve issue #${this.issue.number} branch`,
        "",
        `Agentify-Task-ID: ${taskId}`,
        `Agentify-Issue: ${this.issue.number}`,
        `Agentify-Expected-Base: ${expectedBase}`,
        `Agentify-Plan-Digest: ${this.plan.plan_digest}`,
        "Agentify-Branch-Reservation: true",
      ].join("\n");
      const messageFile = path.join(this.temp, "branch-reservation-message.txt");
      writeText(messageFile, `${message}\n`);
      run("git", ["-C", this.root, "commit", "--allow-empty", "-F", messageFile]);
      const reservation = git(this.root, "rev-parse", "HEAD");
      run("git", ["-C", this.root, "push", "--set-upstream", "origin", branch]);
      return { created: true, head: reservation };
    }
    run("git", ["-C", this.root, "fetch", "--no-tags", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    this.assertCommitOwnership(remote, taskId, expectedBase, this.plan.plan_digest);
    const ancestry = gitAllowFailure(this.root, "merge-base", "--is-ancestor", expectedBase, remote);
    if (ancestry.status !== 0) fail("owned task branch is not descended from the expected base");
    const currentBranch = git(this.root, "branch", "--show-current");
    if (currentBranch !== branch) {
      run("git", ["-C", this.root, "checkout", "-b", branch, `refs/remotes/origin/${branch}`]);
    } else if (git(this.root, "rev-parse", "HEAD") !== remote) {
      fail("local task branch diverged from its owned remote head");
    }
    return { created: false, head: remote };
  }

  planKey(plan) {
    return `${plan.task_id}:${plan.plan_digest}`;
  }

  specialistKey(plan, specialistId) {
    return `${plan.task_id}:${specialistId}:${plan.plan_digest.slice(0, 16)}`;
  }

  plannerKey(plan) {
    return `${plan.task_id}:planner:${plan.plan_digest.slice(0, 16)}`;
  }

  evidenceKey(kind, identity) {
    return `${this.state.task_id}:${kind}:${digest(identity).slice(0, 32)}`;
  }

  modelCallId(role, identity) {
    return `${this.state.task_id}:${role}:${digest({
      plan: this.plan?.plan_digest ?? this.state.plan_digest,
      retry: this.state.retry_count,
      identity,
    }).slice(0, 32)}`;
  }

  consultedSpecialistKey(specialistId) {
    return this.evidenceKey("specialist", {
      specialist_id: specialistId,
      plan_digest: this.plan.plan_digest,
    });
  }

  builderCycleKey(fixCycle = this.state.fix_cycle_count) {
    return this.evidenceKey("builder", {
      plan_digest: this.plan.plan_digest,
      retry_count: this.state.retry_count,
      fix_cycle: fixCycle,
    });
  }

  builderCallKey(fixCycle = this.state.fix_cycle_count) {
    return this.evidenceKey("builder-call", {
      plan_digest: this.plan.plan_digest,
      retry_count: this.state.retry_count,
      fix_cycle: fixCycle,
    });
  }

  validationCycleKey(builderCommit) {
    return this.evidenceKey("validation", {
      plan_digest: this.plan.plan_digest,
      builder_commit: builderCommit,
    });
  }

  reviewCycleKey() {
    return this.evidenceKey("review", {
      plan_digest: this.plan.plan_digest,
      retry_count: this.state.retry_count,
      fix_cycle: this.state.fix_cycle_count,
      validated_commit: this.validation?.final_commit ?? null,
    });
  }

  builderKey(state = this.state) {
    if (!state.builder_result_digest) fail("task state does not reference builder evidence");
    return `${state.task_id}:${state.builder_result_digest}`;
  }

  validationKey(state = this.state) {
    if (!state.validation_result_digest) fail("task state does not reference validation evidence");
    return `${state.task_id}:${state.validation_result_digest}`;
  }

  reviewKey(state = this.state) {
    if (!state.reviewer_verdict_digest) fail("task state does not reference review evidence");
    return `${state.task_id}:${state.reviewer_verdict_digest}`;
  }

  resource(kind, identity, binding = {}) {
    return {
      kind,
      identity,
      ownership_digest: digest({
        task_id: this.state.task_id,
        issue_number: this.issue.number,
        expected_base_commit: this.state.expected_base_commit,
        plan_digest: this.plan?.plan_digest ?? this.state.plan_digest,
        kind,
        identity,
        ...binding,
      }),
    };
  }

  beginExternalRecovery(targetState, checkpoint, eventPrefix) {
    if (this.state.current_state === "recovering") {
      if (this.state.recovery?.target_state !== targetState) fail("active recovery targets a different lifecycle state");
      if (this.state.recovery?.checkpoint !== checkpoint && !this.state.recovery?.completed_mutations.includes(checkpoint)) {
        fail("active recovery checkpoint does not match the trusted mutation");
      }
      return this.state;
    }
    this.mutationState("begin-recovery", {
      state: this.state,
      expected_revision: this.state.revision,
      event_id: `${eventPrefix}:recovery-begin`,
      actor: "trusted-runtime",
      target_state: targetState,
      checkpoint,
      now: nowIso(),
    });
    return this.state;
  }

  recordExternalMutation(mutation, resource, eventPrefix) {
    this.mutationState("record-external", {
      state: this.state,
      expected_revision: this.state.revision,
      event_id: `${eventPrefix}:${mutation}`,
      actor: "trusted-runtime",
      mutation,
      resource: resource ?? null,
      now: nowIso(),
    });
    return this.state;
  }

  completeExternalRecovery(eventPrefix) {
    this.mutationState("complete-recovery", {
      state: this.state,
      expected_revision: this.state.revision,
      event_id: `${eventPrefix}:recovery-complete`,
      actor: "trusted-runtime",
      now: nowIso(),
    });
    return this.state;
  }

  loadPlanFromState() {
    if (!this.state?.plan_digest) fail("task has no bound plan");
    this.plan = this.readRecord("plan", `${this.state.task_id}:${this.state.plan_digest}`);
    if (!this.plan) fail("bound plan record is missing");
    this.specialists = this.plan.selected_specialists.map((selection) => {
      const result = this.readRecord("specialist", this.specialistKey(this.plan, selection.specialist_id));
      if (!result) fail(`specialist evidence is missing for ${selection.specialist_id}`);
      return result;
    });
    return this.plan;
  }

  commentState(prefix = "Agentify task status") {
    const explanation = this.requireRuntime("explain", this.state).explanation;
    this.comment(`**${prefix}:** ${explanation}`);
  }

  mutationState(command, input) {
    const result = this.requireRuntime(command, input);
    for (const intermediate of result.intermediate_states ?? []) {
      this.writeState(intermediate);
    }
    this.writeState(result.state ?? result);
    return this.state;
  }

  transitionBlocked(reason, eventId) {
    if (!this.state || this.state.active_model_call || ["blocked", "refused", "stale-base", "budget-exhausted", "draft-pr-open", "completed", "recovering"].includes(this.state.current_state)) return this.state;
    const result = this.runtime("mutate", {
      state: this.state,
      mutation: {
        expected_revision: this.state.revision,
        event_id: eventId,
        actor: "trusted-runtime",
        transition_to: "blocked",
        reason: "trusted lifecycle failed closed",
        now: nowIso(),
        patch: { failure_reason: publicError(reason) },
      },
    }, { allowFailure: true });
    if (result.ok) this.writeState(result.value.state);
    return this.state;
  }

  runReadinessAndPlan(parsed) {
    const base = this.currentBase();
    const specification = this.requireRuntime("parse-issue", { title: this.issue.title ?? "", body: this.issue.body ?? "" });
    const readinessInput = {
      repository: this.state.repository,
      installation_repository_id: this.repositoryId,
      issue_number: this.issue.number,
      issue_open: this.issue.state === "open",
      actor_authorized: true,
      expected_base_commit: this.state.expected_base_commit,
      current_base_commit: base,
      active_task_id: null,
      conflicting_pull_request: this.issuePullRequestConflict(),
      acceptance_criteria: specification.acceptance_criteria,
      proposed_paths: specification.candidate_paths,
      validation_commands: this.policy.validation_commands,
      protected_path_policy_known: this.policyConfig.protected_path_policy_known === true,
      validation_services_attested: this.policyConfig.validation_services_attested === true,
      validation_policy_current: validationApprovalCurrent(this.root, this.policyConfig),
      available_budget_usd: Math.max(0, this.state.budget.maximum_cost_usd
        - this.state.budget.measured_cost_usd
        - this.state.budget.estimated_cost_usd),
      issue_text: `${this.issue.title ?? ""}\n${this.issue.body ?? ""}`,
    };
    const readiness = this.requireRuntime("readiness", readinessInput);
    this.mutationState("record-readiness", {
      state: this.state,
      decision: readiness,
      expected_revision: this.state.revision,
      event_id: `${parsed.event_id}:readiness`,
      actor: "orchestrator",
      now: nowIso(),
    });
    if (readiness.disposition !== "ready") {
      const questions = readiness.clarification_questions.map((question) => `- ${question}`).join("\n");
      const reasons = readiness.reasons.map((item) => `- ${item.message}`).join("\n");
      this.comment([
        `Agentify readiness result: **${readiness.disposition}**.`,
        reasons ? `\n${reasons}` : "",
        questions ? `\nRequired clarification:\n${questions}` : "",
        "\nNo model call or application branch was created.",
      ].join("\n"));
      return this.output({ status: readiness.disposition, state: this.state.current_state });
    }
    return this.createPlan(specification, readiness.risk_category, `${parsed.event_id}:plan`);
  }

  resumeExistingTask(parsed) {
    if (!this.state.event_ids.includes(parsed.event_id)) {
      this.mutationState("mutate", {
        state: this.state,
        mutation: {
          expected_revision: this.state.revision,
          event_id: parsed.event_id,
          actor: parsed.actor.login,
          reason: "record repeated authorized queue delivery",
          now: nowIso(),
        },
      });
    }
    if (this.state.current_state === "recovering" && this.state.recovery?.target_state === "ready") {
      this.recoverPendingExternal();
    }
    if (["new", "needs-information", "ready"].includes(this.state.current_state) && this.state.plan_digest === null) {
      return this.runReadinessAndPlan(parsed);
    }
    if (["approved", "implementing", "validating", "reviewing", "fixing", "recovering"].includes(this.state.current_state)) {
      if (!this.state.plan_digest) fail("active task recovery has no bound plan digest");
      this.loadPlanFromState();
      return this.execute();
    }
    this.commentState("Agentify already owns this issue");
    return this.output({ status: "existing", state: this.state.current_state });
  }

  queue(parsed) {
    const existing = this.readState();
    if (existing) return this.resumeExistingTask(parsed);
    const base = this.currentBase();
    this.state = this.requireRuntime("initialize", {
      repository: { repository_id: this.repositoryId, full_name: this.repository, default_branch: this.defaultBranch() },
      issue_number: this.issue.number,
      expected_base_commit: base,
      policy: this.policy,
      event_id: parsed.event_id,
      actor: parsed.actor.login,
      now: nowIso(),
    });
    this.writeState(this.state);
    return this.runReadinessAndPlan(parsed);
  }

  consultPlanner(draftPlan) {
    const key = this.plannerKey(draftPlan);
    const callId = this.modelCallId("planner", "planner");
    let result = this.readRecord("planner", key);
    if (result) {
      if (this.state.active_model_call?.call_id === callId) {
        this.reconcileModel(callId, { turns: 0, cost_usd: null, runtime_ms: 0, aborted: false });
      } else if (this.state.active_model_call) {
        fail(`another model call ${this.state.active_model_call.call_id} is unresolved`);
      }
      return result;
    }
    if (this.state.active_model_call) {
      fail(`planner model call ${this.state.active_model_call.call_id} has no durable typed result; retry is unsafe`);
    }
    const request = this.requireRuntime("build-planner-request", { draft_plan: draftPlan });
    this.reserveModel("planner", "planner", callId);
    const model = this.modelConfig();
    const runResult = this.runtime("run-planner-model", {
      cwd: this.root,
      draft_plan: draftPlan,
      request,
      model,
    }, { model: true, allowFailure: true, timeout: this.policy.maximum_runtime_ms });
    if (!runResult.ok) {
      fail(`planner failed with an unresolved model-call reservation: ${runResult.error}`);
    }
    result = runResult.value.result;
    this.writeRecord("planner", key, result);
    this.reconcileModel(callId, runResult.value.usage, runResult.value.usage?.aborted === true);
    if (this.state.current_state === "budget-exhausted") fail("planner consultation exhausted the configured task budget or deadline");
    return result;
  }

  consultSpecialists(planning) {
    const consultations = [];
    for (const selection of this.plan.selected_specialists) {
      const specialistId = selection.specialist_id;
      const key = this.specialistKey(this.plan, specialistId);
      const deterministic = planning.consultations.find((item) => item.specialist_id === specialistId);
      if (!deterministic) fail(`deterministic specialist findings are missing for ${specialistId}`);
      const callId = this.modelCallId("specialist", `specialist-${specialistId}`);
      let result = this.readRecord("specialist", key);
      if (result) {
        if (this.state.active_model_call?.call_id === callId) {
          this.reconcileModel(callId, { turns: 0, cost_usd: null, runtime_ms: 0, aborted: false });
        } else if (this.state.active_model_call) {
          fail(`another model call ${this.state.active_model_call.call_id} is unresolved`);
        }
        consultations.push(result);
        continue;
      }
      if (this.state.active_model_call) {
        fail(`specialist model call ${this.state.active_model_call.call_id} has no durable typed result; retry is unsafe`);
      }
      const request = this.requireRuntime("build-specialist-request", {
        cwd: this.root,
        plan: this.plan,
        specialist_id: specialistId,
      });
      this.reserveModel("specialist", `specialist:${specialistId}`, callId);
      const model = this.modelConfig();
      const runResult = this.runtime("run-specialist-model", {
        cwd: this.root,
        plan: this.plan,
        request,
        deterministic_findings: deterministic,
        model,
      }, { model: true, allowFailure: true, timeout: this.policy.maximum_runtime_ms });
      if (!runResult.ok) {
        fail(`specialist ${specialistId} failed with an unresolved model-call reservation: ${runResult.error}`);
      }
      result = runResult.value.result;
      this.writeRecord("specialist", key, result);
      this.reconcileModel(callId, runResult.value.usage, runResult.value.usage?.aborted === true);
      if (this.state.current_state === "budget-exhausted") fail("specialist consultation exhausted the configured task budget or deadline");
      consultations.push(result);
    }
    return consultations;
  }

  createPlan(specification, risk, eventId) {
    const steps = specification.implementation_steps.map((step) => ({
      ...step,
      validation_command_ids: this.policy.validation_commands.filter((command) => command.required).map((command) => command.command_id),
    }));
    const basePlanningInput = {
      cwd: this.root,
      task_id: this.state.task_id,
      repository: this.state.repository,
      issue_number: this.issue.number,
      expected_base_commit: this.state.expected_base_commit,
      task_summary: specification.task_summary,
      acceptance_criteria: specification.acceptance_criteria,
      candidate_paths: specification.candidate_paths,
      excluded_paths: specification.excluded_paths,
      risk_category: risk,
      policy: this.policy,
      now: this.state.budget.started_at,
      prior_successful_specialist_ids: [],
    };
    // Pass 1: a deterministic draft plan, used only to give the planner a
    // reproducible digest to key its model call against (see consultPlanner).
    const draftPlanning = this.requireRuntime("plan-repository", { ...basePlanningInput, implementation_steps: steps });
    this.plan = draftPlanning.plan;
    const plannerResult = this.consultPlanner(draftPlanning.plan);
    // Pass 2: the final deterministic plan, recomputed with the planner's
    // refined steps. This is the only plan that ever gets recorded.
    const planning = this.requireRuntime("plan-repository", { ...basePlanningInput, implementation_steps: plannerResult.implementation_steps });
    this.plan = planning.plan;
    this.writeRecord("plan", this.planKey(this.plan), this.plan);
    this.specialists = this.consultSpecialists(planning);
    const recoveryPrefix = `${this.state.task_id}:plan:${this.plan.plan_digest}`;
    this.beginExternalRecovery("ready", "plan-recorded", recoveryPrefix);
    this.recordExternalMutation(
      "plan-recorded",
      this.resource("artifact", this.planKey(this.plan), { specialist_ids: this.specialists.map((item) => item.specialist_id) }),
      recoveryPrefix,
    );
    this.completeExternalRecovery(recoveryPrefix);
    this.mutationState("record-plan", {
      state: this.state,
      plan: this.plan,
      policy: this.policy,
      expected_revision: this.state.revision,
      event_id: eventId,
      actor: "orchestrator",
      now: nowIso(),
    });
    const specialists = this.plan.selected_specialists.map((item) => `\`${item.specialist_id}\``).join(", ") || "none";
    const procedures = this.plan.selected_procedures.map((item) => `\`${item.procedure_id}\``).join(", ") || "none";
    this.comment([
      "## Agentify implementation plan",
      `- Task: ${this.plan.task_summary}`,
      `- Plan digest: \`${this.plan.plan_digest}\``,
      `- Expected base: \`${this.plan.expected_base_commit}\``,
      `- Risk: **${this.plan.risk_category}**`,
      `- Specialists: ${specialists}`,
      `- Procedures: ${procedures}`,
      `- Validation: ${this.plan.validation_commands.map((item) => `\`${item.command_id}\``).join(", ")}`,
      "",
      this.plan.approval_required
        ? "An authorized maintainer must post `/agent approve` before one builder receives write authority."
        : "Repository policy approved this plan automatically; implementation will begin.",
    ].join("\n"));
    if (this.state.current_state === "approved") return this.execute();
    return this.output({ status: "awaiting-approval", state: this.state.current_state, plan_digest: this.plan.plan_digest });
  }

  approve(parsed) {
    this.readState();
    if (!this.state) fail("no Agentify task state exists for approval");
    if (this.state.event_ids.includes(parsed.event_id)) return this.output({ status: "duplicate", state: this.state.current_state });
    this.loadPlanFromState();
    this.mutationState("approve", {
      state: this.state,
      policy: this.policy,
      expected_revision: this.state.revision,
      event_id: parsed.event_id,
      approver: parsed.actor.login,
      now: nowIso(),
    });
    this.comment(`Agentify recorded approval by \`${parsed.actor.login}\` for plan \`${this.plan.plan_digest}\` and base \`${this.state.expected_base_commit}\`. Implementation remains draft-only and human-merge-only.`);
    return this.execute();
  }

  stop(parsed) {
    this.readState();
    if (!this.state) return this.output({ status: "ignored", reason: "no task state" });
    if (this.state.event_ids.includes(parsed.event_id)) return this.output({ status: "duplicate", state: this.state.current_state });
    this.mutationState("stop", {
      state: this.state,
      expected_revision: this.state.revision,
      event_id: parsed.event_id,
      actor: parsed.actor.login,
      now: nowIso(),
    });
    this.commentState("Agentify stopped this task");
    return this.output({ status: "stopped", state: this.state.current_state });
  }

  explain() {
    this.readState();
    if (!this.state) {
      this.comment("Agentify has no durable task state for this issue. Queue it with the managed queue label before requesting an explanation.");
      return this.output({ status: "absent" });
    }
    this.commentState();
    return this.output({ status: "explained", state: this.state.current_state });
  }

  replan(parsed) {
    this.readState();
    if (!this.state) fail("no Agentify task state exists to replan");
    if (this.state.active_model_call) {
      this.comment("Agentify refused to replan because an unresolved model-call reservation exists. Human inspection is required to avoid duplicate charges.");
      return this.output({ status: "blocked", reason: "active model call reservation" });
    }
    if (this.state.active_branch || this.state.draft_pr || ["implementing", "validating", "reviewing", "fixing", "draft-pr-open"].includes(this.state.current_state)) {
      this.comment("Agentify refused to replan an active implementation resource. Stop the task and resolve or remove the owned branch or draft pull request before replanning.");
      return this.output({ status: "blocked", reason: "active implementation resource" });
    }
    const base = this.currentBase();
    this.mutationState("replan", {
      state: this.state,
      new_base_commit: base,
      expected_revision: this.state.revision,
      event_id: parsed.event_id,
      actor: parsed.actor.login,
      now: nowIso(),
    });
    const specification = this.requireRuntime("parse-issue", { title: this.issue.title ?? "", body: this.issue.body ?? "" });
    return this.createPlan(specification, riskCategory(`${this.issue.title}\n${this.issue.body}`, specification.candidate_paths), `${parsed.event_id}:new-plan`);
  }

  retry(parsed) {
    this.readState();
    if (!this.state) fail("no Agentify task state exists to retry");
    if (this.state.event_ids.includes(parsed.event_id)) return this.output({ status: "duplicate", state: this.state.current_state });
    if (this.state.active_model_call) {
      if (["planner", "specialist"].includes(this.state.active_model_call.role) && this.state.current_state === "ready") {
        const specification = this.requireRuntime("parse-issue", { title: this.issue.title ?? "", body: this.issue.body ?? "" });
        return this.createPlan(
          specification,
          riskCategory(`${this.issue.title}\n${this.issue.body}`, specification.candidate_paths),
          `${parsed.event_id}:recover-specialist-plan`,
        );
      }
      if (["builder", "reviewer"].includes(this.state.active_model_call.role) && this.state.plan_digest) {
        this.loadPlanFromState();
        return this.execute();
      }
      this.comment("Agentify failed closed because a prior model call has an unresolved reservation without matching durable typed evidence. Retrying could create a duplicate charge; human inspection is required.");
      return this.output({ status: "blocked", reason: "unresolved model call without durable evidence" });
    }
    if (this.state.current_state === "stale-base" || this.state.current_state === "budget-exhausted") {
      this.comment("This task cannot be retried in place. Use `/agent replan` after refreshing the base or budget policy.");
      return this.output({ status: "blocked", state: this.state.current_state });
    }
    if (this.state.current_state === "draft-pr-open" || this.state.current_state === "completed") return this.explain();
    if (["blocked", "failed", "stopped", "refused", "needs-information"].includes(this.state.current_state)) {
      const base = this.currentBase();
      this.mutationState("replan", {
        state: this.state,
        new_base_commit: base,
        expected_revision: this.state.revision,
        event_id: parsed.event_id,
        actor: parsed.actor.login,
        now: nowIso(),
      });
      const specification = this.requireRuntime("parse-issue", { title: this.issue.title ?? "", body: this.issue.body ?? "" });
      return this.createPlan(specification, riskCategory(`${this.issue.title}\n${this.issue.body}`, specification.candidate_paths), `${parsed.event_id}:retry-plan`);
    }
    this.loadPlanFromState();
    return this.execute();
  }

  modelConfig() {
    const key = process.env.PI_API_KEY;
    const provider = process.env.PI_PROVIDER ?? "anthropic";
    const model = process.env.PI_MODEL ?? "";
    if (!key || !model) fail("PI_API_KEY and PI_MODEL are required for the approved builder/reviewer phase");
    const keyFile = path.join(this.temp, `provider-key-${crypto.randomUUID()}`);
    writeText(keyFile, `${key}\n`);
    return {
      provider,
      model,
      thinking_level: process.env.PI_THINKING ?? "high",
      config_dir: path.join(this.temp, "model-runtime"),
      cwd: this.root,
      api_key_file: keyFile,
      timeout_ms: Math.min(600_000, Math.max(1, Number(this.policyConfig.model_timeout_ms ?? 600_000))),
      inactivity_timeout_ms: Math.min(300_000, Math.max(1, Number(this.policyConfig.model_inactivity_timeout_ms ?? 120_000))),
    };
  }

  reservationAmount() {
    const used = this.state.budget.measured_cost_usd + this.state.budget.estimated_cost_usd;
    const remaining = Math.max(0, this.state.budget.maximum_cost_usd - used);
    const configured = Number(this.policyConfig.model_call_reservation_usd ?? this.policy.maximum_cost_usd / this.policy.maximum_model_calls);
    const amount = Math.min(remaining, configured);
    if (!Number.isFinite(amount) || amount <= 0) fail("no bounded model-call budget remains");
    return Number(amount.toFixed(6));
  }

  reserveModel(role, phase, callId) {
    this.mutationState("reserve-model", {
      state: this.state,
      expected_revision: this.state.revision,
      event_id: `${callId}:reserve`,
      actor: "trusted-runtime",
      call_id: callId,
      role,
      phase,
      reservation_cost_usd: this.reservationAmount(),
      now: nowIso(),
    });
  }

  reconcileModel(callId, usage, aborted = false) {
    const normalized = {
      turns: Number.isSafeInteger(usage?.turns) && usage.turns >= 0 ? usage.turns : 0,
      cost_usd: typeof usage?.cost_usd === "number" && Number.isFinite(usage.cost_usd) && usage.cost_usd >= 0 ? usage.cost_usd : null,
      runtime_ms: Number.isSafeInteger(usage?.runtime_ms) && usage.runtime_ms >= 0 ? usage.runtime_ms : 0,
      aborted: aborted || usage?.aborted === true,
    };
    this.mutationState("reconcile-model", {
      state: this.state,
      expected_revision: this.state.revision,
      event_id: `${callId}:reconcile`,
      actor: "trusted-runtime",
      call_id: callId,
      usage: normalized,
      now: nowIso(),
    });
  }

  statusPaths() {
    const changed = parseNameStatusPaths(run("git", ["-C", this.root, "diff", "--name-status", "-z", "--find-renames", "--find-copies", "--find-copies-harder", "HEAD", "--"]).stdout);
    const untracked = parseNul(run("git", ["-C", this.root, "ls-files", "--others", "--exclude-standard", "-z"]).stdout);
    return [...new Set([...changed, ...untracked].map(normalizeRepoPath))].sort();
  }

  commitBuilderChanges(request) {
    const targetState = this.state.current_state;
    if (!["implementing", "fixing"].includes(targetState)) fail("builder commit is outside the writable lifecycle phase");
    const mutation = targetState === "fixing" ? "fix-committed" : "builder-commit";
    const eventPrefix = `${this.state.task_id}:builder-commit:${this.state.fix_cycle_count}`;
    this.beginExternalRecovery(targetState, mutation, eventPrefix);
    const files = this.statusPaths();
    if (files.length === 0) fail("builder returned without an application change");
    for (const file of files) {
      if (!request.allowed_paths.some((scope) => pathInside(file, scope))) fail(`builder changed out-of-scope path ${file}`);
      if (request.protected_paths.some((scope) => pathInside(file, scope))) fail(`builder changed protected path ${file}`);
      if (file === ".agentify-runtime" || file.startsWith(".agentify-runtime/")) fail("builder changed the trusted runtime checkout");
    }
    run("git", ["-C", this.root, "add", "-A", "--", ...request.allowed_paths]);
    const remainder = this.statusPaths();
    if (remainder.some((file) => !request.allowed_paths.some((scope) => pathInside(file, scope)))) {
      fail("unstaged or untracked changes remain outside the approved builder scope");
    }
    if (gitAllowFailure(this.root, "diff", "--quiet").status !== 0) {
      fail("trusted staging left unstaged builder mutations");
    }
    if (parseNul(run("git", ["-C", this.root, "ls-files", "--others", "--exclude-standard", "-z"]).stdout).length > 0) {
      fail("trusted staging left untracked builder files");
    }
    const staged = parseNul(run("git", ["-C", this.root, "diff", "--cached", "--name-only", "-z"]).stdout);
    if (staged.length === 0) fail("trusted builder commit has no staged change");
    run("git", ["-C", this.root, "config", "user.name", "agentify-builder[bot]"]);
    run("git", ["-C", this.root, "config", "user.email", "agentify-builder[bot]@users.noreply.github.com"]);
    const message = [
      `agentify: implement issue #${this.issue.number}`,
      "",
      `Agentify-Task-ID: ${this.state.task_id}`,
      `Agentify-Issue: ${this.issue.number}`,
      `Agentify-Expected-Base: ${this.state.expected_base_commit}`,
      `Agentify-Plan-Digest: ${this.plan.plan_digest}`,
      "Agentify-Builder: builder",
      `Agentify-Fix-Cycle: ${this.state.fix_cycle_count}`,
    ].join("\n");
    const messageFile = path.join(this.temp, `commit-message-${this.state.fix_cycle_count}.txt`);
    writeText(messageFile, `${message}\n`);
    run("git", ["-C", this.root, "commit", "-F", messageFile]);
    const commit = git(this.root, "rev-parse", "HEAD");
    run("git", ["-C", this.root, "push", "origin", this.state.active_branch]);
    this.recordExternalMutation(
      mutation,
      this.resource("commit", commit, { branch: this.state.active_branch, fix_cycle: this.state.fix_cycle_count }),
      eventPrefix,
    );
    this.recordExternalMutation(
      "branch-pushed",
      this.resource("branch", this.state.active_branch, { head: commit }),
      eventPrefix,
    );
    this.completeExternalRecovery(eventPrefix);
    return commit;
  }

  runBuilder(reviewerFindings = []) {
    const request = this.requireRuntime("build-builder-request", {
      cwd: this.root,
      state: this.state,
      plan: this.plan,
      specialist_findings: this.specialists,
      policy: this.policy,
      reviewer_findings: reviewerFindings,
    });
    const fixCycle = this.state.fix_cycle_count;
    const callId = this.modelCallId("builder", `fix-${fixCycle}`);
    const callKey = this.builderCallKey(fixCycle);
    const builderKey = this.builderCycleKey(fixCycle);
    let callEvidence = this.readRecord("builder-call", callKey);
    const recoveredCallEvidence = callEvidence !== null;
    let submission;
    if (callEvidence) {
      if (callEvidence.call_id !== callId || callEvidence.fix_cycle !== fixCycle) {
        fail("durable builder call evidence does not match the active fix cycle");
      }
      submission = callEvidence.submission;
      if (this.state.active_model_call?.call_id === callId) {
        this.reconcileModel(callId, submission, submission.aborted === true);
      } else if (this.state.active_model_call) {
        fail(`another model call ${this.state.active_model_call.call_id} is unresolved`);
      }
    } else {
      if (this.state.active_model_call) {
        fail(`builder model call ${this.state.active_model_call.call_id} has no durable typed result; retry is unsafe`);
      }
      const model = this.modelConfig();
      this.reserveModel("builder", `fix-${fixCycle}`, callId);
      const startedAt = this.state.active_model_call?.started_at ?? nowIso();
      const result = this.runtime("run-builder-model", { request, model }, { model: true, allowFailure: true, timeout: this.policy.maximum_runtime_ms });
      if (!result.ok) {
        fail(`builder model failed with an unresolved model-call reservation: ${result.error}`);
      }
      submission = result.value;
      const completedAt = nowIso();
      callEvidence = {
        schema_version: "1",
        task_id: this.state.task_id,
        call_id: callId,
        fix_cycle: fixCycle,
        builder_agent_id: "builder",
        started_at: startedAt,
        completed_at: completedAt,
        submission,
        evidence_digest: "",
      };
      callEvidence.evidence_digest = digest({ ...callEvidence, evidence_digest: undefined });
      this.requireRuntime("validate-builder-call", callEvidence);
      this.writeRecord("builder-call", callKey, callEvidence);
      this.reconcileModel(callId, submission, submission.aborted === true);
    }
    if (this.state.current_state === "budget-exhausted") fail("builder exhausted the configured budget or deadline");

    let builder = this.readRecord("builder", builderKey);
    if (!builder) {
      const currentHead = git(this.root, "rev-parse", "HEAD");
      const changedPaths = this.statusPaths();
      if (changedPaths.length > 0) {
        this.commitBuilderChanges(request);
      } else {
        const trailers = this.commitTrailers(currentHead);
        if (trailers.get("Agentify-Branch-Reservation") === "true") {
          if (recoveredCallEvidence) {
            fail("builder output was recorded but no durable source commit exists; retry is blocked to avoid a duplicate model charge");
          }
          fail("builder returned without an application change");
        }
        this.assertBuilderCommitOwnership(currentHead, fixCycle);
      }
      const completedAt = nowIso();
      builder = this.requireRuntime("observe-builder", {
        cwd: this.root,
        request,
        submission,
        builder_agent_id: "builder",
        started_at: callEvidence.started_at,
        completed_at: completedAt,
      });
      this.writeRecord("builder", builderKey, builder);
      this.writeRecord("builder", `${this.state.task_id}:${digest(builder)}`, builder);
    }
    this.writeRecord("builder", `${this.state.task_id}:${digest(builder)}`, builder);
    const assessment = this.requireRuntime("assess-builder", { request, result: builder, policy: this.policy, now: nowIso() });
    this.builder = builder;
    this.mutationState("record-builder", {
      state: this.state,
      builder,
      assessment,
      expected_revision: this.state.revision,
      event_id: `${callId}:builder-record`,
      actor: "trusted-runtime",
      now: nowIso(),
    });
    if (!assessment.passed) fail(assessment.reasons.join(" "));
    return builder;
  }

  runValidation() {
    if (!validationApprovalCurrent(this.root, this.policyConfig)) {
      fail("validation_policy_stale: approved package manifest, lockfile, or command set changed before validation");
    }
    const validationPlan = this.requireRuntime("build-validation-plan", {
      state: this.state,
      plan: this.plan,
      builder: this.builder,
      policy: this.policy,
    });
    const key = this.validationCycleKey(this.builder.final_commit);
    let result = this.readRecord("validation", key);
    if (!result) {
      result = this.requireRuntime("run-validation", {
        cwd: this.root,
        plan: validationPlan,
        max_output_bytes: 64 * 1024,
      }, { timeout: this.policy.maximum_runtime_ms });
      const recoveryPrefix = `${this.state.task_id}:validation:${result.final_commit}`;
      this.beginExternalRecovery("validating", "validation-completed", recoveryPrefix);
      this.writeRecord("validation", key, result);
      this.writeRecord("validation", `${this.state.task_id}:${digest(result)}`, result);
      this.recordExternalMutation(
        "validation-completed",
        this.resource("artifact", key, { final_commit: result.final_commit, result_digest: digest(result) }),
        recoveryPrefix,
      );
      this.completeExternalRecovery(recoveryPrefix);
    }
    this.writeRecord("validation", `${this.state.task_id}:${digest(result)}`, result);
    const assessment = this.requireRuntime("assess-validation", { plan: validationPlan, result, now: nowIso() });
    this.validation = result;
    this.mutationState("record-validation", {
      state: this.state,
      validation: result,
      assessment,
      expected_revision: this.state.revision,
      event_id: `${this.state.task_id}:validation-state:${result.final_commit}`,
      actor: "trusted-validator",
      now: nowIso(),
    });
    if (!assessment.passed) fail(assessment.reasons.join(" "));
    return result;
  }

  runReview() {
    const fixCycle = this.state.fix_cycle_count;
    const reviewedCommit = this.validation.final_commit;
    const callId = this.modelCallId("reviewer", `review-${fixCycle}-${reviewedCommit}`);
    const key = this.reviewCycleKey();
    let reviewer = this.readRecord("review", key);
    if (reviewer) {
      if (this.state.active_model_call?.call_id === callId) {
        this.reconcileModel(callId, { turns: 0, cost_usd: null, runtime_ms: 0, aborted: false });
      } else if (this.state.active_model_call) {
        fail(`another model call ${this.state.active_model_call.call_id} is unresolved`);
      }
    } else {
      if (this.state.active_model_call) {
        fail(`reviewer model call ${this.state.active_model_call.call_id} has no durable typed verdict; retry is unsafe`);
      }
      const model = this.modelConfig();
      this.reserveModel("reviewer", `review-${fixCycle}`, callId);
      const reviewedAt = nowIso();
      const result = this.runtime("run-reviewer-model", {
        plan: this.plan,
        builder: this.builder,
        validation: this.validation,
        specialist_findings: this.specialists,
        relevant_memory: this.plan.memory_excerpts.map((entry) => `${entry.context_role}: ${entry.statement} ${entry.relevant_payload}`),
        reviewer_agent_id: String(this.policyConfig.reviewer_agent_id ?? "reviewer"),
        reviewed_at: reviewedAt,
        model,
      }, { model: true, allowFailure: true, timeout: this.policy.maximum_runtime_ms });
      if (!result.ok) {
        fail(`reviewer model failed with an unresolved model-call reservation: ${result.error}`);
      }
      reviewer = result.value.result;
      const recoveryPrefix = `${this.state.task_id}:review:${fixCycle}:${reviewedCommit}`;
      this.beginExternalRecovery("reviewing", "review-completed", recoveryPrefix);
      this.writeRecord("review", key, reviewer);
      this.writeRecord("review", `${this.state.task_id}:${reviewer.verdict_digest}`, reviewer);
      this.recordExternalMutation(
        "review-completed",
        this.resource("artifact", key, { reviewed_commit: reviewedCommit, verdict_digest: reviewer.verdict_digest }),
        recoveryPrefix,
      );
      this.completeExternalRecovery(recoveryPrefix);
      this.reconcileModel(callId, result.value.usage, result.value.usage?.aborted === true);
    }
    if (this.state.current_state === "budget-exhausted") fail("reviewer exhausted the configured budget or deadline");
    this.writeRecord("review", `${this.state.task_id}:${reviewer.verdict_digest}`, reviewer);
    const assessment = this.requireRuntime("assess-review", { reviewer, builder: this.builder, validation: this.validation });
    this.review = reviewer;
    this.mutationState("record-review", {
      state: this.state,
      reviewer,
      assessment,
      expected_revision: this.state.revision,
      event_id: `${callId}:review-record`,
      actor: reviewer.reviewer_agent_id,
      now: nowIso(),
    });
    if (!assessment.passed) fail(assessment.reasons.join(" "));
    return reviewer;
  }

  restoreEvidence() {
    if (this.state.builder_result_digest) {
      this.builder = this.readRecord("builder", this.builderCycleKey())
        ?? this.readRecord("builder", this.builderKey(this.state));
    }
    if (this.state.validation_result_digest && this.builder) {
      this.validation = this.readRecord("validation", this.validationCycleKey(this.builder.final_commit))
        ?? this.readRecord("validation", this.validationKey(this.state));
    }
    if (this.state.reviewer_verdict_digest && this.validation) {
      this.review = this.readRecord("review", this.reviewCycleKey())
        ?? this.readRecord("review", this.reviewKey(this.state));
    }
  }

  ensureOwnedBranch() {
    const remote = this.remoteBranchSha(this.state.active_branch);
    if (this.state.current_state !== "recovering" && remote !== null) {
      return this.checkoutOwnedBranch(
        this.state.active_branch,
        this.state.expected_base_commit,
        this.state.task_id,
      );
    }
    const targetState = this.state.current_state === "recovering"
      ? this.state.recovery?.target_state
      : this.state.current_state;
    if (!targetState || !["implementing", "fixing", "validating", "reviewing"].includes(targetState)) {
      fail("owned branch creation is not valid in the current lifecycle state");
    }
    const eventPrefix = this.state.recovery?.recovery_id ?? `${this.state.task_id}:branch:${this.state.active_branch}`;
    this.beginExternalRecovery(targetState, "branch-created", eventPrefix);
    const branch = this.checkoutOwnedBranch(
      this.state.active_branch,
      this.state.expected_base_commit,
      this.state.task_id,
    );
    this.recordExternalMutation(
      "branch-created",
      this.resource("branch", this.state.active_branch, { head: branch.head }),
      eventPrefix,
    );
    this.recordExternalMutation(
      "branch-pushed",
      this.resource("commit", branch.head, { branch: this.state.active_branch }),
      eventPrefix,
    );
    this.completeExternalRecovery(eventPrefix);
    return branch;
  }

  recoverPendingExternal() {
    if (this.state.current_state !== "recovering" || !this.state.recovery) return;
    const recovery = this.state.recovery;
    const checkpoint = recovery.checkpoint;
    const eventPrefix = recovery.recovery_id;
    if (checkpoint === "branch-created" || (
      checkpoint === "branch-pushed"
      && !recovery.completed_mutations.includes("builder-commit")
      && !recovery.completed_mutations.includes("fix-committed")
    )) {
      this.ensureOwnedBranch();
      return;
    }
    if (checkpoint === "builder-commit" || checkpoint === "fix-committed" || checkpoint === "branch-pushed") {
      const remote = this.remoteBranchSha(this.state.active_branch);
      if (!remote) fail("interrupted builder mutation has no recoverable owned branch");
      this.checkoutOwnedBranch(this.state.active_branch, this.state.expected_base_commit, this.state.task_id);
      this.assertBuilderCommitOwnership(remote, this.state.fix_cycle_count);
      const mutation = recovery.target_state === "fixing" ? "fix-committed" : "builder-commit";
      this.recordExternalMutation(
        mutation,
        this.resource("commit", remote, { branch: this.state.active_branch, fix_cycle: this.state.fix_cycle_count }),
        eventPrefix,
      );
      this.recordExternalMutation(
        "branch-pushed",
        this.resource("branch", this.state.active_branch, { head: remote }),
        eventPrefix,
      );
      this.completeExternalRecovery(eventPrefix);
      return;
    }
    if (["plan-recorded", "validation-completed", "review-completed", "draft-pr-created", "projection-updated", "approval-recorded", "state-created"].includes(checkpoint)) {
      this.completeExternalRecovery(eventPrefix);
      return;
    }
    fail(`unsupported recovery checkpoint ${String(checkpoint)}`);
  }

  execute() {
    if (!this.plan) this.loadPlanFromState();
    this.recoverPendingExternal();
    const base = this.currentBaseRemote();
    const branch = this.state.active_branch ?? this.requireRuntime("branch-name", {
      issue_number: this.issue.number,
      issue_title: this.issue.title ?? "task",
    }).branch;
    const remote = this.remoteBranchSha(branch);
    const conflictPr = this.issuePullRequestConflict(branch, this.state.task_id, this.plan.plan_digest);
    if (this.state.current_state === "approved") {
      this.mutationState("begin-implementation", {
        state: this.state,
        issue_title: this.issue.title ?? "task",
        current_base_commit: base,
        conflicting_branch: remote !== null,
        conflicting_pull_request: conflictPr,
        expected_revision: this.state.revision,
        event_id: `${this.state.task_id}:begin:${this.runId}:${this.runAttempt}`,
        actor: "trusted-runtime",
        now: nowIso(),
      });
      if (this.state.current_state !== "implementing") {
        this.commentState("Agentify stopped before source mutation");
        return this.output({ status: this.state.current_state, state: this.state.current_state });
      }
    }
    if (["implementing", "fixing", "validating", "reviewing"].includes(this.state.current_state)) {
      this.ensureOwnedBranch();
    }
    this.restoreEvidence();

    let reviewerFindings = this.review?.verdict === "changes_requested" ? this.review.findings : [];
    while (true) {
      if (this.state.current_state === "implementing" || this.state.current_state === "fixing") {
        this.runBuilder(reviewerFindings);
      }
      if (this.state.current_state === "validating") {
        if (!this.builder) this.restoreEvidence();
        this.runValidation();
      }
      if (this.state.current_state === "reviewing") {
        if (!this.builder || !this.validation) this.restoreEvidence();
        if (!(this.review?.verdict === "approved" && this.review.reviewed_commit === this.validation.final_commit)) {
          this.runReview();
        }
      }
      if (this.state.current_state === "fixing") {
        reviewerFindings = this.review?.findings ?? [];
        this.builder = null;
        this.validation = null;
        continue;
      }
      break;
    }

    if (this.state.current_state !== "reviewing" || this.review?.verdict !== "approved") {
      this.commentState("Agentify stopped without publishing");
      return this.output({ status: this.state.current_state, state: this.state.current_state });
    }
    return this.publish();
  }

  publish() {
    const snapshot = this.requireRuntime("snapshot", { cwd: this.root });
    const evidenceRef = `agentify-task-evidence-${this.state.task_id}-${this.validation.final_commit.slice(0, 16)}`;
    const existingConflict = this.issuePullRequestConflict(this.state.active_branch, this.state.task_id, this.plan.plan_digest);
    const publication = this.requireRuntime("publication", {
      state: this.state,
      plan: this.plan,
      validation: this.validation,
      reviewer: this.review,
      branch_owned: true,
      current_base_commit: this.currentBaseRemote(),
      current_head_commit: snapshot.head,
      current_tree_digest: snapshot.tree_digest,
      conflicting_pull_request: existingConflict,
      approval_now: nowIso(),
      accepted_task_evidence_ref: evidenceRef,
    });
    if (!publication.allowed) {
      fail(`draft publication was refused: ${publication.reasons.join(" ")}`);
    }
    const publishInput = {
      repo_root: this.root,
      repository: this.repository,
      task_id: this.state.task_id,
      issue_number: this.issue.number,
      expected_base_commit: this.state.expected_base_commit,
      expected_head_commit: this.validation.final_commit,
      plan_digest: this.plan.plan_digest,
      branch: this.state.active_branch,
      base_branch: this.defaultBranch(),
      allowed_paths: this.plan.in_scope_paths,
      protected_paths: [...this.plan.excluded_paths, ...this.policy.protected_paths],
      title: publication.title,
      body: publication.body,
    };
    const inputFile = path.join(this.temp, "publication.json");
    const outputFile = path.join(this.temp, "publication-result.json");
    writeJson(inputFile, publishInput);
    const recoveryPrefix = `${this.state.task_id}:publication:${this.validation.final_commit}:${this.runId}`;
    this.beginExternalRecovery("reviewing", "draft-pr-created", recoveryPrefix);
    run(process.execPath, [this.publisher, inputFile, outputFile], {
      cwd: this.root,
      env: trustedPublicationEnvironment(),
    });
    const pr = readBoundedJson(outputFile, "publication result");
    this.recordExternalMutation(
      "draft-pr-created",
      this.resource("pull-request", String(pr.number), { url: pr.url, head_commit: pr.head_commit }),
      recoveryPrefix,
    );
    this.completeExternalRecovery(recoveryPrefix);
    const sourceUrl = `https://github.com/${this.repository}/actions/runs/${this.runId}`;
    let acceptedEvidence = this.readRecord("accepted-evidence", evidenceRef);
    if (!acceptedEvidence) {
      acceptedEvidence = this.requireRuntime("accepted-evidence", {
        state: this.state,
        plan: this.plan,
        builder: this.builder,
        validation: this.validation,
        reviewer: this.review,
        pull_request_number: pr.number,
        source_artifact_url: sourceUrl,
      });
      this.writeRecord("accepted-evidence", evidenceRef, acceptedEvidence);
    }
    writeJson(path.join(this.outputDirectory, "accepted-task-evidence.json"), acceptedEvidence);
    writeJson(path.join(this.outputDirectory, "plan.json"), this.plan);
    writeJson(path.join(this.outputDirectory, "validation.json"), this.validation);
    writeJson(path.join(this.outputDirectory, "review.json"), this.review);
    this.mutationState("record-publication", {
      state: this.state,
      publication,
      pull_request: {
        number: pr.number,
        url: pr.url,
        head_branch: pr.head_branch,
        base_branch: pr.base_branch,
        head_commit: pr.head_commit,
        draft: true,
      },
      evidence_ref: evidenceRef,
      expected_revision: this.state.revision,
      event_id: `${this.state.task_id}:publication:${pr.number}`,
      actor: "trusted-publisher",
      now: nowIso(),
    });
    this.comment(`Agentify opened draft pull request #${pr.number}. Deterministic validation passed, the independent reviewer approved the stable commit, and human maintainers retain sole merge or rejection authority.`);
    return this.output({
      status: "draft-pr-open",
      state: this.state.current_state,
      pr_number: pr.number,
      pr_url: pr.url,
      head_commit: pr.head_commit,
      evidence_ref: evidenceRef,
    });
  }

  currentBaseRemote() {
    const result = api("GET", `repos/${this.repository}/git/ref/heads/${encodeURIComponent(this.defaultBranch())}`);
    const sha = String(result.value?.object?.sha ?? "");
    if (!SHA.test(sha)) fail("cannot resolve current default-branch commit");
    return sha;
  }

  run() {
    if (!this.loadEvent()) return;
    const trusted = this.trustedEvent();
    const parsed = this.requireRuntime("parse-event", trusted);
    if (parsed.disposition !== "accepted") {
      this.output({ status: parsed.disposition, reason: parsed.reason });
      return;
    }
    this.command = parsed.command;
    if (!this.loadPolicy()) return;
    switch (parsed.command) {
      case "queue": this.queue(parsed); return;
      case "approve": this.approve(parsed); return;
      case "stop": this.stop(parsed); return;
      case "retry": this.retry(parsed); return;
      case "replan": this.replan(parsed); return;
      case "explain": this.explain(parsed); return;
      default: fail("unsupported trusted issue command");
    }
  }
}

const controller = new Controller();
try {
  controller.run();
} catch (error) {
  const message = publicError(error);
  try {
    if (controller.issue) {
      if (!controller.state) controller.readState();
      controller.transitionBlocked(message, `${controller.runId}:${controller.runAttempt}:failure`);
      controller.comment(`Agentify stopped safely: ${message}\n\nNo merge, auto-merge, deployment, force-push, or default-branch application write was attempted.`);
    }
    controller.output({ status: "failed", state: controller.state?.current_state ?? null, reason: message });
  } catch {
    // The original failure remains authoritative. Avoid masking it with a failed status projection.
  }
  console.error(`agentify task lifecycle failed: ${message}`);
  process.exitCode = 1;
} finally {
  controller.cleanup();
}
