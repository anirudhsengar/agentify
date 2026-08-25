#!/usr/bin/env node
import { runAgentifyRuntime } from "./runtime-loader.mjs";

process.exitCode = runAgentifyRuntime("task-runtime.mjs", process.argv.slice(2));
