#!/usr/bin/env node
import { qualifyReleaseEvidence } from "../release-qualification.ts";

function usage(): void {
  console.error("usage: tsx src/core/scripts/qualify-release-evidence.ts --repo <owner/name> --commit <sha> --since <iso> --expert <expert-outcomes.json> --smoke <smoke.json>...");
  console.error("");
  console.error("Runs the combined public-release evidence gate.");
}

const args = process.argv.slice(2);
const smokeEvidenceFiles: string[] = [];
let expertOutcomeManifestPath: string | undefined;
let expectedRepo: string | undefined;
let expectedCommit: string | undefined;
let evidenceSince: string | undefined;

function nextValue(args: string[], index: number): string | null {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) {
    return null;
  }
  return value;
}

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]!;
  if (arg === "-h" || arg === "--help") {
    usage();
    process.exit(0);
  }
  if (arg === "--repo") {
    const next = nextValue(args, index);
    if (next === null) {
      usage();
      process.exit(2);
    }
    expectedRepo = next;
    index += 1;
  } else if (arg === "--commit") {
    const next = nextValue(args, index);
    if (next === null) {
      usage();
      process.exit(2);
    }
    expectedCommit = next;
    index += 1;
  } else if (arg === "--since") {
    const next = nextValue(args, index);
    if (next === null) {
      usage();
      process.exit(2);
    }
    evidenceSince = next;
    index += 1;
  } else if (arg === "--expert") {
    const next = nextValue(args, index);
    if (next === null) {
      usage();
      process.exit(2);
    }
    expertOutcomeManifestPath = next;
    index += 1;
  } else if (arg === "--smoke") {
    const next = nextValue(args, index);
    if (next === null) {
      usage();
      process.exit(2);
    }
    smokeEvidenceFiles.push(next);
    index += 1;
  } else {
    usage();
    process.exit(2);
  }
}

if (smokeEvidenceFiles.length === 0) {
  usage();
  process.exit(2);
}

try {
  const report = qualifyReleaseEvidence({
    expectedRepo,
    expectedCommit,
    evidenceSince,
    smokeEvidenceFiles,
    expertOutcomeManifestPath,
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) {
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
