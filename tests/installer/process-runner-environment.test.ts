import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { DEFAULT_INSTALLER_PROCESS_RUNNER } from "../../src/core/installer/process-runner.ts";
import { PROVIDER_ENV_KEYS } from "../../src/core/provider-auth.ts";

const PROVIDER_CREDENTIAL_KEYS = [...new Set([
  ...PROVIDER_ENV_KEYS,
  ...PROVIDER_ENV_KEYS.map((name) => name.toLowerCase()),
  "PI_AUTH_JSON",
  "pi_auth_json",
  "AGENT_PAT",
  "agent_pat",
])];
const GITHUB_CREDENTIAL_KEYS = ["GITHUB_TOKEN", "GH_TOKEN", "github_token", "gh_token"];

function credentialEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries([
    ...[...PROVIDER_CREDENTIAL_KEYS, ...GITHUB_CREDENTIAL_KEYS]
      .map((name) => [name, `synthetic-${name}`]),
    ["AGENTIFY_TEST_SAFE_VALUE", "retained"],
    ["CI", "0"],
    ["NO_COLOR", "1"],
    ["FORCE_COLOR", "1"],
    ["CLICOLOR_FORCE", "1"],
  ]);
}

test("installer validation children do not inherit provider bundles or automation tokens", () => {
  const environment = credentialEnvironment();
  const before = { ...environment };
  Object.freeze(environment);
  const keys = [...PROVIDER_CREDENTIAL_KEYS, ...GITHUB_CREDENTIAL_KEYS];
  const result = DEFAULT_INSTALLER_PROCESS_RUNNER.run({
    program: process.execPath,
    args: ["-e", `console.log(JSON.stringify({
      credentials: ${JSON.stringify(keys)}.filter(name => process.env[name] !== undefined),
      safe: process.env.AGENTIFY_TEST_SAFE_VALUE,
      ci: process.env.CI,
      colors: ["NO_COLOR", "FORCE_COLOR", "CLICOLOR_FORCE"].filter(name => process.env[name] !== undefined)
    }))`],
    cwd: process.cwd(),
    env: environment,
    timeoutMs: 10_000,
  });
  assert.equal(result.status, 0, result.errorMessage ?? result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    credentials: [], safe: "retained", ci: "1", colors: [],
  });
  assert.deepEqual(environment, before, "sanitization must not mutate caller-owned environment");
});

for (const program of ["gh", "git"]) {
  test(`installer ${program} authentication is restricted to the intended process`, (t) => {
    const environment = credentialEnvironment();
    let childEnvironment: NodeJS.ProcessEnv | undefined;
    const spawn = t.mock.method(childProcess, "spawnSync", (...args: unknown[]) => {
      childEnvironment = (args[2] as { env: NodeJS.ProcessEnv }).env;
      return { status: 0, stdout: "", stderr: "" };
    });
    try {
      syncBuiltinESMExports();
      DEFAULT_INSTALLER_PROCESS_RUNNER.run({
        program, args: ["--version"], cwd: process.cwd(), env: environment, timeoutMs: 1000,
      });
      assert.equal(spawn.mock.callCount(), 1);
      assert.ok(childEnvironment);
      for (const name of PROVIDER_CREDENTIAL_KEYS) {
        assert.equal(childEnvironment[name], undefined, `${program} must not inherit ${name}`);
      }
      for (const name of GITHUB_CREDENTIAL_KEYS) {
        assert.equal(childEnvironment[name], program === "gh" ? environment[name] : undefined);
      }
      assert.equal(childEnvironment.AGENTIFY_TEST_SAFE_VALUE, "retained");
      assert.equal(childEnvironment.CI, "1");
    } finally {
      spawn.mock.restore();
      syncBuiltinESMExports();
    }
  });
}

test("installer sanitizes ambient credentials when no environment override is supplied", () => {
  const keys = ["PI_AUTH_JSON", "AGENT_PAT"];
  const previous = keys.map((name) => [name, process.env[name]] as const);
  try {
    for (const name of keys) process.env[name] = `synthetic-${name}`;
    const result = DEFAULT_INSTALLER_PROCESS_RUNNER.run({
      program: process.execPath,
      args: ["-e", `console.log(JSON.stringify(${JSON.stringify(keys)}.filter(name => process.env[name] !== undefined)))`],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    assert.equal(result.status, 0, result.errorMessage ?? result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), []);
    for (const name of keys) assert.equal(process.env[name], `synthetic-${name}`);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
