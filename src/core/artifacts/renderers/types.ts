export type ManagedArtifactKind =
  | "audit"
  | "harness_export"
  | "scaffold"
  | "state"
  | "prompt"
  | "skill"
  | "extension"
  | "expert"
  | "workflow";

export interface RenderedArtifact {
  relativePath: string;
  content: string;
  marker: string;
  kind: ManagedArtifactKind;
  required: boolean;
  source: string;
}

export interface RenderArtifactsResult {
  artifacts: RenderedArtifact[];
  errors: string[];
}

export interface StructuredRenderError {
  path: string;
  message: string;
}

export type ValidatedRenderResult = RenderArtifactsResult & {
  validationErrors: StructuredRenderError[];
};

export interface RenderContext {
  stateDir: string;
}
