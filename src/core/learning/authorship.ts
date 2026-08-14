import type { AcceptedChangeAuthorKind } from "./contracts.ts";

export function learningAuthorshipTag(
  authorKind: AcceptedChangeAuthorKind,
): "agentify-authored" | "human-authored" | "unknown-authored" {
  switch (authorKind) {
    case "agentify": return "agentify-authored";
    case "human": return "human-authored";
    case "unknown": return "unknown-authored";
  }
}
