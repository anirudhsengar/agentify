#!/usr/bin/env python3
from pathlib import Path
import json


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    target = Path(path)
    text = target.read_text()
    if old not in text:
        raise SystemExit(f"missing replacement anchor in {path}: {old[:100]!r}")
    target.write_text(text.replace(old, new, count))


# Production composition keeps identical transport behavior at its new owner path.
replace(
    "src/core/orchestrator/worker.ts",
    'import { ComsPeer } from "../coms/server.ts";',
    'import { ComsPeer } from "./comms/server.ts";',
)

# Source comments and repository-only tests follow the physical move.
for path, old, new in [
    ("src/core/orchestrator/comms/types.ts", "// coms/types.ts", "// orchestrator/comms/types.ts"),
    ("src/core/orchestrator/comms/registry.ts", "// coms/registry.ts", "// orchestrator/comms/registry.ts"),
    ("src/core/orchestrator/comms/server.ts", "// coms/server.ts", "// orchestrator/comms/server.ts"),
    ("tests/orchestrator/comms/registry.test.ts", "// tests/coms/registry.test.ts", "// tests/orchestrator/comms/registry.test.ts"),
    ("tests/orchestrator/comms/server.test.ts", "// tests/coms/server.test.ts", "// tests/orchestrator/comms/server.test.ts"),
]:
    replace(path, old, new)

replace(
    "tests/orchestrator/comms/registry.test.ts",
    '../../src/core/coms/registry.ts',
    '../../../src/core/orchestrator/comms/registry.ts',
)
replace(
    "tests/orchestrator/comms/registry.test.ts",
    '../../src/core/coms/types.ts',
    '../../../src/core/orchestrator/comms/types.ts',
)
replace(
    "tests/orchestrator/comms/server.test.ts",
    '../../src/core/coms/server.ts',
    '../../../src/core/orchestrator/comms/server.ts',
)
replace(
    "tests/orchestrator/worker.test.ts",
    '../../src/core/coms/server.ts',
    '../../src/core/orchestrator/comms/server.ts',
)
replace(
    "tests/orchestrator/worker.test.ts",
    '../../src/core/coms/registry.ts',
    '../../src/core/orchestrator/comms/registry.ts',
)

fixture = {
    "registry_record_fields": [
        "name", "pid", "socketPath", "project", "cwd", "purpose", "color",
        "lastHeartbeat", "contextUsedPct"
    ],
    "defaults": {
        "coms_root": "~/.pi/coms",
        "max_hops": 5,
        "socket_timeout_ms": 5000,
        "poll_interval_ms": 200,
        "await_timeout_ms": 1800000,
        "heartbeat_interval_ms": 30000,
        "stale_after_ms": 60000
    },
    "error_codes": [
        "hop_limit_exceeded", "unknown_sender", "unknown_target", "self_send",
        "delivery_failed", "timeout", "invalid_envelope"
    ],
    "envelope_fields": {
        "prompt": ["type", "msg_id", "sender", "target", "body", "hops", "ts"],
        "response": ["type", "msg_id", "sender", "target", "body", "hops", "ts", "aborted"],
        "error": ["type", "msg_id", "sender", "target", "hops", "ts", "error", "code"]
    }
}
Path("tests/fixtures/orchestrator-comms-contract.json").write_text(
    json.dumps(fixture, indent=2) + "\n"
)

Path("tests/orchestrator/comms/contract.test.ts").write_text(r'''import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PeerRegistry } from "../../../src/core/orchestrator/comms/registry.ts";
import { ComsPeer } from "../../../src/core/orchestrator/comms/server.ts";
import {
  DEFAULT_AWAIT_TIMEOUT_MS,
  DEFAULT_COMS_ROOT,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_MAX_HOPS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_SOCKET_TIMEOUT_MS,
  STALE_AFTER_MS,
  type ErrorCode,
  type ErrorEnvelope,
  type PeerEntry,
  type PromptEnvelope,
  type ResponseEnvelope,
} from "../../../src/core/orchestrator/comms/types.ts";

interface ContractFixture {
  registry_record_fields: string[];
  defaults: {
    coms_root: string;
    max_hops: number;
    socket_timeout_ms: number;
    poll_interval_ms: number;
    await_timeout_ms: number;
    heartbeat_interval_ms: number;
    stale_after_ms: number;
  };
  error_codes: ErrorCode[];
  envelope_fields: {
    prompt: string[];
    response: string[];
    error: string[];
  };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  fs.readFileSync(path.join(HERE, "../../fixtures/orchestrator-comms-contract.json"), "utf-8"),
) as ContractFixture;

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sortedKeys(value: object): string[] {
  return Object.keys(value).sort((left, right) => left.localeCompare(right));
}

test("communications protocol constants and envelopes match the pre-move fixture", () => {
  assert.deepEqual(
    {
      coms_root: DEFAULT_COMS_ROOT,
      max_hops: DEFAULT_MAX_HOPS,
      socket_timeout_ms: DEFAULT_SOCKET_TIMEOUT_MS,
      poll_interval_ms: DEFAULT_POLL_INTERVAL_MS,
      await_timeout_ms: DEFAULT_AWAIT_TIMEOUT_MS,
      heartbeat_interval_ms: DEFAULT_HEARTBEAT_INTERVAL_MS,
      stale_after_ms: STALE_AFTER_MS,
    },
    fixture.defaults,
  );

  const prompt: PromptEnvelope = {
    type: "prompt",
    msg_id: "fixture-message",
    sender: "sender",
    target: "target",
    body: "body",
    hops: 0,
    ts: "2026-07-13T00:00:00.000Z",
  };
  const response: ResponseEnvelope = {
    type: "response",
    msg_id: "fixture-message",
    sender: "target",
    target: "sender",
    body: "result",
    hops: 1,
    ts: "2026-07-13T00:00:01.000Z",
    aborted: false,
  };
  const error: ErrorEnvelope = {
    type: "error",
    msg_id: "fixture-message",
    sender: "target",
    target: "sender",
    hops: 1,
    ts: "2026-07-13T00:00:01.000Z",
    error: "failed",
    code: "delivery_failed",
  };

  assert.deepEqual(sortedKeys(prompt), [...fixture.envelope_fields.prompt].sort());
  assert.deepEqual(sortedKeys(response), [...fixture.envelope_fields.response].sort());
  assert.deepEqual(sortedKeys(error), [...fixture.envelope_fields.error].sort());
  assert.deepEqual(fixture.error_codes, [
    "hop_limit_exceeded",
    "unknown_sender",
    "unknown_target",
    "self_send",
    "delivery_failed",
    "timeout",
    "invalid_envelope",
  ] satisfies ErrorCode[]);
});

test("registry record shape, atomic write, and private modes remain unchanged", () => {
  const root = tempDir("agentify-orchestrator-comms-registry-");
  try {
    const registry = new PeerRegistry({ registryDir: root, project: "fixture-project" });
    const entry: PeerEntry = {
      name: "fixture-peer",
      pid: process.pid,
      socketPath: "/tmp/fixture-peer.sock",
      project: "fixture-project",
      cwd: "/tmp",
      purpose: "fixture",
      color: "#36F9F6",
      lastHeartbeat: "2026-07-13T00:00:00.000Z",
      contextUsedPct: 0,
    };
    registry.upsert(entry);

    const agentsDirectory = path.join(root, "projects", "fixture-project", "agents");
    const recordPath = path.join(agentsDirectory, "fixture-peer.json");
    const persisted = JSON.parse(fs.readFileSync(recordPath, "utf-8")) as PeerEntry;
    assert.deepEqual(persisted, entry);
    assert.deepEqual(sortedKeys(persisted), [...fixture.registry_record_fields].sort());
    assert.equal(fs.existsSync(`${recordPath}.tmp`), false);

    if (process.platform !== "win32") {
      assert.equal(fs.statSync(agentsDirectory).mode & 0o777, 0o700);
      assert.equal(fs.statSync(recordPath).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listen and close remain idempotent and close resolves pending waits", async () => {
  const root = tempDir("agentify-orchestrator-comms-close-");
  const sender = new ComsPeer({
    name: "sender",
    sessionId: "fixture-sender",
    cwd: "/tmp",
    comsRoot: root,
    project: "fixture-project",
  });
  const receiver = new ComsPeer({
    name: "receiver",
    sessionId: "fixture-receiver",
    cwd: "/tmp",
    comsRoot: root,
    project: "fixture-project",
  });
  try {
    await sender.listen();
    await sender.listen();
    await receiver.listen();
    receiver.on("prompt", () => undefined);

    const pending = sender.send("receiver", "remain pending");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const waiting = sender.await(pending.msg_id, 5_000);
    await sender.close();
    await sender.close();
    const result = await waiting;

    assert.equal(result.status, "error");
    assert.equal(result.error, "peer closed");
    assert.equal(result.errorCode, "delivery_failed");
  } finally {
    await sender.close();
    await receiver.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stale socket cleanup unlinks a symlink without deleting its target", async (context) => {
  if (process.platform === "win32") {
    context.skip("Unix-domain socket symlink behavior is POSIX-specific");
    return;
  }

  const root = tempDir("agentify-orchestrator-comms-symlink-");
  const socketsDirectory = path.join(root, "sockets");
  fs.mkdirSync(socketsDirectory, { recursive: true });
  const victimPath = path.join(root, "victim.txt");
  const socketPath = path.join(socketsDirectory, "fixture-symlink.sock");
  fs.writeFileSync(victimPath, "keep");
  fs.symlinkSync(victimPath, socketPath);

  const peer = new ComsPeer({
    name: "symlink-peer",
    sessionId: "fixture-symlink",
    cwd: "/tmp",
    comsRoot: root,
    project: "fixture-project",
  });
  try {
    await peer.listen();
    assert.equal(fs.readFileSync(victimPath, "utf-8"), "keep");
    assert.equal(fs.lstatSync(socketPath).isSocket(), true);
  } finally {
    await peer.close();
    assert.equal(fs.readFileSync(victimPath, "utf-8"), "keep");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
''')

# Machine-enforced architecture ownership and package exclusion.
replace("tests/maintenance/module-boundaries.test.ts", '  "src/core/coms/",\n', "")
replace("tests/maintenance/module-boundaries.test.ts", '  "src/core/coms/server.ts",\n', "")
replace(
    "tests/maintenance/module-boundaries.test.ts",
    'test("public CLI command inventory remains restricted to supported utilities", () => {',
    '''test("orchestrator owns the communications transport", () => {
  const graph = buildImportGraph();
  const commsPrefix = "src/core/orchestrator/comms/";

  assert.equal(fs.existsSync(path.join(REPO_ROOT, "src/core/coms")), false);
  for (const modulePath of [
    `${commsPrefix}types.ts`,
    `${commsPrefix}registry.ts`,
    `${commsPrefix}server.ts`,
  ]) {
    assert.ok(graph.has(modulePath), `${modulePath} must remain orchestrator-owned`);
  }

  const externalConsumers = [...graph.entries()]
    .filter(([importer, dependencies]) =>
      !importer.startsWith(commsPrefix)
      && [...dependencies].some((dependency) => dependency.startsWith(commsPrefix)))
    .map(([importer]) => importer)
    .sort((left, right) => left.localeCompare(right));

  assert.deepEqual(externalConsumers, ["src/core/orchestrator/worker.ts"]);
});

test("public CLI command inventory remains restricted to supported utilities", () => {''',
)
replace("tests/package/installed-cli-smoke.mjs", '    "dist/coms/",\n', "")
replace(
    "tests/package/installed-cli-smoke.mjs",
    '    "coms/server.ts",\n',
    '    "orchestrator/comms/server.ts",\n    "coms/server.ts",\n',
)

# Ownership and contributor guidance.
replace(
    "AGENTS.md",
    '''- Orchestrator, AIW, webhook, communications, and Agent Expert modules are
  internal experimental surfaces. Do not expose them through package exports or
  CLI commands without satisfying `docs/experimental-surfaces.md`.''',
    '''- Orchestrator—including its owned communications transport under
  `src/core/orchestrator/comms/`—AIW, webhook, and Agent Expert modules are
  internal experimental surfaces. Do not expose them through package exports or
  CLI commands without satisfying `docs/experimental-surfaces.md`.''',
)
replace(
    "CONTRIBUTING.md",
    '│       ├── orchestrator/        # internal experimental runtime',
    '│       ├── orchestrator/        # experimental runtime + owned communications transport',
)
replace(
    "CONTRIBUTING.md",
    '''- **Internal means internal.** Orchestrator, AIW, webhook, communications, and
  Agent Expert modules remain experimental and are not package APIs. Follow
  `docs/experimental-surfaces.md` before attempting to productize one.''',
    '''- **Internal means internal.** Orchestrator (including
  `src/core/orchestrator/comms/`), AIW, webhook, and Agent Expert modules remain
  experimental and are not package APIs. Follow `docs/experimental-surfaces.md`
  before attempting to productize one.''',
)
replace(
    ".github/CODEOWNERS",
    "# Orchestrator and AIW (internal control plane).",
    "# Orchestrator, its owned communications transport, and AIW (internal control plane).",
)
replace(
    ".github/labeler.yml",
    "orchestrator:\n  - changed-files:",
    "# Includes the orchestrator-owned communications transport under comms/.\norchestrator:\n  - changed-files:",
)

# Architecture and lifecycle documentation.
replace(
    "docs/experimental-surfaces.md",
    '''The evidence-based lifecycle decision for every experimental subsystem is recorded
in `docs/architecture/experimental-runtime-decisions.md`. That record retains
webhook, AIW, orchestrator, and Agent Expert in place and approves a separate,
behavior-preserving relocation of communications beneath the orchestrator boundary
through Issue #48. Until that implementation merges, the source table below remains
the current physical layout.''',
    '''The evidence-based lifecycle decision for every experimental subsystem is recorded
in `docs/architecture/experimental-runtime-decisions.md`. Webhook, AIW,
orchestrator, and Agent Expert remain internal. Issue #48 implements the approved
behavior-preserving communications relocation, so the local peer transport is now
owned physically and architecturally by the orchestrator subtree.''',
)
replace(
    "docs/experimental-surfaces.md",
    '''| Orchestrator | `src/core/orchestrator/` | Multi-agent delegation and domain locks |
| Communications runtime | `src/core/coms/` | Internal agent communication registry and server |''',
    '''| Orchestrator and communications transport | `src/core/orchestrator/` including `comms/` | Multi-agent delegation, domain locks, and local Unix-socket peer messaging |''',
)
replace("docs/refactors/runtime-reachability.md", '- `src/core/coms/`;\n', "")
replace(
    "docs/refactors/runtime-reachability.md",
    '''| Orchestrator | `tests/orchestrator/**`, copied workflow JSON, workflow registry, domain locks, and security/contract tests. |
| Communications | communications tests and internal agent registry/server composition. |''',
    '''| Orchestrator | `tests/orchestrator/**`, copied workflow JSON, workflow registry, domain locks, security/contract tests, and the owned `src/core/orchestrator/comms/` peer transport. |''',
)
replace(
    "docs/refactors/runtime-reachability.md",
    '| Experimental composition entrypoints under webhook, AIW, orchestrator, communications, and Agent Expert |',
    '| Experimental composition entrypoints under webhook, AIW, orchestrator (including its communications transport), and Agent Expert |',
)
replace(
    "docs/architecture.md",
    '''- **Experimental composition and runtime:** webhook, AIW, orchestrator runtime,
  communications, Agent Expert, and maintainer-only expert outcome/qualification
  modules. Their tests do not make them supported APIs.''',
    '''- **Experimental composition and runtime:** webhook, AIW, the orchestrator runtime
  and its owned communications transport, Agent Expert, and maintainer-only expert
  outcome/qualification modules. Their tests do not make them supported APIs.''',
)
replace(
    "docs/architecture.md",
    '''Webhook, AIW, orchestrator, communications, and Agent Expert code remain
internal experimental modules. Their source presence does not make them package
APIs. See `docs/experimental-surfaces.md`.''',
    '''Webhook, AIW, orchestrator (including its communications transport), and Agent
Expert code remain internal experimental modules. Their source presence does not
make them package APIs. See `docs/experimental-surfaces.md`.''',
)
replace(
    "docs/architecture.md",
    "## Webhook boundary\n",
    '''## Orchestrator communications ownership

The orchestrator owns its local peer transport under
`src/core/orchestrator/comms/`. `src/core/orchestrator/worker.ts` is the only
production source consumer outside the transport modules themselves. Relocating
the source changes no protocol bytes, envelope fields, error codes, hop limits,
timeout defaults, registry records, socket locations, or operator state under
`~/.pi/coms`.

The transport remains local Unix-domain-socket infrastructure for the experimental
orchestrator. It does not grant repository capabilities, add a network listener,
create a package export, or graduate the orchestrator into the supported product
surface.

## Webhook boundary
''',
)
replace(
    "tests/maintenance/documentation-invariants.test.ts",
    'test("dependency compatibility matrix preserves the upgrade gate and group ownership", () => {',
    '''test("communications is documented as orchestrator-owned", () => {
  for (const documentationFile of [
    "AGENTS.md",
    "CONTRIBUTING.md",
    "docs/architecture.md",
    "docs/experimental-surfaces.md",
    "docs/refactors/runtime-reachability.md",
  ]) {
    const documentation = read(documentationFile);
    assert.doesNotMatch(documentation, /`src\\/core\\/coms\\/`/);
  }
  assert.match(read("docs/architecture.md"), /src\\/core\\/orchestrator\\/comms\\//);
});

test("dependency compatibility matrix preserves the upgrade gate and group ownership", () => {''',
)
replace(
    "CHANGELOG.md",
    "### Changed\n- Enforced supported, neutral, and experimental source boundaries",
    "### Changed\n- Relocated the internal communications registry, protocol types, and Unix-socket peer server beneath `src/core/orchestrator/comms/` without changing protocol, state, CLI, build, or package behavior.\n- Enforced supported, neutral, and experimental source boundaries",
)
