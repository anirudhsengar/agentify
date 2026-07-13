import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const PathClassificationsSchema = Type.Object({
    zero_access: Type.Array(Type.String()),
    read_only: Type.Array(Type.String()),
    no_delete: Type.Array(Type.String()),
    fully_writable: Type.Array(Type.String()),
});

const SecurityChecklistSchema = Type.Object({
    tools: Type.Array(Type.String()),
    commands: Type.Array(Type.String()),
    paths: Type.Array(Type.String()),
    env: Type.Array(Type.String()),
    blocks: Type.Array(Type.String()),
    logs: Type.Array(Type.String()),
});

// Phase 2.9h — typed production credentials and external network calls.
const ProductionCredentialSchema = Type.Object({
    name: Type.String(),
    category: StringEnum([
        "database",
        "llm",
        "monitoring",
        "ci",
        "cloud",
        "other",
    ] as const),
});

const ExternalNetworkCallSchema = Type.Object({
    host: Type.String(),
    purpose: Type.String(),
});

// Phase 2.9h — typed damage control rules and escape hatch.
const DamageControlRulesSchema = Type.Object({
    bash_tool_patterns: Type.Array(Type.String()),
    zero_access_paths: Type.Array(Type.String()),
    read_only_paths: Type.Array(Type.String()),
    no_delete_paths: Type.Array(Type.String()),
});

const EscapeHatchSchema = Type.Object({
    blocking_unblock_path: Type.String(),
    escalation_contact: Type.Union([Type.String(), Type.Null()]),
});

// Phase 2.9h — typed banned interpreters.
const BannedInterpreterSchema = StringEnum([
    "python",
    "node",
    "bash",
    "sh",
    "ruby",
    "perl",
    "powershell",
    "zsh",
    "fish",
    "other",
] as const);

export const SecuritySurfaceSchema = Type.Object({
    paths: PathClassificationsSchema,
    bash_safe_patterns: Type.Array(Type.String()),
    bash_blocked_patterns: Type.Array(Type.String()),
    banned_interpreters: Type.Array(BannedInterpreterSchema),
    env_allowlist: Type.Array(Type.String()),
    production_credentials: Type.Array(ProductionCredentialSchema),
    // Backward-compat — v1 maps used a flat string array.
    production_credentials_v1: Type.Optional(Type.Array(Type.String())),
    damage_control_rules: Type.Array(Type.String()),
    security_checklist: SecurityChecklistSchema,
    // Phase 2.9h — additional D8 fields.
    damage_control_rules_typed: Type.Optional(DamageControlRulesSchema),
    escape_hatch: Type.Optional(EscapeHatchSchema),
    external_network_calls: Type.Optional(Type.Array(ExternalNetworkCallSchema)),
});
