#!/usr/bin/env node
// agentify:managed
//
// Agentify validation smoke: deterministic, dependency-free repository checks
// installed when the repository has no verifiable validation command of its
// own. Checks tracked-file JSON validity, JavaScript syntax, and
// committed-secret patterns. Only certainly-broken content fails the smoke:
// shape and coherence judgments belong to the repository's own tooling.
// Exits 1 with a report on any failure. Agentify owns this file; do not edit
// it by hand.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_SCAN_BYTES = 1024 * 1024;
const MAX_SYNTAX_CHECKS = 200;
const AGENTIFY_RUNTIME_PREFIX = ".github/agentify/";

const SECRET_PATTERNS = [
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub personal access token", re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
];

function fail(failures, check, detail) {
  failures.push(`${check}: ${detail}`);
}

function git(args, cwd) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) return null;
  return result.stdout;
}

function main() {
  const cwd = process.cwd();
  const top = git(["rev-parse", "--show-toplevel"], cwd);
  if (top === null) {
    console.error("validation-smoke: not a git repository");
    process.exit(1);
  }
  const listing = git(["ls-files", "-z"], cwd);
  if (listing === null) {
    console.error("validation-smoke: cannot list tracked files (git ls-files failed)");
    process.exit(1);
  }
  const tracked = listing.split("\0").filter(Boolean);

  const failures = [];
  let jsonChecked = 0;
  let syntaxChecked = 0;
  let textScanned = 0;

  for (const relative of tracked) {
    const absolute = path.join(cwd, relative);
    let stat;
    try {
      stat = fs.lstatSync(absolute);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) continue;

    if (relative.endsWith(".json")) {
      if (stat.size > MAX_JSON_BYTES) {
        fail(failures, "json", `${relative} exceeds ${MAX_JSON_BYTES} bytes; not validated`);
        continue;
      }
      try {
        JSON.parse(fs.readFileSync(absolute, "utf-8"));
        jsonChecked += 1;
      } catch (error) {
        fail(failures, "json", `${relative} is not valid JSON: ${error.message}`);
      }
      continue;
    }

    const underAgentifyRuntime = relative.startsWith(AGENTIFY_RUNTIME_PREFIX);
    if (!underAgentifyRuntime && (relative.endsWith(".mjs") || relative.endsWith(".cjs"))) {
      if (syntaxChecked < MAX_SYNTAX_CHECKS) {
        syntaxChecked += 1;
        const check = spawnSync(process.execPath, ["--check", absolute], { encoding: "utf-8" });
        if (check.status !== 0) {
          fail(failures, "syntax", `${relative} fails node --check: ${(check.stderr || "").trim().split("\n")[0]}`);
        }
      }
    }

    if (!underAgentifyRuntime && stat.size <= MAX_TEXT_SCAN_BYTES) {
      let text;
      try {
        text = fs.readFileSync(absolute, "utf-8");
      } catch {
        continue;
      }
      if (text.includes("\0")) continue;
      textScanned += 1;
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.re.test(text)) {
          fail(failures, "secret-scan", `${relative} matches ${pattern.name} pattern`);
        }
      }
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`validation-smoke: FAIL ${failure}`);
    console.error(`validation-smoke: ${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log(
    `validation-smoke: ok (${tracked.length} tracked files; `
    + `${jsonChecked} JSON parsed, ${syntaxChecked} JS syntax-checked, ${textScanned} text files scanned)`,
  );
}

main();
