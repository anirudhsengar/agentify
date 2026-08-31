import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { AuditResourceBudget } from "../../src/core/audit/resource-budget.ts";
import { createSpawnExplorerTool } from "../../src/core/audit/spawn-explorer-tool.ts";

test("independent readers overlap while duplicate concerns and aggregate overflow remain blocked", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-parallel-readers-"));
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const runs: Array<Promise<unknown>> = [];
  try {
    execFileSync("git", ["init", "-q", cwd]);
    execFileSync("git", ["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=test@example.invalid",
      "commit", "--allow-empty", "-qm", "fixture"]);
    const budget = new AuditResourceBudget({ maxModelCalls: 3 });
    let sessions = 0;
    let admitted!: () => void;
    const allAdmitted = new Promise<void>(resolve => { admitted = resolve; });
    const tool = createSpawnExplorerTool({ agentDir: cwd, stateDir: ".agentify/runtime/audit",
      resourceBudget: budget,
      explorerModel: { id: "fixture", provider: "fixture", api: "openai-completions",
        contextWindow: 100, maxTokens: 10, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      } as unknown as Model<Api>,
      createSession: async options => ({ session: {
        messages: [], dispose() {}, async abort() { release(); },
        async prompt() {
          const handlers = options.resourceLoader.getExtensions().extensions
            .flatMap(extension => extension.handlers.get("before_provider_request") ?? []);
          for (const handler of handlers) await handler({ payload: {} } as never, { cwd } as never);
          sessions += 1;
          if (sessions === 3) admitted();
          await pending;
        },
      } }),
    });
    const start = (concern: string, mode = "concern_tracer") => tool.execute(concern,
      { target_path: ".", mode, concern, focus: mode === "concern_tracer" ? concern : undefined } as never,
      undefined, undefined, { cwd } as never);
    runs.push(start("Payment retry contracts"), start("Session invalidation"), start("Delivery routing"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([allAdmitted, new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error("independent readers were serialized or refused")), 2_000);
      })]);
    } finally { clearTimeout(timer); }
    assert.equal(budget.snapshot().model_calls, 3);
    assert.equal(budget.snapshot().unreported_calls, 3);
    assert.equal(budget.snapshot().unreserved_calls, 0);
    const duplicate = await start("Session invalidation");
    assert.match(JSON.stringify(duplicate), /already active/);
    const overflow = await start("Other behavior");
    assert.match(JSON.stringify(overflow), /concurrency budget exhausted/);
    assert.equal(sessions, 3, "duplicate/overflow dispatch cannot reach the provider");
    release();
    await Promise.all(runs);
    const exhausted = await start("Payment retry contracts");
    assert.doesNotMatch(JSON.stringify(exhausted), /already active/);
    assert.equal(budget.snapshot().model_calls, 3, "finishing incomplete sessions must retain admitted usage");
    assert.equal(budget.snapshot().unreserved_calls, 0);
  } finally {
    release();
    await Promise.allSettled(runs);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
