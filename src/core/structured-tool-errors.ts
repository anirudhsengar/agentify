import type { AgentSession } from "@earendil-works/pi-coding-agent";

type ToolResultAgent = Pick<AgentSession["agent"], "afterToolCall">;

/** Preserve application-returned rejections across the SDK's tool-result bridge. */
export function bindStructuredToolErrors(agent: ToolResultAgent): void {
  const previous = agent.afterToolCall;
  agent.afterToolCall = async (context, signal) => {
    // Agentify tools return structured failure details; the SDK otherwise marks
    // every normally resolved execute() as successful, even with isError=true.
    const rejected = context.isError || (context.result as { isError?: unknown }).isError === true;
    const result = await previous?.({ ...context, isError: rejected }, signal);
    // Preserve extension content/details/usage, and never turn a failure into
    // success. No tool exception is introduced or diagnostic record discarded.
    return rejected ? { ...result, isError: true } : result;
  };
}
