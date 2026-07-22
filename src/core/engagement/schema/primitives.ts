import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const NonEmptyStringSchema = Type.String({ minLength: 1, maxLength: 4_000 });
export const StableIdSchema = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" });
export const EvidenceReferencesSchema = Type.Array(NonEmptyStringSchema, { maxItems: 500 });
export const ScoreSchema = Type.Number({ minimum: 0, maximum: 100 });
export const FivePointSchema = Type.Integer({ minimum: 1, maximum: 5 });
export const ConfidenceSchema = StringEnum(["low", "medium", "high"] as const);
