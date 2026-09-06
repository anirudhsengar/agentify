import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { currentRepositoryCommit } from "./explorer-receipts.ts";
import { loadCanonicalMapAt } from "./map-storage.ts";
import { assessCoverageClosure } from "./schema.ts";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Launch the existing, accounted scout after real topography, not by model choice. */
export function withInitialScoutCheckpoint(
  tools: ReadonlyArray<ToolDefinition>,
  options: {
    stateDir: string;
    scout: ToolDefinition;
    onEvent: (event: AgentSessionEvent) => void;
  },
): ToolDefinition[] {
  let attempted = false;
  return tools.map((tool) => {
    if (tool.name !== "write_map" && tool.name !== "write_map_delta") return tool;
    return {
      ...tool,
      async execute(id, params, signal, onUpdate, ctx) {
        const written = await tool.execute(id, params, signal, onUpdate, ctx);
        if (attempted || signal?.aborted || (written as { isError?: boolean }).isError === true) return written;
        if (!record(written.details) || typeof written.details.path !== "string") return written;
        const map = loadCanonicalMapAt(ctx.cwd, options.stateDir);
        const commit = currentRepositoryCommit(ctx.cwd);
        if (!map || !commit || !assessCoverageClosure(map, { cwd: ctx.cwd }).closed.includes("D1_topography")) return written;
        if (map.explorer_receipts?.repository_commit === commit
          && map.explorer_receipts.receipts.some(receipt => receipt.mode === "concern_scout" && receipt.success)) return written;

        // Set before awaiting: concurrent map writes cannot launch duplicate scouts.
        // A failure stays unresolved; later model-directed attempts still use the
        // existing shared explorer/call/time budgets and duplicate-work guards.
        attempted = true;
        const toolCallId = `agentify-initial-scout:${id}`;
        const args = { mode: "concern_scout", target_path: "." };
        options.onEvent({ type: "tool_execution_start", toolCallId, toolName: "spawn_explorer", args });
        let result: Awaited<ReturnType<ToolDefinition["execute"]>>;
        try {
          signal?.throwIfAborted();
          result = await options.scout.execute(toolCallId, args, signal, undefined, ctx);
        } catch (error) {
          // These events describe an actual application dispatch, not a model
          // proposal or a fabricated successful receipt. Preserve the original error.
          options.onEvent({ type: "tool_execution_end", toolCallId, toolName: "spawn_explorer", isError: true,
            result: { content: [{ type: "text", text: "Application-dispatched initial scout did not complete." }],
              details: { mode: "concern_scout", target_path: "." } } });
          throw error;
        }
        const isError = signal?.aborted === true || (result as { isError?: boolean }).isError === true;
        options.onEvent({ type: "tool_execution_end", toolCallId, toolName: "spawn_explorer", result, isError });
        return {
          ...written,
          content: [...written.content,
            { type: "text" as const, text: isError
              ? "The mandatory initial scout failed or was cancelled. No successful scout receipt is granted."
              : "The application ran the mandatory initial scout. Screen its actual proposals, then trace the retained concerns; do not rerun broad scouting." },
            ...result.content],
        };
      },
    };
  });
}
