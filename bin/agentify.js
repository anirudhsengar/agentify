#!/usr/bin/env node

import { main } from "../dist/cli.js";

await main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`agentify: ${message}\n`);
  process.exitCode = 1;
});
