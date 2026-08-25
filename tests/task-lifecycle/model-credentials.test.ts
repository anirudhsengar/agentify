import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { assertTaskModelCredentialStore } from "../../src/core/task-lifecycle/model-runtime.ts";
import { TaskLifecycleError } from "../../src/core/task-lifecycle/state-machine.ts";

function tempConfigDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentify-task-auth-"));
}

function writeAuth(configDir: string, value: unknown): void {
  fs.writeFileSync(
    path.join(configDir, "auth.json"),
    typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
    { mode: 0o600 },
  );
}

test("stored API-key credential satisfies the credential-store transport", () => {
  const dir = tempConfigDir();
  try {
    writeAuth(dir, { anthropic: { type: "api_key", key: "sk-ant" } });
    assertTaskModelCredentialStore(dir, "anthropic");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stored OAuth credential satisfies the credential-store transport", () => {
  const dir = tempConfigDir();
  try {
    writeAuth(dir, {
      "openai-codex": {
        type: "oauth",
        refresh: "refresh-token",
        access: "access-token",
        expires: 4_000_000_000_000,
      },
    });
    assertTaskModelCredentialStore(dir, "openai-codex");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("missing credential store fails closed", () => {
  const dir = tempConfigDir();
  try {
    assert.throws(
      () => assertTaskModelCredentialStore(dir, "anthropic"),
      (error: unknown) => error instanceof TaskLifecycleError
        && /credential store is missing/.test(error.message),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("credential store without the provider entry fails closed", () => {
  const dir = tempConfigDir();
  try {
    writeAuth(dir, { openai: { type: "api_key", key: "sk-other" } });
    assert.throws(
      () => assertTaskModelCredentialStore(dir, "anthropic"),
      /no usable anthropic credential/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed credential entries fail closed", () => {
  const dir = tempConfigDir();
  try {
    writeAuth(dir, { anthropic: { type: "oauth", refresh: 42 } });
    assert.throws(
      () => assertTaskModelCredentialStore(dir, "anthropic"),
      /no usable anthropic credential/,
    );
    writeAuth(dir, "not json");
    assert.throws(
      () => assertTaskModelCredentialStore(dir, "anthropic"),
      /not valid JSON/,
    );
    writeAuth(dir, ["anthropic"]);
    assert.throws(
      () => assertTaskModelCredentialStore(dir, "anthropic"),
      /must contain an object/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
