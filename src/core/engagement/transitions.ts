import type { EngagementStatus } from "./schema/engagement-status.ts";
import { EngagementError } from "./errors.ts";

const LEGAL_TRANSITIONS: Readonly<Record<EngagementStatus, readonly EngagementStatus[]>> = {
  draft: ["qualified", "stopped"],
  qualified: ["auditing", "stopped"],
  auditing: ["mapped", "stopped"],
  mapped: ["prioritized", "stopped"],
  prioritized: ["designing", "stopped"],
  designing: ["building", "stopped"],
  building: ["evaluating", "stopped"],
  evaluating: ["shadow", "building", "stopped"],
  shadow: ["draft_pilot", "building", "stopped"],
  draft_pilot: ["pilot", "building", "stopped"],
  pilot: ["measuring", "building", "stopped"],
  measuring: ["completed", "pilot", "stopped"],
  completed: [],
  stopped: [],
};

export function assertLegalEngagementTransition(
  from: EngagementStatus,
  to: EngagementStatus,
  stopReason?: string,
): void {
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    throw new EngagementError("invalid_transition", `engagement cannot transition from ${from} to ${to}`);
  }
  if (to === "stopped" && (!stopReason || stopReason.trim().length === 0)) {
    throw new EngagementError("invalid_transition", "transitioning an engagement to stopped requires a non-empty stop reason");
  }
}

export function legalEngagementTransitions(status: EngagementStatus): readonly EngagementStatus[] {
  return LEGAL_TRANSITIONS[status];
}
