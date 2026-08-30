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
  return {
    program: "cmd.exe",
    args: ["/d", "/s", "/c", resolved, ...args],
  };
}

function resolveInvocation(request: InstallerProcessRequest): {
  program: string;
  args: string[];
} {
  if (request.program === "npm" && process.platform === "win32") {
    const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (fs.existsSync(npmCli)) return { program: process.execPath, args: [npmCli, ...request.args] };
  }
  const windowsScript = resolveWindowsCmdScript(request.program, request.args, request.cwd);
  if (windowsScript) return windowsScript;
  return { program: request.program, args: [...request.args] };
}

function sanitizedEnvironment(
  input: NodeJS.ProcessEnv | undefined,
  preserveGitHubAuthentication: boolean,
): NodeJS.ProcessEnv {
  const source = input ?? process.env;
  const output: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (
      /^(?:GITHUB_TOKEN|GH_TOKEN)$/i.test(name)
      && preserveGitHubAuthentication
    ) {
      output[name] = value;
      continue;
    }
    if (!preserveGitHubAuthentication && PROVIDER_ENV_KEY_SET.has(name)) continue;
    if (/^(?:GITHUB_TOKEN|GH_TOKEN|.*(?:SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY))$/i.test(name)) continue;
    output[name] = value;
  }
  output.CI = "1";
  delete output.NO_COLOR;
  delete output.FORCE_COLOR;
  delete output.CLICOLOR_FORCE;
  if (!preserveGitHubAuthentication) {
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
