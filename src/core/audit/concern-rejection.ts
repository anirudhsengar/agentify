const ACCEPTANCE_WORDING = [
  /\bnot\s+rejected\b/i,
  /\baccepted\s+for\s+(?:tracing|inclusion|the\s+portfolio)\b/i,
  /\bretained\s+for\s+(?:tracing|inclusion|the\s+portfolio)\b/i,
] as const;

export function explicitlyAcceptsConcern(whyRejected: string): boolean {
  return ACCEPTANCE_WORDING.some((pattern) => pattern.test(whyRejected));
}

/** True only when the explanation actually rejects the candidate. */
export function isSubstantiveConcernRejection(whyRejected: string): boolean {
  const explanation = whyRejected.trim();
  return explanation.length >= 20
    && !explicitlyAcceptsConcern(explanation);
}
