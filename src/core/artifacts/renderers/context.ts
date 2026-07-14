import type { RenderContext } from "./types.ts";

export function resolveRenderContext(context: RenderContext): RenderContext {
  return { stateDir: context.stateDir };
}
