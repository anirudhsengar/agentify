#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  DraftPublicationAssessmentInput,
  TaskPlanningInput,
  TaskReadinessInput,
  TaskStateMutation,
} from "./contracts.ts";
import { parseTrustedIssueCommand } from "./commands.ts";
import {
  approveTask,
  beginTaskImplementation,
  recordBuilderCompletion,
  recordDraftPublication,
  recordReviewerVerdict,
  recordTaskPlan,
  recordTaskReadiness,
  recordValidationCompletion,
  replanTask,
  stopTask,
} from "./engine.ts";
import {
  assessBuilderResult,
  assessDraftPublication,
  assessReviewerVerdict,
  assessValidationResult,
  buildAcceptedTaskEvidence,
  buildBuilderRequest,
  buildValidationPlan,
} from "./execution.ts";
import { observeBuilderResult } from "./git-observer.ts";
import {
  projectionLabelsForTask,
  serializeGitHubTaskState,
  taskExplanation,
} from "./github-state.ts";
import { parseIssueSpecification } from "./issue.ts";
import {
  runBuilderModel,
  runPlannerModel,
  runReviewerModel,
  runSpecialistModel,
} from "./model-runtime.ts";
import {
  buildOrchestratorPlan,
  buildPlannerRefinementRequest,
  buildSpecialistConsultationRequest,
  loadCurrentSpecialistPortfolio,
} from "./planning.ts";
import { assessTaskReadiness } from "./readiness.ts";
import {
  validateAcceptedTaskEvidence,
  validateBuilderCallEvidence,
  validateBuilderRequest,
  validateBuilderResult,
  validateDurableTaskState,
  validateOrchestratorPlan,
  validatePlannerRefinementResult,
  validateReviewerVerdict,
  validateSpecialistConsultationResult,
  validateTaskLifecyclePolicy,
  validateTrustedIssueEvent,
  validateValidationPlan,
  validateValidationResult,
} from "./schema.ts";
import {
  applyTaskStateMutation,
  beginTaskRecovery,
  completeTaskRecovery,
  makeInitialTaskState,
  reconcileTaskModelCall,
  recordTaskExternalMutation,
  reserveTaskModelCall,
  taskBranchName,
  TaskLifecycleError,
} from "./state-machine.ts";
import { captureRepositorySnapshot, runValidationPlan } from "./validation-runner.ts";

const MAX_INPUT_BYTES = 2 * 1024 * 1024;

function readInput(filePath: string): unknown {
  const absolute = path.resolve(filePath);
  const stat = fs.statSync(absolute);
  if (!stat.isFile() || stat.size < 2 || stat.size > MAX_INPUT_BYTES) {
    throw new TaskLifecycleError("invalid_input", "task runtime input must be one bounded regular JSON file");
  }
  try {
    return JSON.parse(fs.readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new TaskLifecycleError(
      "invalid_input",
      `task runtime input is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskLifecycleError("invalid_input", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function writeOutput(filePath: string, value: unknown): void {
  const absolute = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, absolute);
}

async function dispatch(command: string, inputValue: unknown): Promise<unknown> {
  const input = object(inputValue, `${command} input`);
  switch (command) {
    case "parse-event":
      return parseTrustedIssueCommand(validateTrustedIssueEvent(input));
    case "validate-policy":
      return validateTaskLifecyclePolicy(input);
    case "validate-state":
      return validateDurableTaskState(input);
    case "validate-plan":
      return validateOrchestratorPlan(input);
    case "validate-planner":
      return validatePlannerRefinementResult(input);
    case "validate-specialist":
      return validateSpecialistConsultationResult(input);
    case "validate-builder-call":
      return validateBuilderCallEvidence(input);
    case "validate-builder-result":
      return validateBuilderResult(input);
    case "validate-validation-result":
      return validateValidationResult(input);
    case "validate-review":
      return validateReviewerVerdict(input);
    case "validate-accepted-evidence":
      return validateAcceptedTaskEvidence(input);
    case "render-state": {
      const state = validateDurableTaskState(input);
      return {
        body: serializeGitHubTaskState(state),
        labels: projectionLabelsForTask(state),
      };
    }
    case "initialize":
      return makeInitialTaskState(input as unknown as Parameters<typeof makeInitialTaskState>[0]);
    case "mutate":
      return applyTaskStateMutation(
        validateDurableTaskState(input.state),
        object(input.mutation, "task mutation") as unknown as TaskStateMutation,
      );
    case "reserve-model":
      return reserveTaskModelCall({
        ...(input as unknown as Omit<Parameters<typeof reserveTaskModelCall>[0], "state">),
        state: validateDurableTaskState(input.state),
      });
    case "reconcile-model":
      return reconcileTaskModelCall({
        ...(input as unknown as Omit<Parameters<typeof reconcileTaskModelCall>[0], "state">),
        state: validateDurableTaskState(input.state),
      });
    case "begin-recovery":
      return beginTaskRecovery({
        ...(input as unknown as Omit<Parameters<typeof beginTaskRecovery>[0], "state">),
        state: validateDurableTaskState(input.state),
      });
    case "record-external":
      return recordTaskExternalMutation({
        ...(input as unknown as Omit<Parameters<typeof recordTaskExternalMutation>[0], "state">),
        state: validateDurableTaskState(input.state),
      });
    case "complete-recovery":
      return completeTaskRecovery({
        ...(input as unknown as Omit<Parameters<typeof completeTaskRecovery>[0], "state">),
        state: validateDurableTaskState(input.state),
      });
    case "explain":
      return { explanation: taskExplanation(validateDurableTaskState(input)) };
    case "branch-name":
      return {
        branch: taskBranchName(Number(input.issue_number), String(input.issue_title ?? "task")),
      };
    case "parse-issue":
      return parseIssueSpecification(String(input.title ?? ""), String(input.body ?? ""));
    case "readiness":
      return assessTaskReadiness(input as unknown as TaskReadinessInput);
    case "record-readiness":
      return recordTaskReadiness({
        ...(input as unknown as Omit<Parameters<typeof recordTaskReadiness>[0], "state">),
        state: validateDurableTaskState(input.state),
      });
    case "plan-repository": {
      const cwd = String(input.cwd ?? ".");
      const portfolio = loadCurrentSpecialistPortfolio(cwd);
      return buildOrchestratorPlan({
        ...(input as unknown as Omit<TaskPlanningInput, "portfolio">),
        cwd,
        policy: validateTaskLifecyclePolicy(input.policy),
        portfolio,
      });
    }
    case "build-planner-request":
      return buildPlannerRefinementRequest({
        draft_plan: validateOrchestratorPlan(input.draft_plan),
      });
    case "run-planner-model":
      return runPlannerModel(input as unknown as Parameters<typeof runPlannerModel>[0]);
    case "build-specialist-request": {
      const cwd = String(input.cwd ?? ".");
      return buildSpecialistConsultationRequest({
        portfolio: loadCurrentSpecialistPortfolio(cwd),
        plan: validateOrchestratorPlan(input.plan),
        specialist_id: String(input.specialist_id ?? ""),
      });
    }
    case "run-specialist-model":
      return runSpecialistModel(input as unknown as Parameters<typeof runSpecialistModel>[0]);
    case "record-plan":
      return recordTaskPlan({
        ...(input as unknown as Omit<Parameters<typeof recordTaskPlan>[0], "state" | "plan" | "policy">),
        state: validateDurableTaskState(input.state),
        plan: validateOrchestratorPlan(input.plan),
        policy: validateTaskLifecyclePolicy(input.policy),
      });
    case "approve":
      return approveTask({
        ...(input as unknown as Omit<Parameters<typeof approveTask>[0], "state" | "policy">),
        state: validateDurableTaskState(input.state),
        policy: validateTaskLifecyclePolicy(input.policy),
      });
    case "stop":
      return stopTask({
        ...(input as unknown as Omit<Parameters<typeof stopTask>[0], "state">),
        state: validateDurableTaskState(input.state),
      });
    case "replan":
      return replanTask({
        ...(input as unknown as Omit<Parameters<typeof replanTask>[0], "state">),
        state: validateDurableTaskState(input.state),
      });
    case "begin-implementation":
      return beginTaskImplementation({
        ...(input as unknown as Omit<Parameters<typeof beginTaskImplementation>[0], "state">),
        state: validateDurableTaskState(input.state),
      });
    case "build-builder-request":
      return buildBuilderRequest({
        ...(input as unknown as Omit<Parameters<typeof buildBuilderRequest>[0], "state" | "plan" | "policy">),
        state: validateDurableTaskState(input.state),
        plan: validateOrchestratorPlan(input.plan),
        policy: validateTaskLifecyclePolicy(input.policy),
      });
    case "run-builder-model":
      return runBuilderModel({
        request: validateBuilderRequest(input.request),
        model: input.model as Parameters<typeof runBuilderModel>[0]["model"],
      });
    case "observe-builder":
      return observeBuilderResult({
        ...(input as unknown as Omit<Parameters<typeof observeBuilderResult>[0], "request" | "submission">),
        request: validateBuilderRequest(input.request),
        submission: input.submission as Parameters<typeof observeBuilderResult>[0]["submission"],
      });
    case "assess-builder":
      return assessBuilderResult(
        validateBuilderRequest(input.request),
        validateBuilderResult(input.result),
        validateTaskLifecyclePolicy(input.policy),
        String(input.now),
      );
    case "record-builder":
      return recordBuilderCompletion({
        ...(input as unknown as Omit<Parameters<typeof recordBuilderCompletion>[0], "state" | "builder">),
        state: validateDurableTaskState(input.state),
        builder: validateBuilderResult(input.builder),
      });
    case "build-validation-plan":
      return buildValidationPlan({
        state: validateDurableTaskState(input.state),
        plan: validateOrchestratorPlan(input.plan),
        builder: validateBuilderResult(input.builder),
        policy: validateTaskLifecyclePolicy(input.policy),
      });
    case "run-validation":
      return runValidationPlan(
        validateValidationPlan(input.plan),
        {
          ...(input.options as object | undefined),
          cwd: String(input.cwd ?? "."),
        } as Parameters<typeof runValidationPlan>[1],
      );
    case "snapshot":
      return captureRepositorySnapshot(String(input.cwd ?? "."));
    case "assess-validation":
      return assessValidationResult(
        validateValidationPlan(input.plan),
        validateValidationResult(input.result),
        String(input.now),
      );
    case "record-validation":
      return recordValidationCompletion({
        ...(input as unknown as Omit<Parameters<typeof recordValidationCompletion>[0], "state" | "validation">),
        state: validateDurableTaskState(input.state),
        validation: validateValidationResult(input.validation),
      });
    case "run-reviewer-model":
      return runReviewerModel(input as unknown as Parameters<typeof runReviewerModel>[0]);
    case "assess-review":
      return assessReviewerVerdict({
        reviewer: validateReviewerVerdict(input.reviewer),
        builder: validateBuilderResult(input.builder),
        validation: validateValidationResult(input.validation),
      });
    case "record-review":
      return recordReviewerVerdict({
        ...(input as unknown as Omit<Parameters<typeof recordReviewerVerdict>[0], "state" | "reviewer">),
        state: validateDurableTaskState(input.state),
        reviewer: validateReviewerVerdict(input.reviewer),
      });
    case "accepted-evidence":
      return buildAcceptedTaskEvidence({
        state: validateDurableTaskState(input.state),
        plan: validateOrchestratorPlan(input.plan),
        builder: validateBuilderResult(input.builder),
        validation: validateValidationResult(input.validation),
        reviewer: validateReviewerVerdict(input.reviewer),
        pull_request_number: Number(input.pull_request_number),
        source_artifact_url: String(input.source_artifact_url ?? ""),
      });
    case "publication":
      return assessDraftPublication({
        ...(input as unknown as DraftPublicationAssessmentInput),
        state: validateDurableTaskState(input.state),
        plan: validateOrchestratorPlan(input.plan),
        validation: validateValidationResult(input.validation),
        reviewer: validateReviewerVerdict(input.reviewer),
      });
    case "record-publication":
      return recordDraftPublication({
        ...(input as unknown as Omit<Parameters<typeof recordDraftPublication>[0], "state">),
        state: validateDurableTaskState(input.state),
      });
    default:
      throw new TaskLifecycleError("invalid_input", `unknown task runtime command ${command}`);
  }
}

async function main(): Promise<void> {
  const [command, inputPath, outputPath] = process.argv.slice(2);
  if (!command || !inputPath || !outputPath) {
    throw new TaskLifecycleError("invalid_input", "usage: task-runtime COMMAND INPUT.json OUTPUT.json");
  }
  const result = await dispatch(command, readInput(inputPath));
  writeOutput(outputPath, result);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`agentify task runtime failed: ${message.slice(0, 2_000)}`);
  process.exitCode = 1;
});
