import type {
  ParsedIssueCommand,
  RepositoryPermission,
  TaskCommandKind,
  TrustedIssueEvent,
} from "./contracts.ts";
import { redactTaskText } from "./serialization.ts";

const AUTHORIZED_PERMISSIONS = new Set<RepositoryPermission>(["write", "maintain", "admin"]);
const QUEUE_LABELS = new Set(["agentify:queue"]);
const COMMANDS = new Map<string, TaskCommandKind>([
  ["/agent approve", "approve"],
  ["/agent stop", "stop"],
  ["/agent retry", "retry"],
  ["/agent replan", "replan"],
  ["/agent explain", "explain"],
]);

function eventId(event: TrustedIssueEvent): string {
  const suffix = event.comment_id === null
    ? `label:${event.label_name ?? "none"}`
    : `comment:${event.comment_id}`;
  return `${event.delivery_id}:${suffix}`;
}

function rejected(
  event: TrustedIssueEvent,
  disposition: "ignored" | "unauthorized" | "invalid",
  reason: string,
): ParsedIssueCommand {
  return {
    disposition,
    command: null,
    event_id: eventId(event),
    issue_number: event.issue_number,
    reason: redactTaskText(reason, 500),
  };
}

function normalizedCommand(body: string): string | null {
  if (Buffer.byteLength(body, "utf8") > 16_000 || body.includes("\0")) return null;
  const lines = body.replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) return null;
  const command = lines[0].toLowerCase();
  return COMMANDS.has(command) ? command : null;
}

export function actorMayMutateTask(event: TrustedIssueEvent): boolean {
  return event.actor.type === "User" && AUTHORIZED_PERMISSIONS.has(event.actor.permission);
}

export function parseTrustedIssueCommand(event: TrustedIssueEvent): ParsedIssueCommand {
  if (event.installation_repository_id !== event.repository.repository_id) {
    return rejected(event, "invalid", "event repository does not match the installed repository identity");
  }
  if (event.issue_is_pull_request) {
    return rejected(event, "ignored", "task lifecycle commands are accepted only on GitHub issues");
  }
  if (event.issue_state !== "open") {
    return rejected(event, "ignored", "closed issues cannot start or mutate an Agentify task");
  }
  if (!actorMayMutateTask(event)) {
    return rejected(event, "unauthorized", "actor does not hold trusted repository write permission");
  }

  if (event.event_name === "issues") {
    if (event.action !== "labeled" || !event.label_name || !QUEUE_LABELS.has(event.label_name)) {
      return rejected(event, "ignored", "issue event is not an Agentify queue-label delivery");
    }
    return {
      disposition: "accepted",
      command: "queue",
      event_id: eventId(event),
      issue_number: event.issue_number,
      actor: event.actor,
    };
  }

  if (event.event_name !== "issue_comment" || event.action !== "created") {
    return rejected(event, "ignored", "only newly created issue comments can carry Agentify commands");
  }
  if (
    event.comment_id === null
    || event.comment_body === null
    || event.comment_created_at === null
    || event.comment_updated_at === null
  ) {
    return rejected(event, "invalid", "comment identity or timestamps cannot be verified");
  }
  if (event.comment_created_at !== event.comment_updated_at) {
    return rejected(event, "ignored", "edited comment deliveries are not authoritative commands");
  }
  const normalized = normalizedCommand(event.comment_body);
  if (!normalized) {
    return rejected(event, "ignored", "comment is not one exact supported Agentify command");
  }
  const command = COMMANDS.get(normalized);
  if (!command) return rejected(event, "ignored", "unknown Agentify command");
  return {
    disposition: "accepted",
    command,
    event_id: eventId(event),
    issue_number: event.issue_number,
    actor: event.actor,
  };
}

export function supportedIssueCommandHelp(): string {
  return [
    "Queue with the `agentify:queue` label, then use one exact command on its own line:",
    "`/agent approve`, `/agent stop`, `/agent retry`, `/agent replan`, or `/agent explain`.",
    "Only authorized human repository writers can mutate task state.",
  ].join(" ");
}
