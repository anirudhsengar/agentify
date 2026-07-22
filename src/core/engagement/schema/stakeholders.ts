import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { NonEmptyStringSchema, StableIdSchema } from "./primitives.ts";

export const StakeholderRoleSchema = StringEnum([
  "executive_sponsor", "business_owner", "workflow_owner", "daily_user",
  "technical_owner", "security_reviewer", "compliance_reviewer", "approver", "maintainer",
] as const);

export const StakeholderSchema = Type.Object({
  stakeholder_id: StableIdSchema,
  name: NonEmptyStringSchema,
  roles: Type.Array(StakeholderRoleSchema, { minItems: 1, maxItems: 9 }),
  decision_rights: Type.Array(NonEmptyStringSchema, { maxItems: 50 }),
  escalation_contact: Type.Boolean(),
  goals: Type.Array(NonEmptyStringSchema, { maxItems: 50 }),
  concerns: Type.Array(NonEmptyStringSchema, { maxItems: 50 }),
}, { additionalProperties: false });

export const StakeholderRegisterSchema = Type.Object({
  schema_version: Type.Literal("1"),
  engagement_id: StableIdSchema,
  stakeholders: Type.Array(StakeholderSchema, { minItems: 1, maxItems: 500 }),
  workflow_owner_id: StableIdSchema,
  adoption_owner_id: StableIdSchema,
}, { additionalProperties: false, description: "People, roles, ownership, decision rights, and escalation paths." });

export type Stakeholder = Static<typeof StakeholderSchema>;
export type StakeholderRegister = Static<typeof StakeholderRegisterSchema>;
