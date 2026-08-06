/**
 * Complete installed CLI command inventory.
 */
export const PUBLIC_SUBCOMMAND_NAMES = ["login", "logout", "models"] as const;
export type PublicSubcommandName = (typeof PUBLIC_SUBCOMMAND_NAMES)[number];

/** Print help for one public maintenance command without reading or mutating state. */
export function printPublicCommandHelp(
  name: PublicSubcommandName,
  out: NodeJS.WritableStream,
): void {
  if (name === "login") {
    out.write(`Usage: agentify login [--provider <name>]\n\n`);
    out.write(`Configure provider credentials outside repository state.\n`);
    out.write(`Credentials are read from provider environment variables or a masked interactive prompt.\n`);
    out.write(`OAuth-only providers print their supported login instructions.\n`);
    return;
  }
  if (name === "logout") {
    out.write(`Usage: agentify logout [--provider <name> | --all] [--yes]\n\n`);
    out.write(`Remove one stored provider credential or clear all stored auth.\n`);
    return;
  }
  if (name === "models") {
    out.write(`Usage:\n`);
    out.write(`  agentify models list [--provider <name>]\n`);
    out.write(`  agentify models show [--resolved]\n`);
    out.write(`  agentify models set <provider>/<model>\n`);
    out.write(`  agentify models set <primary|explorer|lite> <provider>/<model>\n`);
    out.write(`  agentify models unset [primary|explorer|lite]\n\n`);
    out.write(`List or configure model assignments for the persistent team.\n`);
    return;
  }
}

/**
 * Public maintenance help shared by the installed CLI and contract tests.
 * No internal/operator command is dispatchable through the installed binary.
 */
export function printPublicSubcommandHelp(out: NodeJS.WritableStream): void {
  out.write(`\nProvider and model configuration:\n`);
  out.write(`  agentify login [--provider <name>]\n`);
  out.write(`    Configure a provider outside repository state. Environment\n`);
  out.write(`    credentials remain in the environment; OAuth-only providers\n`);
  out.write(`    print their supported login instructions.\n`);
  out.write(`  agentify logout [--provider <name> | --all] [--yes]\n`);
  out.write(`    Remove one stored provider credential or clear all stored auth.\n`);
  out.write(`  agentify models list [--provider <name>]\n`);
  out.write(`    List models available with the current provider credentials.\n`);
  out.write(`  agentify models show [--resolved]\n`);
  out.write(`    Show configured and resolved model assignments.\n`);
  out.write(`  agentify models set <provider>/<model>\n`);
  out.write(`  agentify models set <primary|explorer|lite> <provider>/<model>\n`);
  out.write(`    Configure the default model or one persistent team role.\n`);
  out.write(`  agentify models unset [primary|explorer|lite]\n`);
  out.write(`    Clear the default model or a named role assignment.\n`);
}
