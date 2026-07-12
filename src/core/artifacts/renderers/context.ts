import type { RenderContext } from "./types.ts";

// Deprecated direct callers retain the historical mutable default. Supported
// production orchestration always supplies an explicit RenderContext.
let legacyRendererStateDir = ".pi";

/** @deprecated Pass an explicit RenderContext to render functions. */
export function setRendererStateDir(stateDir: string): void {
  legacyRendererStateDir = stateDir;
}

export function resolveRenderContext(
  context?: RenderContext | { stateDir?: string },
): RenderContext {
  return { stateDir: context?.stateDir ?? legacyRendererStateDir };
}
