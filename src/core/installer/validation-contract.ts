import type { InstallerCommand } from "./contracts.ts";

export const AGENTIFY_VALIDATION_SMOKE_COMMAND_ID = "test-agentify-validation-smoke";

export function isVerifiedValidationCommand(command: InstallerCommand): boolean {
  return command.kind !== "install"
    && command.required
    && command.assessment === "verified";
}

export function isRepositoryOwnedValidationCommand(command: InstallerCommand): boolean {
  return command.command_id !== AGENTIFY_VALIDATION_SMOKE_COMMAND_ID;
}

export function isVerifiedRepositoryTestCommand(command: InstallerCommand): boolean {
  return command.kind === "test"
    && isVerifiedValidationCommand(command)
    && isRepositoryOwnedValidationCommand(command);
}

export function verifiedRepositoryTestCommands(
  commands: ReadonlyArray<InstallerCommand>,
): InstallerCommand[] {
  return commands.filter(isVerifiedRepositoryTestCommand);
}

export function trustedValidationArgv(
  commands: ReadonlyArray<InstallerCommand>,
): string[][] {
  return commands
    .filter(isVerifiedValidationCommand)
    .filter(isRepositoryOwnedValidationCommand)
    .map((command) => [...command.argv]);
}
