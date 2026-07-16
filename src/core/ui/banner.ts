// ASCII brand banner printed by `agentify` on startup. The art is a
// hand-drawn block-letter render of the word "AGENTIFY" — selected
// during design review over a figlet-rendered or gradient-colored
// alternative. It is intentionally narrow enough that the banner
// plus a tagline fit comfortably inside a standard 80-column terminal.
//
// The banner prints plain text (no styling) on purpose: it must
// remain machine-greppable for log indexing, and the binary must
// stay free of a styling dependency for one print call.

/**
 * Seven-line ASCII block spelling AGENTIFY. Each row is exactly 67
 * characters wide (longest row, the top line, has a leading three-space
 * indent). Print with `process.stdout.write`.
 */
export const AGENTIFY_BANNER = [
  "   █████╗  ██████╗ ███████╗███╗   ██╗████████╗██╗███████╗██╗   ██╗",
  "  ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝██║██╔════╝╚██╗ ██╔╝",
  "  ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ██║█████╗   ╚████╔╝ ",
  "  ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ██║██╔══╝    ╚██╔╝  ",
  "  ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ██║██║        ██║   ",
  "  ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝╚═╝        ╚═╝   ",
].join("\n");

/**
 * Tagline printed under the banner. The leading "agentify" word is
 * kept lower-case to match the binary name; the version is pulled from
 * `readPackageVersion()` so it can never drift.
 */
export function bannerTagline(version: string): string {
  return `agentify v${version}  one command for the full life of an agentic codebase.`;
}

/**
 * Compose the full banner output (six art lines + tagline, each
 * terminated with a newline). The trailing newline is omitted so the
 * caller can decide whether to flush alongside other print calls.
 */
export function bannerLines(version: string): string {
  return `${AGENTIFY_BANNER}\n${bannerTagline(version)}`;
}

/**
 * Print the banner + tagline to `stream` (defaulting to stdout). Each
 * line ends with a newline; the tagline is followed by a blank line so
 * the next interactive prompt has visual breathing room.
 */
export function printBanner(version: string, stream: NodeJS.WritableStream = process.stdout): void {
  stream.write(`${bannerLines(version)}\n\n`);
}
