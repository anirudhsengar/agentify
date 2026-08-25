#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import { registerBundledOAuthFlows } from "../register-bundled-oauth-flows.ts";

registerBundledOAuthFlows();
import type { MemoryCandidateDraft } from "../memory/schema.ts";
import type {
  AcceptedMergeEvent,
  AcceptedTaskEvidence,
  LearningContextRequest,
} from "./contracts.ts";
import { buildLearningContext } from "./context.ts";
import { processAcceptedMerge } from "./engine.ts";
import { reconcileAcceptedMerges } from "./reconciliation.ts";
import { verifyLearningSelfUpdateDiff } from "./self-update.ts";
import { adoptLearningProposal } from "./proposal.ts";
import {
  validateAcceptedMergeEvent,
  validateAcceptedTaskEvidence,
} from "./validation.ts";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;

function usage(): never {
  throw new Error(`usage:
  agentify-learning process --event <json> [--task-evidence <json>] [--candidates <json>] --output <json>
  agentify-learning reconcile --repository-id <owner/repo> --default-branch <branch> [--max-commits <n>] --output <json>
  agentify-learning adopt-proposal --repository-id <owner/repo> --proposal <sha> --expected-head <sha> --output <json>
  agentify-learning verify-diff --expected-head <sha> --output <json>
  agentify-learning context [--request <json>] --output <json>`);
}

function parseFlags(args: ReadonlyArray<string>): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) usage();
    if (flags.has(key)) throw new Error(`duplicate argument ${key}`);
    flags.set(key, value);
  }
  return flags;
}

function required(flags: ReadonlyMap<string, string>, name: string): string {
  const value = flags.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readJsonFile(filePath: string): unknown {
  const absolute = path.resolve(filePath);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`input must be a regular non-symlink file: ${absolute}`);
  }
  if (stat.size > MAX_INPUT_BYTES) {
    throw new Error(`input exceeds ${MAX_INPUT_BYTES} bytes: ${absolute}`);
  }
  return JSON.parse(fs.readFileSync(absolute, "utf-8")) as unknown;
}

function writeJsonFile(filePath: string, value: unknown): void {
  const absolute = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(temporary, absolute);
}

function candidateDrafts(value: unknown): MemoryCandidateDraft[] {
  if (!Array.isArray(value)) throw new Error("candidate input must be a JSON array");
  return value as MemoryCandidateDraft[];
}

function contextRequest(value: unknown): LearningContextRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("learning context request must be a JSON object");
  }
  return value as LearningContextRequest;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) usage();
  const flags = parseFlags(rest);
  const output = required(flags, "--output");

  switch (command) {
    case "process": {
      const event = validateAcceptedMergeEvent(
        readJsonFile(required(flags, "--event")),
      ) as AcceptedMergeEvent;
      const taskPath = flags.get("--task-evidence");
      const taskEvidence = taskPath === undefined
        ? null
        : validateAcceptedTaskEvidence(readJsonFile(taskPath)) as AcceptedTaskEvidence;
      const candidatePath = flags.get("--candidates");
      const candidates = candidatePath === undefined
        ? []
        : candidateDrafts(readJsonFile(candidatePath));
      const report = processAcceptedMerge({
        cwd: process.cwd(),
        event,
        task_evidence: taskEvidence,
        candidate_drafts: candidates,
      });
      writeJsonFile(output, report);
      return;
    }
    case "reconcile": {
      const maxValue = flags.get("--max-commits");
      const maxCommits = maxValue === undefined ? undefined : Number(maxValue);
      const report = reconcileAcceptedMerges({
        cwd: process.cwd(),
        repository_id: required(flags, "--repository-id"),
        default_branch: required(flags, "--default-branch"),
        max_commits: maxCommits,
      });
      writeJsonFile(output, report);
      return;
    }
    case "verify-diff": {
      writeJsonFile(
        output,
        verifyLearningSelfUpdateDiff(
          process.cwd(),
          required(flags, "--expected-head"),
        ),
      );
      return;
    }
    case "adopt-proposal": {
      writeJsonFile(output, adoptLearningProposal({
        cwd: process.cwd(),
        repository_id: required(flags, "--repository-id"),
        proposal_commit: required(flags, "--proposal"),
        expected_head: required(flags, "--expected-head"),
      }));
      return;
    }
    case "context": {
      const requestPath = flags.get("--request");
      const request = requestPath === undefined
        ? {}
        : contextRequest(readJsonFile(requestPath));
      writeJsonFile(output, buildLearningContext(process.cwd(), request));
      return;
    }
    default:
      usage();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`agentify-learning: ${message}\n`);
  process.exitCode = 1;
});
