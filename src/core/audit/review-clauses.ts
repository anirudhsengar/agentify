/** Exact assertion fragments, never inferred facts or replacements for whole claims. */
export function addCompoundReviewChecks(
  original: Record<string, unknown>, observedPaths: ReadonlySet<string>,
): Record<string, unknown> {
  const extra: Array<[string, unknown]> = [];
  for (const [id, value] of Object.entries(original)) {
    const kind = /^(pitfalls|invariants)\[[0-9]+\]$/.exec(id)?.[1];
    if (!kind || value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as Record<string, unknown>;
    if (typeof item.reference !== "string" || !observedPaths.has(item.reference)) continue;
    for (const field of kind === "pitfalls" ? ["risk", "consequence"] : ["rule", "why"]) {
      const text = item[field];
      if (typeof text !== "string") continue;
      const pieces = assertionFragments(text);
      if (pieces.length < 2) continue;
      pieces.forEach((fragment, index) => {
        const key = `clause:${id}.${field}:${index}`;
        if (Object.hasOwn(original, key)) throw new Error("review clause ID conflicts with an original claim");
        extra.push([key, { original_claim: id, original_field: field, reference: item.reference,
          assertion_fragment: fragment }]);
      });
    }
  }
  if (Object.keys(original).length + extra.length > 512) throw new Error("review claim budget exceeded by compound assertions");
  // The original complete claims remain mandatory. No original byte, condition,
  // structural relation or evidence reference is substituted by the fragments.
  return extra.length === 0 ? original : { ...original, ...Object.fromEntries(extra) };
}

function assertionFragments(text: string): string[] {
  const pieces: string[] = [];
  const boundary = /[.!?](?=\s+[A-Z])|;(?=\s)|,(?=\s+(?:so|therefore|thus|hence|otherwise)\b)/g;
  let start = 0;
  let scanned = 0;
  let code = false;
  for (const match of text.matchAll(boundary)) {
    const index = match.index!;
    // A quoted code span may contain punctuation that is not prose. An
    // unmatched opening backtick conservatively leaves the remainder intact.
    for (; scanned < index; scanned += 1) {
      if (text[scanned] === "`" && text[scanned - 1] !== "\\") code = !code;
    }
    if (code) continue;
    const end = index + match[0].length;
    pieces.push(text.slice(start, end));
    start = end;
  }
  pieces.push(text.slice(start));
  return pieces.filter(piece => piece.trim().length > 0);
}
