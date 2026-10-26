import assert from "node:assert/strict";
import test from "node:test";
import { buildAssignmentModelSelections, resolveTurnModelSelection } from "../../src/state/agentModelRouting.ts";

test("direct specialist turns use the specialist's exact preference unless the user selects a model for this send", () => {
  const specialistModel = { providerConnectionId: "provider-cody", modelId: "model-cody" };
  const threadModel = { providerConnectionId: "provider-thread", modelId: "model-thread" };
  const explicitModel = { providerConnectionId: "provider-explicit", modelId: "model-explicit" };
  const preferences = { cody: { modelKey: "Cody Model", modelSelection: specialistModel } };

  assert.deepEqual(resolveTurnModelSelection(undefined, threadModel, "cody", preferences), specialistModel);
  assert.deepEqual(resolveTurnModelSelection(explicitModel, threadModel, "cody", preferences), explicitModel);
  assert.deepEqual(resolveTurnModelSelection(undefined, threadModel, undefined, preferences), threadModel);
  assert.equal(resolveTurnModelSelection(undefined, threadModel, "doc", preferences), undefined,
    "a specialist without an exact configured model must not inherit Maestro's thread model");
});

test("agent preferences preserve only explicit provider-qualified model identities", () => {
  const selections = buildAssignmentModelSelections({
    cody: { modelKey: "Cody Model", modelSelection: { providerConnectionId: "provider-cody", modelId: "model-cody" } },
    doc: { modelKey: "doc-model" },
    research: { modelKey: "duplicate" },
    tester: { modelKey: "disabled-model" },
  }, ["cody", "doc", "research", "tester"]);
  assert.deepEqual(selections, {
    cody: { providerConnectionId: "provider-cody", modelId: "model-cody" },
  });
});

test("stale explicit model identities are preserved for backend rejection instead of substitution", () => {
  assert.deepEqual(buildAssignmentModelSelections({
    cody: { modelKey: "removed-model", modelSelection: { providerConnectionId: "removed-provider", modelId: "removed-model" } },
  }, ["cody"]), { cody: { providerConnectionId: "removed-provider", modelId: "removed-model" } });
});

test("dynamic specialist preferences are sent under stable runtime identity while remaining keyed by UI identity", () => {
  const selection = { providerConnectionId: "provider-security", modelId: "model-security" };
  assert.deepEqual(buildAssignmentModelSelections({
    "security-reviewer": { modelKey: "Security model", modelSelection: selection },
  }, [{ preferenceId: "security-reviewer", definitionId: "definition-7e6b" }]), {
    "definition-7e6b": selection,
  });
  assert.deepEqual(resolveTurnModelSelection(undefined, undefined, "security-reviewer", {
    "security-reviewer": { modelKey: "Security model", modelSelection: selection },
  }), selection);
});

test("agent preferences preserve reasoningEffort alongside providerConnectionId and modelId", () => {
  const selections = buildAssignmentModelSelections({
    cody: { modelKey: "Cody Model", effort: "high", modelSelection: { providerConnectionId: "provider-cody", modelId: "model-cody", reasoningEffort: "high" } },
    research: { modelKey: "Research Model", effort: "low", modelSelection: { providerConnectionId: "provider-research", modelId: "model-research" } },
  }, ["cody", "research"]);
  assert.deepEqual(selections, {
    cody: { providerConnectionId: "provider-cody", modelId: "model-cody", reasoningEffort: "high" },
    research: { providerConnectionId: "provider-research", modelId: "model-research", reasoningEffort: "low" },
  });
});

