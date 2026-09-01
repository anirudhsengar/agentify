import { spawnSync } from "node:child_process";
import { resolveValidationInvocation } from "../task-lifecycle/validation-runner.ts";
import { PROVIDER_ENV_KEYS } from "../provider-auth.ts";
import type {
  InstallerProcessRequest,
  InstallerProcessResult,
  InstallerProcessRunner,
} from "./contracts.ts";

const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const PROVIDER_ENV_KEY_SET = new Set<string>(PROVIDER_ENV_KEYS);

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
    const invocation = resolveValidationInvocation([request.program, ...request.args], request.cwd);
    const options = {
      cwd: request.cwd,
      encoding: "utf-8" as const,
      env: sanitizedEnvironment(request.env, request.program === "gh"),
      input: request.input,
      timeout: request.timeoutMs,
      maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
      windowsHide: true,
      shell: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    };
    const result = spawnSync(invocation.command, invocation.args, options);
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
