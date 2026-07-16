// Public entry for the agentify UI layer. Three things ship here:
//
//   - `printBanner` — the ASCII + tagline banner printed once per
//     invocation when stdout is a TTY and `AGENTIFY_OLD_UI` is unset.
//
//   - `ClackUi` — the supported default `AgentifyUi` implementation in
//     0.2.x. Backed by `@clack/prompts` so the first-run pickers are
//     searchable and the secret prompt is masked.
//
//   - `ConsoleUi` — the historic hand-rolled `node:readline/promises`
//     implementation. Kept behind the `AGENTIFY_OLD_UI=1` env flag for
//     users who hit a terminal incompatibility.
//
//   - `startSpinner` — `clack.spinner()` wrapped with TTY gating and a
//     coarse-grained update API for the audit pipeline.

export { AGENTIFY_BANNER, bannerLines, bannerTagline, printBanner } from "./banner.ts";
export { ClackUi } from "./clack-ui.ts";
export { ConsoleUi } from "./console-ui.ts";
export { startSpinner, type SpinnerHandle, type SpinnerKind } from "./spinner.ts";
