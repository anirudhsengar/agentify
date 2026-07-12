import type { CodebaseMap } from "./schema.ts";

/**
 * Interpret documented typed-versus-legacy aliases without modifying the
 * schema contract. Presence of a modern field wins even when its value is
 * empty or false; legacy fields are fallback-only.
 */
type Lifecycle = CodebaseMap["meta"]["lifecycle"];
type Meta = CodebaseMap["meta"];
type Skeleton = CodebaseMap["skeleton"];
type TypeContractSurface = CodebaseMap["type_contract_surface"];
type SecuritySurface = CodebaseMap["security_surface"];
type ApiContract = NonNullable<TypeContractSurface["api_contracts"]>[number];
type ProductionCredential = SecuritySurface["production_credentials"][number];

export type LifecycleCompatibilityInput = Partial<Pick<
    Lifecycle,
    | "review_loop"
    | "documentation_loop"
    | "conditional_docs"
    | "has_review_loop"
    | "has_documentation_loop"
    | "has_conditional_docs"
>>;

export interface ResolvedLifecyclePresence {
    reviewLoop: boolean;
    documentationLoop: boolean;
    conditionalDocs: boolean;
}

export function resolveLifecyclePresence(
    lifecycle: LifecycleCompatibilityInput,
): ResolvedLifecyclePresence {
    return {
        reviewLoop: lifecycle.review_loop?.present ?? lifecycle.has_review_loop ?? false,
        documentationLoop:
            lifecycle.documentation_loop?.present
            ?? lifecycle.has_documentation_loop
            ?? false,
        conditionalDocs:
            lifecycle.conditional_docs?.present
            ?? lifecycle.has_conditional_docs
            ?? false,
    };
}

export type FrameworkMetaCompatibilityInput = Partial<Pick<Meta, "frameworks">>;
export type FrameworkSkeletonCompatibilityInput = Partial<Pick<Skeleton, "frameworks">>;

export interface ResolvedFrameworks {
    source: "meta" | "skeleton" | "none";
    frameworks: string[];
}

export function resolveFrameworks(
    meta: FrameworkMetaCompatibilityInput | undefined,
    skeleton: FrameworkSkeletonCompatibilityInput | undefined,
): ResolvedFrameworks {
    if (meta?.frameworks !== undefined) {
        return { source: "meta", frameworks: [...meta.frameworks] };
    }
    if (skeleton?.frameworks !== undefined) {
        return { source: "skeleton", frameworks: [...skeleton.frameworks] };
    }
    return { source: "none", frameworks: [] };
}

export type TypeContractCompatibilityInput = Partial<Pick<
    TypeContractSurface,
    "api_contracts" | "openapi_or_graphql" | "synced_types" | "synced_types_observed"
>>;

export interface ResolvedApiContracts {
    source: "typed" | "legacy" | "none";
    contracts: ApiContract[];
}

export function resolveApiContracts(
    surface: TypeContractCompatibilityInput,
): ResolvedApiContracts {
    if (surface.api_contracts !== undefined) {
        return { source: "typed", contracts: [...surface.api_contracts] };
    }
    if (surface.openapi_or_graphql !== undefined && surface.openapi_or_graphql !== null) {
        return { source: "legacy", contracts: [surface.openapi_or_graphql] };
    }
    return { source: "none", contracts: [] };
}

export type ResolvedSyncedTypes =
    | { source: "typed"; synced: string[]; unsynced: string[] }
    | { source: "legacy"; observed: boolean }
    | { source: "none" };

export function resolveSyncedTypes(
    surface: TypeContractCompatibilityInput,
): ResolvedSyncedTypes {
    if (surface.synced_types !== undefined) {
        return {
            source: "typed",
            synced: [...surface.synced_types.synced],
            unsynced: [...surface.synced_types.unsynced],
        };
    }
    if (surface.synced_types_observed !== undefined) {
        return { source: "legacy", observed: surface.synced_types_observed };
    }
    return { source: "none" };
}

export type SecurityCompatibilityInput = Partial<Pick<
    SecuritySurface,
    "production_credentials" | "production_credentials_v1"
>>;

export type ResolvedProductionCredential =
    | {
        source: "typed";
        name: string;
        category: ProductionCredential["category"];
    }
    | {
        source: "legacy";
        name: string;
        category: null;
    };

export function resolveProductionCredentials(
    surface: SecurityCompatibilityInput,
): ResolvedProductionCredential[] {
    if (surface.production_credentials !== undefined) {
        return surface.production_credentials.map((credential) => ({
            source: "typed" as const,
            name: credential.name,
            category: credential.category,
        }));
    }
    return (surface.production_credentials_v1 ?? []).map((name) => ({
        source: "legacy" as const,
        name,
        category: null,
    }));
}
