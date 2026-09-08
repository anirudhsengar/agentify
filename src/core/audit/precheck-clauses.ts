export interface PrecheckClause {
  original_claim: string;
  field: string;
  text: string;
  reference: string;
}

export interface PrecheckClausePlan {
  claims: Record<string, PrecheckClause>;
  original_claim_context: Record<string, unknown>;
}

/** Presentation boundaries, not a parser or a proof of natural-language meaning. */
function proseFragments(text: string): string[] {
  const fragments: string[] = [];
  let start = 0;
  const boundaryPattern = /(?<=[.!?;])\s+(?=[A-Z`])|,\s+(?=(?:so|but|however|therefore|yet|whereas)\b)|\s+(?=and\s+(?:is|are|was|were|has|have|does|do|can|cannot|will|would|should|must|returns?|raises?|throws?|sets?|stores?|writes?|reads?|calls?|uses?|creates?|deletes?|updates?|reports?|produces?|rejects?|accepts?|skips?|keeps?|loads?|checks?|requires?|allows?|disables?|enables?|remains?)\b)/g;
  for (const boundary of text.matchAll(boundaryPattern)) {
    const end = boundary.index! + boundary[0].length;
    fragments.push(text.slice(start, end));
    start = end;
  }
  fragments.push(text.slice(start));
  return fragments;
}

/** Give each compound fragment an independent checklist ID, preserving all prose. */
export function expandPrecheckClauses(original: Record<string, unknown>): PrecheckClausePlan | null {
  const clauses: PrecheckClause[] = [];
  let compound = false;
  for (const [id, value] of Object.entries(original)) {
    if (!/^(pitfalls|invariants)\[\d+\]$/.test(id)
      || value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const claim = value as Record<string, unknown>;
    if (typeof claim.reference !== "string") return null;
    for (const [field, text] of Object.entries(claim)) {
      if (field === "reference") continue;
      if (typeof text !== "string" || text.trim().length === 0) return null;
      const fragments = proseFragments(text);
      compound ||= fragments.length > 1;
      for (const fragment of fragments) {
        clauses.push({ original_claim: id, field, text: fragment, reference: claim.reference });
        // Retain the original precheck rather than emitting an oversized checklist.
        if (clauses.length > 128) return null;
      }
    }
  }
  return compound ? {
    claims: Object.fromEntries(clauses.map((clause, index) => [`clause_${index}`, clause])),
    original_claim_context: original,
  } : null;
}
