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

  inspectionBlockReason(toolName: string): string | undefined {
    if (!this.due || !INSPECTION_TOOLS.has(toolName)) return undefined;
    return "A validated map checkpoint is required before further repository inspection. "
      + "Call write_map_delta now with evidence already observed; leave unsupported dimensions as gaps. "
      + "A rejected write or prose response does not complete the checkpoint.";
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
