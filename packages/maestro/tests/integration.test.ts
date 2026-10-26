import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createWorld } from "@mediobot-v2/domain";
import { CodyDecisionProvider } from "@mediobot-v2/cody";
import { RuntimeTaskSubmission, WorkerRuntime } from "@mediobot-v2/runtime";
import { ToolRuntime } from "@mediobot-v2/tools";
import { createMaestroCodyExecution, MaestroDecisionError, MaestroDecisionProvider } from "../src/index.ts";

const testMaestroDefinition = { id: "maestro", name: "Maestro", role: "orchestration", version: "1.0.0", instructions: "Test Maestro behavior." };

describe("Maestro to Cody execution boundary", () => {
  it("supports a direct user response without creating a Cody worker", async () => {
    const world = createWorld();
    const runtime = new WorkerRuntime(world);
    let delivered = "";
    let modelInput = "";
    const execution = createMaestroCodyExecution({ world, runtime, tools: new ToolRuntime(world),
      codyDecisions: new CodyDecisionProvider({ complete: async () => "{}" }),
      maestroDefinition: { ...testMaestroDefinition, instructions: "Canonical Maestro behavior." },
      skillCatalog: [{ id: "delegation", name: "Bounded delegation", description: "Delegate specialist work.", whenToUse: "A specialist is useful." }],
      maestroDecisions: new MaestroDecisionProvider({ complete: async ({ input }) => {
        modelInput = input;
        return JSON.stringify({ type: "respond", message: "Hello! What would you like to work on?", basis: "conversation", evidenceRefs: [] });
      } }),
      onUserMessage: (message) => { delivered = message; } });
    assert.equal("orchestrator" in execution, false, "production execution factory exposes only the LangGraph-backed adapter");
    assert.equal("orchestrator" in execution.adapter, false, "one workflow engine owns the production adapter lifecycle");
    const submission = new RuntimeTaskSubmission(world, runtime);
    submission.registerAdapter(execution.maestroDefinitionId, execution.adapter);
    const submitted = submission.submit({ definitionId: execution.maestroDefinitionId, goal: "Hi", options: { workspaceRoot: process.cwd() } });
    assert.deepEqual(await submitted.result, { state: "completed" });
    assert.equal(delivered, "Hello! What would you like to work on?");
    assert.equal((JSON.parse(modelInput) as { definitionInstructions?: string }).definitionInstructions, "Canonical Maestro behavior.");
    assert.deepEqual((JSON.parse(modelInput) as { skillCatalog?: unknown }).skillCatalog,
      [{ id: "delegation", name: "Bounded delegation", description: "Delegate specialist work.", whenToUse: "A specialist is useful." }]);
    const snapshot = world.inspect();
    assert.equal(snapshot.workers.length, 1);
    assert.equal(snapshot.definitions.find((definition) => definition.id === snapshot.workers[0]?.definitionId)?.name, "Maestro");
    assert.ok(snapshot.evidence.some((evidence) => evidence.source.type === "maestro-response"));
  });

  it("validates each bounded decision and refuses unknown assignment IDs", async () => {
    const signal = new AbortController().signal;
    const world = createWorld();
    const direct = new MaestroDecisionProvider({ complete: async () => JSON.stringify({ type: "request_user_input", question: "Which folder should I inspect?" }) });
    assert.deepEqual(await direct.decide("Inspect this", { assignableDefinitionIds: ["cody"] }, signal),
      { type: "request_user_input", question: "Which folder should I inspect?" });
    assert.deepEqual(world.inspect().workers, []);
    assert.deepEqual(world.inspect().tasks, []);
    assert.deepEqual(world.inspect().goals, []);
    const invalid = new MaestroDecisionProvider({ complete: async () => JSON.stringify({ type: "delegate", definitionId: "tester",
      objective: "Test it", relevantContextRefs: [], constraints: [], expectedOutcome: "Tests pass", evidenceExpectations: ["test result"] }) });
    await assert.rejects(invalid.decide("Test it", { assignableDefinitionIds: ["cody"] }, signal), /invalid decision/);
    const unsupported = new MaestroDecisionProvider({ complete: async () => JSON.stringify({ type: "assign", definitionId: "cody", goal: "Test it" }) });
    await assert.rejects(unsupported.decide("Test it", { assignableDefinitionIds: ["cody"] }, signal), /invalid decision/);
    const missingIntentText = "benign provider payload with no supported decision";
    const missingIntent = new MaestroDecisionProvider({ complete: async () => JSON.stringify({ answer: missingIntentText }) });
    await assert.rejects(missingIntent.decide("Hi", {}, signal), (error: unknown) => {
      assert.ok(error instanceof MaestroDecisionError);
      assert.equal(error.reason, "missing-intent");
      assert.deepEqual(error.recognizedKeys, []);
      assert.equal(error.message.includes(missingIntentText), false);
      return true;
    });
    const acquire = new MaestroDecisionProvider({ complete: async () => JSON.stringify({ type: "acquire_context",
      request: "Find relevant project configuration", contextKinds: ["project-file"] }) });
    assert.deepEqual(await acquire.decide("Understand the project", {}, signal), { type: "acquire_context",
      request: "Find relevant project configuration", contextKinds: ["project-file"] });
    await assert.rejects(acquire.decide("Understand the project", { availableIntents: ["respond"] }, signal), /invalid decision/);
    const capability = new MaestroDecisionProvider({ complete: async () => JSON.stringify({ type: "use_capability",
      capability: "browser.observe", objective: "Inspect the current page", contextRefs: [] }) });
    assert.deepEqual(await capability.decide("What is on this page?", { capabilityMetadata: [{ name: "browser.observe" }] }, signal),
      { type: "use_capability", capability: "browser.observe", objective: "Inspect the current page", contextRefs: [] });
    await assert.rejects(capability.decide("What is on this page?", {}, signal), /invalid decision/);
  });

  it("creates a real child Cody task, runs owned tools, and returns attributed evidence to Maestro", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-maestro-cody-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "test"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(path.join(root, "src", "math.js"), "export const add = (a, b) => a * b;\n");
    await writeFile(path.join(root, "test", "math.test.js"), [
      "import assert from 'node:assert/strict';",
      "import { add } from '../src/math.js';",
      "assert.equal(add(2, 3), 5);",
    ].join("\n"));

    const codyActions = [
      { type: "list", path: "." },
      { type: "read", path: "src/math.js" },
      { type: "write", path: "src/math.js", content: "export const add = (a, b) => a + b;\n" },
      { type: "run", command: process.execPath, args: ["--test", "test/math.test.js"], verification: "Addition returns the arithmetic sum" },
      { type: "finish", summary: "Repaired addition and verified the project test." },
    ];
    let codyIndex = 0;
    const codyInputs: string[] = [];
    let codyDefinitionId = "";
    const maestroDecisions = new MaestroDecisionProvider({ complete: async () => JSON.stringify({
      type: "delegate", definitionId: codyDefinitionId, objective: "Fix the failing addition behavior.",
      relevantContextRefs: ["workspace:src/math.js", "workspace:test/math.test.js"], constraints: ["Preserve unrelated behavior."],
      expectedOutcome: "Addition returns the arithmetic sum and its test passes.", evidenceExpectations: ["changed file", "test result"],
    }) });
    const world = createWorld();
    const runtime = new WorkerRuntime(world);
    const tools = new ToolRuntime(world);
    const execution = createMaestroCodyExecution({
      world, runtime, tools, maestroDefinition: testMaestroDefinition,
      codyDecisions: new CodyDecisionProvider({ complete: async ({ input }) => { codyInputs.push(input); return JSON.stringify(codyActions[codyIndex++]); } }),
      maestroDecisions,
    });
    codyDefinitionId = execution.codyDefinitionId;
    const submission = new RuntimeTaskSubmission(world, runtime);
    submission.registerAdapter(execution.maestroDefinitionId, execution.adapter);
    const events: Array<{ type: string; taskId?: string; workerId?: string }> = [];
    const submitted = submission.submit({ definitionId: execution.maestroDefinitionId, goal: "Fix the broken addition test",
      options: { workspaceRoot: root }, onEvent: (event) => events.push(event) });
    const result = await submitted.result;
    const snapshot = world.inspect();
    const child = snapshot.tasks.find((task) => task.parentTaskId === submitted.task.id);
    const cody = child && snapshot.workers.find((worker) => worker.id === child.assignedWorkerId);

    assert.deepEqual(result, { state: "completed" });
    assert.ok(child, "Maestro must create a child task instead of impersonating Cody");
    assert.ok(cody);
    assert.equal(snapshot.definitions.find((definition) => definition.id === cody.definitionId)?.name, "Cody");
    assert.equal(child.assignedWorkerId, cody.id);
    assert.equal(await readFile(path.join(root, "src", "math.js"), "utf8"), "export const add = (a, b) => a + b;\n");
    const commandExecution = snapshot.evidence.find((evidence) => evidence.taskId === child.id && evidence.workerId === cody.id
      && evidence.source.type === "coding-verification" && evidence.kind === "command-execution" && evidence.validity === "observed");
    assert.ok(commandExecution);
    assert.equal(commandExecution.claim, undefined);
    assert.match(commandExecution.content, /exited with code 0/);
    assert.match(commandExecution.content, /task correctness is not established/i);
    assert.ok(snapshot.evidence.some((evidence) => evidence.taskId === child.id && evidence.workerId === cody.id
      && evidence.source.type === "coding-tool" && evidence.source.reference === commandExecution.source.reference
      && evidence.kind === "tool-result" && evidence.validity === "observed"));
    assert.ok(snapshot.evidence.some((evidence) => evidence.taskId === submitted.task.id
      && evidence.workerId === submitted.workers[0]?.id && evidence.source.type === "worker-result"));
    const goal = snapshot.goals[0];
    assert.ok(goal);
    assert.ok(goal.evidenceIds.includes(commandExecution.id));
    assert.equal(goal.objective, "Fix the broken addition test");
    assert.deepEqual(goal.constraints.map((constraint) => constraint.text), ["Preserve unrelated behavior."]);
    assert.equal(goal.successCriteria[0]?.state, "unknown", "Cody task completion is not goal satisfaction");
    assert.ok(goal.evidenceIds.some((evidenceId) => snapshot.evidence.some((entry) => entry.id === evidenceId && entry.taskId === child.id)));
    assert.equal(snapshot.assignments[0]?.objective, "Fix the failing addition behavior.");
    assert.deepEqual(snapshot.assignments[0]?.evidenceExpectations, ["changed file", "test result"]);
    assert.match((JSON.parse(codyInputs[0]!) as { goal: string }).goal, /Preserve unrelated behavior/);
    assert.match((JSON.parse(codyInputs[0]!) as { goal: string }).goal, /Expected outcome: Addition returns the arithmetic sum/);
    assert.match((JSON.parse(codyInputs[0]!) as { goal: string }).goal, /Evidence expectations: changed file, test result/);
    assert.ok(events.some((event) => event.type === "task.started" && event.taskId === child.id && event.workerId === cody.id));
    assert.ok(events.some((event) => event.type === "tool.completed" && event.taskId === child.id && event.workerId === cody.id));
    assert.equal(codyIndex, codyActions.length);
  });

  for (const observe of [false, true]) it(observe ? "reports read-only inspection without requiring a check command" : "rejects an immediate Cody finish with only model-summary evidence", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-maestro-evidence-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const world = createWorld();
    const runtime = new WorkerRuntime(world);
    let definitionId = "";
    let calls = 0;
    let delivered = "";
    const events: string[] = [];
    const execution = createMaestroCodyExecution({ world, runtime, tools: new ToolRuntime(world),
      maestroDefinition: testMaestroDefinition,
      codyDecisions: new CodyDecisionProvider({ complete: async () => JSON.stringify(observe && calls++ === 0
        ? { type: "list", path: "." } : { type: "finish", summary: "Everything is proven." }) }),
      maestroDecisions: new MaestroDecisionProvider({ complete: async () => JSON.stringify({ type: "delegate", definitionId,
        objective: "Inspect workspace", relevantContextRefs: [], constraints: [], expectedOutcome: "Findings", evidenceExpectations: [] }) }),
      onUserMessage: (message) => { delivered = message; } });
    definitionId = execution.codyDefinitionId;
    const submission = new RuntimeTaskSubmission(world, runtime);
    submission.registerAdapter(execution.maestroDefinitionId, execution.adapter);
    const submitted = submission.submit({ definitionId: execution.maestroDefinitionId, goal: "Inspect workspace",
      options: { workspaceRoot: root }, onEvent: (event) => events.push(event.type) });
    assert.deepEqual(await submitted.result, observe ? { state: "completed" } : { state: "failed", error: "Cody returned no tool-backed evidence" });
    assert.equal(events.includes("maestro.evidence-reviewed"), false);
    if (observe) {
      assert.match(delivered, /Read-only inspection completed from observed workspace evidence/);
      assert.match(delivered, /No check command was applicable to this read-only task/);
      assert.match(delivered, /project behavior was not independently tested/);
      assert.match(delivered, /model claim/);
      assert.notEqual(world.inspect().goals[0]?.status, "satisfied", "observation must not be promoted to independent verification");
    } else {
      assert.equal(delivered, "");
      assert.equal(world.inspect().evidence.some((entry) => entry.source.type === "worker-result"), false);
    }
  });

  it("rejects an assignment to an unavailable worker definition", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-maestro-invalid-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const world = createWorld();
    const runtime = new WorkerRuntime(world);
    const execution = createMaestroCodyExecution({ world, runtime, tools: new ToolRuntime(world),
      maestroDefinition: testMaestroDefinition,
      codyDecisions: new CodyDecisionProvider({ complete: async () => "{}" }),
      maestroDecisions: new MaestroDecisionProvider({ complete: async () => JSON.stringify({ type: "delegate", definitionId: "tester",
        objective: "Test", relevantContextRefs: [], constraints: [], expectedOutcome: "Tests pass", evidenceExpectations: ["test result"] }) }) });
    const submission = new RuntimeTaskSubmission(world, runtime);
    submission.registerAdapter(execution.maestroDefinitionId, execution.adapter);
    const submitted = submission.submit({ definitionId: execution.maestroDefinitionId, goal: "Do work", options: { workspaceRoot: root } });
    assert.deepEqual(await submitted.result, { state: "failed", error: "Maestro returned an invalid decision" });
    assert.equal(world.inspect().workers.length, 1);
  });
});
