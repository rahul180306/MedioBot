import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { DurableTaskEngine } from "@mediobot-v2/runtime";
import { LocalDatabase } from "../../src/storage/db.ts";
import { SqliteDurableTaskStore } from "../../src/storage/durableTaskStore.ts";
import { ProviderRepository } from "../../src/storage/providerRepository.ts";
import { ModelResolver } from "../../src/runtime/modelRegistry.ts";
import { createComposition } from "../../src/composition.ts";

test("production composition enforces distinct model and reasoning effort routing across Maestro, Cody, and Doc", async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mediobot-model-routing-"));
  const workspaceRoot = path.join(directory, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(path.join(workspaceRoot, "sample.txt"), "hello world");

  const db = new LocalDatabase(path.join(directory, "mediobot.db"));
  const engine = new DurableTaskEngine(new SqliteDurableTaskStore(db.rawDb));
  const providers = new ProviderRepository(db.rawDb);

  // Set up distinct providers
  providers.save({ id: "prov-maestro", providerType: "custom", displayName: "Same Display Name", connected: true, enabled: true,
    baseUrl: "http://unused.invalid", models: [
      { id: "model-maestro", name: "Model A", enabled: true, capabilities: { text: true, reasoning: true, vision: false, tools: false } },
    ] });
  providers.save({ id: "prov-cody", providerType: "custom", displayName: "Same Display Name", connected: true, enabled: true,
    baseUrl: "http://unused.invalid", models: [
      { id: "model-cody", name: "Model B", enabled: true, capabilities: { text: true, reasoning: true, vision: false, tools: true } },
    ] });
  providers.save({ id: "prov-doc", providerType: "custom", displayName: "Same Display Name", connected: true, enabled: true,
    baseUrl: "http://unused.invalid", models: [
      { id: "model-doc", name: "Model C", enabled: true, capabilities: { text: true, reasoning: true, vision: false, tools: false } },
    ] });

  type CapturedCall = {
    modelId: string;
    reasoningEffort?: string;
    input: string;
  };
  const capturedCalls: CapturedCall[] = [];

  const modelResolver = new ModelResolver(providers, {
    createClient: (clientOptions) => ({
      complete: async (params) => {
        capturedCalls.push({
          modelId: clientOptions.modelId,
          reasoningEffort: params.reasoningEffort,
          input: params.input,
        });

        // If Maestro is deciding:
        if (clientOptions.modelId === "model-maestro") {
          // If first turn, delegate to Cody and Doc; if synthesis turn, respond
          if (params.input.includes("bounded-execution-state")) {
            return JSON.stringify({
              type: "respond",
              message: "Maestro completed final synthesis.",
            });
          }
          return JSON.stringify({
            type: "delegate_text",
            independence: "Independent implementation and documentation review",
            assignments: [
              {
                definitionId: "cody",
                objective: "Implement a minor function",
                relevantContext: "Context supplied",
                relevantContextRefs: [],
                constraints: [],
                expectedOutcome: "Code updated",
                evidenceExpectations: [],
                requiredCapabilities: ["filesystem.write"],
              },
              {
                definitionId: "doc",
                objective: "Review documentation constraints",
                relevantContext: "Documentation supplied",
                relevantContextRefs: [],
                constraints: [],
                expectedOutcome: "Doc summary",
                evidenceExpectations: [],
              },
            ],
          });
        }

        // If Cody is deciding:
        if (clientOptions.modelId === "model-cody") {
          return JSON.stringify({
            intent: "respond",
            response: "Cody completed the assignment using exact routed model.",
          });
        }

        // If Doc is deciding:
        if (clientOptions.modelId === "model-doc") {
          return JSON.stringify({
            status: "completed",
            summary: "Doc completed documentation review.",
            evidence: ["Doc evidence 1"],
            blockers: [],
            unresolved: [],
            artifacts: [],
          });
        }

        return JSON.stringify({ status: "completed", summary: "Default response" });
      },
    }),
  });

  const composition = createComposition({ durableTaskEngine: engine, modelResolver });
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const { task } = await engine.submitTask({
    goal: "Coordinate Cody and Doc with strict per-specialist model and reasoning effort routing",
    definitionId: composition.maestroDefinitionId,
    workspaceId: "workspace-routing",
    modelSelection: { providerConnectionId: "prov-maestro", modelId: "model-maestro", reasoningEffort: "low" },
    assignmentModelSelections: {
      cody: { providerConnectionId: "prov-cody", modelId: "model-cody", reasoningEffort: "high" },
      doc: { providerConnectionId: "prov-doc", modelId: "model-doc", reasoningEffort: "medium" },
    },
  });

  const execution = await composition.submit(composition.maestroDefinitionId, task.goal, {
    taskId: task.id,
    workspaceId: "workspace-routing",
    workspaceRoot,
    modelSelection: { providerConnectionId: "prov-maestro", modelId: "model-maestro", reasoningEffort: "low" },
    assignmentModelSelections: {
      cody: { providerConnectionId: "prov-cody", modelId: "model-cody", reasoningEffort: "high" },
      doc: { providerConnectionId: "prov-doc", modelId: "model-doc", reasoningEffort: "medium" },
    },
  });

  await execution.result;

  // Verify Maestro used model-maestro / low effort
  const maestroCalls = capturedCalls.filter(c => c.modelId === "model-maestro");
  assert.ok(maestroCalls.length >= 1, "Maestro must execute on model-maestro");
  for (const call of maestroCalls) {
    assert.equal(call.reasoningEffort, "low");
  }

  // Verify Cody used model-cody / high effort (NOT Maestro's captured client!)
  const codyCalls = capturedCalls.filter(c => c.modelId === "model-cody");
  assert.ok(codyCalls.length >= 1, "Cody must execute on model-cody");
  for (const call of codyCalls) {
    assert.equal(call.reasoningEffort, "high");
  }

  // Verify Doc used model-doc / medium effort
  const docCalls = capturedCalls.filter(c => c.modelId === "model-doc");
  assert.ok(docCalls.length >= 1, "Doc must execute on model-doc");
  for (const call of docCalls) {
    assert.equal(call.reasoningEffort, "medium");
  }

  // Check child task persistence
  const delegations = await engine.getDelegations(task.id);
  const codyDelegation = delegations.find(d => d.assignedMediobotId === "cody");
  assert.ok(codyDelegation?.childTaskId);
  const codyChildSelection = await engine.getTaskModelSelection(codyDelegation.childTaskId);
  assert.deepEqual(codyChildSelection, {
    providerConnectionId: "prov-cody",
    modelId: "model-cody",
    reasoningEffort: "high",
  });
});

test("model-backed specialists without an explicit valid selection block and make zero requests", async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mediobot-model-blocking-"));
  const workspaceRoot = path.join(directory, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });

  const db = new LocalDatabase(path.join(directory, "mediobot.db"));
  const engine = new DurableTaskEngine(new SqliteDurableTaskStore(db.rawDb));
  const providers = new ProviderRepository(db.rawDb);

  providers.save({ id: "prov-maestro", providerType: "custom", displayName: "Maestro Prov", connected: true, enabled: true,
    baseUrl: "http://unused.invalid", models: [
      { id: "model-maestro", name: "Model A", enabled: true, capabilities: { text: true, reasoning: true, vision: false, tools: false } },
    ] });

  let codyRequests = 0;
  let finalSynthesisInput = "";
  const modelResolver = new ModelResolver(providers, {
    createClient: (clientOptions) => ({
      complete: async (params) => {
        if (clientOptions.modelId === "model-maestro") {
          if (params.input.includes("bounded-execution-state")) {
            finalSynthesisInput = params.input;
            return JSON.stringify({ type: "respond", message: "Observed blocked child." });
          }
          return JSON.stringify({
            type: "delegate_text",
            independence: "Independent implementation",
            assignments: [
              {
                definitionId: "cody",
                objective: "Implement a function",
                relevantContext: "Context",
                relevantContextRefs: [],
                constraints: [],
                expectedOutcome: "Code updated",
                evidenceExpectations: [],
                requiredCapabilities: ["filesystem.write"],
              },
            ],
          });
        }
        if (clientOptions.modelId === "model-cody") {
          codyRequests++;
          return JSON.stringify({ intent: "respond", response: "Should not be reached" });
        }
        return JSON.stringify({ status: "completed" });
      },
    }),
  });

  const composition = createComposition({ durableTaskEngine: engine, modelResolver });
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  // Provide explicit routing for assignmentModelSelections, but leave Cody completely unconfigured
  const { task } = await engine.submitTask({
    goal: "Coordinate Cody without configuring Cody's model",
    definitionId: composition.maestroDefinitionId,
    workspaceId: "workspace-blocking",
    modelSelection: { providerConnectionId: "prov-maestro", modelId: "model-maestro" },
    assignmentModelSelections: {
      tester: { providerConnectionId: "prov-tester", modelId: "model-tester" },
    },
  });

  const execution = await composition.submit(composition.maestroDefinitionId, task.goal, {
    taskId: task.id,
    workspaceId: "workspace-blocking",
    workspaceRoot,
    modelSelection: { providerConnectionId: "prov-maestro", modelId: "model-maestro" },
    assignmentModelSelections: {
      tester: { providerConnectionId: "prov-tester", modelId: "model-tester" },
    },
  });

  await execution.result;

  // Cody made zero requests
  assert.equal(codyRequests, 0, "Cody must not make any model requests when unconfigured");

  // Verify that Maestro's final synthesis received the blocked report
  assert.match(finalSynthesisInput, /No configured model selection for Cody/);
  assert.match(finalSynthesisInput, /\\"status\\":\\"blocked\\"/);
});
