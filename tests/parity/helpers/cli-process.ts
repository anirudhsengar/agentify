import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface CliProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface CliSandbox {
  cwd: string;
  home: string;
  cleanup: () => void;
}

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

export function repoRoot(): string {
  return REPO_ROOT;
}

export function createCliSandbox(prefix: string): CliSandbox {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-cwd-`));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-home-`));
  return {
    cwd,
    home,
    cleanup: () => {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

export function sanitizedCliEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CI: "1",
    NO_COLOR: "1",
  };
  for (const key of Object.keys(env)) {
    if (key.endsWith("_API_KEY") || key.endsWith("_TOKEN")) delete env[key];
  }
  return env;
}

export function runCompiledCli(
  args: readonly string[],
  options: { cwd: string; home: string; timeout?: number },
): CliProcessResult {
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "bin", "agentify.js"), ...args],
    {
      cwd: options.cwd,
      env: sanitizedCliEnv(options.home),
      encoding: "utf-8",
      timeout: options.timeout ?? 30_000,
    },
  );
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
