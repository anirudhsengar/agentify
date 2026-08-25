import * as path from "node:path";

// pi-coding-agent publishes with hasShrinkwrap, so npm installs its own nested
// copy of pi-ai and never dedupes it. Without intervention the bundle then
// contains TWO pi-ai module instances, and module-level state set through our
// direct pi-ai import (registerBundledOAuthFlowLoaders for OAuth flows) never
// reaches the copy that pi-coding-agent's ModelRuntime actually loads through.
// Resolve every bare pi-ai import — ours and pi-coding-agent's — to the single
// top-level copy. Shared with the bundling regression test so the test builds
// with exactly the production resolution behavior.
export function createSinglePiAiPlugin(repoRoot) {
  const topLevelPiAi = path.join(repoRoot, "node_modules", "@earendil-works", "pi-ai");
  return {
    name: "single-pi-ai",
    setup(build) {
      build.onResolve({ filter: /^@earendil-works\/pi-ai(\/.*)?$/ }, async (args) => {
        if (args.pluginData?.singlePiAi) return null;
        if (args.resolveDir.startsWith(topLevelPiAi + path.sep)) return null;
        const result = await build.resolve(args.path, {
          kind: args.kind,
          resolveDir: repoRoot,
          pluginData: { singlePiAi: true },
        });
        return result.errors.length > 0 ? null : result;
      });
    },
  };
}
