#!/usr/bin/env node

// Trusted default-branch controller for binding an Agentify-authored merged PR
// to its durable issue state and immutable accepted-task evidence.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const AGENTIFY_BRANCH = /^agentify\/issue-([1-9][0-9]*)-[a-z0-9][a-z0-9-]{0,63}$/;
const MARKER = /<!-- agentify:task task=([A-Za-z0-9._:/-]{1,256}) issue=([1-9][0-9]*) branch=([^\s]{1,256}) plan=([0-9a-f]{64}) -->/g;

function fail(message) { throw new Error(String(message).slice(0, 2_000)); }
function readJson(file, label) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size < 2 || stat.size > MAX_EVENT_BYTES) fail(`${label} is not one bounded JSON file`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
function runNode(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) fail(result.stderr || result.stdout || `${path.basename(script)} failed`);
}
function runtime(runtimePath, command, input, directory) {
  const inputPath = path.join(directory, `${command}-input.json`);
  const outputPath = path.join(directory, `${command}-output.json`);
  writeJson(inputPath, input);
  runNode(runtimePath, [command, inputPath, outputPath]);
  return readJson(outputPath, `${command} output`);
}

function main() {
  const [eventPath, mergeEventPath, evidencePath] = process.argv.slice(2);
  if (!eventPath || !mergeEventPath || !evidencePath) fail("usage: complete-accepted-task-merge.mjs EVENT MERGE_EVENT TASK_EVIDENCE");
  const event = readJson(path.resolve(eventPath), "GitHub event");
  const pr = event.pull_request;
  if (!pr || pr.merged !== true) fail("accepted-task completion requires a merged pull request event");
  const repository = String(event.repository?.full_name ?? process.env.GITHUB_REPOSITORY ?? "");
  const repositoryId = String(event.repository?.id ?? process.env.GITHUB_REPOSITORY_ID ?? "");
  const defaultBranch = String(event.repository?.default_branch ?? "");
  const headBranch = String(pr.head?.ref ?? "");
  const headCommit = String(pr.head?.sha ?? "");
  const mergeCommit = String(pr.merge_commit_sha ?? "");
  const prNumber = Number(pr.number);
  const baseEvent = readJson(path.resolve(mergeEventPath), "accepted merge event");
  const branchMatch = AGENTIFY_BRANCH.exec(headBranch);
  if (!branchMatch) {
    writeJson(path.resolve(mergeEventPath), { ...baseEvent, author_kind: "human", issue_number: null });
    return;
  }
  const body = String(pr.body ?? "");
  if (Buffer.byteLength(body, "utf8") > 64 * 1024) fail("Agentify pull-request body exceeds the trusted marker bound");
  const markers = [...body.matchAll(MARKER)];
  if (markers.length !== 1) fail("Agentify pull request must contain exactly one canonical task marker");
  const [, taskId, issueText, markerBranch, planDigest] = markers[0];
  const issue = Number(issueText);
  if (issue !== Number(branchMatch[1]) || markerBranch !== headBranch) fail("Agentify task marker issue or branch is forged");

  const runtimePath = path.resolve(".github/agentify/task-runtime.mjs");
  const stateScript = path.resolve(".github/scripts/task-state-github.mjs");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-accepted-merge-"));
  try {
    const stateOutput = path.join(directory, "state.json");
    runNode(stateScript, ["state-read", String(issue), stateOutput]);
    const stateEnvelope = readJson(stateOutput, "durable task state");
    const state = stateEnvelope?.state;
    if (!state || state.task_id !== taskId || state.issue_number !== issue || state.plan_digest !== planDigest) fail("durable task state does not match the task marker");
    if (state.repository?.repository_id !== repositoryId || state.repository?.full_name !== repository || state.repository?.default_branch !== defaultBranch) fail("durable task state repository identity does not match the merge");
    if (!state.draft_pr || state.draft_pr.number !== prNumber || state.draft_pr.head_branch !== headBranch || state.draft_pr.head_commit !== headCommit || state.final_commit !== headCommit) fail("durable task state does not identify the merged validated draft head");
    if (!state.accepted_task_evidence_ref) fail("durable task state has no accepted-task evidence reference");
    const recordOutput = path.join(directory, "evidence.json");
    runNode(stateScript, ["record-read", String(issue), "accepted-evidence", state.accepted_task_evidence_ref, recordOutput]);
    const record = readJson(recordOutput, "accepted-task evidence record");
    if (!record?.value) fail("accepted-task evidence record is missing");
    const evidence = runtime(runtimePath, "validate-accepted-evidence", record.value, directory);
    if (evidence.task_id !== taskId || evidence.issue_number !== issue || evidence.pull_request_number !== prNumber || evidence.plan_digest !== planDigest) fail("accepted-task evidence binding does not match the merged task");
    writeJson(path.resolve(evidencePath), evidence);

    const eventId = `merge-${prNumber}-${mergeCommit}`;
    const acceptedMerge = { repository_id: repositoryId, task_id: taskId, issue_number: issue, pull_request_number: prNumber, head_branch: headBranch, validated_head_commit: headCommit, merge_commit: mergeCommit, default_branch: defaultBranch, merge_actor: String(pr.merged_by?.login ?? "github-merge"), event_id: eventId, merged_at: new Date(pr.merged_at).toISOString() };
    if (state.current_state === "completed") {
      if (JSON.stringify(state.accepted_merge) !== JSON.stringify(acceptedMerge)) fail("completed task state is bound to a different accepted merge");
    } else {
      if (state.current_state !== "draft-pr-open") fail("accepted merge found stale task state");
      const mutation = runtime(runtimePath, "mutate", { state, mutation: { expected_revision: state.revision, expected_current_state: "draft-pr-open", transition_to: "completed", event_id: eventId, actor: acceptedMerge.merge_actor, reason: "human merged the validated Agentify draft pull request", now: acceptedMerge.merged_at, patch: { accepted_merge: acceptedMerge } } }, directory);
      const nextPath = path.join(directory, "completed-state.json");
      writeJson(nextPath, mutation.state);
      runNode(stateScript, ["state-write", String(issue), nextPath, path.join(directory, "state-write.json")]);
    }
    writeJson(path.resolve(mergeEventPath), { ...baseEvent, author_kind: "agentify", issue_number: issue });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

try { main(); } catch (error) {
  console.error(`agentify accepted-task merge failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
