import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { Page } from "playwright";
import { createWorld } from "@mediobot-v2/domain";
import type { ResourceId, TaskId, WorkerId } from "@mediobot-v2/domain";
import {
  AutonomousBrowserTask,
  PlaywrightBrowserPage,
  type BrowserAction,
  type BrowserObservation,
  type DecisionProvider,
  type ObservationProvider,
  type BrowserExecutor,
  type BrowserExecutionResult,
  ModelDecisionProvider,
  OpenAICompatibleStructuredClient,
  OpenAICompatibleVisionClient,
  ModelProviderError,
  ModelActionValidationError,
  resolveDevelopmentModelConfig,
  validateDecision,
  type StructuredModelRequest,
} from "../src/index.ts";

type Fixture = {
  world: ReturnType<typeof createWorld>;
  workerId: WorkerId;
  taskId: TaskId;
  resourceId: ResourceId;
  cleanup(): Promise<void>;
};

async function fixture(goal: string): Promise<Fixture> {
  const world = createWorld();
  const definition = world.registerMediobotDefinition({
    name: "Vision", role: "browser", version: "1", instructions: "Use observed browser state to pursue the assigned goal.",
    declaredCapabilities: [{ kind: "resource", name: "browser-page" }],
  });
  const worker = world.spawnWorker(definition.id);
  const task = world.assignTask(world.createTask(goal).id, worker.id);
  const resource = world.registerResource({
    kind: "browser-page", owner: { type: "worker", worldId: world.id, workerId: worker.id },
  });
  const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-vision-"));
  world.setWorkerState(worker.id, "busy");
  world.setTaskState(task.id, "running");
  world.setResourceState(resource.id, "in-use");
  await writeFile(path.join(root, "fixture-marker"), "local fixture");
  return { world, workerId: worker.id, taskId: task.id, resourceId: resource.id, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function observation(revision: number, url: string, elements: BrowserObservation["elements"]): BrowserObservation {
  return { revision, fingerprint: `${url}:${JSON.stringify(elements)}`, url, title: "Fixture", text: "", elements };
}

class ScriptedPage implements ObservationProvider, BrowserExecutor {
  private revision = 0;
  private state = "home";
  private closed = false;
  async observe(): Promise<BrowserObservation> {
    if (this.closed) throw new Error("page is closed");
    if (this.state === "home") return observation(this.revision, "http://fixture.local/", [
      { id: "open", role: "link", name: "Open record", enabled: true },
      { id: "search", role: "textbox", name: "Search records", enabled: true },
      { id: "update", role: "button", name: "Update record", enabled: true },
    ]);
    if (this.state === "detail") return observation(this.revision, "http://fixture.local/record", [
      { id: "save", role: "button", name: "Save changes", enabled: true },
    ]);
    if (this.state === "dialog") return observation(this.revision, "http://fixture.local/confirm", [
      { id: "confirm", role: "button", name: "Confirm update", enabled: true },
    ]);
    return observation(this.revision, "http://fixture.local/done", [
      { id: "result", role: "status", name: "Update complete", enabled: true },
    ]);
  }
  async execute(action: BrowserAction, current: BrowserObservation, signal: AbortSignal): Promise<BrowserExecutionResult> {
    if (signal.aborted) return { state: "cancelled" };
    if (current.revision !== this.revision || action.observationRevision !== this.revision) {
      return { state: "rejected-before-mutation", reason: "stale-observation" };
    }
    if (action.type === "click") {
      if (action.targetId === "open") this.state = "detail";
      else if (action.targetId === "update") this.state = "dialog";
      else if (action.targetId === "confirm" || action.targetId === "save") this.state = "done";
      else return { state: "rejected-before-mutation", reason: "invalid-target" };
    } else if (action.type === "type") {
      if (action.targetId !== "search") return { state: "rejected-before-mutation", reason: "invalid-target" };
      this.state = "detail";
    } else if (action.type !== "wait") return { state: "rejected-before-mutation", reason: "invalid-action" };
    this.revision += 1;
    return { state: "accepted" };
  }
  async close(): Promise<void> { this.closed = true; }
}

class GoalDecisionProvider implements DecisionProvider {
  async decide(goal: string, state: BrowserObservation): Promise<BrowserAction> {
    const target = goal === "open the record" ? "Open record"
      : goal === "search records and inspect the result" ? "Search records"
        : state.elements.some((item) => item.name === "Update record") ? "Update record"
          : state.elements.some((item) => item.name === "Confirm update") ? "Confirm update"
            : "Save changes";
    const element = state.elements.find((item) => item.name === target);
    if (element?.role === "textbox") return { type: "type", targetId: element.id, value: "recent record",
      observationRevision: state.revision };
    if (element) return { type: "click", targetId: element.id, observationRevision: state.revision };
    if (state.elements.some((item) => item.name === "Update complete") && goal !== "open the record") {
      return { type: "finish", observationRevision: state.revision };
    }
    if (state.elements.some((item) => item.name === "Save changes")) {
      return { type: "click", targetId: "save", observationRevision: state.revision };
    }
    return { type: "finish", observationRevision: state.revision };
  }
}

describe("generic autonomous browser loop", () => {
  it("attaches redacted diagnostics to unsupported and missing action discriminators", () => {
    const state = observation(5, "http://fixture.local/", [{ id: "secret-element-id", role: "button", name: "Open", enabled: true }]);
    for (const raw of [
      '{"type":"open","targetId":"secret-element-id"}',
      '{"action":"click","targetId":"secret-element-id"}',
    ]) {
      assert.throws(() => validateDecision(raw, state), (error: unknown) => {
        assert.ok(error instanceof ModelActionValidationError);
        const serialized = JSON.stringify(error.diagnostic);
        assert.equal(serialized.includes("secret-element-id"), false);
        assert.equal(serialized.includes(raw), false);
        return true;
      });
    }
    assert.throws(() => validateDecision('{"type":"open","targetId":"secret-element-id"}', state),
      (error: unknown) => error instanceof ModelActionValidationError
        && error.diagnostic.kind === "invalid-model-action" && error.diagnostic.type === "unknown"
        && error.diagnostic.fieldTypes?.targetId === "string(redacted)");
    assert.throws(() => validateDecision('{"action":"click","targetId":"secret-element-id"}', state),
      (error: unknown) => error instanceof ModelActionValidationError
        && error.diagnostic.hasType === false && error.diagnostic.hasAction === true
        && error.diagnostic.actionType === "click");
  });

  it("diagnoses wrapped actions and malformed JSON without retaining the model response", () => {
    const state = observation(5, "http://fixture.local/", [{ id: "private-target", role: "button", name: "Open", enabled: true }]);
    assert.throws(() => validateDecision('{"action":{"type":"click","targetId":"private-target"}}', state),
      (error: unknown) => error instanceof ModelActionValidationError
        && error.diagnostic.hasAction === true && error.diagnostic.actionType === "object"
        && error.diagnostic.nestedKeys?.join(",") === "targetId,type" && error.diagnostic.nestedType === "click"
        && !JSON.stringify(error.diagnostic).includes("private-target"));
    const malformed = '{"type":"click","targetId":';
    assert.throws(() => validateDecision(malformed, state), (error: unknown) => error instanceof ModelActionValidationError
      && error.diagnostic.kind === "malformed-model-json" && error.diagnostic.characterCount === malformed.length
      && error.diagnostic.parserCategory === "invalid-json" && !JSON.stringify(error.diagnostic).includes(malformed));
  });

  it("carries only sanitized action diagnostics into task progress and the failure result", async (t) => {
    const f = await fixture("continue");
    t.after(f.cleanup);
    const progress: unknown[] = [];
    const diagnostic = { kind: "invalid-model-action" as const, characterCount: 52, keys: ["targetId", "type"],
      hasType: true, type: "open", hasAction: false, fieldTypes: { targetId: "string(redacted)" } };
    const decisions: DecisionProvider = { decide: async () => {
      throw new ModelActionValidationError('MODEL_ACTION_INVALID: unsupported action type "open"; keys=["targetId","type"]', diagnostic);
    } };
    const page = new ScriptedPage();
    const task = new AutonomousBrowserTask({ world: f.world, workerId: f.workerId, taskId: f.taskId,
      resourceId: f.resourceId, observations: page, executor: page, decisions, maxSteps: 2,
      onProgress: (event) => progress.push(event) });
    const result = await task.run("continue");
    assert.equal(result.state, "failed");
    if (result.state !== "failed") return;
    assert.deepEqual(result.diagnostic, diagnostic);
    const failed = progress.find((event) => typeof event === "object" && event !== null && "type" in event
      && (event as { type: string }).type === "failed") as { message: string; diagnostic: unknown };
    assert.deepEqual(failed.diagnostic, diagnostic);
    const evidenceShape = JSON.stringify({ progress, diagnostic: result.diagnostic });
    assert.equal(evidenceShape.includes("private-target"), false);
    assert.equal(evidenceShape.includes("reasoning phrase"), false);
    await task.close();
  });

  it("keeps think text out of invalid-action diagnostics and validates a general action strictly", async () => {
    const state = observation(6, "http://fixture.local/", [{ id: "button-1", role: "button", name: "Continue", enabled: true }]);
    const client = new OpenAICompatibleStructuredClient({ apiKey: "secret", modelId: "MiniMaxAI/MiniMax-M2.7",
      fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content:
        '<think>private reasoning phrase</think>{"type":"click","targetId":"button-1"}' } }] }), { status: 200 }) });
    const decisions = new ModelDecisionProvider(client);
    assert.deepEqual(await decisions.decide("continue", state, [], new AbortController().signal),
      { type: "click", targetId: "button-1", observationRevision: 6 });
    const invalidClient = new OpenAICompatibleStructuredClient({ apiKey: "secret", modelId: "MiniMaxAI/MiniMax-M2.7",
      fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content:
        '<think>private reasoning phrase</think>{"type":"open","targetId":"private-target"}' } }] }), { status: 200 }) });
    await assert.rejects(() => new ModelDecisionProvider(invalidClient).decide("continue", state, [], new AbortController().signal),
      (error: unknown) => error instanceof ModelActionValidationError && error.diagnostic.type === "unknown"
        && !error.message.includes("private reasoning phrase") && !JSON.stringify(error.diagnostic).includes("private-target"));
  });

  it("strips MiniMax think blocks and exposes only the final structured action", async () => {
    const client = new OpenAICompatibleStructuredClient({ apiKey: "secret", modelId: "MiniMaxAI/MiniMax-M2.7",
      fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content:
        '<think>private reasoning that must not escape</think>{"type":"finish"}' } }] }), { status: 200 }) });
    const content = await client.complete({ system: "", input: "", signal: new AbortController().signal });
    assert.equal(content, '{"type":"finish"}');
    assert.equal(content.includes("private reasoning"), false);
  });

  it("returns typed capacity and structured-parse errors without retrying or guessing", async () => {
    let calls = 0;
    const capacity = new OpenAICompatibleStructuredClient({ apiKey: "secret", modelId: "deepseek-ai/DeepSeek-V4-Flash-0731",
      fetch: async () => { calls += 1; return new Response("", { status: 429 }); } });
    await assert.rejects(() => capacity.complete({ system: "", input: "", signal: new AbortController().signal }),
      (error: unknown) => error instanceof ModelProviderError && error.code === "capacity");
    assert.equal(calls, 1);
    const trailing = new OpenAICompatibleStructuredClient({ apiKey: "secret", modelId: "deepseek-ai/DeepSeek-V4-Flash-0731",
      fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"type":"finish"} explanation' } }] }), { status: 200 }) });
    await assert.rejects(() => trailing.complete({ system: "", input: "", signal: new AbortController().signal }),
      (error: unknown) => error instanceof ModelProviderError && error.code === "structured-parse");
  });

  it("normalizes and strips provider reasoning tags such as <think> without breaking structured JSON", async () => {
    const rawInputs = [
      '<think>reasoning</think>{"action":"navigate","url":"https://example.com"}',
      '<think>\nmulti-line internal reasoning\ncalculation: 17 + 25 = 42\n</think>\n```json\n{"action":"click","target":"btn-1"}\n```',
      '<THINK>uppercase reasoning tag</THINK>{"type":"finish"}',
    ];
    for (const raw of rawInputs) {
      const client = new OpenAICompatibleStructuredClient({
        apiKey: "test-key",
        modelId: "MiniMaxAI/MiniMax-M2.7",
        fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: raw } }] }), { status: 200 }),
      });
      const output = await client.complete({ system: "", input: "", signal: new AbortController().signal });
      assert.doesNotMatch(output, /<\/?think/i);
      assert.doesNotMatch(output, /reasoning/i);
      assert.ok(JSON.parse(output));
    }

    const incomplete = new OpenAICompatibleStructuredClient({
      apiKey: "test-key",
      modelId: "MiniMaxAI/MiniMax-M2.7",
      fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: "<think>truncated reasoning without close tag" } }] }), { status: 200 }),
    });
    await assert.rejects(
      () => incomplete.complete({ system: "", input: "", signal: new AbortController().signal }),
      (error: unknown) => error instanceof ModelProviderError && error.code === "structured-parse"
    );
  });


  it("resolves explicit text and vision selections without fallback and rejects unknown IDs", () => {
    const config = resolveDevelopmentModelConfig({ DAHL_API_KEY: "dahl-secret", NVIDIA_API_KEY: "nvidia-secret",
      MEDIOBOT_DEV_TEXT_MODEL: "deepseek-ai/DeepSeek-V4-Flash-0731",
      MEDIOBOT_DEV_VISION_MODEL: "meta/llama-3.2-90b-vision-instruct" });
    assert.equal(config.text.modelId, "deepseek-ai/DeepSeek-V4-Flash-0731");
    assert.equal(config.vision.modelId, "meta/llama-3.2-90b-vision-instruct");
    assert.throws(() => resolveDevelopmentModelConfig({ MEDIOBOT_DEV_TEXT_MODEL: "image-model" }), /unsupported text model/i);
    assert.throws(() => resolveDevelopmentModelConfig({ DAHL_API_KEY: "x", MEDIOBOT_DEV_TEXT_MODEL: "google/diffusiongemma-26b-a4b-it" }), /unsupported text model/i);
  });

  it("enforces modality capability at provider construction and request boundaries", async () => {
    // DiffusionGemma supports text input as well as images; the structured text client is valid.
    assert.doesNotThrow(() => new OpenAICompatibleStructuredClient({ apiKey: "x", modelId: "google/diffusiongemma-26b-a4b-it" }));
    assert.throws(() => new OpenAICompatibleVisionClient({ apiKey: "x", modelId: "MiniMaxAI/MiniMax-M2.7" }),
      (error: unknown) => error instanceof ModelProviderError && error.code === "unsupported-modality");
    let fetched = false;
    const vision = new OpenAICompatibleVisionClient({ apiKey: "x", modelId: "meta/llama-3.2-90b-vision-instruct",
      fetch: async () => { fetched = true; throw new Error("unexpected fetch"); } });
    await assert.rejects(() => vision.analyzeImage({ prompt: "inspect", image: "https://example.test/image.png" }),
      (error: unknown) => error instanceof ModelProviderError && error.code === "unsupported-modality");
    assert.equal(fetched, false, "invalid remote image input is rejected before provider access");
  });

  it("sends local data-URI images to the selected NVIDIA vision model and never serializes credentials", async () => {
    let sent = "";
    const provider = new OpenAICompatibleVisionClient({ apiKey: "vision-secret", modelId: "google/diffusiongemma-26b-a4b-it",
      baseUrl: "https://integrate.api.nvidia.com/v1", fetch: async (_input, init) => {
        sent = String(init?.body);
        return new Response(JSON.stringify({ choices: [{ message: { content: "<think>private visual reasoning</think>a blue rectangle" } }] }), { status: 200 });
      } });
    assert.equal(JSON.stringify(provider).includes("vision-secret"), false);
    const result = await provider.analyzeImage({ image: "data:image/png;base64,AA==", prompt: "Describe it" });
    assert.equal(result.content, "a blue rectangle");
    assert.equal(result.content.includes("private visual reasoning"), false);
    assert.match(sent, /data:image\/png;base64,AA==/);
    assert.match(sent, /google\/diffusiongemma-26b-a4b-it/);
  });

  it("rejects malformed vision responses and propagates cancellation without leaking secrets", async () => {
    const malformed = new OpenAICompatibleVisionClient({ apiKey: "secret", modelId: "meta/llama-3.2-90b-vision-instruct",
      fetch: async () => new Response("{}", { status: 200 }) });
    await assert.rejects(() => malformed.analyzeImage({ image: "data:image/png;base64,AA==", prompt: "x" }),
      (error: unknown) => error instanceof ModelProviderError && error.code === "invalid-response");
    const waiting: typeof fetch = async (_input, init) => new Promise((_resolve, reject) =>
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
    const cancelled = new OpenAICompatibleVisionClient({ apiKey: "secret", modelId: "meta/llama-3.2-90b-vision-instruct", fetch: waiting });
    const controller = new AbortController();
    const pending = cancelled.analyzeImage({ image: "data:image/png;base64,AA==", prompt: "x", signal: controller.signal });
    controller.abort();
    await assert.rejects(() => pending, (error: unknown) => error instanceof ModelProviderError && error.code === "cancelled");
    const timeoutProvider = new OpenAICompatibleVisionClient({ apiKey: "secret", modelId: "meta/llama-3.2-90b-vision-instruct",
      timeoutMs: 5, fetch: waiting });
    await assert.rejects(() => timeoutProvider.analyzeImage({ image: "data:image/png;base64,AA==", prompt: "x" }),
      (error: unknown) => error instanceof ModelProviderError && error.code === "timeout");
  });

  it("accepts only a structured action bound to an observed enabled target", () => {
    const state = observation(3, "http://fixture.local/", [
      { id: "e1", role: "textbox", name: "Search", enabled: true },
    ]);
    assert.deepEqual(validateDecision('{"type":"type","targetId":"e1","value":"Cedar"}', state),
      { type: "type", targetId: "e1", value: "Cedar", observationRevision: 3 });
    assert.throws(() => validateDecision("Here is my thought: click e1", state), /malformed JSON/i);
    assert.throws(() => validateDecision('{"type":"click","targetId":"missing"}', state), /nonexistent/i);
    assert.throws(() => validateDecision('{"type":"type","targetId":"e1","value":"x","script":"bad"}', state), /malformed type/i);
  });

  it("bounds model context and propagates the abort signal without guessing prose", async () => {
    const state = observation(4, "http://fixture.local/", [{ id: "e1", role: "button", name: "Continue", enabled: true }]);
    let passedSignal: AbortSignal | undefined;
    let input = "";
    let metrics: { readonly systemCharacters?: number; readonly inputCharacters?: number;
      readonly providerInputTokens?: number; readonly providerOutputTokens?: number } | undefined;
    const provider = new ModelDecisionProvider({ complete: async (request) => {
      passedSignal = request.signal; input = request.input; return '{"type":"click","targetId":"e1"}';
    }, usage: () => ({ inputTokens: 42, outputTokens: 8 }) }, (value) => { metrics = value; });
    const signal = new AbortController().signal;
    assert.deepEqual(await provider.decide("continue", state, [], signal),
      { type: "click", targetId: "e1", observationRevision: 4 });
    assert.equal(passedSignal, signal);
    assert.match(input, /"goal":"continue"/);
    assert.equal(typeof metrics?.systemCharacters, "number");
    assert.equal(metrics?.inputCharacters, input.length);
    assert.equal(metrics?.providerInputTokens, 42);
    assert.equal(metrics?.providerOutputTokens, 8);
    let system = "";
    await new ModelDecisionProvider({ complete: async (request) => { system = request.system; return '{"type":"finish"}'; } })
      .decide("continue", state, [], signal);
    assert.match(system, /Never use scripts, selectors, DOM evaluation/);
  });

  it("calls an OpenAI-compatible endpoint with structured mode and never puts credentials in errors", async () => {
    let requestBody = "";
    let auth = "";
    const client = new OpenAICompatibleStructuredClient({ apiKey: "sensitive-test-key", modelId: "model-x",
      baseUrl: "https://provider.example/v1", fetch: async (_input, init) => {
        requestBody = String(init?.body); auth = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"type":"finish"}' } }] }), { status: 200 });
      } });
    assert.equal(JSON.stringify(client).includes("sensitive-test-key"), false);
    const result = await client.complete({ system: "system", input: "{}", signal: new AbortController().signal });
    assert.equal(result, '{"type":"finish"}');
    assert.equal(auth, "Bearer sensitive-test-key");
    assert.match(requestBody, /"response_format":\{"type":"json_object"\}/);
  });

  it("distinguishes provider timeout, caller cancellation, and provider errors without leaking key material", async () => {
    const waitingFetch: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
    const timeoutClient = new OpenAICompatibleStructuredClient({ apiKey: "not-for-logs", modelId: "test", timeoutMs: 5, fetch: waitingFetch });
    await assert.rejects(() => timeoutClient.complete({ system: "", input: "", signal: new AbortController().signal }), /timed out/i);
    const controller = new AbortController();
    const cancel = timeoutClient.complete({ system: "", input: "", signal: controller.signal });
    controller.abort();
    await assert.rejects(() => cancel, /cancelled/i);
    const badProvider = new OpenAICompatibleStructuredClient({ apiKey: "not-for-logs", modelId: "test",
      fetch: async () => new Response("not-for-logs", { status: 401 }) });
    await assert.rejects(() => badProvider.complete({ system: "", input: "", signal: new AbortController().signal }),
      (error: unknown) => error instanceof Error && /HTTP 401/.test(error.message) && !error.message.includes("not-for-logs"));
  });

  it("keeps benchmark goals and fixture-specific behavior out of production Vision modules", async () => {
    const production = await Promise.all(["../src/index.ts", "../src/model.ts"].map((file) =>
      readFile(new URL(file, import.meta.url), "utf8")));
    assert.doesNotMatch(production.join("\n"), /Cedar|Nimbus|Juniper|Local Records|confirmArchive/i);
  });

  it("runs distinct goals through the same observation, decision, executor, and verifier contracts", async (t) => {
    const cases = ["open the record", "search records and inspect the result", "update the record after confirmation"];
    for (const goal of cases) {
      const f = await fixture(goal);
      t.after(f.cleanup);
      const page = new ScriptedPage();
      const agent = new AutonomousBrowserTask({
        world: f.world, workerId: f.workerId, taskId: f.taskId, resourceId: f.resourceId,
        observations: page, executor: page, decisions: new GoalDecisionProvider(),
        goalVerifier: { verify: async () => "verified" }, maxSteps: 6,
      });
      const result = await agent.run(goal);
      assert.equal(result.state, "completed", goal);
      assert.ok(result.history.length > 0);
      assert.ok(result.timings.every((timing) => timing.totalMs >= 0));
      assert.ok(result.evidence.some((entry) => entry.execution === "accepted" && entry.effect === "observable-change"
        && entry.changed === true), goal);
      assert.doesNotMatch(JSON.stringify(result.evidence), /recent record/);
      assert.ok(result.evidence.some((entry) => entry.effect === "finish-requested" && entry.goalVerification === "verified"));
      assert.ok(f.world.inspect().events.some((event) => event.type === "vision.goal-verified"
        && event.workerId === f.workerId && event.taskId === f.taskId && event.resourceId === f.resourceId));
      await agent.close();
    }
  });

  it("classifies a changed wait observation separately from an ordinary action effect", async (t) => {
    const f = await fixture("wait for the page to change");
    t.after(f.cleanup);
    let changed = false;
    const observations: ObservationProvider = { observe: async () => observation(changed ? 1 : 0,
      changed ? "http://fixture.local/ready" : "http://fixture.local/waiting", []) };
    const executor: BrowserExecutor = { execute: async (action) => {
      if (action.type === "wait") { changed = true; return { state: "accepted" }; }
      return { state: "rejected-before-mutation", reason: "invalid-action" };
    }, close: async () => undefined };
    const decisions: DecisionProvider = { decide: async (_goal, state) => state.url.endsWith("waiting")
      ? { type: "wait", observationRevision: state.revision }
      : { type: "finish", observationRevision: state.revision } };
    const agent = new AutonomousBrowserTask({ world: f.world, workerId: f.workerId, taskId: f.taskId,
      resourceId: f.resourceId, observations, executor, decisions,
      goalVerifier: { verify: async () => "verified" } });
    const result = await agent.run("wait for the page to change");
    assert.equal(result.state, "completed");
    assert.equal(result.evidence[0]?.effect, "wait-state-change");
    assert.equal(result.evidence[0]?.changed, true);
    await agent.close();
  });

  it("records a stale decision as rejected before mutation and never invokes the executor", async (t) => {
    const f = await fixture("open the record");
    t.after(f.cleanup);
    const page = new ScriptedPage();
    let executions = 0;
    const executor: BrowserExecutor = { execute: async () => { executions += 1; return { state: "accepted" }; }, close: () => page.close() };
    const decisions: DecisionProvider = { decide: async () => ({ type: "click", targetId: "open", observationRevision: -1 }) };
    const agent = new AutonomousBrowserTask({ world: f.world, workerId: f.workerId, taskId: f.taskId,
      resourceId: f.resourceId, observations: page, executor, decisions });
    const result = await agent.run("open the record");
    assert.equal(result.state, "failed");
    assert.equal(executions, 0);
    assert.equal(result.evidence[0]?.execution, "rejected-before-mutation");
    assert.equal(result.evidence[0]?.rejectionReason, "stale-observation");
    assert.equal(result.evidence[0]?.actionObservationRevision, -1);
    assert.equal(result.evidence[0]?.beforeObservation.revision, 0);
    await agent.close();
  });

  it("does not treat finish as success unless the independent verifier says verified", async (t) => {
    for (const verification of ["unknown", "not-verified"] as const) {
      const f = await fixture("inspect the record");
      t.after(f.cleanup);
      const page = new ScriptedPage();
      const decisions: DecisionProvider = { decide: async (_goal, state) => ({ type: "finish", observationRevision: state.revision }) };
      const agent = new AutonomousBrowserTask({ world: f.world, workerId: f.workerId, taskId: f.taskId,
        resourceId: f.resourceId, observations: page, executor: page, decisions, maxSteps: 8,
        ...(verification === "unknown" ? {} : { goalVerifier: { verify: async () => verification } }) });
      const result = await agent.run("inspect the record");
      assert.equal(result.state, "failed", verification);
      assert.match(result.error, /could not be verified/i);
      assert.equal(result.evidence.length, 3);
      assert.ok(result.evidence.every((entry) => entry.execution === "not-required"
        && entry.effect === "finish-requested" && entry.goalVerification === verification));
      assert.equal(f.world.inspect().events.filter((event) => event.type === "vision.finish-requested").length, 3);
      assert.equal(f.world.inspect().events.some((event) => event.type === "vision.goal-verified"), false);
      await agent.close();
    }
  });

  it("keeps action evidence isolated and correctly attributed across concurrent task instances", async (t) => {
    const first = await fixture("open the record");
    const second = await fixture("search records and inspect the result");
    t.after(first.cleanup);
    t.after(second.cleanup);
    const run = (f: Fixture) => {
      const page = new ScriptedPage();
      const agent = new AutonomousBrowserTask({ world: f.world, workerId: f.workerId, taskId: f.taskId,
        resourceId: f.resourceId, observations: page, executor: page, decisions: new GoalDecisionProvider(),
        goalVerifier: { verify: async () => "verified" } });
      return agent.run("open the record").finally(() => agent.close());
    };
    const [firstResult, secondResult] = await Promise.all([run(first), run(second)]);
    for (const [f, result] of [[first, firstResult], [second, secondResult]] as const) {
      assert.equal(result.state, "completed");
      assert.ok(result.evidence.length > 0);
      assert.ok(result.evidence.every((entry) => entry.worldId === f.world.id && entry.workerId === f.workerId
        && entry.taskId === f.taskId && entry.resourceId === f.resourceId));
    }
    assert.notEqual(firstResult.evidence[0]?.taskId, secondResult.evidence[0]?.taskId);
  });

  it("records cancellation of an in-flight action without retrying it", async (t) => {
    const f = await fixture("open the record");
    t.after(f.cleanup);
    const controller = new AbortController();
    const page = new ScriptedPage();
    let executions = 0;
    const executor: BrowserExecutor = { execute: async () => {
      executions += 1;
      controller.abort();
      return { state: "cancelled" };
    }, close: () => page.close() };
    const agent = new AutonomousBrowserTask({ world: f.world, workerId: f.workerId, taskId: f.taskId,
      resourceId: f.resourceId, observations: page, executor, decisions: new GoalDecisionProvider(), signal: controller.signal });
    const result = await agent.run("open the record");
    assert.equal(result.state, "cancelled");
    assert.equal(executions, 1);
    assert.equal(result.evidence[0]?.execution, "cancelled");
    assert.equal(result.evidence[0]?.effect, "cancelled");
    assert.equal(result.evidence[0]?.taskId, f.taskId);
    await agent.close();
  });

  it("runs the same loop against an owned local Playwright page for find, search, and intermediate-dialog goals", async (t) => {
    const goals = ["open the Cedar record", "search for Cedar and inspect its record", "change Cedar status to ready"];
    const html = `<!doctype html><title>Records</title>
      <main><h1>Records</h1><a href="#record" id="cedar">Cedar record</a>
      <label>Search records <input id="search" placeholder="Search records"></label>
      <button id="update">Update Cedar</button><p id="result"></p>
      <section id="dialog" role="dialog" hidden><p>Review the pending change</p><button id="confirm">Confirm update</button></section>
      <script>
        document.querySelector('#cedar').addEventListener('click', () => { document.querySelector('h1').textContent='Cedar record'; document.querySelector('#result').textContent='Owner: Research'; });
        document.querySelector('#search').addEventListener('keydown', e => { if(e.key==='Enter') document.querySelector('#result').textContent='Cedar record — Owner: Research'; });
        document.querySelector('#update').addEventListener('click', () => { document.querySelector('#dialog').hidden=false; });
        document.querySelector('#confirm').addEventListener('click', () => { document.querySelector('#dialog').hidden=true; document.querySelector('#result').textContent='Status: ready'; });
      </script></main>`;

    for (const goal of goals) {
      const f = await fixture(goal);
      t.after(f.cleanup);
      const browser = await PlaywrightBrowserPage.launch({ resourceId: f.resourceId });
      t.after(() => browser.close());
      await browser.navigate(`data:text/html,${encodeURIComponent(html)}`);
      const decisions: DecisionProvider = {
        decide: async (_goal, state) => {
          const has = (name: string) => state.elements.find((element) => element.name === name);
          if (goal === goals[0]) {
            if (state.text.includes("Owner: Research")) return { type: "finish", observationRevision: state.revision };
            const link = has("Cedar record");
            if (link && !state.url.endsWith("#record")) return { type: "click", targetId: link.id, observationRevision: state.revision };
          }
          if (goal === goals[1]) {
            const search = has("Search records");
            if (search && !search.value) return { type: "type", targetId: search.id, value: "Cedar", observationRevision: state.revision };
            if (state.text.includes("Owner: Research")) return { type: "finish", observationRevision: state.revision };
            if (search?.value) return { type: "press", key: "Enter", observationRevision: state.revision };
          }
          if (goal === goals[2]) {
            if (state.text.includes("Status: ready")) return { type: "finish", observationRevision: state.revision };
            const confirm = has("Confirm update");
            if (confirm) return { type: "click", targetId: confirm.id, observationRevision: state.revision };
            const update = has("Update Cedar");
            if (update) return { type: "click", targetId: update.id, observationRevision: state.revision };
          }
          throw new Error(`No fixture decision for ${state.url}: ${state.elements.map((element) => element.name).join(", ")} | ${state.text}`);
        },
      };
      const agent = new AutonomousBrowserTask({ world: f.world, workerId: f.workerId, taskId: f.taskId,
        resourceId: f.resourceId, observations: browser, executor: browser, decisions,
        goalVerifier: { verify: async () => "verified" }, maxSteps: 8 });
      const result = await agent.run(goal);
      assert.equal(result.state, "completed", goal);
      assert.ok(result.history.length >= 1);
      assert.ok(result.history.every((entry) => entry.progress !== "no-effect"), goal);
      await agent.close();
    }
  });

  it("rejects an action selected for a stale observation", async (t) => {
    const f = await fixture("open the record");
    t.after(f.cleanup);
    const page = new ScriptedPage();
    const first = await page.observe();
    const action: BrowserAction = { type: "click", targetId: "open", observationRevision: first.revision };
    assert.deepEqual(await page.execute(action, first, new AbortController().signal), { state: "accepted" });
    assert.deepEqual(await page.execute(action, first, new AbortController().signal),
      { state: "rejected-before-mutation", reason: "stale-observation" });
  });

  it("fails closed when the supplied browser resource belongs to another worker", async (t) => {
    const f = await fixture("open the record");
    t.after(f.cleanup);
    const otherDefinition = f.world.registerMediobotDefinition({ name: "Other", role: "browser", version: "1",
      instructions: "other", declaredCapabilities: [] });
    const otherWorker = f.world.spawnWorker(otherDefinition.id);
    const otherResource = f.world.registerResource({ kind: "browser-page",
      owner: { type: "worker", worldId: f.world.id, workerId: otherWorker.id } });
    const page = new ScriptedPage();
    const agent = new AutonomousBrowserTask({ world: f.world, workerId: f.workerId, taskId: f.taskId,
      resourceId: otherResource.id, observations: page, executor: page, decisions: new GoalDecisionProvider() });
    const result = await agent.run("open the record");
    assert.equal(result.state, "failed");
    assert.match(result.error, /not owned/i);
    assert.equal(f.world.inspect().events.some((event) => event.resourceId === otherResource.id), false);
    await agent.close();
  });

  it("revalidates worker ownership after a deferred decision before executing", async (t) => {
    const f = await fixture("open the record");
    t.after(f.cleanup);
    let resolveDecision!: (action: BrowserAction) => void;
    let onDecision!: () => void;
    const decisionEntered = new Promise<void>((resolve) => { onDecision = resolve; });
    const decision = new Promise<BrowserAction>((resolve) => { resolveDecision = resolve; });
    let executions = 0;
    const page = new ScriptedPage();
    const executor: BrowserExecutor = { execute: async () => { executions += 1; return { state: "accepted" }; }, close: () => page.close() };
    const decisions: DecisionProvider = { decide: async (_goal, state) => {
      onDecision();
      return decision;
    } };
    const agent = new AutonomousBrowserTask({ world: f.world, workerId: f.workerId, taskId: f.taskId,
      resourceId: f.resourceId, observations: page, executor, decisions });
    const running = agent.run("open the record");
    await decisionEntered;
    f.world.setResourceState(f.resourceId, "released");
    resolveDecision({ type: "wait", observationRevision: 0 });
    const result = await running;
    assert.equal(result.state, "failed");
    assert.equal(executions, 0);
    await agent.close();
  });

  it("does not attribute a finish request after its browser resource has been released", async (t) => {
    const f = await fixture("open the record");
    t.after(f.cleanup);
    let resolveDecision!: (action: BrowserAction) => void;
    let onDecision!: () => void;
    const decisionEntered = new Promise<void>((resolve) => { onDecision = resolve; });
    const decision = new Promise<BrowserAction>((resolve) => { resolveDecision = resolve; });
    const page = new ScriptedPage();
    const decisions: DecisionProvider = { decide: async () => { onDecision(); return decision; } };
    const agent = new AutonomousBrowserTask({ world: f.world, workerId: f.workerId, taskId: f.taskId,
      resourceId: f.resourceId, observations: page, executor: page, decisions });
    const running = agent.run("open the record");
    await decisionEntered;
    f.world.setResourceState(f.resourceId, "released");
    resolveDecision({ type: "finish", observationRevision: 0 });
    const result = await running;
    assert.equal(result.state, "failed");
    assert.equal(f.world.inspect().events.some((event) => event.type === "vision.finish-requested"
      && event.resourceId === f.resourceId), false);
    await agent.close();
  });

  it("settles a blocked decision promptly on cancellation even if the provider ignores its signal", async (t) => {
    const f = await fixture("open the record");
    t.after(f.cleanup);
    let resolveDecision!: (action: BrowserAction) => void;
    let onDecision!: () => void;
    const decisionEntered = new Promise<void>((resolve) => { onDecision = resolve; });
    const decision = new Promise<BrowserAction>((resolve) => { resolveDecision = resolve; });
    const controller = new AbortController();
    let executions = 0;
    const page = new ScriptedPage();
    const executor: BrowserExecutor = { execute: async () => { executions += 1; return { state: "accepted" }; }, close: () => page.close() };
    const decisions: DecisionProvider = { decide: async () => { onDecision(); return decision; } };
    const agent = new AutonomousBrowserTask({ world: f.world, workerId: f.workerId, taskId: f.taskId,
      resourceId: f.resourceId, observations: page, executor, decisions, signal: controller.signal });
    const running = agent.run("open the record");
    await decisionEntered;
    controller.abort();
    const result = await running;
    assert.equal(result.state, "cancelled");
    resolveDecision({ type: "wait", observationRevision: 0 });
    assert.equal(executions, 0);
    await agent.close();
  });

  it("rejects stale external browser state before executing a Playwright action", async (t) => {
    const f = await fixture("open the record");
    t.after(f.cleanup);
    const browser = await PlaywrightBrowserPage.launch({ resourceId: f.resourceId });
    t.after(() => browser.close());
    const html = "<button>Continue</button><p>Before</p>";
    await browser.navigate(`data:text/html,${encodeURIComponent(html)}`);
    const before = await browser.observe(new AbortController().signal);
    const target = before.elements.find((element) => element.name === "Continue");
    assert.ok(target);
    await browser.navigate(`data:text/html,${encodeURIComponent("<button>Different</button><p>After</p>")}`);
    assert.deepEqual(await browser.execute({ type: "click", targetId: target.id,
      observationRevision: before.revision }, before, new AbortController().signal),
    { state: "rejected-before-mutation", reason: "stale-observation" });
  });

  it("keeps duplicate observed controls bound to the exact observation if identical siblings reorder and reobserve", async (t) => {
    const f = await fixture("activate the second Open control");
    t.after(f.cleanup);
    const browser = await PlaywrightBrowserPage.launch({ resourceId: f.resourceId });
    t.after(() => browser.close());
    const html = `<!doctype html><title>Duplicates</title><main>
      <section id="one"><button id="first">Open</button></section><section id="two"><button id="second">Open</button></section><p id="result"></p>
      <script>
        first.addEventListener('click', () => result.textContent = 'first');
        second.addEventListener('click', () => result.textContent = 'second');
      </script></main>`;
    await browser.navigate(`data:text/html,${encodeURIComponent(html)}`);
    const before = await browser.observe(new AbortController().signal);
    const target = before.elements.filter((element) => element.role === "button" && element.name === "Open")[1];
    assert.ok(target);
    // Swap indistinguishable siblings after observation. The public fingerprint is intentionally unchanged.
    const page = (browser as unknown as { page: Page }).page;
    await page.evaluate(() => {
      const main = document.querySelector("main")!;
      const first = document.querySelector("#one")!;
      const second = document.querySelector("#two")!;
      main.insertBefore(second, first);
    });
    const concurrentObservation = await browser.observe(new AbortController().signal);
    assert.equal(concurrentObservation.fingerprint, before.fingerprint);
    assert.deepEqual(await browser.execute({ type: "click", targetId: target.id, observationRevision: before.revision }, before,
      new AbortController().signal), { state: "rejected-before-mutation", reason: "stale-observation" });
    assert.equal(await page.locator("#result").innerText(), "");
  });

  it("grounds duplicate link names and input labels to their observed nodes", async (t) => {
    const f = await fixture("use the second duplicate control");
    t.after(f.cleanup);
    const browser = await PlaywrightBrowserPage.launch({ resourceId: f.resourceId });
    t.after(() => browser.close());
    const html = `<!doctype html><title>Duplicate links and inputs</title><main>
      <section id="one"><a id="first-link" href="#first">Open</a><label>Search <input id="first-input"></label></section>
      <section id="two"><a id="second-link" href="#second">Open</a><label>Search <input id="second-input"></label></section>
      <p id="result"></p><script>
        document.querySelector('#first-link').addEventListener('click', e => { e.preventDefault(); result.textContent='first link'; });
        document.querySelector('#second-link').addEventListener('click', e => { e.preventDefault(); result.textContent='second link'; });
      </script></main>`;
    await browser.navigate(`data:text/html,${encodeURIComponent(html)}`);
    const before = await browser.observe(new AbortController().signal);
    const links = before.elements.filter((element) => element.role === "link" && element.name === "Open");
    const inputs = before.elements.filter((element) => element.role === "textbox" && element.name === "Search");
    assert.equal(links.length, 2);
    assert.equal(inputs.length, 2);
    const page = (browser as unknown as { page: Page }).page;
    await page.evaluate(() => document.querySelector("main")!.insertBefore(
      document.querySelector("#two")!, document.querySelector("#one")!));
    assert.deepEqual(await browser.execute({ type: "click", targetId: links[1]!.id, observationRevision: before.revision }, before,
      new AbortController().signal), { state: "rejected-before-mutation", reason: "stale-observation" });
    assert.equal(await page.locator("#result").innerText(), "");
    const reordered = await browser.observe(new AbortController().signal);
    const currentLink = reordered.elements.find(element => element.role === "link")!;
    await browser.execute({ type: "click", targetId: currentLink.id, observationRevision: reordered.revision }, reordered,
      new AbortController().signal);
    assert.equal(await page.locator("#result").innerText(), "second link");
    const afterClick = await browser.observe(new AbortController().signal);
    const reorderedInputs = afterClick.elements.filter((element) => element.role === "textbox" && element.name === "Search");
    await page.evaluate(() => document.querySelector("main")!.insertBefore(
      document.querySelector("#one")!, document.querySelector("#two")!));
    assert.deepEqual(await browser.execute({ type: "type", targetId: reorderedInputs[0]!.id, value: "needle",
      observationRevision: afterClick.revision }, afterClick, new AbortController().signal),
    { state: "rejected-before-mutation", reason: "stale-observation" });
    assert.equal(await page.locator("#second-input").inputValue(), "");
    const current = await browser.observe(new AbortController().signal);
    const currentInputs = current.elements.filter(element => element.role === "textbox");
    await browser.execute({ type: "type", targetId: currentInputs[1]!.id, value: "needle",
      observationRevision: current.revision }, current, new AbortController().signal);
    assert.equal(await page.locator("#second-input").inputValue(), "needle");
    assert.equal(await page.locator("#first-input").inputValue(), "");
  });

  it("serializes concurrent actions against one owned Playwright page", async (t) => {
    const f = await fixture("continue once");
    t.after(f.cleanup);
    const browser = await PlaywrightBrowserPage.launch({ resourceId: f.resourceId });
    t.after(() => browser.close());
    await browser.navigate(`data:text/html,${encodeURIComponent("<button>Continue</button><button>Cancel</button>")}`);
    const state = await browser.observe(new AbortController().signal);
    const [continueButton, cancelButton] = state.elements;
    assert.ok(continueButton && cancelButton);
    const actions = await Promise.allSettled([
      browser.execute({ type: "click", targetId: continueButton.id, observationRevision: state.revision }, state, new AbortController().signal),
      browser.execute({ type: "click", targetId: cancelButton.id, observationRevision: state.revision }, state, new AbortController().signal),
    ]);
    assert.equal(actions.filter((action) => action.status === "fulfilled" && action.value.state === "accepted").length, 1);
    assert.equal(actions.filter((action) => action.status === "fulfilled" && action.value.state === "rejected-before-mutation"
      && action.value.reason === "busy").length, 1);
  });

  it("enforces step budget and cancellation with attributable terminal events", async (t) => {
    const f = await fixture("open the record");
    t.after(f.cleanup);
    const page = new ScriptedPage();
    const decisions: DecisionProvider = { decide: async (_goal, state) => ({ type: "wait", observationRevision: state.revision }) };
    const agent = new AutonomousBrowserTask({ world: f.world, workerId: f.workerId, taskId: f.taskId,
      resourceId: f.resourceId, observations: page, executor: page, decisions, maxSteps: 2 });
    const result = await agent.run("open the record");
    assert.equal(result.state, "failed");
    assert.match(result.error, /maximum step limit/i);
    assert.equal(result.history.length, 2);
    assert.ok(result.history.every((entry) => entry.progress === "no-effect"));
    assert.ok(result.evidence.every((entry) => entry.effect === "no-observable-change" && entry.changed === false));
    assert.ok(f.world.inspect().events.some((event) => event.type === "vision.failed" && event.workerId === f.workerId));
    await agent.close();
  });

  it("reports an executor failure without converting it to success", async (t) => {
    const f = await fixture("open the record");
    t.after(f.cleanup);
    const page = new ScriptedPage();
    let decisions = 0;
    let observations = 0;
    const observationsProvider: ObservationProvider = { observe: async () => { observations += 1; return page.observe(); } };
    const executor: BrowserExecutor = { execute: async () => { throw new Error("uncertain mutation failure"); }, close: () => page.close() };
    const goalDecisions = new GoalDecisionProvider();
    const decisionProvider: DecisionProvider = { decide: async (goal, state) => { decisions += 1; return goalDecisions.decide(goal, state); } };
    const agent = new AutonomousBrowserTask({ world: f.world, workerId: f.workerId, taskId: f.taskId,
      resourceId: f.resourceId, observations: observationsProvider, executor, decisions: decisionProvider, maxSteps: 5 });
    const result = await agent.run("open the record");
    assert.equal(result.state, "failed");
    assert.match(result.error, /not retried/i);
    assert.equal(result.history.length, 0);
    assert.equal(decisions, 1);
    assert.equal(observations, 2, "uncertain mutation triggers one fresh observation");
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0]?.execution, "execution-error");
    assert.equal(result.evidence[0]?.effect, "execution-failed");
    assert.equal(result.evidence[0]?.afterObservation?.revision, 0);
    assert.ok(f.world.inspect().events.some((event) => event.type === "vision.failed"
      && event.workerId === f.workerId && event.taskId === f.taskId && event.resourceId === f.resourceId));
    await agent.close();
  });


  it("keeps execution history within the configured bound", async (t) => {
    const f = await fixture("observe repeatedly");
    t.after(f.cleanup);
    const page = new ScriptedPage();
    const waits: DecisionProvider = { decide: async (_goal, state) => ({ type: "wait", observationRevision: state.revision }) };
    const agent = new AutonomousBrowserTask({ world: f.world, workerId: f.workerId, taskId: f.taskId,
      resourceId: f.resourceId, observations: page, executor: page, decisions: waits, maxSteps: 4, maxHistory: 1 });
    const result = await agent.run("observe repeatedly");
    assert.equal(result.state, "failed");
    assert.equal(result.history.length, 1);
    await agent.close();
  });

  it("returns cancellation distinctly and keeps the caller-owned browser resource attributable", async (t) => {
    const f = await fixture("open the record");
    t.after(f.cleanup);
    const controller = new AbortController();
    controller.abort();
    const page = new ScriptedPage();
    const agent = new AutonomousBrowserTask({ world: f.world, workerId: f.workerId, taskId: f.taskId,
      resourceId: f.resourceId, observations: page, executor: page, decisions: new GoalDecisionProvider(), signal: controller.signal });
    const result = await agent.run("open the record");
    assert.equal(result.state, "cancelled");
    assert.ok(f.world.inspect().events.some((event) => event.type === "vision.cancelled"
      && event.workerId === f.workerId && event.taskId === f.taskId && event.resourceId === f.resourceId));
    await agent.close();
  });
});
