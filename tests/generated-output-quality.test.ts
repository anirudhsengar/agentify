import { testTypescriptCliFallbackSurfaceIsActionable } from "./generated-output-quality.typescript-cli.case.ts";
import { testMonorepoFallbackSurfaceKeepsPackageBoundaries } from "./generated-output-quality.monorepo.case.ts";
import { testFrontendFallbackSurfaceKeepsUserWorkflowValidation } from "./generated-output-quality.frontend.case.ts";
import { testBackendServiceSurfaceKeepsOperationalBoundaries } from "./generated-output-quality.backend.case.ts";
import { testSparseTestRepoIsHonestAboutMissingValidation } from "./generated-output-quality.sparse-tests.case.ts";
import { testCliWithNoTestsKeepsTypecheckAsPrimaryValidation } from "./generated-output-quality.cli-no-tests.case.ts";
import { testSmallLibrarySurfacePreservesPublicApiCompatibility } from "./generated-output-quality.small-library.case.ts";
import { testGeneratedCodeSurfacePreservesSourceOfTruthBoundaries } from "./generated-output-quality.generated-code.case.ts";
import { testGeneratedSkillsFeedbackDocsAndPitfallsAreOperational } from "./generated-output-quality.skills-feedback.case.ts";
import { testRailsStyleSurfacePreservesMvcAndJobBoundaries } from "./generated-output-quality.rails.case.ts";
import { testStrongDomainDocsArePreservedAndRoutable } from "./generated-output-quality.domain-docs.case.ts";
import { testExpertSurfaceCarriesActionableDomainKnowledge } from "./generated-output-quality.expert-surface.case.ts";
import { testExpertPlanPromptForcesCitedRiskAwarePlanning } from "./generated-output-quality.expert-plan.case.ts";

testTypescriptCliFallbackSurfaceIsActionable();
testMonorepoFallbackSurfaceKeepsPackageBoundaries();
testFrontendFallbackSurfaceKeepsUserWorkflowValidation();
testBackendServiceSurfaceKeepsOperationalBoundaries();
testSparseTestRepoIsHonestAboutMissingValidation();
testCliWithNoTestsKeepsTypecheckAsPrimaryValidation();
testSmallLibrarySurfacePreservesPublicApiCompatibility();
testGeneratedCodeSurfacePreservesSourceOfTruthBoundaries();
testGeneratedSkillsFeedbackDocsAndPitfallsAreOperational();
testRailsStyleSurfacePreservesMvcAndJobBoundaries();
testStrongDomainDocsArePreservedAndRoutable();
testExpertSurfaceCarriesActionableDomainKnowledge();
testExpertPlanPromptForcesCitedRiskAwarePlanning();

console.log("generated-output quality tests passed.");
