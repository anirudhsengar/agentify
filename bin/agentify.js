#!/usr/bin/env node

import { main } from "../dist/cli.js";

await main(process.argv.slice(2)).catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`agentify: ${message}\n`);
  process.exitCode = 1;
});
