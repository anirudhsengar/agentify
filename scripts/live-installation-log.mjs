import assert from "node:assert/strict";

const RELEVANT_EVENTS = new Set(["agentify.run_start", "agentify.audit_budget", "agentify.run_end"]);

/** AgentifyLog JSONL envelopes may contain a redacted, JSON-serialized payload. */
export function summarizeInstallationEvents(events) {
  const selected = events.filter((event) => RELEVANT_EVENTS.has(event?.event)).map((event) => {
    const payload = typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload;
    assert.ok(payload !== null && typeof payload === "object" && !Array.isArray(payload),
      `invalid ${event.event} payload`);
    return { ...event, payload };
  });
  return {
    terminals: selected.filter((event) => event.event === "agentify.run_end").map((event) => event.payload),
    budget: selected.filter((event) => event.event === "agentify.audit_budget").at(-1)?.payload ?? null,
    model: selected.find((event) => event.event === "agentify.run_start")?.payload?.model ?? null,
  };
}
