#!/usr/bin/env node
import {
  loadSmokeEvidenceFilesWithOptions,
  type SmokeEvidenceProfile,
} from "../smoke-evidence.ts";

function usage(): void {
  console.error("usage: tsx src/core/scripts/verify-smoke-evidence.ts [--profile full|no-llm] <smoke-evidence.json>...");
  console.error("");
  console.error("Verifies staged GitHub smoke evidence files. Default profile: full.");
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
  usage();
  process.exit(args.length === 1 ? 0 : 2);
}

let profile: SmokeEvidenceProfile = "full";
const evidenceFiles: string[] = [];

function parseProfile(value: string): SmokeEvidenceProfile | null {
  if (value === "full") return "full";
  if (value === "no-llm" || value === "no_llm") return "no_llm";
  return null;
}

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]!;
  if (arg === "--profile") {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("-")) {
      usage();
      process.exit(2);
    }
    const parsedProfile = parseProfile(value);
    if (parsedProfile === null) {
      usage();
      process.exit(2);
    }
    profile = parsedProfile;
    index += 1;
  } else if (arg === "-h" || arg === "--help") {
    usage();
    process.exit(0);
  } else if (arg.startsWith("-")) {
    usage();
    process.exit(2);
  } else {
    evidenceFiles.push(arg);
  }
}

if (evidenceFiles.length === 0) {
  usage();
  process.exit(2);
}

try {
  const report = loadSmokeEvidenceFilesWithOptions(evidenceFiles, { profile });
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) {
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
