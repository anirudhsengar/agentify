#!/usr/bin/env node
import { loadExpertOutcomeEvidenceFile } from "../expert-outcome.ts";

function usage(): void {
  console.error("usage: tsx src/core/scripts/score-expert-outcomes.ts <expert-outcomes.json>");
  console.error("");
  console.error("Scores dogfood expert outcome transcripts against generated expertise.");
}

const args = process.argv.slice(2);
if (args.length !== 1 || args[0] === "-h" || args[0] === "--help") {
  usage();
  process.exit(args.length === 1 ? 0 : 2);
}

try {
  const report = loadExpertOutcomeEvidenceFile(args[0]!);
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) {
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
