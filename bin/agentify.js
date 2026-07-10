#!/usr/bin/env node
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { main } = await jiti.import("../src/cli.ts");
await main(process.argv.slice(2)).catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`agentify: ${message}\n`);
  process.exitCode = 1;
});
