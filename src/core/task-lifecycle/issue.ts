import type { IssueAcceptanceCriterion, TaskImplementationStep } from "./contracts.ts";
import { digestTaskValue, normalizeTaskPaths, redactTaskText, taskSlug } from "./serialization.ts";

export interface ParsedIssueSpecification {
  task_summary: string;
  acceptance_criteria: IssueAcceptanceCriterion[];
  candidate_paths: string[];
  excluded_paths: string[];
  implementation_steps: TaskImplementationStep[];
}

interface MarkdownSection {
  heading: string;
  lines: string[];
}

function sections(body: string): MarkdownSection[] {
  const result: MarkdownSection[] = [{ heading: "", lines: [] }];
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) result.push({ heading: heading[1].trim().toLowerCase(), lines: [] });
    else result[result.length - 1].lines.push(line);
  }
  return result;
}

function bullets(section: MarkdownSection): string[] {
  return section.lines
    .map((line) => /^\s*(?:[-*+] |\d+[.)]\s+|\[[ xX]\]\s*)(.+?)\s*$/.exec(line)?.[1]?.trim() ?? "")
    .filter(Boolean);
}

function normalizeInlinePath(value: string): string {
  const trimmed = value.trim();
  const inlineCode = /^`([^`]+)`$/.exec(trimmed);
  return (inlineCode?.[1] ?? trimmed).trim();
}

function pathCandidates(section: MarkdownSection): string[] {
  const values: string[] = [];
  for (const line of section.lines) {
    for (const match of line.matchAll(/`([^`]+)`/g)) values.push(match[1].trim());
    const bullet = /^\s*(?:[-*+] |\d+[.)]\s+)([^\s]+)\s*$/.exec(line)?.[1];
    if (bullet) values.push(normalizeInlinePath(bullet));
  }
  return values.map(normalizeInlinePath).filter((value) =>
    !value.includes(" ")
    && !value.startsWith("/")
    && !value.includes("\0")
    && (value.includes("/") || /\.[A-Za-z0-9]+$/.test(value))
  );
}

function firstParagraph(body: string): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const collected: string[] = [];
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) continue;
    if (line.trim() === "") {
      if (collected.length > 0) break;
      continue;
    }
    if (/^\s*(?:[-*+] |\d+[.)]\s+)/.test(line)) continue;
    collected.push(line.trim());
  }
  return collected.join(" ");
}

export function parseIssueSpecification(title: string, body: string): ParsedIssueSpecification {
  const parsedSections = sections(body);
  const acceptance = parsedSections.filter((section) =>
    /^(?:acceptance criteria|definition of done|requirements?|success criteria)$/.test(section.heading)
  ).flatMap(bullets);
  const inScope = parsedSections.filter((section) =>
    /^(?:scope|in scope|paths?|files?|implementation scope)$/.test(section.heading)
  ).flatMap(pathCandidates);
  const excluded = parsedSections.filter((section) =>
    /^(?:out of scope|excluded paths?|do not change|non-goals?)$/.test(section.heading)
  ).flatMap(pathCandidates);
  const criteria = acceptance.slice(0, 64).map((statement, index) => ({
    criterion_id: `criterion-${index + 1}-${digestTaskValue(statement).slice(0, 8)}`,
    statement: redactTaskText(statement, 4_000),
    verification: `Verify deterministically that: ${redactTaskText(statement, 3_900)}`,
  }));
  const candidatePaths = normalizeTaskPaths(inScope.slice(0, 512));
  const excludedPaths = normalizeTaskPaths(excluded.slice(0, 512));
  const taskSummary = redactTaskText([title.trim(), firstParagraph(body)].filter(Boolean).join(" — "), 8_000);
  const steps: TaskImplementationStep[] = criteria.map((criterion, index) => ({
    step_id: `step-${index + 1}-${taskSlug(criterion.statement, 24)}`,
    description: criterion.statement,
    in_scope_paths: candidatePaths,
    required_procedure_ids: [],
    validation_command_ids: [],
  }));
  return {
    task_summary: taskSummary || "Authorized GitHub issue",
    acceptance_criteria: criteria,
    candidate_paths: candidatePaths,
    excluded_paths: excludedPaths,
    implementation_steps: steps.length > 0 ? steps : [{
      step_id: "step-1-clarify",
      description: "Implement the accepted issue after deterministic clarification.",
      in_scope_paths: candidatePaths,
      required_procedure_ids: [],
      validation_command_ids: [],
    }],
  };
}
