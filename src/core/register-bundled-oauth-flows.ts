import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";

let registered = false;

/**
 * pi-ai loads OAuth flow implementations through bundler-opaque dynamic imports
 * (variable specifiers) so browser-oriented bundles can exclude the Node-only
 * flow code (`node:http` callback servers, `node:crypto` PKCE). Agentify ships
 * self-contained single-file Node bundles: those variable specifiers survive
 * bundling and then fail at runtime (e.g. `Cannot find module
 * dist/openai-codex.js`) on the first OAuth login, refresh, or `toAuth` call.
 * Registering the statically bundled flows makes every `login`/`refresh`/
 * `toAuth` path resolve in-process instead.
 */
export function registerBundledOAuthFlows(): void {
  if (registered) return;
  registerBunOAuthFlows();
  registered = true;
}
