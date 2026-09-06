const INSPECTION_TOOLS = new Set(["read", "grep", "find", "ls"]);
const CHECKPOINT_TOOLS = new Set(["write_map", "write_map_delta"]);
const INSPECTIONS_PER_CHECKPOINT = 4;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Schedules evidence checkpoints; it never approves evidence or changes budgets. */
export class AuditCheckpointCadence {
  #inspections = 0;

  get due(): boolean {
    return this.#inspections >= INSPECTIONS_PER_CHECKPOINT;
  }

  observe(event: unknown): void {
    if (!record(event) || event.type !== "tool_execution_end" || event.isError !== false) return;
    if (typeof event.toolName !== "string") return;
    if (INSPECTION_TOOLS.has(event.toolName)) {
      this.#inspections = Math.min(this.#inspections + 1, INSPECTIONS_PER_CHECKPOINT);
      return;
    }
    if (!CHECKPOINT_TOOLS.has(event.toolName) || !record(event.result) || event.result.isError === true) return;
    const details = event.result.details;
    if (record(details) && typeof details.path === "string" && details.path.length > 0) {
      this.#inspections = 0;
    }
  }
}
