import assert from "node:assert/strict";
import { it } from "node:test";
import { createWorld } from "@mediobot-v2/domain";
import { CodyDecisionProvider, CodyExecutionAdapter, createCodyDefinition } from "@mediobot-v2/cody";
import type { WorkerExecutionContext, WorkerExecutionPlan } from "@mediobot-v2/runtime";
import { RuntimeTaskSubmission, WorkerRuntime } from "@mediobot-v2/runtime";
import { ToolRuntime } from "@mediobot-v2/tools";
import { ModelProviderError } from "@mediobot-v2/models";
import { createMaestroCodyExecution, MAESTRO_DECISION_CONTRACT, MAESTRO_MAX_DECISION_ATTEMPTS,
  isOrdinaryConversationGoal, MaestroDecisionError, MaestroDecisionProvider, MaestroExecutionAdapter, createMaestroDefinition,
  validateMaestroDecision } from "../src/index.ts";

const signal = new AbortController().signal;
const respond = { type: "respond", message: "Hello", basis: "conversation", evidenceRefs: [] };
const delegation = { type: "delegate", definitionId: "unknown", objective: "Inspect",
  relevantContextRefs: [], constraints: [], expectedOutcome: "Findings", evidenceExpectations: [] };

it("does not mistake Node.js in a documentation objective for a project file path", () => {
  assert.equal(isOrdinaryConversationGoal("Verify from official Node.js documentation whether fetch accepts AbortSignal.timeout()"), true);
});

it("normalizes supported reasoning and prose wrappers before Maestro schema validation", async () => {
  const provider = new MaestroDecisionProvider({ complete: async () =>
    '<think>private analysis</think>\nDecision:\n```json\n{"type":"respond","message":"The prior tool failed.","basis":"conversation","evidenceRefs":[]}\n```' });
  assert.deepEqual(await provider.decide("Why?", {}, signal), { type: "respond", message: "The prior tool failed.", basis: "conversation", evidenceRefs: [] });
});

for (const failure of ["capacity", "invalid-plan", "prepare-throw", "cancel-prepare", "cancel-running"] as const) {
  it(`terminalizes child resources and task on ${failure}`, async () => {
    const world = createWorld();
    const runtime = new WorkerRuntime(world, { maxConcurrentExecutions: failure === "capacity" ? 1 : 2 });
    const tools = new ToolRuntime(world);
    const codyDefinition = createCodyDefinition(world);
    const maestro = createMaestroDefinition(world, {
      id: "maestro", name: "Maestro", role: "orchestration", version: "1", instructions: "Delegate.",
    });
    const unrelatedWorker = world.spawnWorker(codyDefinition.id);
    const unrelated = world.registerResource({ kind: "workspace", owner: { type: "worker", worldId: world.id, workerId: unrelatedWorker.id } });
    class FailingCody extends CodyExecutionAdapter {
      override prepare(context: WorkerExecutionContext): WorkerExecutionPlan {
        const plan = super.prepare(context);
        world.registerResource({ kind: "workspace", owner: { type: "task", worldId: world.id, taskId: context.taskId } });
        world.registerResource({ kind: "workspace", owner: { type: "world", worldId: world.id } });
        if (failure === "prepare-throw") throw new Error("Child preparation failed");
        if (failure === "cancel-prepare") runtime.cancel(world.inspect().tasks.find((task) => task.id === context.taskId)!.parentTaskId!);
        return failure === "invalid-plan" ? { ...plan, resourceIds: [...plan.resourceIds, ...plan.resourceIds] } : plan;
      }
    }
    const adapter = new MaestroExecutionAdapter({ codyDefinitionId: codyDefinition.id, runtime,
      cody: new FailingCody({ tools, decisions: new CodyDecisionProvider({ complete: async () => {
        assert.fail("Rejected child must not execute");
      } }) }),
      decisions: new MaestroDecisionProvider({ complete: async () => JSON.stringify({ ...delegation, definitionId: codyDefinition.id }) }),
    });
    const submission = new RuntimeTaskSubmission(world, runtime);
    submission.registerAdapter(maestro.id, adapter);
    const events: Array<{ type: string; taskId?: string; workerId?: string }> = [];
    const parent = submission.submit({ definitionId: maestro.id, goal: "Inspect", options: { workspaceRoot: process.cwd() },
      onEvent: (event) => {
        events.push(event);
        const task = world.inspect().tasks.find((task) => task.id === event.taskId);
        if (failure === "cancel-running" && event.type === "task.started" && task?.parentTaskId) runtime.cancel(task.parentTaskId);
      } });
    const cancelled = failure === "cancel-prepare" || failure === "cancel-running";
    assert.deepEqual(await parent.result, cancelled ? { state: "cancelled" } : { state: "failed", error: failure === "capacity"
      ? "Runtime execution capacity reached (1)" : failure === "invalid-plan" ? "Resource is listed more than once" : "Child preparation failed" });
    const snapshot = world.inspect();
    const child = snapshot.tasks.find((task) => task.parentTaskId === parent.task.id)!;
    assert.ok(child);
    assert.equal(child.state, failure === "cancel-prepare" || failure === "cancel-running" ? "cancelled" : "failed");
    assert.equal(snapshot.tasks.find((task) => task.id === parent.task.id)?.state, cancelled ? "cancelled" : "failed");
    assert.ok(snapshot.workers.every((worker) => worker.state === "idle"));
    assert.deepEqual(runtime.activeTaskIds(), []);
    const childResources = snapshot.resources.filter((resource) =>
      resource.owner.type === "task" && resource.owner.taskId === child.id
      || resource.owner.type === "worker" && resource.owner.workerId === child.assignedWorkerId);
    assert.ok(childResources.length >= 2);
    assert.ok(childResources.every((resource) => resource.state === "released"));
    assert.equal(snapshot.resources.find((resource) => resource.id === unrelated.id)?.state, "available");
    assert.ok(snapshot.resources.filter((resource) => resource.owner.type === "world").every((resource) => resource.state === "available"));
    assert.equal(snapshot.goals[0]?.successCriteria[0]?.state, "unknown");
    assert.equal(snapshot.evidence.some((entry) => entry.source.type === "worker-result" || entry.source.type === "maestro-response"), false);
    assert.equal(events.filter((event) => event.type === `task.${child.state}` && event.taskId === child.id && event.workerId === child.assignedWorkerId).length, 1);
    assert.equal(events.some((event) => event.type === "task.started" && event.taskId === child.id), failure === "cancel-running");
  });
}

it("repairs structural failures with the contract and fixed feedback only", async () => {
  const requests: Array<{ system: string; input: string }> = [];
  const outputs = ["private rejected payload", JSON.stringify({ type: "respond", reasoning: "private reasoning" }), JSON.stringify(respond)];
  const provider = new MaestroDecisionProvider({ complete: async (request) => {
    requests.push(request);
    return outputs[requests.length - 1]!;
  } });
  assert.deepEqual(await provider.decide("Hi", {}, signal), respond);
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.ok(request.system.includes(MAESTRO_DECISION_CONTRACT));
    assert.equal(request.input, requests[0]!.input);
    assert.doesNotMatch(request.system, /private rejected payload|private reasoning/);
  }
  assert.match(requests[1]!.system, /invalid-json/);
  assert.match(requests[2]!.system, /schema-mismatch/);
});

it("repair feedback names exact required keys when all required keys are present but extra keys exist", async () => {
  const requests: Array<{ system: string }> = [];
  // respond with extra key: all required keys present ("type","message") but "reasoning" is extra
  const outputs = [JSON.stringify({ ...respond, message: "Hi", reasoning: "private" }), JSON.stringify(respond)];
  const provider = new MaestroDecisionProvider({ complete: async (request) => {
    requests.push(request);
    return outputs[requests.length - 1]!;
  } });
  assert.deepEqual(await provider.decide("Goal", {}, signal), { type: "respond", message: "Hello", basis: "conversation", evidenceRefs: [] });
  assert.equal(requests.length, 2);
  // Repair prompt must name the exact required keys without echoing the model's output
  assert.match(requests[1]!.system, /type, message, basis, evidenceRefs/);
  assert.match(requests[1]!.system, /schema-mismatch/);
  assert.doesNotMatch(requests[1]!.system, /private/);
});

it("bounds invalid output and provider parse repairs without leaking diagnostics", async () => {
  for (const output of ["broken private output", "[]", JSON.stringify({ type: "respond", message: "Hi", taskId: "forged" }), "provider-parse"]) {
    let calls = 0;
    const provider = new MaestroDecisionProvider({ complete: async () => {
      calls++;
      if (output === "provider-parse") throw new ModelProviderError("structured-parse", "private provider message", "private diagnostic");
      return output;
    } });
    await assert.rejects(provider.decide("Hi", {}, signal), (error: unknown) => {
      assert.ok(error instanceof MaestroDecisionError);
      assert.equal(error.category, "structural");
      assert.doesNotMatch(JSON.stringify(error), /private|forged/);
      return true;
    });
    assert.equal(calls, MAESTRO_MAX_DECISION_ATTEMPTS);
  }
});

it("does not let a schema repair replace a rejected delegation with a direct answer", async () => {
  const goal = "List the current project files using authorized workspace evidence.";
  const requests: Array<{ input: string; system: string }> = [];
  const outputs = [
    JSON.stringify({ ...delegation, definitionId: "cody", extra: "provider-added field" }),
    JSON.stringify(respond),
    JSON.stringify({ ...delegation, definitionId: "cody" }),
  ];
  const provider = new MaestroDecisionProvider({ complete: async (request) => {
    requests.push(request);
    return outputs[requests.length - 1]!;
  } });
  const decision = await provider.decide(goal, { availableIntents: ["respond", "delegate"], assignableDefinitionIds: ["cody"] }, signal);
  assert.equal(decision.type, "delegate");
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => JSON.parse(request.input).userGoal === goal), "repair retains the original user goal");
  assert.match(requests[1]!.system, /preserve the "delegate" intent/i);
  assert.match(requests[2]!.system, /preserve the "delegate" intent/i);
});

it("rejects project-state responses without authorized evidence references", async () => {
  const outputs = [
    JSON.stringify({ type: "respond", message: "The project contains guessed.ts", basis: "project-evidence", evidenceRefs: [] }),
    JSON.stringify(respond),
  ];
  let calls = 0;
  const provider = new MaestroDecisionProvider({ complete: async (request) => {
    calls += 1;
    if (calls === 2) assert.match(request.system, /authorized evidence reference/i);
    return outputs[calls - 1]!;
  } });
  assert.deepEqual(await provider.decide("What files are present?", {}, signal), respond);
  assert.equal(calls, 2);
});

it("does not let a conversation label bypass semantic current-project evidence gating", async () => {
  const goal = "Which files are in the currently open project?";
  const requests: Array<{ system: string; input: string }> = [];
  const provider = new MaestroDecisionProvider({ complete: async (request) => {
    requests.push(request);
    if (request.system.includes("MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER")) {
      assert.deepEqual(JSON.parse(request.input), { userGoal: goal, workspaceStatus: "OPEN" });
      return JSON.stringify({ requiresCurrentProjectEvidence: true });
    }
    const data = JSON.parse(request.input) as Record<string, unknown>;
    assert.equal(data.userGoal, goal);
    if (!data.projectEvidenceRequired) return JSON.stringify({ type: "respond", message: "Probably src/main.ts", basis: "conversation", evidenceRefs: [] });
    assert.deepEqual(data.assignableDefinitionIds, ["cody"]);
    return JSON.stringify({ ...delegation, definitionId: "cody" });
  } });
  const decision = await provider.decide(goal, { workspaceState: { status: "OPEN" }, assignableDefinitionIds: ["cody"],
    availableIntents: ["respond", "delegate"] }, signal);
  assert.equal(decision.type, "delegate");
  assert.ok(requests.some((request) => JSON.parse(request.input).projectEvidenceRequired === true));
});

it("checks proposed answer claims even when the request classifier says ordinary conversation", async () => {
  const goal = "Could you help me with this?";
  let decisionCalls = 0;
  const provider = new MaestroDecisionProvider({ complete: async ({ input, system }) => {
    if (system.includes("MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER")) {
      const classification = JSON.parse(input) as { proposedAnswer?: string };
      if (classification.proposedAnswer === undefined) {
        assert.match(system, /classify the request/i);
        return JSON.stringify({ requiresCurrentProjectEvidence: false });
      }
      assert.match(system, /classify the ANSWER itself/i);
      assert.match(system, /do not classify only the userGoal/i);
      assert.match(classification.proposedAnswer, /project contains guessed\.ts/);
      return JSON.stringify({ requiresCurrentProjectEvidence: true });
    }
    const data = JSON.parse(input) as Record<string, unknown>;
    assert.equal(data.userGoal, goal);
    decisionCalls++;
    if (decisionCalls === 1) return JSON.stringify({ type: "respond", message: "The project contains guessed.ts", basis: "conversation", evidenceRefs: [] });
    assert.equal(data.projectEvidenceRequired, true);
    return JSON.stringify({ ...delegation, definitionId: "cody" });
  } });
  const decision = await provider.decide(goal, { workspaceState: { status: "OPEN" }, assignableDefinitionIds: ["cody"],
    availableIntents: ["respond", "delegate"] }, signal);
  assert.equal(decision.type, "delegate");
  assert.equal(decisionCalls, 2);
});

it("does not treat previous-turn summaries as current project evidence", () => {
  const previousTurnEvidence = { id: "old-turn", source: { type: "previous-turn-execution", reference: "turn-old" },
    content: "filesystem.list succeeded: old.ts", kind: "tool-result", validity: "confirmed" } as const;
  assert.throws(() => validateMaestroDecision({ type: "respond", message: "Current files include old.ts", basis: "project-evidence",
    evidenceRefs: ["old-turn"] }, { projectEvidenceRequired: true, workspaceState: { status: "OPEN" },
    assignableDefinitionIds: ["cody"], relevantEvidence: [previousTurnEvidence] }), (error: unknown) => {
    assert.ok(error instanceof MaestroDecisionError);
    assert.equal(error.reason, "insufficient-evidence");
    return true;
  });
});

it("fails closed on semantic violations without repair", async () => {
  for (const [decision, context, reason] of [
    [delegation, { assignableDefinitionIds: ["cody"] }, "unknown-delegation"],
    [respond, { availableIntents: ["delegate"] }, "intent-not-available"],
    [{ type: "use_capability", capability: "unknown", objective: "Inspect", contextRefs: [] }, {}, "unavailable-capability"],
  ] as const) {
    let calls = 0;
    const provider = new MaestroDecisionProvider({ complete: async () => { calls++; return JSON.stringify(decision); } });
    await assert.rejects(provider.decide("Hi", context, signal), (error: unknown) => {
      assert.ok(error instanceof MaestroDecisionError);
      assert.equal(error.category, "semantic");
      assert.equal(error.reason, reason);
      return true;
    });
    assert.equal(calls, 1);
  }
});

it("does not repair transport failures or cancelled calls", async () => {
  let calls = 0;
  const failure = new ModelProviderError("capacity", "Capacity reached");
  const provider = new MaestroDecisionProvider({ complete: async () => { calls++; throw failure; } });
  await assert.rejects(provider.decide("Hi", {}, signal), (error) => error === failure);
  assert.equal(calls, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(provider.decide("Hi", {}, controller.signal));
  assert.equal(calls, 1);
  const fresh = new AbortController();
  const during = new MaestroDecisionProvider({ complete: async () => { fresh.abort(); return "invalid"; } });
  await assert.rejects(during.decide("Hi", {}, fresh.signal));
});

function fixture() {
  const world = createWorld();
  const runtime = new WorkerRuntime(world);
  let calls = 0;
  const execution = createMaestroCodyExecution({ world, runtime, tools: new ToolRuntime(world),
    maestroDefinition: { id: "maestro", name: "Maestro", role: "orchestration", version: "1", instructions: "Choose an intent." },
    codyDecisions: new CodyDecisionProvider({ complete: async () => { throw new Error("Must not execute"); } }),
    maestroDecisions: new MaestroDecisionProvider({ complete: async () => { calls++; return JSON.stringify(respond); } }) });
  return { world, runtime, execution, calls: () => calls };
}

it("direct turn response creates no execution identities", async () => {
  const { world, execution } = fixture();
  const before = world.inspect();
  assert.deepEqual(await execution.adapter.decideTurn(world, execution.maestroDefinitionId, "Hi", undefined, signal), respond);
  assert.deepEqual(world.inspect(), before);
  assert.equal(before.tasks.length, 0);
  assert.equal(before.workers.length, 0);
  assert.equal(before.goals.length, 0);
});

it("revalidates every supplied precomputed decision before creating child state", async () => {
  for (const decision of [null, { type: "delegate" }, delegation, { ...respond, workerId: "forged" },
    { type: "acquire_context", request: "Inspect", contextKinds: [] },
    { ...delegation, constraints: ["<think>private</think>"] }]) {
    const { world, runtime, execution, calls } = fixture();
    const submission = new RuntimeTaskSubmission(world, runtime);
    submission.registerAdapter(execution.maestroDefinitionId, execution.adapter);
    const submitted = submission.submit({ definitionId: execution.maestroDefinitionId, goal: "Hi",
      options: { workspaceRoot: process.cwd(), maestroDecision: decision } });
    assert.deepEqual(await submitted.result, { state: "failed", error: "Maestro returned an invalid decision" });
    assert.equal(calls(), 0);
    const snapshot = world.inspect();
    assert.equal(snapshot.workers.length, 1);
    assert.equal(snapshot.tasks.length, 1);
    assert.equal(snapshot.goals.length, 0);
    assert.equal(snapshot.assignments.length, 0);
    assert.equal(snapshot.evidence.length, 0);
  }
});
