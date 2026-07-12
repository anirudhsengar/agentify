import { defaultConfigDir, ensureAgentifyConfig } from "./agentify-config.ts";
import { ProjectClassifier } from "./project-classifier.ts";
import type { ProjectKind, RunAgentifyOptions } from "./types.ts";
import { createRunContext } from "./runs/run-context.ts";
import { runBrownfieldAudit } from "./runs/brownfield-run.ts";
import { runGreenfield } from "./runs/greenfield-run.ts";
import { applyStagedBundle } from "./generation/apply-bundle.ts";
import { collectAuditArtifactSnapshot } from "./generation/artifact-snapshot.ts";
import { writeRenderedArtifactsToStaging } from "./generation/staging-bundle.ts";

export {
  applyStagedBundle,
  collectAuditArtifactSnapshot,
  writeRenderedArtifactsToStaging,
};

async function chooseAmbiguousKind(options: RunAgentifyOptions): Promise<ProjectKind> {
  const value = await options.ui.promptSelect(
    "This repository is ambiguous. Should agentify audit existing files or start a new-project chat?",
    [
      { label: "Audit existing files", value: "brownfield" },
      { label: "Start new project chat", value: "greenfield" },
    ],
  );
  return value === "greenfield" ? "greenfield" : "brownfield";
}

export async function runAgentify(options: RunAgentifyOptions): Promise<void> {
  const config = options.configOverride
    ?? await ensureAgentifyConfig(defaultConfigDir(), options.ui);
  const classification = options.mode
    ? { kind: options.mode }
    : ProjectClassifier.classify(options.cwd);
  let kind = classification.kind;
  if (kind === "ambiguous") {
    kind = await chooseAmbiguousKind(options);
  }

  const context = createRunContext(options, config);
  if (kind === "greenfield") {
    await runGreenfield(context);
    return;
  }
  await runBrownfieldAudit(context);
}
