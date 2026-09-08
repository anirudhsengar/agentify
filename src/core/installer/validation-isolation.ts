import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface ValidationCheckoutSuccess<T> {
  ok: true;
  value: T;
}

interface ValidationCheckoutFailure {
  ok: false;
  error: string;
}

export type ValidationCheckoutResult<T> = ValidationCheckoutSuccess<T> | ValidationCheckoutFailure;

function runGit(args: readonly string[], timeoutMs: number) {
  return spawnSync("git", [...args], {
    encoding: "utf-8",
    timeout: timeoutMs,
    windowsHide: true,
    shell: false,
  });
}

function failureDetail(prefix: string, result: ReturnType<typeof runGit>): string {
  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim().replace(/\s+/g, " ");
  const processError = result.error?.message?.trim();
  const detail = output || processError || `git exited with status ${result.status ?? "unknown"}`;
  return `${prefix}: ${detail.slice(0, 400)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hasCommittedGitCheckout(cwd: string): boolean {
  const result = runGit(["-C", cwd, "rev-parse", "--verify", "HEAD^{commit}"], 10_000);
  return result.status === 0 && /^[0-9a-f]{40,64}$/i.test((result.stdout ?? "").trim());
}

function overlayPath(sourceRoot: string, checkoutRoot: string, relativePath: string): void {
  const source = path.join(sourceRoot, ...relativePath.split("/"));
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const destination = path.join(checkoutRoot, ...relativePath.split("/"));
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), destination);
    return;
  }
  if (stat.isDirectory()) {
    fs.cpSync(source, destination, { recursive: true, preserveTimestamps: true });
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`validation overlay path is not a regular file, directory, or symlink: ${relativePath}`);
  }
  fs.copyFileSync(source, destination);
}

/**
 * Run repository validation against an exact local clone instead of the
 * installation target. Optional overlays let finalization validate the exact
 * Agentify-managed output without exposing the target to build/test residue.
 */
export function runInDisposableValidationCheckout<T>(options: {
  cwd: string;
  overlayPaths?: ReadonlyArray<string>;
  operation(checkoutCwd: string): T;
}): ValidationCheckoutResult<T> {
  let cwd: string;
  try {
    cwd = fs.realpathSync.native(path.resolve(options.cwd));
  } catch (error) {
    return { ok: false, error: `isolated validation could not resolve the repository root: ${errorMessage(error)}` };
  }
  const head = runGit(["-C", cwd, "rev-parse", "--verify", "HEAD^{commit}"], 10_000);
  if (head.status !== 0 || !/^[0-9a-f]{40,64}$/i.test((head.stdout ?? "").trim())) {
    return { ok: false, error: failureDetail("isolated validation could not resolve committed HEAD", head) };
  }

  let temporaryRoot: string;
  try {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-validation-"));
  } catch (error) {
    return { ok: false, error: `isolated validation could not create a temporary checkout: ${errorMessage(error)}` };
  }
  const checkout = path.join(temporaryRoot, "repository");
  let result: ValidationCheckoutResult<T>;
  try {
    const clone = runGit([
      "clone",
      "--quiet",
      "--no-hardlinks",
      "--no-checkout",
      "--",
      cwd,
      checkout,
    ], 120_000);
    if (clone.status !== 0) {
      result = { ok: false, error: failureDetail("isolated validation could not clone the local repository", clone) };
    } else {
      const materialize = runGit([
        "-C",
        checkout,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "checkout",
        "--quiet",
        "--detach",
        "--force",
        (head.stdout ?? "").trim(),
      ], 120_000);
      if (materialize.status !== 0) {
        result = {
          ok: false,
          error: failureDetail("isolated validation could not materialize committed HEAD", materialize),
        };
      } else {
        const removeLocalOrigin = runGit([
          "-C",
          checkout,
          "remote",
          "remove",
          "origin",
        ], 10_000);
        if (removeLocalOrigin.status !== 0) {
          result = {
            ok: false,
            error: failureDetail("isolated validation could not remove its target-revealing local origin", removeLocalOrigin),
          };
        } else {
          for (const relativePath of options.overlayPaths ?? []) {
            overlayPath(cwd, checkout, relativePath);
          }
          result = { ok: true, value: options.operation(checkout) };
        }
      }
    }
  } catch (error) {
    result = { ok: false, error: `isolated validation failed: ${errorMessage(error)}` };
  }

  try {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  } catch (error) {
    return { ok: false, error: `isolated validation cleanup failed: ${errorMessage(error)}` };
  }
  return result;
}
