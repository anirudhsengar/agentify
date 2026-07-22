import { StringEnum } from "@earendil-works/pi-ai";
import type { Static } from "typebox";

export const ENGAGEMENT_STATUSES = [
  "draft",
  "qualified",
  "auditing",
  "mapped",
  "prioritized",
  "designing",
  "building",
  "evaluating",
  "shadow",
  "draft_pilot",
  "pilot",
  "measuring",
  "completed",
  "stopped",
] as const;

export const EngagementStatusSchema = StringEnum(ENGAGEMENT_STATUSES, {
  description: "Current lifecycle stage of an FDE engagement.",
});

export type EngagementStatus = Static<typeof EngagementStatusSchema>;
