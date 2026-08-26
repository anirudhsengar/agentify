#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const IMPLEMENTATION_PAYLOAD_PREFIX = ".github/implementation/";
const ONE_SHOT_WORKFLOW = /^\.github\/workflows\/(?:apply|export|materialize|qualify)-.*\.ya?ml$/i;
const ENCODED_PATCH_FRAGMENT = /(?:^|\/).+\.(?:patch|diff)(?:\.gz)?\.b64(?:\.part\d+)?$/i;

export function isTemporaryImplementationArtifact(repositoryPath) {
  return repositoryPath.startsWith(IMPLEMENTATION_PAYLOAD_PREFIX)
    || ONE_SHOT_WORKFLOW.test(repositoryPath)
    || ENCODED_PATCH_FRAGMENT.test(repositoryPath);
}

export function parseNameStatusZ(raw) {
  if (typeof raw !== "string") throw new TypeError("name-status output must be a string");
  const fields = raw.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const entries = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) throw new Error("git name-status output contains an empty status");
    const kind = status[0];
    const pathCount = kind === "R" || kind === "C" ? 2 : 1;
    const paths = fields.slice(index, index + pathCount);
    if (paths.length !== pathCount || paths.some((value) => value.length === 0)) {
      throw new Error(`git name-status output is incomplete for status ${status}`);
    }
    entries.push({ status, paths });
    index += pathCount;
  }
  return entries;
}

export function assessImplementationDiff(entries) {
  const violations = [];
  const activeTemporary = [];
  let activeNonTemporary = 0;

  for (const entry of entries) {
    if (!entry || typeof entry.status !== "string" || !Array.isArray(entry.paths)) {
      throw new TypeError("diff entries must contain status and paths");
    }
    const kind = entry.status[0];
    const activePaths = kind === "D"
      ? []
      : kind === "R" || kind === "C"
        ? [entry.paths.at(-1)]
        : entry.paths;
    for (const repositoryPath of activePaths) {
      if (typeof repositoryPath !== "string" || repositoryPath.length === 0) {
        throw new TypeError("diff paths must be non-empty strings");
      }
      if (isTemporaryImplementationArtifact(repositoryPath)) {
        activeTemporary.push(repositoryPath);
      } else {
        activeNonTemporary += 1;
      }
    }
  }

  if (activeTemporary.length > 0) {
    violations.push(
      `temporary implementation artifacts are added, copied, renamed, or modified: ${[...new Set(activeTemporary)].sort().join(", ")}`,
    );
  }
  if (activeTemporary.length > 0 && activeNonTemporary === 0) {
    violations.push(
      "the final change contains only temporary payload/workflow artifacts and no production implementation",
    );
  }
  return violations;
}

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
}

function entriesForInvocation(args) {
  if (args.length === 0) {
    return git(["ls-files", "-z"])
      .split("\0")
      .filter(Boolean)
      .map((repositoryPath) => ({ status: "T", paths: [repositoryPath] }));
  }
  if (args.length !== 2 || args.some((value) => value.trim().length === 0)) {
    throw new Error("usage: verify-implementation-diff.mjs [<base-ref> <head-ref>]");
  }
  return parseNameStatusZ(git([
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    `${args[0]}...${args[1]}`,
  ]));
}

export function main(args = process.argv.slice(2)) {
  const violations = assessImplementationDiff(entriesForInvocation(args));
  if (violations.length > 0) {
    for (const violation of violations) console.error(`implementation-diff gate: ${violation}`);
    return 1;
  }
  console.log(
    args.length === 0
      ? "implementation-diff gate: repository contains no temporary implementation artifacts"
      : "implementation-diff gate: final PR diff contains production changes and no active staging artifacts",
  );
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) process.exitCode = main();
