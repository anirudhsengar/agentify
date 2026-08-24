import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PROVIDER_ENV_KEYS } from "../provider-auth.ts";
import type {
  InstallerProcessRequest,
  InstallerProcessResult,
  InstallerProcessRunner,
} from "./contracts.ts";

const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const PROVIDER_ENV_KEY_SET = new Set<string>(PROVIDER_ENV_KEYS);

function resolveWindowsCmdScript(
  program: string,
  args: readonly string[],
  cwd: string,
): { program: string; args: string[] } | null {
  if (process.platform !== "win32") return null;
  if (!/\.(?:bat|cmd)$/i.test(path.basename(program))) return null;
  const resolved = path.isAbsolute(program) ? path.normalize(program) : path.resolve(cwd, program);
  const root = path.resolve(cwd);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Windows .bat/.cmd validation scripts must resolve inside the repository cwd");
  }
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Windows .bat/.cmd validation scripts must identify a regular local file");
  }
  // Node cannot spawn .bat/.cmd directly (EINVAL). Route through cmd.exe without shell:true
  // so argv stays discrete and is not concatenated into an injectable shell string.
  const comspec = process.env.ComSpec?.trim() || "cmd.exe";
  return {
    program: comspec,
    args: ["/d", "/s", "/c", resolved, ...args],
  };
}

function resolveInvocation(request: InstallerProcessRequest): {
  program: string;
  args: string[];
} {
  if (request.program === "gh") {
    const override = process.env.AGENTIFY_GH_CLI?.trim();
    if (override) {
      const resolved = path.resolve(override);
      const stat = fs.lstatSync(resolved);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error("AGENTIFY_GH_CLI must identify a regular local executable or JavaScript file");
      }
      if (/\.(?:cjs|mjs|js)$/i.test(resolved)) {
        return { program: process.execPath, args: [resolved, ...request.args] };
      }
      return { program: resolved, args: [...request.args] };
    }
  }
  if (request.program === "npm" && process.platform === "win32") {
    const candidates = [
      process.env.npm_execpath,
      path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
    const npmCli = candidates.find((candidate) => fs.existsSync(candidate));
    if (npmCli) return { program: process.execPath, args: [npmCli, ...request.args] };
  }
  const windowsScript = resolveWindowsCmdScript(request.program, request.args, request.cwd);
  if (windowsScript) return windowsScript;
  return { program: request.program, args: [...request.args] };
}

function sanitizedEnvironment(
  input: NodeJS.ProcessEnv | undefined,
  agentifyToolInvocation: boolean,
): NodeJS.ProcessEnv {
  const source = input ?? process.env;
  const output: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (
      /^(?:GITHUB_TOKEN|GH_TOKEN)$/i.test(name)
      && agentifyToolInvocation
    ) {
      output[name] = value;
      continue;
    }
    if (!agentifyToolInvocation && PROVIDER_ENV_KEY_SET.has(name)) continue;
    if (/^(?:GITHUB_TOKEN|GH_TOKEN|.*(?:SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY))$/i.test(name)) continue;
    output[name] = value;
  }
  // CI is what the repository's own automation sets, so validation observes the
  // same behavior a maintainer would see upstream.
  output.CI = "1";
  if (agentifyToolInvocation) {
    // Only Agentify's own tool output is forced monochrome, because Agentify
    // parses it. NO_COLOR is a behavioral contract, not formatting: forcing it
    // on repository validation makes a repository that implements NO_COLOR fail
    // its own colour tests, so Agentify would be breaking the very validation
    // it is trying to verify.
    output.NO_COLOR = "1";
  } else {
    delete output.GITHUB_TOKEN;
    delete output.GH_TOKEN;
  }
  return output;
}

export const DEFAULT_INSTALLER_PROCESS_RUNNER: InstallerProcessRunner = {
  run(request: InstallerProcessRequest): InstallerProcessResult {
    const invocation = resolveInvocation(request);
    const result = spawnSync(invocation.program, invocation.args, {
      cwd: request.cwd,
      encoding: "utf-8",
      env: sanitizedEnvironment(request.env, request.program === "gh"),
      input: request.input,
      timeout: request.timeoutMs,
      maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
      windowsHide: true,
      shell: false,
    });
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      timedOut: code === "ETIMEDOUT",
      errorMessage: result.error?.message ?? null,
    };
  },
};

export function conciseProcessFailure(result: InstallerProcessResult): string {
  if (result.timedOut) return "command exceeded its configured timeout";
  const text = `${result.stderr}\n${result.stdout}`.trim().replace(/\s+/g, " ");
  if (text) return text.slice(0, 400);
  if (result.errorMessage) return result.errorMessage.slice(0, 400);
  return `command exited with status ${result.status ?? "unknown"}`;
}
