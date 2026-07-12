import type { CodebaseMap } from "../../audit/schema.ts";

export function nonEmptyCommand(command: string | null | undefined): string | null {
  const trimmed = command?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function uniqueCommands(commands: string[]): string[] {
  return [...new Set(commands.map((command) => command.trim()).filter((command) => command.length > 0))];
}

export function repositoryValidationCommands(map: CodebaseMap): string[] {
  return uniqueCommands([
    map.validation_surface.typecheck_command,
    map.validation_surface.lint_command,
    map.validation_surface.test_command,
    map.validation_surface.e2e_command,
  ].map(nonEmptyCommand).filter((command): command is string => command !== null));
}

function changeTypeValidationEntries(map: CodebaseMap): Array<{ changeType: string; mandatory: string[] }> {
  return Object.entries(map.validation_surface.per_change_type).map(([changeType, commands]) => ({
    changeType,
    mandatory: uniqueCommands(commands.mandatory),
  }));
}

export function changeTypeValidationLines(map: CodebaseMap): string[] {
  return changeTypeValidationEntries(map).map(({ changeType, mandatory }) => {
    const commands = mandatory.map((command) => `\`${command}\``).join(", ") || "none";
    return `- ${changeType}: ${commands}`;
  });
}

export function mandatoryChangeTypeCommands(map: CodebaseMap): string[] {
  return uniqueCommands(changeTypeValidationEntries(map).flatMap((entry) => entry.mandatory));
}
