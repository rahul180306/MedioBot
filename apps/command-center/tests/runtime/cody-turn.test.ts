import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Readable, Writable } from "node:stream";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TaskId } from "@mediobot-v2/domain";
import { startCommandCenter } from "../../src/server.ts";
import { LocalDatabase } from "../../src/storage/db.ts";
import { ProviderRepository } from "../../src/storage/providerRepository.ts";
import { ModelResolver } from "../../src/runtime/modelRegistry.ts";
import { ToolPermissionEngine } from "@mediobot-v2/tools";
import { DurableTaskEngine } from "@mediobot-v2/runtime";
import { createComposition } from "../../src/composition.ts";
import { SqliteDurableTaskStore } from "../../src/storage/durableTaskStore.ts";

class ResponseCapture extends Writable {
  statusCode = 200;
  output = "";
  onChunk?: () => void;
  writeHead(status: number) { this.statusCode = status; return this; }
  override _write(chunk: Buffer, _: BufferEncoding, callback: () => void) { this.output += chunk.toString(); this.onChunk?.(); callback(); }
}

async function request(
  app: Awaited<ReturnType<typeof startCommandCenter>>,
  method: string,
  url: string,
  body?: unknown,
) {
  const req = Object.assign(Readable.from(body ? [JSON.stringify(body)] : []), { method, url, headers: {} });
  const res = new ResponseCapture();
  const finished = new Promise<void>((resolve) => res.once("finish", resolve));
  app.handle(req as never, res as never);
  await finished;
  return { status: res.statusCode, json: JSON.parse(res.output) };
}

async function awaitTaskCompletion(
  app: Awaited<ReturnType<typeof startCommandCenter>>,
  taskId: string,
): Promise<string> {
  const id = taskId as unknown as TaskId;
  const priorTerminal = app.composition.taskEvents.get(id)?.find((event) =>
    ["task.completed", "task.failed", "task.cancelled"].includes(event.type));
  if (priorTerminal) return priorTerminal.type;
  return new Promise<string>((resolve) => {
    const listener = (event: { type: string }) => {
      if (["task.completed", "task.failed", "task.cancelled"].includes(event.type)) {
        subs.delete(listener);
        if (subs.size === 0) app.composition.subscribers.delete(id);
        resolve(event.type);
      }
    };
    const subs = app.composition.subscribers.get(id) ?? new Set();
    subs.add(listener);
    app.composition.subscribers.set(id, subs);
  });
}

async function turnEvents(
  app: Awaited<ReturnType<typeof startCommandCenter>>,
  threadId: string,
  turnId: string,
) {
  const req = Object.assign(Readable.from([]), { method: "GET", url: `/api/turns/${turnId}/events?threadId=${threadId}`, headers: {} });
  const res = new ResponseCapture();
  const terminal = new Promise<void>((resolve) => {
    res.onChunk = () => {
      if (res.output.includes('"type":"task.completed"') || res.output.includes('"type":"task.failed"')
        || res.output.includes('"type":"turn.snapshot"')
          && (res.output.includes('"status":"completed"') || res.output.includes('"status":"failed"'))) resolve();
    };
  });
  app.handle(req as never, res as never);
  await terminal;
  res.emit("close");
  return res.output.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
}

function makeProvider(root: string): { providerRepo: ProviderRepository; database: LocalDatabase } {
  const dbPath = path.join(root, "mediobot.db");
  const database = new LocalDatabase(dbPath);
  const providerRepo = new ProviderRepository(database.raw);
  providerRepo.save({
    id: "selected-provider",
    providerType: "custom",
    displayName: "Selected",
    connected: true,
    enabled: true,
    baseUrl: "http://unused.invalid",
    models: [{
      id: "selected-model",
      name: "Text engine",
      enabled: true,
      capabilities: { text: true, reasoning: true, vision: true, tools: false },
    }],
  });
  return { providerRepo, database };
}

test("production /api/turns uses the loaded Maestro definition for a direct conversation without delegating", { timeout: 10000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-maestro-direct-"));
  const { providerRepo, database } = makeProvider(root);
  let maestroInput: Record<string, unknown> | undefined;
  let maestroSystem = "";
  const resolver = new ModelResolver(providerRepo, {
    createClient: () => ({ complete: async ({ input, system }: { input: string; system: string }) => {
      if (system.includes("MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER")) return JSON.stringify({ requiresCurrentProjectEvidence: false });
      maestroInput = JSON.parse(input) as Record<string, unknown>;
      maestroSystem = system;
      return JSON.stringify({ type: "respond", message: "Hello. What would you like to work on?", basis: "conversation", evidenceRefs: [] });
    } }),
  });
  const app = await startCommandCenter({ databasePath: path.join(root, "mediobot.db"), providerRepository: providerRepo,
    modelResolver: resolver, workspaceRoot: root, vite: false, listen: false });
  t.after(async () => { await app.close(); database.close(); rmSync(root, { recursive: true, force: true }); });

  const response = await request(app, "POST", "/api/turns", { threadId: "maestro-direct", turnId: "hello",
    prompt: "Hi", modelSelection: { providerConnectionId: "selected-provider", modelId: "selected-model" } });
  assert.ok([200, 202].includes(response.status));
  assert.equal(maestroInput?.userGoal, "Hi");
  assert.match(String(maestroInput?.definitionInstructions), /calm, strategic coordinator/);
  assert.match(String(maestroInput?.definitionInstructions), /You own the original goal and final synthesis/);
  assert.match(maestroSystem, /Structured runtimeState and permissions are authoritative/);
  assert.deepEqual(app.composition.world.inspect().tasks, [], "a direct response must not create an execution task");
  const saved = await request(app, "GET", "/api/threads/maestro-direct");
  assert.equal(saved.json.thread.turns[0].status, "completed");
  assert.equal(saved.json.thread.turns[0].items.find((item: { type: string }) => item.type === "agent_message").text,
    "Hello. What would you like to work on?");
});

test("/api/turns forwards an explicit verification request to Maestro without requiring it for ordinary implementation", { timeout: 10000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-verification-intent-"));
  const { providerRepo, database } = makeProvider(root);
  let maestroCalls = 0;
  const resolver = new ModelResolver(providerRepo, { createClient: () => ({ complete: async ({ input, system }: { input: string; system: string }) => {
    if (system.includes("MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER")) return JSON.stringify({ requiresCurrentProjectEvidence: false });
    const data = JSON.parse(input) as Record<string, unknown>;
    maestroCalls += 1;
    const cody = (data.availableMediobots as Array<{ definitionId: string; role: string }>).find(item => item.role === "coding");
    assert.ok(cody);
    return JSON.stringify({ type: "delegate", definitionId: cody.definitionId, objective: "Implement the requested helper",
      relevantContextRefs: [], constraints: [], expectedOutcome: "A working helper", evidenceExpectations: [] });
  } }) });
  const app = await startCommandCenter({ databasePath: path.join(root, "mediobot.db"), providerRepository: providerRepo,
    modelResolver: resolver, workspaceRoot: root, vite: false, listen: false });
  t.after(async () => { await app.close(); database.close(); rmSync(root, { recursive: true, force: true }); });
  const submissions: Array<Readonly<Record<string, unknown>>> = [];
  Object.defineProperty(app.composition, "submit", { configurable: true, value: ((
    _definitionId: unknown, _goal: string, options: Readonly<Record<string, unknown>> | undefined,
    onBeforeEmit?: (taskId: TaskId) => void,
  ) => {
    submissions.push(options ?? {});
    const taskId = `task-verification-${submissions.length}` as unknown as TaskId;
    onBeforeEmit?.(taskId);
    return { taskId, result: Promise.resolve({ state: "completed" }) as never };
  }) as typeof app.composition.submit });

  const selection = { providerConnectionId: "selected-provider", modelId: "selected-model" };
  const verified = await request(app, "POST", "/api/turns", { threadId: "verify-thread", turnId: "verify-turn",
    prompt: "Create a prime checker and verify the result.", modelSelection: selection });
  const ordinary = await request(app, "POST", "/api/turns", { threadId: "ordinary-thread", turnId: "ordinary-turn",
    prompt: "Create a prime checker.", modelSelection: selection });
  assert.equal(verified.status, 202);
  assert.equal(ordinary.status, 202);
  assert.equal(maestroCalls, 2);
  assert.equal(submissions[0]?.requireVerification, true,
    "explicit verification intent must activate Maestro's existing independent verification path");
  assert.equal(submissions[1]?.requireVerification, undefined,
    "an ordinary implementation request must not incur unsolicited independent verification");
});

test("selected Cody uses its explicit provider, private durable continuity, and Cody attribution across restart", { timeout: 20000 }, async (t) => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "mediobot-specialist-route-"));
  const root = path.join(parent, "workspace");
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "continuity-fixture", dependencies: { react: "18.2.0" } }));
  const dbPath = path.join(parent, "mediobot.db");
  const { providerRepo, database } = makeProvider(parent);
  providerRepo.save({ id: "cody-provider", providerType: "custom", displayName: "Cody Provider", connected: true,
    enabled: true, baseUrl: "http://unused.invalid", models: [{ id: "cody-model", name: "Cody Model", enabled: true,
      capabilities: { text: true, reasoning: true, vision: false, tools: true } }] });
  const resolvedPairs: string[] = [];
  const codyInputs: Array<Record<string, unknown>> = [];
  let codyActions = 0;
  const resolver = new ModelResolver(providerRepo, {
    createClient: (options) => {
      resolvedPairs.push(`${options.modelId}`);
      return { complete: async ({ input, system }: { input: string; system: string }) => {
        const data = JSON.parse(input) as Record<string, unknown>;
        if (system.includes("MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER")) return JSON.stringify({ requiresCurrentProjectEvidence: false });
        if (typeof data.goal === "string" && Array.isArray(data.recentToolHistory)) {
          codyInputs.push(data);
          codyActions += 1;
          if (codyActions === 1) return JSON.stringify({ type: "list", path: "." });
          if (codyActions === 2) return JSON.stringify({ type: "read", path: "package.json" });
          if (codyActions === 3) return JSON.stringify({ type: "finish", summary: "package.json identifies React 18.2.0 as a dependency." });
          assert.match(String(data.goal), /React 18\.2\.0/);
          assert.match(String(data.goal), /Which framework did I identify earlier/i);
          return JSON.stringify({ type: "finish", summary: "Earlier I identified React 18.2.0 from package.json." });
        }
        if (typeof data.userGoal === "string") {
          const recalled = data.userGoal.includes("Which framework did I identify earlier");
          return JSON.stringify({ type: "respond", message: recalled
            ? "Earlier I identified React 18.2.0 from package.json."
            : "I inspected package.json and found React 18.2.0.", basis: "conversation", evidenceRefs: [] });
        }
        if (system.includes("You are Cody, MedioBot's Software engineering specialist")) {
          return JSON.stringify({ type: "respond", message: "I inspected package.json and found React 18.2.0.", basis: "conversation", evidenceRefs: [] });
        }
        throw new Error("Unexpected model request in direct Cody continuity test");
      } };
    },
  });
  const app = await startCommandCenter({ databasePath: dbPath, providerRepository: providerRepo, modelResolver: resolver,
    workspaceRoot: root, vite: false, listen: false });
  let closeActive = app.close;
  t.after(async () => { await closeActive(); database.close(); rmSync(parent, { recursive: true, force: true }); });

  const selection = { providerConnectionId: "cody-provider", modelId: "cody-model" };
  const first = await request(app, "POST", "/api/turns", { threadId: "specialist-thread", turnId: "inspect",
    specialistId: "cody", prompt: "Inspect package.json and identify the framework.", modelSelection: selection });
  assert.equal(first.status, 202);
  const firstTask = first.json.taskId as string;
  assert.equal(await awaitTaskCompletion(app, firstTask), "task.completed");
  assert.ok(codyActions >= 3, "the Cody execution adapter must invoke actual authorized filesystem tools");
  assert.deepEqual([...new Set(resolvedPairs)], ["cody-model"], "every resolved model request must use the selected specialist provider's model");
  const childTask = app.composition.world.inspect().tasks.find((task) => task.parentTaskId === firstTask);
  assert.ok(childTask, "direct Cody work must create a Cody child task");
  const savedFirst = await request(app, "GET", "/api/threads/specialist-thread");
  const firstTurn = savedFirst.json.thread.turns.find((turn: { id: string }) => turn.id === "inspect");
  assert.ok(firstTurn.items.some((item: { type: string; actor?: { mediobotId?: string } }) =>
    item.type === "agent_message" && item.actor?.mediobotId === "cody"), "the durable response must identify Cody as speaker");
  const row = database.raw.prepare("SELECT context_summary FROM specialist_sessions WHERE thread_id = ? AND specialist_id = ? AND scope_id = ?")
    .get("specialist-thread", "cody", "conversation:specialist-thread") as { context_summary: string } | undefined;
  assert.match(row?.context_summary ?? "", /React 18\.2\.0/, "Cody's report must be persisted in Cody's scoped continuity");

  await app.close();
  closeActive = async () => {};
  const restarted = await startCommandCenter({ databasePath: dbPath, providerRepository: providerRepo, modelResolver: resolver,
    workspaceRoot: root, vite: false, listen: false });
  closeActive = restarted.close;
  const second = await request(restarted, "POST", "/api/turns", { threadId: "specialist-thread", turnId: "recall",
    specialistId: "cody", prompt: "Which framework did I identify earlier? Answer without reading files again.", modelSelection: selection });
  assert.equal(second.status, 202);
  const secondTerminal = await awaitTaskCompletion(restarted, second.json.taskId as string);
  const failureRecord = database.raw.prepare("SELECT error_json FROM durable_tasks WHERE id = ?").get(second.json.taskId) as { error_json: string | null } | undefined;
  assert.equal(secondTerminal, "task.completed", failureRecord?.error_json ?? JSON.stringify(restarted.composition.taskEvents.get(second.json.taskId as TaskId)?.find((event) => event.type === "task.failed")));
  assert.equal(codyActions, 4, "the follow-up must finish from durable Cody continuity without another tool action");
  assert.match(String(codyInputs.at(-1)?.goal), /React 18\.2\.0/);
  const secondEvents = restarted.composition.taskEvents.get(second.json.taskId as TaskId)!;
  assert.ok(secondEvents.some((event) => event.type === "maestro.responded" && event.workerDefinitionId === "cody"),
    "the product event must retain the actual responding specialist identity");
  const thread = await request(restarted, "GET", "/api/threads/specialist-thread");
  const recall = thread.json.thread.turns.find((turn: { id: string }) => turn.id === "recall");
  assert.ok(recall.items.some((item: { type: string; actor?: { mediobotId?: string }; text?: string }) =>
    item.type === "agent_message" && item.actor?.mediobotId === "cody" && /React 18\.2\.0/.test(item.text ?? "")));
});

test("application shutdown cancels and settles an active LangGraph specialist before closing SQLite", { timeout: 15000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-shutdown-checkpoint-"));
  const { providerRepo, database } = makeProvider(root);
  providerRepo.save({ id: "cody-provider", providerType: "custom", displayName: "Cody Provider", connected: true,
    enabled: true, baseUrl: "http://unused.invalid", models: [{ id: "cody-model", name: "Cody Model", enabled: true,
      capabilities: { text: true, reasoning: true, vision: false, tools: true } }] });
  let signal: AbortSignal | undefined;
  let announceStarted!: () => void;
  const started = new Promise<void>(resolve => { announceStarted = resolve; });
  const resolver = new ModelResolver(providerRepo, {
    createClient: () => ({ complete: async (request: { input: string; system: string; signal?: AbortSignal }) => {
      if (request.system.includes("MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER")) return JSON.stringify({ requiresCurrentProjectEvidence: false });
      signal = request.signal;
      announceStarted();
      return await new Promise<string>((_resolve, reject) => {
        if (request.signal?.aborted) { reject(new Error("aborted")); return; }
        request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    } }),
  });
  const app = await startCommandCenter({ databasePath: path.join(root, "mediobot.db"), providerRepository: providerRepo,
    modelResolver: resolver, workspaceRoot: root, vite: false, listen: false });
  t.after(async () => { await app.close().catch(() => {}); database.close(); rmSync(root, { recursive: true, force: true }); });

  const response = await request(app, "POST", "/api/turns", { threadId: "shutdown-thread", turnId: "slow-cody",
    specialistId: "cody", prompt: "Inspect the project and report its package manager.",
    modelSelection: { providerConnectionId: "cody-provider", modelId: "cody-model" } });
  assert.equal(response.status, 202);
  const taskId = response.json.taskId as TaskId;
  await Promise.race([started, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Cody request did not start")), 3_000))]);
  const closeStartedAt = performance.now();
  await app.close();
  assert.equal(signal?.aborted, true, "shutdown must propagate cancellation into the active model request");
  assert.ok(performance.now() - closeStartedAt < 5_000, "shutdown should settle the cancelled specialist promptly");
  assert.equal((database.raw.prepare("SELECT status FROM durable_tasks WHERE id = ?").get(taskId) as { status: string } | undefined)?.status,
    "cancelled");
});

test("application shutdown aborts and awaits a pre-task Maestro decision", { timeout: 15000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-shutdown-decision-"));
  const { providerRepo, database } = makeProvider(root);
  let signal: AbortSignal | undefined;
  let announceStarted!: () => void;
  const started = new Promise<void>(resolve => { announceStarted = resolve; });
  const resolver = new ModelResolver(providerRepo, {
    createClient: () => ({ complete: async (request: { input: string; system: string; signal?: AbortSignal }) => {
      if (request.system.includes("MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER")) return JSON.stringify({ requiresCurrentProjectEvidence: false });
      signal = request.signal;
      announceStarted();
      return await new Promise<string>((_resolve, reject) => {
        if (request.signal?.aborted) { reject(new Error("aborted")); return; }
        request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    } }),
  });
  const app = await startCommandCenter({ databasePath: path.join(root, "mediobot.db"), providerRepository: providerRepo,
    modelResolver: resolver, workspaceRoot: root, vite: false, listen: false });
  t.after(async () => { await app.close().catch(() => {}); database.close(); rmSync(root, { recursive: true, force: true }); });

  const turnRequest = request(app, "POST", "/api/turns", { threadId: "shutdown-decision-thread", turnId: "slow-maestro",
    prompt: "Plan an implementation task and delegate it to Cody.",
    modelSelection: { providerConnectionId: "selected-provider", modelId: "selected-model" } });
  await Promise.race([started, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Maestro decision did not start")), 3_000))]);
  await app.close();
  await turnRequest;
  assert.equal(signal?.aborted, true, "shutdown must abort the pre-task Maestro decision");
});

test("user pause checkpoints a live Maestro-to-Cody run and resumes once after restart", { timeout: 30000 }, async t => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "mediobot-user-pause-e2e-"));
  const root = path.join(parent, "workspace");
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "pause-fixture" }));
  let { providerRepo, database } = makeProvider(parent);
  const selected = { providerConnectionId: "selected-provider", modelId: "selected-model" };
  let codyDecisions = 0;
  const secondDecisionStarted = (() => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; })();
  const releaseSecondDecision = (() => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; })();
  const createResolver = (repo: ProviderRepository) => new ModelResolver(repo, { createClient: () => ({ complete: async ({ input, system }: { input: string; system: string }) => {
    const data = JSON.parse(input) as Record<string, unknown>;
    if (system.includes("MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER")) return JSON.stringify({ requiresCurrentProjectEvidence: false });
    if (typeof data.goal === "string" && Array.isArray(data.recentToolHistory)) {
      codyDecisions++;
      const history = data.recentToolHistory as Array<{ action: string }>;
      if (!history.some(entry => entry.action.includes("filesystem.list"))) return JSON.stringify({ type: "list", path: "." });
      if (!history.some(entry => entry.action.includes("filesystem.read"))) {
        if (codyDecisions === 2) { secondDecisionStarted.resolve(); await releaseSecondDecision.promise; }
        return JSON.stringify({ type: "read", path: "package.json" });
      }
      return JSON.stringify({ type: "finish", summary: "package.json names this project pause-fixture." });
    }
    if (Array.isArray(data.availableIntents) && (data.availableIntents as string[]).includes("delegate_text")) {
      return JSON.stringify({ type: "delegate_text", independence: "Cody can inspect the requested package file independently.", assignments: [
        { assignmentId: "pause-cody", definitionId: "cody", objective: "Read package.json and report the project name.",
          relevantContext: "Inspect only the package manifest and report its name.", relevantContextRefs: [], constraints: [],
          expectedOutcome: "Report the package name from the file.", evidenceExpectations: ["Observed file read"], requiredCapabilities: ["filesystem.read"] },
        { assignmentId: "pause-doc", definitionId: "doc", objective: "Check whether the file-reading capability is available for documentation work.",
          relevantContext: "This dependent task is intentionally unavailable in this controlled fixture.", relevantContextRefs: [], constraints: [],
          expectedOutcome: "Report availability truthfully.", evidenceExpectations: [], requiredCapabilities: ["filesystem.read"], dependsOn: ["pause-cody"] },
      ] });
    }
    if (Array.isArray(data.availableIntents) && (data.availableIntents as string[]).includes("respond")) {
      const refs = Array.isArray(data.relevantEvidence)
        ? (data.relevantEvidence as Array<{ id?: unknown }>).flatMap(item => typeof item.id === "string" ? [item.id] : []) : [];
      return JSON.stringify({ type: "respond", message: "Cody read package.json and reported the package name pause-fixture.",
        basis: refs.length ? "project-evidence" : "conversation", evidenceRefs: refs });
    }
    throw new Error("Unexpected controlled model request in user-pause test");
  } }) });
  let app = await startCommandCenter({ databasePath: path.join(parent, "mediobot.db"), providerRepository: providerRepo,
    modelResolver: createResolver(providerRepo), workspaceRoot: root, vite: false, listen: false });
  t.after(async () => { try { await app.close(); } catch {} try { database.close(); } catch {} rmSync(parent, { recursive: true, force: true }); });

  const started = await request(app, "POST", "/api/turns", { threadId: "pause-thread", turnId: "pause-turn",
    prompt: "Inspect package.json and tell me its project name.", modelSelection: selected });
  assert.equal(started.status, 202);
  const taskId = started.json.taskId as string;
  await Promise.race([secondDecisionStarted.promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Cody did not reach its second decision")), 8_000))]);
  const pause = await request(app, "POST", `/api/tasks/${taskId}/pause`);
  assert.equal(pause.status, 202, JSON.stringify(pause.json));
  releaseSecondDecision.resolve();
  const waitForStatus = async (server: Awaited<ReturnType<typeof startCommandCenter>>, expected: string) => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const task = await server.composition.durableTaskEngine!.getTask(taskId);
      if (task?.status === expected) return task;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Task did not reach ${expected}; got ${(await server.composition.durableTaskEngine!.getTask(taskId))?.status}`);
  };
  await waitForStatus(app, "paused");
  assert.equal(readFileSync(path.join(root, "package.json"), "utf8"), JSON.stringify({ name: "pause-fixture" }));
  assert.ok(codyDecisions >= 2, "Cody's active model decision should settle before pause becomes durable");
  const pauseEvent = (await app.composition.durableTaskEngine!.getEvents(taskId)).find(event =>
    event.eventType === "task.state_changed" && event.payload.toState === "paused");
  assert.ok(pauseEvent, JSON.stringify(await app.composition.durableTaskEngine!.getEvents(taskId)));
  assert.equal(pauseEvent!.payload.toState, "paused");
  assert.ok(Array.isArray((pauseEvent!.payload.details as Record<string, unknown>)?.interruptIds));

  await app.close();
  database.close();
  ({ providerRepo, database } = makeProvider(parent));
  app = await startCommandCenter({ databasePath: path.join(parent, "mediobot.db"), providerRepository: providerRepo,
    modelResolver: createResolver(providerRepo), workspaceRoot: root, vite: false, listen: false });
  await app.workspaceManager.openWorkspace(root);
  assert.equal((await app.composition.durableTaskEngine!.getTask(taskId))?.status, "paused", "pause must survive process restart");
  const resumed = await request(app, "POST", `/api/tasks/${taskId}/resume`);
  assert.equal(resumed.status, 202, JSON.stringify(resumed.json));
  await waitForStatus(app, "completed");
  assert.equal(codyDecisions, 4, "resume may replay the unexecuted reasoning decision but not completed tool actions");
  const tools = (await app.composition.getTaskEvents(taskId as import("@mediobot-v2/domain").TaskId)).filter(event => event.type.startsWith("tool."));
  assert.equal(tools.filter(event => event.type === "tool.completed" && event.toolName === "filesystem.list").length, 1);
  assert.equal(tools.filter(event => event.type === "tool.completed" && event.toolName === "filesystem.read").length, 1);
});

test("restartable LangGraph approval resumes the exact Cody write through /api/turns", { timeout: 30000 }, async (t) => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "mediobot-langgraph-approval-e2e-"));
  const root = path.join(parent, "workspace");
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "approved.txt"), "baseline\n");
  const dbPath = path.join(parent, "mediobot.db");
  let { providerRepo, database } = makeProvider(parent);
  providerRepo.save({ id: "cody-provider", providerType: "custom", displayName: "Cody Provider", connected: true,
    enabled: true, baseUrl: "http://unused.invalid", models: [{ id: "cody-model", name: "Cody Model", enabled: true,
      capabilities: { text: true, reasoning: true, vision: false, tools: true } }] });
  let codyDecisions = 0;
  let maestroPlanDecisions = 0;
  const createResolver = (repo: ProviderRepository) => new ModelResolver(repo, {
    createClient: () => ({ complete: async ({ input, system }: { input: string; system: string }) => {
      const data = JSON.parse(input) as Record<string, unknown>;
      if (system.includes("MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER")) return JSON.stringify({ requiresCurrentProjectEvidence: false });
      if (Array.isArray(data.availableIntents) && (data.availableIntents as string[]).includes("delegate_text")) {
        maestroPlanDecisions++;
        return JSON.stringify({ type: "delegate_text",
          independence: "Cody performs the authorized file change while Tester independently reviews the requested outcome from the supplied task context.",
          assignments: [
            { assignmentId: "cody-write", definitionId: "cody", objective: "Create approved.txt with a short confirmation.",
              relevantContext: "The user authorized this exact file change.", relevantContextRefs: [], constraints: [],
              expectedOutcome: "The file contains the requested confirmation.", evidenceExpectations: ["Observed file write"],
              requiredCapabilities: ["filesystem.write"] },
            { assignmentId: "tester-review", definitionId: "tester", objective: "Independently review the requested file-change outcome.",
              relevantContext: "Confirm the task has a clear, bounded acceptance condition.", relevantContextRefs: [], constraints: [],
              expectedOutcome: "A concise review of the acceptance condition.", evidenceExpectations: [] },
          ] });
      }
      if (typeof data.goal === "string" && Array.isArray(data.recentToolHistory)) {
        codyDecisions++;
        const history = data.recentToolHistory as Array<{ action: string; result?: string }>;
        if (!history.some(entry => entry.action.includes("filesystem.read"))) {
          return JSON.stringify({ type: "read", path: "approved.txt" });
        }
        if (!history.some(entry => entry.action.includes("filesystem.write"))) {
          return JSON.stringify({ type: "write", path: "approved.txt", content: "written once after restart approval\n" });
        }
        if (history.some(entry => entry.action === "finish" && entry.result?.includes("A check command is required"))
          && !history.some(entry => entry.action.includes("terminal.execute"))) {
          return JSON.stringify({ type: "run", command: process.execPath, args: ["--version"], cwd: ".", verification: "Confirm the configured Node.js runtime responds." });
        }
        if (history.some(entry => entry.action.includes("terminal.execute"))) {
          return JSON.stringify({ type: "finish", summary: "Created approved.txt after the persisted approval and verified the configured Node.js runtime." });
        }
        return JSON.stringify({ type: "finish", summary: "Created approved.txt after the persisted approval was granted." });
      }
      if (data.assignment && system.includes('"status":"completed"')) {
        return JSON.stringify({ status: "completed", summary: "The requested change has a clear, bounded acceptance condition.",
          evidence: ["The task context identifies approved.txt and the expected confirmation."], blockers: [], unresolved: [] });
      }
      const evidence = Array.isArray(data.relevantEvidence)
        ? (data.relevantEvidence as Array<{ id?: unknown }>).flatMap(item => typeof item.id === "string" ? [item.id] : []) : [];
      if (Array.isArray(data.availableIntents) && (data.availableIntents as string[]).includes("respond")) {
        return JSON.stringify({ type: "respond", message: "Cody updated approved.txt after restart-safe approval.",
          basis: evidence.length ? "project-evidence" : "conversation", evidenceRefs: evidence });
      }
      return JSON.stringify({ type: "respond", message: "Cody completed the approved write.", basis: "project-evidence", evidenceRefs: [] });
    } }),
  });
  let app = await startCommandCenter({ databasePath: dbPath, providerRepository: providerRepo,
    modelResolver: createResolver(providerRepo), workspaceRoot: root, defaultApprovalMode: "Ask before edits", vite: false, listen: false });
  t.after(async () => { try { await app.close(); } catch {} try { database.close(); } catch {} rmSync(parent, { recursive: true, force: true }); });

  const selection = { providerConnectionId: "cody-provider", modelId: "cody-model" };
  let submitted = await request(app, "POST", "/api/turns", { threadId: "approval-thread", turnId: "cancel-write-turn",
    prompt: "Create approved.txt with a short confirmation and independently review the acceptance condition.", modelSelection: selection,
    approvalMode: "Ask before edits" });
  assert.equal(submitted.status, 202);
  let parentTaskId = submitted.json.taskId as string;
  let approval: { approval_id: string; task_id: string; interrupt_id: string | null } | undefined;
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 8_000;
    const poll = () => {
      approval = database.raw.prepare(`SELECT a.approval_id, a.task_id, i.interrupt_id FROM durable_tool_approvals a
        LEFT JOIN durable_tool_approval_interrupts i USING (approval_id) WHERE a.status = 'requested'
        AND a.request_json LIKE '%approved.txt%' ORDER BY a.created_at DESC LIMIT 1`).get() as typeof approval;
      if (approval?.interrupt_id) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`Cody did not persist the approval interrupt: decisions=${codyDecisions}; approvals=${JSON.stringify(database.raw.prepare("SELECT approval_id, task_id, status, request_json FROM durable_tool_approvals").all())}; events=${JSON.stringify(app.composition.taskEvents.get(parentTaskId as TaskId)?.map(event => ({ type: event.type, tool: event.toolName, error: event.error?.message })) ?? [])}`));
      setTimeout(poll, 20);
    };
    poll();
  });
  assert.ok(approval);
  assert.notEqual(approval.task_id, parentTaskId, "Cody's child task owns the exact tool approval");
  const child = await app.composition.durableTaskEngine!.getTask(approval.task_id as TaskId);
  assert.equal(child?.status, "waiting_approval");
  assert.equal((await app.composition.durableTaskEngine!.getTask(parentTaskId as TaskId))?.status, "waiting_approval");
  assert.equal(readFileSync(path.join(root, "approved.txt"), "utf8"), "baseline\n", "the write must not run before approval");
  // Hold the family control lock, then queue cancellation before approval. The
  // requests must serialize: cancellation wins, and stale approval cannot
  // restart the interrupted LangGraph run afterward.
  let releaseControlLock!: () => void;
  let announceControlLock!: () => void;
  const controlLockEntered = new Promise<void>(resolve => { announceControlLock = resolve; });
  const controlLockGate = new Promise<void>(resolve => { releaseControlLock = resolve; });
  const lock = app.composition.withTaskControlLock!;
  const heldControlLock = lock(parentTaskId as TaskId, async () => {
    announceControlLock();
    await controlLockGate;
  });
  await controlLockEntered;
  const cancellationWhilePausedPromise = request(app, "POST", `/api/tasks/${approval.task_id}/cancel`);
  await new Promise<void>(resolve => setImmediate(resolve));
  const staleApprovalPromise = request(app, "POST", `/api/turns/cancel-write-turn/approvals/${approval.approval_id}`, {
    approved: true, threadId: "approval-thread",
  });
  await new Promise<void>(resolve => setTimeout(resolve, 20));
  releaseControlLock();
  await heldControlLock;
  const [cancellationWhilePaused, staleApproval] = await Promise.all([cancellationWhilePausedPromise, staleApprovalPromise]);
  assert.equal(cancellationWhilePaused.status, 202, JSON.stringify(cancellationWhilePaused.json));
  assert.equal(staleApproval.status, 409,
    `approval queued behind cancellation must not resume the cancelled workflow: ${JSON.stringify(staleApproval.json)}`);
  assert.equal((database.raw.prepare("SELECT status FROM durable_tool_approvals WHERE approval_id = ?")
    .get(approval.approval_id) as { status: string }).status, "cancelled",
  "cancelling a suspended task must cancel its exact pending approval");
  assert.equal((await app.composition.durableTaskEngine!.getTask(approval.task_id as TaskId))?.status, "cancelled");
  assert.equal((await app.composition.durableTaskEngine!.getTask(parentTaskId as TaskId))?.status, "cancelled");
  assert.equal(readFileSync(path.join(root, "approved.txt"), "utf8"), "baseline\n",
    "cancelling a suspended approval must not execute its pending write");
  const cancelledThread = await request(app, "GET", "/api/threads/approval-thread");
  assert.equal(cancelledThread.json.thread.turns.find((turn: { id: string }) => turn.id === "cancel-write-turn")?.status, "cancelled");

  submitted = await request(app, "POST", "/api/turns", { threadId: "approval-thread", turnId: "write-turn",
    prompt: "Create approved.txt with a short confirmation and independently review the acceptance condition.", modelSelection: selection,
    approvalMode: "Ask before edits" });
  assert.equal(submitted.status, 202);
  parentTaskId = submitted.json.taskId as string;
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 8_000;
    const poll = () => {
      approval = database.raw.prepare(`SELECT a.approval_id, a.task_id, i.interrupt_id FROM durable_tool_approvals a
        LEFT JOIN durable_tool_approval_interrupts i USING (approval_id) WHERE a.status = 'requested'
        AND a.request_json LIKE '%approved.txt%' ORDER BY a.created_at DESC LIMIT 1`).get() as typeof approval;
      if (approval?.interrupt_id && approval.task_id !== undefined) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`Cody did not persist the restartable approval interrupt: decisions=${codyDecisions}; events=${JSON.stringify(app.composition.taskEvents.get(parentTaskId as TaskId)?.map(event => event.type) ?? [])}`));
      setTimeout(poll, 20);
    };
    poll();
  });
  assert.ok(approval);
  const assignmentPlan = (await app.composition.durableTaskEngine!.getCheckpoints(parentTaskId as TaskId))
    .find(checkpoint => checkpoint.snapshot.kind === "maestro-assignment-plan-v1");
  assert.ok(assignmentPlan, "the exact validated Maestro plan must be durable before specialists run");
  const savedAssignments = (assignmentPlan.snapshot.decision as { assignments?: Array<{ assignmentId?: string }> }).assignments;
  assert.deepEqual(savedAssignments?.map(assignment => assignment.assignmentId), ["cody-write", "tester-review"],
    "restart state must preserve every independent specialist assignment, not only the approval-owning child");
  assert.ok(database.raw.prepare(`SELECT 1 FROM langgraph_task_outcomes WHERE workflow_name = 'maestro-specialist-groups'
    AND thread_id = ? AND checkpoint_ns = 'specialists' AND task_id = 'tester-review'`).get(parentTaskId),
  "the completed independent Tester outcome must be persisted while Cody waits for approval");
  let savedApprovalThread: Awaited<ReturnType<typeof request>> | undefined;
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 2_000;
    const poll = async () => {
      savedApprovalThread = await request(app, "GET", "/api/threads/approval-thread");
      const restartTurn = savedApprovalThread.json.thread.turns.find((turn: { id: string }) => turn.id === "write-turn");
      if (restartTurn?.items.some((item: { type: string; approval?: { approvalId: string } }) =>
        item.type === "approval_request" && item.approval?.approvalId === approval!.approval_id)) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`Approval event did not reach the parent thread: ${JSON.stringify(app.composition.taskEvents.get(parentTaskId as TaskId)?.map(event => event.type) ?? [])}`));
      setTimeout(() => void poll(), 20);
    };
    void poll();
  });
  const pendingApprovalItem = savedApprovalThread!.json.thread.turns.find((turn: { id: string }) => turn.id === "write-turn")?.items.find((item: { type: string; approval?: { approvalId: string } }) =>
    item.type === "approval_request" && item.approval?.approvalId === approval!.approval_id);
  assert.equal(pendingApprovalItem?.actor?.mediobotId, "cody", "live approval events must retain the owning specialist identity");
  const plansBeforeRestart = maestroPlanDecisions;

  // The graph has settled at its durable interrupt. Closing here models process restart
  // without cancelling an active model request or granting the pending action.
  await app.close();
  database.close();
  ({ providerRepo, database } = makeProvider(parent));
  // Give the parent and approval-owning child different saved selections. A
  // restart must validate and resume with the child's original model.
  const parentCreated = database.raw.prepare("SELECT id, payload_json FROM durable_task_events WHERE task_id = ? AND event_type = 'task.created'")
    .get(parentTaskId) as { id: string; payload_json: string };
  const parentPayload = JSON.parse(parentCreated.payload_json) as Record<string, unknown>;
  parentPayload.modelSelection = { providerConnectionId: "selected-provider", modelId: "selected-model" };
  database.raw.prepare("UPDATE durable_task_events SET payload_json = ? WHERE id = ?")
    .run(JSON.stringify(parentPayload), parentCreated.id);
  providerRepo.save({ id: "cody-provider", providerType: "custom", displayName: "Cody Provider", connected: true,
    enabled: true, baseUrl: "http://unused.invalid", models: [{ id: "cody-model", name: "Cody Model", enabled: true,
      capabilities: { text: true, reasoning: true, vision: false, tools: true } }] });
  app = await startCommandCenter({ databasePath: dbPath, providerRepository: providerRepo,
    modelResolver: createResolver(providerRepo), workspaceRoot: root, defaultApprovalMode: "Full access", vite: false, listen: false });
  await app.workspaceManager.openWorkspace(root);
  const selectionLookups: string[] = [];
  const getSelection = app.composition.durableTaskEngine!.getTaskModelSelection.bind(app.composition.durableTaskEngine);
  app.composition.durableTaskEngine!.getTaskModelSelection = async (id: string) => {
    selectionLookups.push(id);
    return getSelection(id);
  };
  assert.equal((await app.composition.durableTaskEngine!.getTask(parentTaskId as TaskId))?.status, "waiting_approval");
  assert.equal(app.composition.permissionEngine!.getWorkflowInterruptId(approval.approval_id), approval.interrupt_id,
    "the persisted approval must be attached to the LangGraph interrupt after restart");
  const restoredChildView = await request(app, "GET", `/api/tasks/${approval.task_id}`);
  assert.equal(restoredChildView.status, 200);
  assert.equal(restoredChildView.json.task.state, "waiting_approval");
  assert.deepEqual(restoredChildView.json.task.assignedMediobot, { id: "cody", name: "Cody" },
    "a durable task view must preserve the assigned Mediobot identity after its process-local worker disappears");
  assert.deepEqual(restoredChildView.json.task.workers, [],
    "restart recovery must not invent an active worker instance that was not restored");
  assert.ok(Array.isArray(restoredChildView.json.task.events));

  const actualResume = app.composition.resume!.bind(app.composition);
  let failFirstResume = true;
  (app.composition as any).resume = async (...args: unknown[]) => {
    if (failFirstResume) {
      failFirstResume = false;
      throw new Error("controlled transient resume failure");
    }
    return actualResume(...args as [TaskId, Readonly<Record<string, unknown>>?]);
  };
  const approvalUrl = `/api/turns/write-turn/approvals/${approval.approval_id}?threadId=approval-thread`;
  const failedResume = await request(app, "POST", approvalUrl, { approved: true, threadId: "approval-thread" });
  assert.equal(failedResume.status, 500, "the controlled interruption confirms the approval grant is durable before resume");
  assert.equal((database.raw.prepare("SELECT status FROM durable_tool_approvals WHERE approval_id = ?")
    .get(approval.approval_id) as { status: string }).status, "approved");
  const resolution = await request(app, "POST", approvalUrl,
    { approved: true, threadId: "approval-thread" });
  assert.equal(resolution.status, 202, JSON.stringify(resolution.json));
  assert.equal(selectionLookups[0], approval.task_id, "approval recovery must resolve the child task's configured model first");
  assert.equal(resolution.json.resumed, true);
  const resumed = await awaitTaskCompletion(app, parentTaskId);
  assert.equal(resumed, "task.completed");
  assert.equal(maestroPlanDecisions, plansBeforeRestart, "approval recovery must use the persisted multi-specialist plan without asking Maestro to re-delegate");
  assert.equal(readFileSync(path.join(root, "approved.txt"), "utf8"), "written once after restart approval\n");
  assert.ok(codyDecisions >= 3, "Cody reads, requests the write, and continues after the approved action");
  assert.equal((database.raw.prepare("SELECT status FROM durable_tool_approvals WHERE approval_id = ?")
    .get(approval.approval_id) as { status: string }).status, "consumed");
  assert.equal(app.composition.permissionEngine!.resolvePolicy(approval.task_id as TaskId).mode, "Ask before edits",
    "restart recovery must restore the task's original policy instead of the changed application default");
  const events = await app.composition.getTaskEvents!(parentTaskId as TaskId);
  assert.ok(events.some(event => event.type === "approval.required"));
  assert.ok(events.some(event => event.type === "approval.resolved"));
  assert.ok(events.some(event => event.type === "tool.completed" && event.toolName === "terminal.execute"));
  assert.equal(events.filter(event => event.type === "tool.completed" && event.toolName === "filesystem.write").length, 1,
    "the approved side effect must execute exactly once");
  assert.ok(events.some(event => event.type === "task.completed"));
  assert.equal(app.composition.subscribers.has(parentTaskId as TaskId), false,
    "terminal completion must remove the event subscription");

  const replayed = await turnEvents(app, "approval-thread", "write-turn");
  const replayedSnapshot = replayed.find((event: { type: string }) => event.type === "turn.snapshot");
  const replayedTurn = replayedSnapshot?.payload?.turn;
  assert.equal(replayedTurn?.status, "completed", "durable event projection must recover terminal turn state after restart");
  const replayedApproval = replayedTurn?.items?.find((item: { type: string; approval?: { approvalId: string } }) =>
    item.type === "approval_request" && item.approval?.approvalId === approval!.approval_id);
  assert.equal(replayedApproval?.approval?.status, "approved", "recovered transcript must show the resolved approval");
  assert.equal(replayedApproval?.actor?.mediobotId, "cody", "recovered approval must retain Cody attribution");
  const replayedWrites = replayedTurn?.items?.filter((item: { type: string; tool?: { toolName: string } }) =>
    item.type === "tool_execution" && item.tool?.toolName === "filesystem.write");
  assert.deepEqual(replayedWrites?.map((item: { tool?: { status: string } }) => item.tool?.status), ["cancelled", "success"],
    "the pre-approval invocation must settle separately from the authorized resumed write");
  assert.ok(replayedWrites?.every((item: { actor?: { mediobotId: string } }) => item.actor?.mediobotId === "cody"),
    "recovered write lifecycle must retain Cody attribution");
  const savedAfterRecovery = await request(app, "GET", "/api/threads/approval-thread");
  assert.equal(savedAfterRecovery.json.thread.turns.find((turn: { id: string }) => turn.id === "write-turn")?.status, "completed",
    "the recovered state must be persisted, not only reconstructed in the live client");
});

test("selected Doc reaches the web-capable adapter and preserves Doc response attribution", { timeout: 15000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-direct-doc-"));
  const { providerRepo, database } = makeProvider(root);
  const searchedQueries: string[] = [];
  const crawledUrls: string[] = [];
  let codyDecisionInput = "";
  const officialUrl = "https://nodejs.org/en/learn/getting-started/introduction";
  const web = {
    shutdown: async () => {},
    search: async ({ query }: { query: string }) => {
      searchedQueries.push(query);
      return { query, totalMatches: 1, items: [{ title: "Introduction to Node.js", url: officialUrl,
        snippet: "Node.js is a JavaScript runtime.", source: "controlled-fixture" }] };
    },
    crawl: async ({ url }: { url: string }) => {
      crawledUrls.push(url);
      return { url, finalUrl: url, status: 200, success: true, markdown: "Node.js is a JavaScript runtime built on V8.",
        title: "Introduction to Node.js", links: [], media: [], metadata: {}, cached: false, sanitized: false,
        provenance: { sourceUrl: url, accessedAt: Date.now(), contentHash: "controlled-fixture" }, promptInjectionFlags: [], durationMs: 1 };
    },
  };
  const resolver = new ModelResolver(providerRepo, { createClient: () => ({ complete: async ({ input, system }: { input: string; system: string }) => {
    const data = JSON.parse(input) as Record<string, unknown>;
    if (system.includes("MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER")) return JSON.stringify({ requiresCurrentProjectEvidence: false });
    if (typeof data.goal === "string" && Array.isArray(data.recentToolHistory)) {
      codyDecisionInput = data.goal;
      return JSON.stringify({ type: "finish", summary: "Hello! How can I help?" });
    }
    if (data.assignment && typeof data.assignment === "object" && typeof data.webContent === "string") {
      assert.match(data.webContent, /Introduction to Node\.js/);
      assert.match(data.webContent, /Node\.js is a JavaScript runtime/);
      return JSON.stringify({ status: "completed", summary: "Node.js documentation describes Node.js as a JavaScript runtime built on V8.",
        evidence: [`[Introduction to Node.js](${officialUrl})`], blockers: [], unresolved: [] });
    }
    if (Array.isArray(data.projectIntelligence)
        && (data.projectIntelligence as Array<{ name?: string }>).some((record) => ["bounded-web-worker-reports", "specialist-executor-results"].includes(record.name ?? ""))) {
      return JSON.stringify({ type: "respond", message: `Official Node.js docs describe Node.js as a JavaScript runtime built on V8: ${officialUrl}`,
        basis: "conversation", evidenceRefs: [] });
    }
    if (system.includes("You are Doc, MedioBot's doc specialist")) {
      return JSON.stringify({ type: "respond", message: `Official Node.js docs describe Node.js as a JavaScript runtime built on V8: ${officialUrl}`,
        basis: "conversation", evidenceRefs: [] });
    }
    if (system.includes("You are Cody, MedioBot's Software engineering specialist")) {
      return JSON.stringify({ type: "respond", message: "Hello! How can I help?", basis: "conversation", evidenceRefs: [] });
    }
    throw new Error("Unexpected model request in direct Doc test");
  } }) });
  const databasePath = path.join(root, "mediobot.db");
  const durableTaskEngine = new DurableTaskEngine(new SqliteDurableTaskStore(database.rawDb));
  const composition = createComposition({ modelResolver: resolver, workspaceRoot: root, crawl4aiRuntime: web as never,
    checkpointDatabasePath: databasePath, durableTaskEngine });
  const app = await startCommandCenter({ databasePath, providerRepository: providerRepo,
    modelResolver: resolver, composition, workspaceRoot: root, vite: false, listen: false });
  t.after(async () => { await app.close(); database.close(); rmSync(root, { recursive: true, force: true }); });

  const response = await request(app, "POST", "/api/turns", { threadId: "doc-thread", turnId: "node-docs", specialistId: "doc",
    prompt: "Find and explain the official Node.js introduction documentation.",
    modelSelection: { providerConnectionId: "selected-provider", modelId: "selected-model" } });
  assert.equal(response.status, 202);
  assert.equal(await awaitTaskCompletion(app, response.json.taskId as string), "task.completed");
  assert.match(searchedQueries[0] ?? "", /Node\.js/i);
  assert.deepEqual(crawledUrls, [officialUrl]);
  const events = app.composition.taskEvents.get(response.json.taskId as TaskId)!;
  assert.ok(events.some((event) => event.type === "tool.completed" && event.toolName === "web.search" && event.workerDefinitionId === "doc"));
  assert.ok(events.some((event) => event.type === "tool.completed" && event.toolName === "web.crawl" && event.workerDefinitionId === "doc"));
  const saved = await request(app, "GET", "/api/threads/doc-thread");
  const reply = saved.json.thread.turns[0].items.find((item: { type: string; actor?: { mediobotId?: string } }) =>
    item.type === "agent_message" && item.actor?.mediobotId === "doc");
  assert.equal(reply.actor.mediobotId, "doc");
  assert.match(reply.text, /nodejs\.org/);
  const persistedRows = database.raw.prepare("SELECT thread_id, checkpoint_ns, COUNT(*) AS count FROM checkpoints GROUP BY thread_id, checkpoint_ns").all();
  assert.ok(persistedRows.some(row => (row as { thread_id: string }).thread_id === response.json.taskId),
  `the /api/turns specialist execution must checkpoint in product SQLite; observed ${JSON.stringify(persistedRows)}`);
  const persistedOutcomes = database.raw.prepare(`SELECT task_id, payload_json FROM langgraph_task_outcomes
    WHERE workflow_name = 'maestro-specialist-groups' AND thread_id = ?`).all(response.json.taskId as string);
  assert.ok(persistedOutcomes.length > 0, "the /api/turns specialist result must be durably recorded beside the LangGraph checkpoint");
  assert.ok(persistedOutcomes.some(row => JSON.parse((row as { payload_json: string }).payload_json).kind === "web"),
    "the persisted outcome must retain the actual executor group attribution");

  const codyTurn = await request(app, "POST", "/api/turns", { threadId: "doc-thread", turnId: "private-cody",
    specialistId: "cody", prompt: "Say hi briefly.", modelSelection: { providerConnectionId: "selected-provider", modelId: "selected-model" } });
  assert.equal(codyTurn.status, 202);
  assert.equal(await awaitTaskCompletion(app, codyTurn.json.taskId as string), "task.completed");
  assert.doesNotMatch(codyDecisionInput, /Node\.js|nodejs\.org/i, "Cody must not receive Doc's private response from the shared thread transcript");
  const codyEvents = app.composition.taskEvents.get(codyTurn.json.taskId as TaskId)!;
  assert.ok(codyEvents.some((event) => event.type === "maestro.responded" && event.workerDefinitionId === "cody"));
  assert.equal(codyEvents.filter((event) => event.type === "tool.started" && event.workerDefinitionId === "cody").length, 0,
    "a simple greeting must not trigger Cody filesystem or terminal tools");
});

test("/api/turns rejects invalid specialist identity before persisting a turn", { timeout: 10000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-invalid-specialist-"));
  const { providerRepo, database } = makeProvider(root);
  const app = await startCommandCenter({ databasePath: path.join(root, "mediobot.db"), providerRepository: providerRepo,
    workspaceRoot: root, vite: false, listen: false });
  t.after(async () => { await app.close(); database.close(); rmSync(root, { recursive: true, force: true }); });
  const response = await request(app, "POST", "/api/turns", { threadId: "invalid-specialist-thread", turnId: "invalid",
    specialistId: "not-a-specialist", prompt: "hello", modelSelection: { providerConnectionId: "selected-provider", modelId: "selected-model" } });
  assert.equal(response.status, 400);
  assert.equal(response.json.error.code, "invalid-specialist");
  const saved = await request(app, "GET", "/api/threads/invalid-specialist-thread");
  assert.equal(saved.status, 404, "rejected identity must not leave a partially persisted turn");
});

test("project file answers require authorized Cody list evidence and cite only the observed filenames", { timeout: 15000 }, async (t) => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "mediobot-project-list-evidence-"));
  const root = path.join(parent, "workspace");
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "alpha.txt"), "alpha fixture");
  writeFileSync(path.join(root, "src", "index.ts"), "export {};\n");
  writeFileSync(path.join(root, ".env"), "sensitive fixture must stay hidden");
  const { providerRepo, database } = makeProvider(parent);
  let maestroCalls = 0;
  let codyCalls = 0;
  let repairInput: Record<string, unknown> | undefined;
  let repairSystem = "";
  let schemaRepairInput: Record<string, unknown> | undefined;
  let schemaRepairSystem = "";
  let codyObservedResult = "";
  const resolver = new ModelResolver(providerRepo, {
    createClient: () => ({ complete: async ({ input, system }: { input: string; system: string }) => {
      const data = JSON.parse(input) as Record<string, unknown>;
      if (typeof data.goal === "string" && Array.isArray(data.recentToolHistory)) {
        codyCalls += 1;
        if (codyCalls === 1) return JSON.stringify({ type: "list", path: "." });
        const history = data.recentToolHistory as Array<{ action: string; result: string }>;
        codyObservedResult = history.at(-1)?.result ?? "";
        assert.match(codyObservedResult, /alpha\.txt/);
        assert.match(codyObservedResult, /src/);
        assert.doesNotMatch(codyObservedResult, /\.env/);
        return JSON.stringify({ type: "finish", summary: `Observed project entries: alpha.txt and src/. Evidence: ${codyObservedResult}` });
      }
      if (system.includes("MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER")) return JSON.stringify({ requiresCurrentProjectEvidence: true });
      maestroCalls += 1;
      if (maestroCalls === 1) {
        const cody = (data.availableMediobots as Array<{ definitionId: string; role: string }>).find((worker) => worker.role === "coding");
        assert.ok(cody);
        return JSON.stringify({ type: "delegate", definitionId: cody.definitionId, objective: "List the current project root",
          relevantContextRefs: [], constraints: ["Do not read contents or modify files."], expectedOutcome: "Actual entries",
          evidenceExpectations: ["filesystem.list"], unexpectedProviderField: "discarded fixture value" });
      }
      if (maestroCalls === 2) {
        schemaRepairInput = data;
        schemaRepairSystem = system;
        return JSON.stringify({ type: "respond", message: "The project contains guessed.ts", basis: "conversation", evidenceRefs: [] });
      }
      if (maestroCalls > 3) {
        const evidence = Array.isArray(data.relevantEvidence) ? data.relevantEvidence as Array<{ id?: string; source?: { type?: string }; validity?: string }> : [];
        const evidenceRefs = evidence.filter((entry) => entry.id && entry.source?.type === "coding-tool" && entry.validity === "observed")
          .map((entry) => entry.id!);
        assert.ok(evidenceRefs.length > 0, "final synthesis must receive Cody's authorized list evidence");
        return JSON.stringify({ type: "respond", message: "Cody observed alpha.txt and src/ in the project root.", basis: "project-evidence", evidenceRefs });
      }
      repairInput = data;
      repairSystem = system;
      assert.equal(data.userGoal, "List the current project files using the workspace tools.");
      const cody = (data.availableMediobots as Array<{ definitionId: string; role: string; assignable: boolean; capabilities: string[] }>)
        .find((worker) => worker.role === "coding");
      assert.ok(cody?.assignable);
      assert.ok(cody.capabilities.some((capability) => capability.includes("workspace")));
      return JSON.stringify({ type: "delegate", definitionId: cody.definitionId,
        objective: "List the current project root using the authorized filesystem tool and report the actual relative entries.",
        relevantContextRefs: [], constraints: ["Do not read file contents or modify files."],
        expectedOutcome: "Return only filenames and directories present in the authorized project root.",
        evidenceExpectations: ["Successful filesystem.list result for the current workspace root"] });
    } }),
  });
  const app = await startCommandCenter({ databasePath: path.join(parent, "mediobot.db"), providerRepository: providerRepo,
    modelResolver: resolver, workspaceRoot: root, vite: false, listen: false });
  t.after(async () => { await app.close(); database.close(); rmSync(parent, { recursive: true, force: true }); });

  const response = await request(app, "POST", "/api/turns", { threadId: "project-list-evidence", turnId: "list-current-files",
    prompt: "List the current project files using the workspace tools.",
    modelSelection: { providerConnectionId: "selected-provider", modelId: "selected-model" } });
  assert.equal(response.status, 202);
  const taskId = response.json.taskId as string;
  assert.equal(await awaitTaskCompletion(app, taskId), "task.completed");
  assert.equal(maestroCalls, 4, "schema repair, evidence rejection, delegation, and evidence-backed synthesis are separate decisions");
  assert.match(schemaRepairSystem, /Preserve the "delegate" intent/i);
  assert.equal(schemaRepairInput?.userGoal, "List the current project files using the workspace tools.");
  assert.match(repairSystem, /authorized evidence reference/i);
  assert.equal(repairInput?.projectEvidenceRequired, true);
  assert.equal(repairInput?.userGoal, "List the current project files using the workspace tools.");

  const snapshot = app.composition.world.inspect();
  const codyTask = snapshot.tasks.find((task) => task.parentTaskId === taskId);
  assert.ok(codyTask, "Maestro must create a real Cody child task");
  assert.ok(snapshot.evidence.some((entry) => entry.taskId === codyTask.id && entry.source.type === "coding-tool"
    && entry.kind === "tool-result" && entry.validity === "observed" && /filesystem\.list succeeded/.test(entry.content)));
  assert.match(codyObservedResult, /alpha\.txt/);
  assert.match(codyObservedResult, /src/);
  assert.doesNotMatch(codyObservedResult, /guessed\.ts|\.env/);
  const events = app.composition.taskEvents.get(taskId as unknown as TaskId) ?? [];
  assert.ok(events.some((event) => event.type === "tool.completed" && event.toolName === "filesystem.list"));
  assert.ok(events.some((event) => event.type === "task.completed"));

  const saved = await request(app, "GET", "/api/threads/project-list-evidence");
  const turn = saved.json.thread.turns.find((entry: { id: string }) => entry.id === "list-current-files");
  assert.equal(turn.status, "completed");
  assert.equal(turn.items.some((item: { type: string; tool?: { toolName: string; status: string } }) =>
    item.type === "tool_execution" && item.tool?.toolName === "filesystem.list" && item.tool.status === "success"), true);
  const finalMessage = turn.items.filter((item: { type: string; text?: string; actor?: { name?: string } }) =>
    item.type === "agent_message" && item.actor?.name === "Maestro").at(-1)?.text ?? "";
  assert.match(finalMessage, /alpha\.txt/);
  assert.match(finalMessage, /src\//);
  assert.doesNotMatch(finalMessage, /guessed\.ts|\.env/);
  assert.equal(readFileSync(path.join(root, "alpha.txt"), "utf8"), "alpha fixture", "read-only request does not mutate files");
});

test("production /api/turns refuses to assert current project facts when no workspace is authorized", { timeout: 10000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-maestro-no-workspace-"));
  const { providerRepo, database } = makeProvider(root);
  const decisions: Array<Record<string, unknown>> = [];
  const resolver = new ModelResolver(providerRepo, {
    createClient: () => ({ complete: async ({ input, system }: { input: string; system: string }) => {
      const data = JSON.parse(input) as Record<string, unknown>;
      if (system.includes("MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER")) return JSON.stringify({ requiresCurrentProjectEvidence: true });
      decisions.push(data);
      if (decisions.length === 1) return JSON.stringify({ type: "respond", message: "The project has fake.ts", basis: "conversation", evidenceRefs: [] });
      return JSON.stringify({ type: "respond", message: "The project has fake.ts, but I cannot verify it.", basis: "cannot-verify", evidenceRefs: [] });
    } }),
  });
  const app = await startCommandCenter({ databasePath: path.join(root, "mediobot.db"), providerRepository: providerRepo,
    modelResolver: resolver, vite: false, listen: false });
  t.after(async () => { await app.close(); database.close(); rmSync(root, { recursive: true, force: true }); });

  const response = await request(app, "POST", "/api/turns", { threadId: "maestro-no-workspace", turnId: "blocked-delegation",
    prompt: "Inspect the current project", modelSelection: { providerConnectionId: "selected-provider", modelId: "selected-model" } });
  assert.ok([200, 202].includes(response.status));
  assert.equal(decisions.length, 2);
  assert.deepEqual(decisions[0]?.availableIntents, ["respond", "request_user_input"]);
  assert.deepEqual(decisions[0]?.assignableDefinitionIds, []);
  assert.equal(decisions[1]?.projectEvidenceRequired, true);
  assert.equal((decisions[0]?.availableMediobots as Array<{ role: string; assignable: boolean }>)
    .find((definition) => definition.role === "coding")?.assignable, false);
  assert.equal(app.workspaceManager.session, null);
  assert.deepEqual(app.composition.world.inspect().tasks, [], "a model decision cannot create execution without workspace authorization");
  const saved = await request(app, "GET", "/api/threads/maestro-no-workspace");
  assert.equal(saved.json.thread.turns[0].status, "completed");
  const final = saved.json.thread.turns[0].items.find((item: { type: string; actor?: { name?: string } }) =>
    item.type === "agent_message" && item.actor?.name === "Maestro");
  assert.equal(final.text, "I cannot verify current project information because no authorized project tools are available for this turn.");
  assert.doesNotMatch(final.text, /fake\.ts/);
});

test("production Cody tools cannot read outside the selected workspace even when the model requests it", { timeout: 10000 }, async (t) => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "mediobot-maestro-permission-boundary-"));
  const root = path.join(parent, "workspace");
  mkdirSync(root);
  const outsideSentinel = "OUTSIDE_WORKSPACE_SENTINEL_MUST_NOT_LEAK";
  writeFileSync(path.join(parent, "outside.txt"), outsideSentinel);
  const { providerRepo, database } = makeProvider(parent);
  const codyInputs: Array<Record<string, unknown>> = [];
  const resolver = new ModelResolver(providerRepo, {
    createClient: () => ({ complete: async ({ input }: { input: string }) => {
      const data = JSON.parse(input) as Record<string, unknown>;
      if (typeof data.goal === "string" && Array.isArray(data.recentToolHistory)) {
        codyInputs.push(data);
        if (codyInputs.length === 1) return JSON.stringify({ type: "read", path: "../outside.txt" });
        return JSON.stringify({ type: "finish", summary: "The runtime denied the out-of-workspace read; no outside content was accessed." });
      }
      const cody = (data.availableMediobots as Array<{ definitionId: string; role: string }>).find((entry) => entry.role === "coding")!;
      return JSON.stringify({ type: "delegate", definitionId: cody.definitionId, objective: "Inspect the requested adjacent file",
        relevantContextRefs: [], constraints: [], expectedOutcome: "Report whether the adjacent file can be read", evidenceExpectations: [] });
    } }),
  });
  const permissionEngine = new ToolPermissionEngine({ defaultPolicy: { mode: "Approve for me" } });
  const durableTaskEngine = new DurableTaskEngine(new SqliteDurableTaskStore(database.rawDb));
  const composition = createComposition({ workspaceRoot: root, modelResolver: resolver, permissionEngine, durableTaskEngine });
  const app = await startCommandCenter({ databasePath: path.join(parent, "mediobot.db"), providerRepository: providerRepo,
    modelResolver: resolver, composition, workspaceRoot: root, vite: false, listen: false });
  t.after(async () => { await app.close(); database.close(); rmSync(parent, { recursive: true, force: true }); });

  const response = await request(app, "POST", "/api/turns", { threadId: "maestro-boundary", turnId: "outside-read",
    prompt: "Read the file adjacent to this workspace and report its contents", modelSelection: { providerConnectionId: "selected-provider", modelId: "selected-model" } });
  assert.equal(response.status, 202);
  assert.equal(await awaitTaskCompletion(app, response.json.taskId as string), "task.completed");
  assert.equal(codyInputs.length, 2, "Cody receives the failed tool outcome before finishing");
  const history = codyInputs[1]!.recentToolHistory as Array<{ action: string; result: string }>;
  const failedRead = history.find((entry) => /failed|denied/i.test(entry.result));
  assert.ok(failedRead, `Cody must retain the rejected read result after any authorized group context: ${JSON.stringify(history)}`);
  assert.match(failedRead.result, /failed/);
  assert.doesNotMatch(JSON.stringify(codyInputs), new RegExp(outsideSentinel));
  const toolFailure = app.composition.world.inspect().evidence.find((entry) => entry.source.type === "coding-tool" && entry.validity === "observed");
  assert.ok(toolFailure);
  assert.doesNotMatch(toolFailure.content, new RegExp(outsideSentinel));
  assert.ok(app.composition.taskEvents.get(response.json.taskId as TaskId)?.some((event) => event.type === "tool.failed"));
  assert.equal(readFileSync(path.join(parent, "outside.txt"), "utf8"), outsideSentinel);
  const saved = await request(app, "GET", "/api/threads/maestro-boundary");
  const assistantText = JSON.stringify(saved.json.thread.turns.flatMap((turn: { items: Array<{ type: string; text?: string }> }) =>
    turn.items.filter((item) => item.type === "agent_message").map((item) => item.text)));
  assert.doesNotMatch(assistantText, new RegExp(outsideSentinel));
});

test("production text delegation returns to Maestro with canonical definition and original project context", { timeout: 10000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-maestro-text-synthesis-"));
  const { providerRepo, database } = makeProvider(root);
  providerRepo.save({ id: "research-provider", providerType: "custom", displayName: "Research Provider", connected: true,
    enabled: true, baseUrl: "http://unused.invalid", models: [{ id: "research-model", name: "Research Model", enabled: true,
      capabilities: { text: true, reasoning: true, vision: false, tools: false } }] });
  const priorPrompt = "In this project, I care most about maintainability.";
  const prompt = "Compare the tradeoffs in this project context without changing files.";
  let planningInput: Record<string, unknown> | undefined;
  let synthesisInput: Record<string, unknown> | undefined;
  let synthesisSystem = "";
  const resolvedPairs: string[] = [];
  const resolver = new ModelResolver(providerRepo, {
    createClient: (options) => ({ complete: async ({ input, system }: { input: string; system: string }) => {
      resolvedPairs.push(options.modelId);
      const data = JSON.parse(input) as Record<string, unknown>;
      if (data.assignment && typeof data.assignment === "object") {
        assert.match(system, /Research:/);
        return JSON.stringify({ status: "completed", summary: "Compared local risks and tradeoffs from the supplied facts.",
          evidence: ["The supplied facts indicate a bounded local process."], blockers: [], unresolved: [] });
      }
      if (system.includes("MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER")) return JSON.stringify({ requiresCurrentProjectEvidence: false });
      if (data.userGoal === priorPrompt) return JSON.stringify({ type: "respond", message: "I will prioritize maintainability.", basis: "conversation", evidenceRefs: [] });
      if (Array.isArray(data.projectIntelligence) && (data.projectIntelligence as Array<{ name?: string }>).some((entry) => entry.name === "specialist-result")) {
        synthesisInput = data;
        synthesisSystem = system;
        return JSON.stringify({ type: "respond", message: "The supplied context supports these tradeoffs; no external research or project verification was performed.", basis: "conversation", evidenceRefs: [] });
      }
      if (Array.isArray(data.availableMediobots)) {
        planningInput = data;
        const research = (data.availableMediobots as Array<{ definitionId: string; role: string; assignable: boolean }>)
          .find((definition) => definition.role === "research");
        assert.ok(research?.assignable);
        return JSON.stringify({ type: "delegate_text", independence: "One bounded analysis from the supplied local context is sufficient.",
          assignments: [{ definitionId: research.definitionId, objective: "Identify the key tradeoffs", relevantContext: "The user asks for tradeoffs based on the current project context.",
            relevantContextRefs: [], constraints: ["Do not claim external research"], expectedOutcome: "Summarize supported tradeoffs", evidenceExpectations: ["Claims tied to supplied context"] }] });
      }
      throw new Error("Unexpected model request in text delegation test");
    } }),
  });
  const app = await startCommandCenter({ databasePath: path.join(root, "mediobot.db"), providerRepository: providerRepo,
    modelResolver: resolver, workspaceRoot: root, vite: false, listen: false });
  t.after(async () => { await app.close(); database.close(); rmSync(root, { recursive: true, force: true }); });

  const first = await request(app, "POST", "/api/turns", { threadId: "maestro-text", turnId: "context-turn",
    prompt: priorPrompt, modelSelection: { providerConnectionId: "selected-provider", modelId: "selected-model" } });
  assert.ok([200, 202].includes(first.status));
  const response = await request(app, "POST", "/api/turns", { threadId: "maestro-text", turnId: "tradeoffs",
    prompt, modelSelection: { providerConnectionId: "selected-provider", modelId: "selected-model" },
    assignmentModelSelections: { research: { providerConnectionId: "research-provider", modelId: "research-model" } } });
  assert.equal(response.status, 202);
  const taskId = response.json.taskId as string;
  assert.equal(await awaitTaskCompletion(app, taskId), "task.completed");

  assert.equal(planningInput?.userGoal, prompt);
  assert.match(String(planningInput?.definitionInstructions), /You own the original goal and final synthesis/);
  assert.ok(synthesisInput, "specialist results must be submitted to a Maestro synthesis decision");
  assert.equal(synthesisInput?.userGoal, prompt);
  assert.match(String(synthesisInput?.definitionInstructions), /You own the original goal and final synthesis/);
  assert.match(synthesisSystem, /Structured runtimeState and permissions are authoritative/);
  assert.deepEqual(synthesisInput?.availableIntents, ["respond", "request_user_input"], "synthesis cannot silently start unbounded follow-on work");
  const workspace = synthesisInput?.workspaceState as Record<string, unknown>;
  assert.equal(workspace.workspaceId, app.workspaceManager.session?.workspaceId);
  assert.equal(workspace.rootPath, realpathSync(root));
  assert.equal(workspace.status, "OPEN");
  assert.ok((synthesisInput?.recentHistory as Array<{ user: string }>).some((turn) => turn.user === priorPrompt));
  const intelligence = synthesisInput?.projectIntelligence as Array<{ name: string; value: string }>;
  const results = intelligence.filter((entry) => entry.name === "specialist-result").map((entry) => JSON.parse(entry.value) as Record<string, unknown>);
  assert.equal(results.length, 1, "Maestro synthesis must receive the specialist executor result");
  assert.equal(results[0]?.executor, "text");
  assert.equal(results[0]?.status, "completed");
  const researchTask = app.composition.world.inspect().tasks.find(task => task.parentTaskId === taskId);
  assert.ok(researchTask, "Research must receive a durable child assignment");
  assert.deepEqual(await app.composition.durableTaskEngine!.getTaskModelSelection(researchTask.id),
    { providerConnectionId: "research-provider", modelId: "research-model" }, "the explicit specialist preference must be persisted with the child");
  assert.ok(resolvedPairs.includes("research-model"), "the worker request must use the specialist's configured model");
  assert.match(String(results[0]?.summary), /Compared local risks and tradeoffs/);
  assert.equal(app.composition.world.inspect().evidence.some((entry) => entry.source.type === "worker-report"), true);
  const saved = await request(app, "GET", "/api/threads/maestro-text");
  const turn = saved.json.thread.turns.find((entry: { items: Array<{ type: string; text?: string }> }) =>
    entry.items.some((item) => item.type === "user_message" && item.text === prompt)) as { items: Array<{ type: string; text?: string }> } | undefined;
  assert.ok(turn, "the submitted prompt must remain in its own persisted turn");
  assert.ok(turn.items.some((item) => item.type === "agent_message" && /no external research or project verification/i.test(item.text ?? "")));

  const unavailablePreference = await request(app, "POST", "/api/turns", { threadId: "invalid-specialist-model", turnId: "invalid-model",
    prompt: "Run a bounded task", modelSelection: { providerConnectionId: "selected-provider", modelId: "selected-model" },
    assignmentModelSelections: { research: { providerConnectionId: "missing-provider", modelId: "missing-model" } } });
  assert.equal(unavailablePreference.status, 409, "the backend must reject an unavailable specialist preference instead of silently switching providers");
  assert.equal(unavailablePreference.json.error.code, "assignment-model-unavailable");
  assert.equal(app.composition.world.inspect().tasks.some(task => task.goal === "Run a bounded task"), false,
    "an invalid specialist model must fail before creating an execution task");
});

// ---------------------------------------------------------------------------
// 1. Happy path: Maestro delegates to Cody → file read/write/verify/finish
// ---------------------------------------------------------------------------
test("delegate → Cody file read/write/verify → evidence → frontend events → persisted transcript", { timeout: 15000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-cody-turn-"));
  writeFileSync(path.join(root, "hello.txt"), "original content");
  const { providerRepo, database } = makeProvider(root);

  let decisionCalls = 0;
  let synthesisCalls = 0;
  let codyStep = 0;
  let maestroInput: Record<string, unknown> | undefined;
  let maestroSystem = "";

  const resolver = new ModelResolver(providerRepo, {
    createClient: () => ({
      complete: async ({ input, system }: { input: string; system: string }) => {
        const data = JSON.parse(input) as Record<string, unknown>;
        if (system.includes("MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER")) return JSON.stringify({ requiresCurrentProjectEvidence: false });

        // Cody step calls: { goal, recentToolHistory }
        if (typeof data.goal === "string" && Array.isArray(data.recentToolHistory)) {
          codyStep += 1;
          if (codyStep === 1) return JSON.stringify({ type: "list" });
          if (codyStep === 2) return JSON.stringify({ type: "read", path: "hello.txt" });
          if (codyStep === 3) return JSON.stringify({ type: "write", path: "hello.txt", content: "hello world" });
          if (codyStep === 4) {
            return JSON.stringify({
              type: "run",
              command: "node",
              args: ["-e", "process.exit(0)"],
              verification: "node exits 0 confirming write completed",
            });
          }
          return JSON.stringify({ type: "finish", summary: "Updated hello.txt to hello world" });
        }

        // Maestro planning call: { userGoal, availableIntents, availableMediobots, ... }
        // The LangGraph route makes a distinct, bounded synthesis decision
        // after the specialist report has been persisted.
        if (decisionCalls > 0) {
          synthesisCalls += 1;
          assert.ok(JSON.stringify(data).includes("Updated hello.txt to hello world"), "synthesis input must include Cody's completed report");
          const evidence = Array.isArray(data.relevantEvidence) ? data.relevantEvidence as Array<{ id?: string; source?: { type?: string }; validity?: string }> : [];
          const evidenceRefs = evidence.filter((entry) => entry.id && ["observed", "verified"].includes(String(entry.validity))
            && ["coding-tool", "tester-verification"].includes(String(entry.source?.type))).map((entry) => entry.id!);
          assert.ok(evidenceRefs.length > 0, "synthesis must receive authorized Cody execution evidence");
          return JSON.stringify({ type: "respond", message: "Cody updated hello.txt. The check command exited 0, but goal correctness remains unverified.", basis: "project-evidence", evidenceRefs });
        }
        decisionCalls += 1;
        maestroInput = data;
        maestroSystem = system;
        const meds = data.availableMediobots as Array<{ definitionId: string; role: string; assignable: boolean; capabilities: string[] }>;
        const cody = meds.find((m) => m.role === "coding");
        assert.ok(cody, "Cody must be in availableMediobots");
        assert.ok(cody.assignable, "Cody must be assignable when workspace is open");
        assert.ok((data.availableIntents as string[]).includes("delegate"), "delegate must be in availableIntents when workspace is authorized");
        assert.ok(cody.capabilities.includes("workspace"), "Cody must advertise workspace capability");

        return JSON.stringify({
          type: "delegate",
          definitionId: cody.definitionId,
          objective: "Change the greeting in hello.txt to say 'hello world'",
          relevantContextRefs: ["hello.txt"],
          constraints: ["Preserve the file encoding", "Do not add extra whitespace"],
          expectedOutcome: "hello.txt contains the text 'hello world' as its only content",
          evidenceExpectations: ["Verification command exits 0 confirming the written content"],
        });
      },
    }),
  });

  const app = await startCommandCenter({
    databasePath: path.join(root, "mediobot.db"),
    providerRepository: providerRepo,
    modelResolver: resolver,
    workspaceRoot: root,
    vite: false,
    listen: false,
  });
  t.after(async () => { await app.close(); database.close(); rmSync(root, { recursive: true, force: true }); });

  const selection = { providerConnectionId: "selected-provider", modelId: "selected-model" };
  const response = await request(app, "POST", "/api/turns", {
    threadId: "cody-thread",
    turnId: "cody-turn",
    prompt: "Change hello.txt to say hello world",
    modelSelection: selection,
  });
  assert.equal(response.status, 202, "Delegate decision must return 202");
  assert.ok(response.json.taskId, "202 response must include taskId");
  const taskId = response.json.taskId as string;
  const terminal = await awaitTaskCompletion(app, taskId);
  assert.equal(terminal, "task.completed", "Cody task must complete successfully");
  const graphOutcome = database.raw.prepare(`SELECT payload_json FROM langgraph_task_outcomes
    WHERE workflow_name = ? AND thread_id = ? AND checkpoint_ns = ? AND task_id = ?`)
    .get("maestro-specialist-groups", taskId, "specialists", "assignment-1") as { payload_json?: string } | undefined;
  assert.ok(graphOutcome?.payload_json, "the normal single-Cody production delegation must execute and persist through LangGraph");
  assert.equal((JSON.parse(graphOutcome.payload_json) as { status?: string }).status, "completed");

  // File was actually written on disk
  const fileContent = readFileSync(path.join(root, "hello.txt"), "utf8");
  assert.equal(fileContent, "hello world", "Cody must have written the new content to disk");

  // Server reused the pre-validated decision — no second model planning call
  assert.equal(decisionCalls, 1, "Server must reuse the validated delegate decision; no second planning call");
  assert.ok(synthesisCalls >= 1, "LangGraph must ask Maestro to synthesize the completed Cody report");
  assert.equal(maestroInput?.userGoal, "Change hello.txt to say hello world");
  assert.match(String(maestroInput?.definitionInstructions), /You own the original goal and final synthesis/);
  assert.match(maestroSystem, /Structured runtimeState and permissions are authoritative/);
  const projectState = maestroInput?.workspaceState as Record<string, unknown>;
  assert.equal(projectState.workspaceId, app.workspaceManager.session?.workspaceId);
  assert.equal(projectState.rootPath, realpathSync(root));
  assert.equal(projectState.status, "OPEN");
  const modelRoster = maestroInput?.availableMediobots as Array<{ definitionId: string; role: string; description: string; assignable: boolean; capabilities: string[] }>;
  const codyMetadata = modelRoster.find((entry) => entry.role === "coding");
  assert.ok(codyMetadata?.assignable);
  assert.deepEqual([...new Set(codyMetadata?.capabilities ?? [])].sort(), [
    "filesystem.list", "filesystem.read", "filesystem.search", "filesystem.write", "terminal.execute",
    "text-inference", "workspace",
  ]);
  const assignableIdsFromRoster = modelRoster.filter((entry) => entry.assignable).map((entry) => entry.definitionId).sort();
  assert.deepEqual([...(maestroInput?.assignableDefinitionIds as string[])].sort(), assignableIdsFromRoster);
  for (const role of ["research", "tester"]) {
    const specialist = modelRoster.find((entry) => entry.role === role);
    assert.ok(specialist?.assignable);
    assert.deepEqual(specialist?.capabilities, role === "research"
      ? ["text-inference", "web.search", "web.crawl"]
      : ["text-inference", "filesystem.list", "filesystem.read", "terminal.execute"]);
    if (role === "tester") assert.match(specialist?.description ?? "", /execute approved tests/i);
  }
  const visionMetadata = modelRoster.find((entry) => entry.role === "visual-browser");
  assert.equal(visionMetadata?.assignable, false, "Vision is registered but not assignable through the Maestro text executor");
  assert.deepEqual(visionMetadata?.capabilities, []);
  const skills = maestroInput?.skillCatalog as Array<{ id: string; description: string; whenToUse: string }>;
  const delegationSkill = skills.find((skill) => skill.id === "delegation");
  assert.ok(delegationSkill);
  assert.ok(delegationSkill.description.trim().length > 0);
  assert.ok(delegationSkill.whenToUse.trim().length > 0);

  // Evidence collected in world
  const snapshot = app.composition.world.inspect();
  const childTask = snapshot.tasks.find((task) => task.parentTaskId === taskId);
  assert.ok(childTask, "Cody child task must exist");

  const allEvidence = snapshot.evidence;
  const toolEvidence = allEvidence.filter((e) => e.source.type === "coding-tool" && e.taskId === childTask.id);
  assert.ok(toolEvidence.length >= 3, "Must have tool evidence for list, read, write operations");

  const verificationEvidence = allEvidence.filter((e) => e.source.type === "coding-verification" && e.taskId === childTask.id);
  assert.equal(verificationEvidence.length, 1, "Verification command evidence must be recorded exactly once");
  assert.equal(verificationEvidence[0]!.kind, "command-execution");
  assert.equal(verificationEvidence[0]!.validity, "observed");

  const diffEvidence = allEvidence.filter((e) => e.source.type === "workspace-diff" && e.taskId === childTask.id);
  assert.equal(diffEvidence.length, 1, "Exactly one workspace-diff evidence record must exist");

  const summaryEvidence = allEvidence.filter((e) => e.source.type === "cody-summary" && e.taskId === childTask.id);
  assert.equal(summaryEvidence.length, 1, "Cody must record a cody-summary evidence");
  assert.equal(summaryEvidence[0]!.kind, "model-summary");
  assert.equal(summaryEvidence[0]!.validity, "observed", "Cody summary is a model claim, never verified execution proof");

  const maestroResponse = allEvidence.filter((e) => e.source.type === "maestro-response" && e.taskId === taskId);
  assert.equal(maestroResponse.length, 1, "Maestro must record exactly one maestro-response evidence");
  // The final message must accurately distinguish verified/unverified
  assert.match(maestroResponse[0]!.content, /check command/i, "Final message must reference command execution status");
  assert.doesNotMatch(maestroResponse[0]!.content, /Goal satisfied/, "Goal cannot be satisfied without the configured completion policy");

  // Worker and tool events reached the frontend
  const events = app.composition.taskEvents.get(taskId as unknown as TaskId)!;
  assert.ok(events.some((e) => e.type === "worker.started" && e.workerId === childTask.assignedWorkerId), "worker.started must be published");
  assert.ok(events.some((e) => e.type === "tool.started"), "tool.started events must be published for Cody tool calls");
  assert.ok(events.some((e) => e.type === "tool.completed"), "tool.completed events must be published");
  assert.ok(events.some((e) => e.type === "file.changed" && (e as { diff?: unknown }).diff), "file.changed with diff must be published on task completion");
  assert.ok(events.some((e) => e.type === "task.completed"), "task.completed must be published");

  // A late SSE subscriber gets the complete persisted transcript snapshot;
  // reconnects with a valid event cursor replay individual unseen events.
  const streamed = await turnEvents(app, "cody-thread", "cody-turn");
  const streamedSnapshot = streamed.find((e: { type: string }) => e.type === "turn.snapshot");
  assert.equal(streamedSnapshot?.payload?.turn?.status, "completed", "SSE snapshot must expose the persisted terminal state");
  assert.ok(streamedSnapshot?.payload?.turn?.items?.some((item: { type: string }) => item.type === "tool_execution"), "SSE snapshot must include Cody tool activity");
  assert.ok(streamedSnapshot?.payload?.turn?.items?.some((item: { type: string; diff?: unknown }) => item.type === "diff" && item.diff), "SSE snapshot must include the persisted diff");

  // Turn persisted to SQLite with correct items
  const saved = await request(app, "GET", "/api/threads/cody-thread");
  const turn = saved.json.thread.turns[0] as {
    status: string;
    items: Array<{ type: string; text?: string; diff?: unknown; actor?: { type: string; mediobotId?: string } }>;
  };
  assert.equal(turn.status, "completed");
  assert.ok(turn.items.some((item) => item.type === "tool_execution"), "Persisted turn must include tool_execution items");
  assert.ok(turn.items.some((item) => item.type === "diff"), "Persisted turn must include a diff item");
  const agentMsg = turn.items.find((item) => item.type === "agent_message" && item.actor?.type !== "system"
    && /verif/i.test(item.text ?? ""));
  assert.ok(agentMsg, "Persisted turn must include a Maestro agent_message");
  assert.ok(agentMsg?.text, "Maestro agent_message must have content");
  // The final message must reference verification status, not fabricate completion
  assert.match(agentMsg!.text!, /verif/i, "Final agent_message must reference verification status");
  assert.ok(turn.items.some((item) => item.type === "user_message"), "User message must be present");
});

test("/api/turns creates and behaviorally verifies the requested Python helper through Maestro and Cody", { timeout: 15000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-prime-turn-"));
  const { providerRepo, database } = makeProvider(root);
  let maestroCalls = 0;
  let codyStep = 0;
  let synthesisCalls = 0;
  const pythonSource = [
    "from math import isqrt",
    "",
    "def is_prime(value):",
    "    if not isinstance(value, int) or isinstance(value, bool):",
    "        raise TypeError('value must be an integer')",
    "    if value < 2:",
    "        return False",
    "    return all(value % divisor for divisor in range(2, isqrt(value) + 1))",
    "",
  ].join("\n");
  const pythonCommand = process.env.PYTHON ?? (process.platform === "win32" ? "py" : "python3");
  const pythonPrefix = process.env.PYTHON ? [] : process.platform === "win32" ? ["-3"] : [];
  const missingInterpreter = `mediobot-missing-python-${globalThis.crypto.randomUUID()}`;
  const checkCode = "from is_prime import is_prime; assert not is_prime(-3); assert not is_prime(0); assert not is_prime(1); assert is_prime(2); assert is_prime(104729); assert not is_prime(104728)";
  const resolver = new ModelResolver(providerRepo, {
    createClient: () => ({
      complete: async ({ input, system }: { input: string; system: string }) => {
        const data = JSON.parse(input) as Record<string, unknown>;
        if (typeof data.goal === "string" && Array.isArray(data.recentToolHistory)) {
          assert.match(system, /Never repeat filesystem\.list for a directory whose entries are already present/);
          const actions = [
            { type: "list", path: ".", commentary: "I’m checking the workspace structure before creating the helper." },
            { type: "write", path: "is_prime.py", content: pythonSource },
            { type: "list", path: "." },
            { type: "read", path: "is_prime.py" },
            { type: "write", path: "is_prime.py", content: pythonSource,
              commentary: "The target file is new. I’m adding the function and its edge-case handling now." },
            { type: "run", command: `${missingInterpreter} --password inline-command-secret -c 'inline script secret'`,
              args: ["--token", "synthetic-credential-value", "-H", "Authorization: Basic inline-header-secret",
                "--header", "Cookie: session=inline-cookie-secret", "-c", checkCode], cwd: ".",
              verification: "Check negative values, 0, 1, 2, and a large prime/non-prime pair",
              commentary: "The implementation is ready. I’m running the requested edge-case check." },
            { type: "run", command: pythonCommand, args: [...pythonPrefix, "-c", checkCode], cwd: ".",
              verification: "Check negative values, 0, 1, 2, and a large prime/non-prime pair",
              commentary: "The first interpreter could not start (ENOENT). I’m retrying once with the available Python executable." },
            { type: "finish", summary: "Created is_prime.py. The first check command could not start (ENOENT); I used the available Python executable and the edge-case check exited 0.",
              commentary: "The fallback edge-case check exited successfully; I’m reporting both attempts to Maestro." },
          ];
          if (codyStep === 3) assert.ok((data.recentToolHistory as Array<{ result: string }>).some(entry =>
            entry.result.includes('write to "is_prime.py" was not executed; read that exact target path now')),
          "after a rejected write and repeated listing, recovery identifies the exact target that must be read");
          if (codyStep === 6) assert.match(JSON.stringify(data.recentToolHistory), /launchErrorCode=ENOENT/,
            "Cody's changed executable is justified by the actual first launch failure");
          return JSON.stringify(actions[codyStep++]!);
        }
        if (maestroCalls > 0) {
          synthesisCalls += 1;
          const evidence = Array.isArray(data.relevantEvidence) ? data.relevantEvidence as Array<{ id?: string; source?: { type?: string }; validity?: string }> : [];
          const references = evidence.filter(item => item.id && item.validity === "observed"
            && ["coding-tool", "coding-verification"].includes(String(item.source?.type))).map(item => item.id!);
          assert.ok(references.length > 0, "Maestro synthesis must receive actual tool evidence");
          return JSON.stringify({ type: "respond", message: `Created is_prime.py. The first interpreter could not start (ENOENT); ${pythonCommand} then passed the requested edge-case check with exit code 0. This is Cody's self-check, not an independent Tester result.`,
            basis: "project-evidence", evidenceRefs: references });
        }
        maestroCalls += 1;
        const agents = data.availableMediobots as Array<{ definitionId: string; role: string; assignable: boolean }>;
        const cody = agents.find(agent => agent.role === "coding");
        assert.ok(cody?.assignable);
        assert.ok((data.availableIntents as string[]).includes("delegate"));
        return JSON.stringify({ type: "delegate", definitionId: cody.definitionId,
          objective: "Create is_prime.py with a prime-checking function and verify edge cases.",
          relevantContextRefs: [], constraints: ["Create a new file only after confirming the target does not exist."],
          expectedOutcome: "A Python function that returns correct results for negative values, 0, 1, 2, and large integers.",
          evidenceExpectations: ["The Python check command exits 0."] });
      },
    }),
  });
  const app = await startCommandCenter({ databasePath: path.join(root, "mediobot.db"), providerRepository: providerRepo,
    modelResolver: resolver, workspaceRoot: root, vite: false, listen: false });
  t.after(async () => { await app.close(); database.close(); rmSync(root, { recursive: true, force: true }); });
  const selection = { providerConnectionId: "selected-provider", modelId: "selected-model" };
  const response = await request(app, "POST", "/api/turns", { threadId: "prime-thread", turnId: "prime-turn",
    prompt: "Create a Python function that checks whether a number is prime. Ask Cody to implement it, verify the result, and explain what was completed.",
    modelSelection: selection });
  assert.equal(response.status, 202);
  const taskId = response.json.taskId as string;
  const terminalState = await awaitTaskCompletion(app, taskId);
  assert.equal(terminalState, "task.completed");
  assert.equal(readFileSync(path.join(root, "is_prime.py"), "utf8"), pythonSource);
  assert.equal(maestroCalls, 1);
  assert.ok(synthesisCalls >= 1);
  const events = app.composition.taskEvents.get(taskId as unknown as TaskId)!;
  const assignment = events.find(event => event.type === "worker.assigned" && event.workerDefinitionId === app.composition.codyDefinitionId);
  assert.ok(assignment, "Cody assignment should be persisted as a structured event");
  assert.match(assignment.message ?? "", /prime|is_prime/i,
    "the structured assignment event must preserve the objective without fabricating a Maestro-authored message");
  const codyMessages = events.filter(event => event.type === "worker.message" && event.workerDefinitionId === app.composition.codyDefinitionId);
  assert.deepEqual(codyMessages.map(event => event.message), [
    "I’m checking the workspace structure before creating the helper.",
    "The target file is new. I’m adding the function and its edge-case handling now.",
    "The implementation is ready. I’m running the requested edge-case check.",
    "The first interpreter could not start (ENOENT). I’m retrying once with the available Python executable.",
    "The fallback edge-case check exited successfully; I’m reporting both attempts to Maestro.",
  ], "Cody's messages come from its model decisions and are correlated to its real execution");
  assert.equal(events.filter(event => event.type === "worker.progress" && /^Cody progress\.?$/i.test(event.message ?? "")).length, 0,
    "generic progress is not substituted for organizational communication");
  const codyActivityStates = events.filter(event => event.workerDefinitionId === app.composition.codyDefinitionId
    && (event.type === "worker.started" || event.type === "worker.completed" || event.type.startsWith("tool."))).map(event => event.activityState);
  for (const expectedState of ["thinking", "inspecting", "editing", "verifying", "completed"] as const) {
    assert.ok(codyActivityStates.includes(expectedState), `Cody's attributed event stream should retain ${expectedState} state`);
  }
  const taskView = await request(app, "GET", `/api/tasks/${taskId}`);
  const createdArtifact = (taskView.json.task.artifacts as Array<{ id: string; mediobotId: string; reference: string; contentHash: string }> | undefined)
    ?.find(artifact => artifact.reference === "is_prime.py");
  assert.ok(createdArtifact, "the durable task projection must expose Cody's created file artifact");
  assert.equal(createdArtifact.mediobotId, "cody", "artifact attribution must use persistent specialist identity");
  assert.equal(createdArtifact.contentHash, createHash("sha256").update(pythonSource).digest("hex"));
  assert.match(createdArtifact.id, /^artifact-[a-f0-9]{32}$/);
  const expectedMissingTarget = events.find(event => event.type === "tool.failed" && event.toolName === "filesystem.read"
    && event.failureCategory === "file-not-found");
  assert.equal(expectedMissingTarget?.error?.message, "File not found (ENOENT); no content was read.",
    "a safe create-only existence probe must expose missing-file semantics instead of a generic tool failure");
  const pythonCheck = events.find(event => event.type === "tool.completed" && event.toolName === "terminal.execute"
    && event.isVerification && event.exitCode === 0);
  assert.ok(pythonCheck, "the actual Python edge-case command must be a successful attributed verification event");
  const failedCheck = events.find(event => event.type === "tool.failed" && event.toolName === "terminal.execute"
    && event.isVerification && event.errorCode === "ENOENT");
  assert.equal(failedCheck?.error?.message, "Command could not start (ENOENT).",
    "the launch failure remains distinct from a process that ran and returned a nonzero exit code");
  assert.equal(failedCheck?.exitCode, null);
  assert.match(failedCheck?.command ?? "", /mediobot-missing-python-.*\[arguments redacted\] --token \[REDACTED\] -H \[REDACTED\] --header \[REDACTED\] -c \[REDACTED\]/);
  assert.match(failedCheck?.command ?? "", /-H \[REDACTED\] --header \[REDACTED\]/,
    "HTTP header arguments are redacted before durable event projection");
  assert.equal(failedCheck?.workingDirectory, ".");
  assert.match(failedCheck?.recoveryReason ?? "", /ENOENT/);
  assert.equal(JSON.stringify(failedCheck).includes("synthetic-credential-value"), false);
  assert.equal(JSON.stringify(failedCheck).includes("inline-header-secret"), false);
  assert.equal(JSON.stringify(failedCheck).includes("inline-cookie-secret"), false);
  assert.equal(JSON.stringify(failedCheck).includes("inline-command-secret"), false);
  assert.equal(JSON.stringify(failedCheck).includes("inline script secret"), false);
  assert.equal(events.filter(event => event.type === "tool.started" && event.toolName === "filesystem.list").length, 1,
    "the repeated listing is rejected before a second filesystem.list invocation");
  assert.equal(events.filter(event => event.type === "tool.started" && event.toolName === "filesystem.write").length, 1,
    "the premature write is rejected and only the post-ENOENT write executes");
  assert.equal(events.filter(event => event.type === "tool.started" && event.toolName === "terminal.execute").length, 2,
    "only the failed start and one evidence-justified alternate executable are launched");
  const saved = await request(app, "GET", "/api/threads/prime-thread");
  const transcriptItems = saved.json.thread.turns[0].items as Array<{ id: string; type: string; actor?: { name?: string }; text?: string; activityLabel?: string; tool?: unknown }>;
  const agentMessages = transcriptItems.filter(item => item.type === "agent_message");
  const finalMessage = agentMessages.at(-1);
  assert.ok(transcriptItems.some(item => item.type === "activity" && item.actor?.name === "Maestro"
    && item.activityLabel === "Assigned Cody" && /prime|is_prime/i.test(item.text ?? "")),
    "the durable Main Chat transcript shows the real structured assignment as Maestro activity, not fabricated dialogue");
  assert.ok(agentMessages.some(item => item.actor?.name === "Cody" && /first interpreter could not start/i.test(item.text ?? "")),
    "the durable Main Chat transcript retains Cody's model-authored recovery update");
  assert.equal(transcriptItems.some(item => /^(?:Cody|Worker) progress\.?$/i.test(item.text ?? "")), false,
    "generic worker progress does not flood the client-facing conversation");
  assert.equal(agentMessages.some(item => /^(?:Cody|Maestro) (?:started|completed)\.$/i.test(item.text ?? "")), false,
    "runtime state changes remain in the event stream without synthetic chat narration");
  const toolItems = transcriptItems.filter(item => item.type === "tool_execution") as Array<{ id: string; actor?: { name?: string }; tool?: {
    toolName?: string; command?: string; workingDirectory?: string; recoveryReason?: string; errorCode?: string; exitCode?: number | null;
  } }>;
  const persistedFailure = toolItems.find(item => item.tool?.toolName === "terminal.execute" && item.tool.errorCode === "ENOENT");
  assert.equal(persistedFailure?.actor?.name, "Cody");
  assert.equal(persistedFailure?.tool?.workingDirectory, ".", JSON.stringify(persistedFailure));
  assert.match(persistedFailure?.tool?.command ?? "", /--token \[REDACTED\]/);
  assert.match(persistedFailure?.tool?.recoveryReason ?? "", /ENOENT/);
  const specialistTasks = await request(app, "GET", "/api/tasks");
  const codyTask = (specialistTasks.json.tasks as Array<{ id: string; assignedMediobot?: { id: string }; events?: Array<{ id: string; type: string; toolName?: string; command?: string; workingDirectory?: string; recoveryReason?: string; errorCode?: string }> }>)
    .find(candidate => candidate.assignedMediobot?.id === "cody");
  const specialistFailure = codyTask?.events?.find(event => event.type === "tool.failed" && event.toolName === "terminal.execute" && event.errorCode === "ENOENT");
  assert.equal(specialistFailure?.id, failedCheck?.id, `individual specialist history replays the same attributed event identity as Main Chat: ${JSON.stringify(codyTask)}`);
  assert.equal(specialistFailure?.command, failedCheck?.command);
  assert.equal(specialistFailure?.workingDirectory, ".");
  assert.equal(specialistFailure?.recoveryReason, failedCheck?.recoveryReason);
  assert.match(finalMessage?.text ?? "", /ENOENT/i);
  assert.match(finalMessage?.text ?? "", /exit code 0|successfully/i);
  assert.match(finalMessage?.text ?? "", /not an independent Tester result/i,
    "the final synthesis distinguishes Cody's self-check from an independent Tester result");
  assert.doesNotMatch(finalMessage?.text ?? "", /Tester (?:independently )?verified/i);
});

test("/api/turns keeps model-authored group findings, Cody tool evidence, Main Chat events, and specialist history aligned", { timeout: 20000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-org-communication-"));
  writeFileSync(path.join(root, "project.txt"), "The project uses a local configuration file.\n");
  const { providerRepo, database } = makeProvider(root);
  let resolveDocPublished!: () => void;
  const docPublished = new Promise<void>(resolve => { resolveDocPublished = resolve; });
  let maestroCalls = 0;
  let codyCalls = 0;
  let docCalls = 0;
  let codyConsumedGroupFinding = false;
  let docConcurrentWithCody = false;
  const resolver = new ModelResolver(providerRepo, {
    createClient: () => ({ complete: async ({ input, system }: { input: string; system: string }) => {
      const data = JSON.parse(input) as Record<string, unknown>;
      if (system.includes("MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER")) return JSON.stringify({ requiresCurrentProjectEvidence: false });
      if (typeof data.goal === "string" && Array.isArray(data.recentToolHistory)) {
        codyCalls += 1;
        if (codyCalls === 1) {
          // Hold Cody's first decision until Doc has authored the group finding.
          // Cody's next loop iteration then reads it through its active cursor.
          await Promise.race([docPublished, new Promise((_, reject) => setTimeout(() => reject(new Error("Doc finding timed out")), 5_000))]);
          docConcurrentWithCody = true;
          return JSON.stringify({ type: "list", path: "." });
        }
        if (codyCalls >= 3) {
          return JSON.stringify({ type: "finish", summary: "Doc's group finding was consistent with project.txt, which confirms the local configuration detail." });
        }
        const history = data.recentToolHistory as Array<{ action?: string; result?: string }>;
        const finding = history.find(entry => /shared group finding from doc/i.test(entry.action ?? "")
          && /local configuration file/i.test(entry.result ?? ""));
        if (finding) {
          codyConsumedGroupFinding = true;
          return JSON.stringify({ type: "read", path: "project.txt", commentary: "Doc's shared finding points me to the local project configuration; I’m checking the file evidence." });
        }
        return JSON.stringify({ type: "finish", summary: "I could not retrieve the shared finding; project inspection is incomplete." });
      }
      if (system.includes("Return exactly JSON") && /Doc: documentation intelligence specialist/.test(system)) {
        docCalls += 1;
        const assignment = data.assignment as { objective?: string } | undefined;
        assert.match(assignment?.objective ?? "", /share.*finding/i);
        if (system.includes("requires one model-authored group finding")) {
          // The first report omitted its required group action; this bounded repair is model-authored.
          resolveDocPublished();
          return JSON.stringify({ status: "completed", summary: "The supplied project notes identify a local configuration file.",
            evidence: ["project.txt is the source for this bounded check."], blockers: [], unresolved: [],
            groupMessages: [{ kind: "finding", content: "The project uses a local configuration file.", evidenceRefs: [] }] });
        }
        return JSON.stringify({ status: "completed", summary: "The supplied project notes identify a local configuration file.",
          evidence: ["project.txt is the source for this bounded check."], blockers: [], unresolved: [] });
      }
      if (maestroCalls > 0) {
        const reports = JSON.stringify(data.projectIntelligence ?? []);
        assert.match(reports, /Doc's group finding was consistent with project\.txt/);
        const evidence = Array.isArray(data.relevantEvidence) ? data.relevantEvidence as Array<{ id?: string; validity?: string }> : [];
        const refs = evidence.filter(item => item.id && ["observed", "verified"].includes(String(item.validity))).map(item => item.id!);
        assert.ok(refs.length > 0, "final synthesis receives persisted specialist execution evidence");
        return JSON.stringify({ type: "respond", message: "Doc published a shared finding about the local configuration file. Cody read project.txt, confirmed the finding, and reported the evidence.", basis: "project-evidence", evidenceRefs: refs });
      }
      maestroCalls += 1;
      const available = data.availableMediobots as Array<{ definitionId: string; role: string; assignable: boolean }>;
      const cody = available.find(item => item.role === "coding");
      const doc = available.find(item => item.role === "doc");
      assert.ok(cody?.assignable && doc?.assignable);
      return JSON.stringify({ type: "delegate_text", independence: "Doc can report its supplied project note while Cody independently checks the workspace.", assignments: [
        { assignmentId: "doc-finding", definitionId: doc.definitionId, objective: "Share the project configuration finding with the authorized group.",
          relevantContext: "The project uses a local configuration file.", relevantContextRefs: [], constraints: [],
          expectedOutcome: "A bounded finding published to the shared group.", evidenceExpectations: [] },
        { assignmentId: "cody-check", definitionId: cody.definitionId, objective: "Check the project configuration detail and use relevant group findings.",
          relevantContext: "Inspect the workspace and consume authorized group findings.", relevantContextRefs: [], constraints: [],
          expectedOutcome: "A file-backed result that accounts for peer findings.", evidenceExpectations: [], requiredCapabilities: ["filesystem.list", "filesystem.read"] },
      ] });
    } }),
  });
  const app = await startCommandCenter({ databasePath: path.join(root, "mediobot.db"), providerRepository: providerRepo,
    modelResolver: resolver, workspaceRoot: root, vite: false, listen: false });
  t.after(async () => { await app.close(); database.close(); rmSync(root, { recursive: true, force: true }); });
  const response = await request(app, "POST", "/api/turns", { threadId: "org-thread", turnId: "org-turn",
    prompt: "Have Doc share the supplied project finding with the group while Cody independently checks it in the workspace.",
    modelSelection: { providerConnectionId: "selected-provider", modelId: "selected-model" } });
  assert.equal(response.status, 202);
  const taskId = response.json.taskId as string;
  const completedEvent = await awaitTaskCompletion(app, taskId);
  if (completedEvent !== "task.completed") t.diagnostic(JSON.stringify({ docCalls,
    events: app.composition.taskEvents.get(taskId as unknown as TaskId)?.map(event => ({ type: event.type, worker: event.workerDefinitionId, message: event.message, error: event.error })) }));
  assert.equal(completedEvent, "task.completed");
  assert.ok(docConcurrentWithCody, "Cody's active execution overlaps Doc's publication window");
  assert.ok(codyConsumedGroupFinding, "Cody's next model decision receives Doc's attributed finding through its group cursor");
  assert.equal(docCalls, 2, "Doc's missing group action is repaired once without repeating specialist execution");
  assert.ok(codyCalls >= 3, "Cody continues through workspace listing, read, and completion decisions");

  const events = app.composition.taskEvents.get(taskId as unknown as TaskId)!;
  const groupEvent = events.find(event => event.type === "worker.progress" && event.workerDefinitionId === "doc"
    && /published shared finding/i.test(event.message ?? ""));
  const codyRead = events.find(event => event.type === "tool.completed" && event.workerDefinitionId === "cody" && event.toolName === "filesystem.read");
  assert.ok(groupEvent, "the actual group publication is attributed to Doc in the execution event stream");
  assert.ok(codyRead, "Cody invokes its authorized filesystem tool after receiving the finding");
  const taskView = await request(app, "GET", `/api/tasks/${taskId}`);
  const codyEvents = taskView.json.task.events as Array<{ id: string; type: string; toolName?: string; workerDefinitionId?: string }>;
  assert.ok(codyEvents.some(event => event.id === codyRead.id && event.type === "tool.completed"),
    "Cody's individual task view replays the same tool evidence identity");
  assert.ok(codyEvents.some(event => event.type === "worker.progress" && event.workerDefinitionId === "cody"
    && /received shared finding from doc/i.test((event as { message?: string }).message ?? "")),
  "Cody's individual workspace event history records the attributed peer finding");
  const docHistory = await request(app, "GET", "/api/specialists/doc/group-history");
  const group = (docHistory.json.groups as Array<{ taskId: string; messages: Array<{ senderSpecialistId: string; content: string; sequenceNumber: number }> }>)
    .find(item => item.taskId === taskId);
  const finding = group?.messages.find(message => message.senderSpecialistId === "doc" && /local configuration file/i.test(message.content));
  assert.ok(finding, "Doc's explicitly model-authored finding is durably available to its authorized workspace");
  assert.ok(finding.sequenceNumber > 0);

  const streamed = await turnEvents(app, "org-thread", "org-turn");
  assert.ok(streamed.some(event => event.type === "turn.snapshot"
    && event.payload?.turn?.items?.some((item: { type?: string; actor?: { mediobotId?: string }; text?: string }) =>
      item.type === "activity" && item.actor?.mediobotId === "doc" && /published shared finding/i.test(item.text ?? ""))),
  "Main Chat event replay exposes the same attributed collaboration activity in the turn snapshot");
  const streamedItems = streamed.flatMap(event => event.type === "turn.snapshot" ? event.payload?.turn?.items ?? [] : []) as Array<{ type?: string; text?: string }>;
  assert.equal(streamedItems.some(item => /^(?:Cody|Doc|Worker) progress\.?$/i.test(item.text ?? "")), false,
    "generic progress text is not projected into Main Chat");
  assert.ok(streamedItems.some(item => item.type === "tool_execution"), "Main Chat replay includes actual tool execution");
  const transcript = await request(app, "GET", "/api/threads/org-thread");
  const transcriptItems = transcript.json.thread.turns[0].items as Array<{ type: string; text?: string }>;
  assert.equal(transcriptItems.some(item => /^(?:Cody|Doc|Worker) progress\.?$/i.test(item.text ?? "")), false,
    "generic progress text is not persisted in the Main Chat transcript");
  const final = transcriptItems.filter(item => item.type === "agent_message").at(-1);
  assert.match(final?.text ?? "", /Doc published a shared finding/);
  assert.match(final?.text ?? "", /Cody read project\.txt/);
});

test("/api/turns returns real selected-workspace filenames after bounded Cody decision recovery", { timeout: 15000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-list-turn-"));
  writeFileSync(path.join(root, "alpha.txt"), "alpha");
  writeFileSync(path.join(root, "beta.ts"), "beta");
  writeFileSync(path.join(root, ".env"), "must not be disclosed");
  const { providerRepo, database } = makeProvider(root);
  let codyCalls = 0;
  const resolver = new ModelResolver(providerRepo, {
    createClient: () => ({ complete: async ({ input }: { input: string }) => {
      const data = JSON.parse(input) as Record<string, unknown>;
      if (typeof data.goal === "string" && Array.isArray(data.recentToolHistory)) {
        codyCalls += 1;
        if (codyCalls === 1) return '{"name":"filesystem.list","arguments":{"path":"."}}';
        if (codyCalls === 2) return '<think>private reasoning</think>\nUse this action:\n```json\n{"type":"list","path":"."}\n```';
        const history = data.recentToolHistory as Array<{ result: string }>;
        const observed = history.at(-1)?.result ?? "";
        assert.match(observed, /alpha\.txt/);
        assert.match(observed, /beta\.ts/);
        assert.doesNotMatch(observed, /\.env/);
        return JSON.stringify({ type: "finish", summary: `Files observed in selected project: ${observed}` });
      }
      const available = data.availableMediobots as Array<{ definitionId: string; role: string }>;
      const cody = available.find((worker) => worker.role === "coding")!;
      return JSON.stringify({ type: "delegate", definitionId: cody.definitionId,
        objective: "List the actual files in the open project folder", relevantContextRefs: [], constraints: [],
        expectedOutcome: "Report filenames returned by the filesystem tool", evidenceExpectations: [] });
    } }),
  });
  const app = await startCommandCenter({ databasePath: path.join(root, "mediobot.db"), providerRepository: providerRepo,
    modelResolver: resolver, workspaceRoot: root, vite: false, listen: false });
  t.after(async () => { await app.close(); database.close(); rmSync(root, { recursive: true, force: true }); });

  const response = await request(app, "POST", "/api/turns", { threadId: "list-thread", turnId: "list-turn",
    prompt: "What are all the files in the folder?", modelSelection: { providerConnectionId: "selected-provider", modelId: "selected-model" } });
  assert.equal(response.status, 202);
  assert.equal(await awaitTaskCompletion(app, response.json.taskId as string), "task.completed");
  assert.equal(codyCalls, 3, "one malformed response is repaired, then list and finish use the normal Cody loop");
  const saved = await request(app, "GET", "/api/threads/list-thread");
  const turn = saved.json.thread.turns[0] as { items: Array<{ type: string; text?: string }> };
  const final = turn.items.find((item) => item.type === "agent_message" && item.text?.includes("Files observed"));
  assert.ok(final);
  assert.match(final.text ?? "", /alpha\.txt/);
  assert.match(final.text ?? "", /beta\.ts/);
  assert.doesNotMatch(final.text ?? "", /No successful check command was recorded/,
    "the Main Chat synthesis must not impose a code-check requirement on this file-listing request");
  assert.doesNotMatch(final.text ?? "", /\.env|private reasoning/);
});

// ---------------------------------------------------------------------------
// 2. Failed Cody execution → task.failed; turn persisted as failed
// ---------------------------------------------------------------------------
test("failed Cody model → task.failed → turn persisted as failed, not completed", { timeout: 10000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-cody-fail-"));
  writeFileSync(path.join(root, "target.txt"), "content");
  const { providerRepo, database } = makeProvider(root);

  const resolver = new ModelResolver(providerRepo, {
    createClient: () => ({
      complete: async ({ input }: { input: string; system: string }) => {
        const data = JSON.parse(input) as Record<string, unknown>;

        if (typeof data.goal === "string" && Array.isArray(data.recentToolHistory)) {
          // Cody model always throws → execution fails
          throw new Error("Controlled model failure");
        }

        // Maestro planning — delegate to Cody
        const meds = data.availableMediobots as Array<{ definitionId: string; role: string }>;
        const cody = meds.find((m) => m.role === "coding")!;
        return JSON.stringify({
          type: "delegate",
          definitionId: cody.definitionId,
          objective: "Update target.txt",
          relevantContextRefs: ["target.txt"],
          constraints: [],
          expectedOutcome: "target.txt updated",
          evidenceExpectations: [],
        });
      },
    }),
  });

  const app = await startCommandCenter({
    databasePath: path.join(root, "mediobot.db"),
    providerRepository: providerRepo,
    modelResolver: resolver,
    workspaceRoot: root,
    vite: false,
    listen: false,
  });
  t.after(async () => { await app.close(); database.close(); rmSync(root, { recursive: true, force: true }); });

  const selection = { providerConnectionId: "selected-provider", modelId: "selected-model" };
  const response = await request(app, "POST", "/api/turns", {
    threadId: "fail-thread", turnId: "fail-turn", prompt: "Update target.txt", modelSelection: selection,
  });
  assert.equal(response.status, 202);
  const taskId = response.json.taskId as string;

  const terminal = await awaitTaskCompletion(app, taskId);
  assert.equal(terminal, "task.failed", "Failed Cody model must produce task.failed, not task.completed");

  // File unchanged — no successful write occurred
  assert.equal(readFileSync(path.join(root, "target.txt"), "utf8"), "content", "File must not be modified after Cody failure");

  // Preserve a truthful final failure report without labeling the task complete.
  const snapshot = app.composition.world.inspect();
  const maestroResponses = snapshot.evidence.filter((e) => e.source.type === "maestro-response" && e.taskId === taskId);
  assert.equal(maestroResponses.length, 1, "Maestro should preserve a truthful failure summary in the task record");
  assert.match(maestroResponses[0]!.content, /"status":"failed"/i);
  assert.doesNotMatch(maestroResponses[0]!.content, /task completed|goal satisfied|verified successfully/i);

  // Persisted turn reflects failure
  const saved = await request(app, "GET", "/api/threads/fail-thread");
  const turn = saved.json.thread.turns[0] as { status: string; items: Array<{ type: string }> };
  assert.equal(turn.status, "failed", "Turn must be persisted as failed");
  const maestroFailure = turn.items.filter((item) => item.type === "agent_message" && "actor" in item
    && (item as { actor?: { name?: string } }).actor?.name === "Maestro").at(-1);
  assert.ok(maestroFailure, "Maestro must give a truthful terminal response after Cody fails");
  assert.match((maestroFailure as { text?: string }).text ?? "", /No specialist assignment completed|Cody did not complete|Maestro could not complete the task/i);
  assert.ok(
    turn.items.some((item) => item.type === "agent_message"),
    "Failed turn must include an error message item",
  );
});

// ---------------------------------------------------------------------------
// 3. Workspace isolation: workspaceRoot baked at submission; other workspace unaffected
// ---------------------------------------------------------------------------
test("in-flight Cody task writes only to the submission-time workspace root", { timeout: 10000 }, async (t) => {
  const root1 = mkdtempSync(path.join(os.tmpdir(), "mediobot-ws1-"));
  const root2 = mkdtempSync(path.join(os.tmpdir(), "mediobot-ws2-"));
  writeFileSync(path.join(root1, "target.txt"), "workspace one");
  writeFileSync(path.join(root2, "target.txt"), "workspace two");
  const { providerRepo, database } = makeProvider(root1);

  let capturedDecisionRoot: string | undefined;
  let codyStep = 0;

  const resolver = new ModelResolver(providerRepo, {
    createClient: () => ({
      complete: async ({ input }: { input: string; system: string }) => {
        const data = JSON.parse(input) as Record<string, unknown>;

        if (typeof data.goal === "string" && Array.isArray(data.recentToolHistory)) {
          codyStep += 1;
          if (codyStep === 1) return JSON.stringify({ type: "read", path: "target.txt" });
          if (codyStep === 2) return JSON.stringify({ type: "write", path: "target.txt", content: "written by cody" });
          if (codyStep === 3) return JSON.stringify({ type: "run", command: "node", args: ["-e", "process.exit(0)"], verification: "node exits 0" });
          return JSON.stringify({ type: "finish", summary: "Done" });
        }

        const meds = data.availableMediobots as Array<{ definitionId: string; role: string }>;
        const cody = meds.find((m) => m.role === "coding")!;
        capturedDecisionRoot = (data.workspaceState as Record<string, unknown>)?.rootPath as string | undefined;
        return JSON.stringify({
          type: "delegate",
          definitionId: cody.definitionId,
          objective: "Update target.txt",
          relevantContextRefs: ["target.txt"],
          constraints: [],
          expectedOutcome: "target.txt updated",
          evidenceExpectations: [],
        });
      },
    }),
  });

  const app = await startCommandCenter({
    databasePath: path.join(root1, "mediobot.db"),
    providerRepository: providerRepo,
    modelResolver: resolver,
    workspaceRoot: root1,
    vite: false,
    listen: false,
  });
  t.after(async () => {
    await app.close();
    database.close();
    rmSync(root1, { recursive: true, force: true });
    rmSync(root2, { recursive: true, force: true });
  });

  const selection = { providerConnectionId: "selected-provider", modelId: "selected-model" };
  const response = await request(app, "POST", "/api/turns", {
    threadId: "ws-thread", turnId: "ws-turn", prompt: "Update target.txt", modelSelection: selection,
  });
  assert.equal(response.status, 202);
  const terminal = await awaitTaskCompletion(app, response.json.taskId as string);
  assert.equal(terminal, "task.completed");

  // Write landed in root1 only — root2 is unaffected
  assert.equal(readFileSync(path.join(root1, "target.txt"), "utf8"), "written by cody");
  assert.equal(readFileSync(path.join(root2, "target.txt"), "utf8"), "workspace two");
  // Maestro's planning context referenced root1 (workspace manager canonicalises via realpathSync)
  assert.equal(capturedDecisionRoot, realpathSync(root1));
});

test("a persisted project conversation cannot silently execute against another active workspace", { timeout: 10000 }, async (t) => {
  const rootA = mkdtempSync(path.join(os.tmpdir(), "mediobot-thread-project-a-"));
  const rootB = mkdtempSync(path.join(os.tmpdir(), "mediobot-thread-project-b-"));
  const { providerRepo, database } = makeProvider(rootB);
  let modelCalls = 0;
  const resolver = new ModelResolver(providerRepo, { createClient: () => ({ complete: async () => { modelCalls += 1; return '{"type":"respond","message":"unexpected","basis":"conversation","evidenceRefs":[]}'; } }) });
  const app = await startCommandCenter({ databasePath: path.join(rootB, "mediobot.db"), providerRepository: providerRepo,
    modelResolver: resolver, workspaceRoot: rootA, vite: false, listen: false });
  t.after(async () => { await app.close(); database.close(); rmSync(rootA, { recursive: true, force: true }); rmSync(rootB, { recursive: true, force: true }); });

  const sessionA = app.workspaceManager.session!;
  await app.history.saveMetadata({ id: "project-a-thread", projectId: sessionA.workspaceId, title: "Project A" });
  const sessionB = await app.workspaceManager.openWorkspace(rootB);
  assert.notEqual(sessionA.workspaceId, sessionB.workspaceId);

  const response = await request(app, "POST", "/api/turns", { threadId: "project-a-thread", turnId: "wrong-project-turn",
    prompt: "Inspect the currently open project", projectId: sessionA.workspaceId,
    modelSelection: { providerConnectionId: "selected-provider", modelId: "selected-model" } });
  assert.equal(response.status, 409);
  assert.equal(response.json.error.code, "project-workspace-mismatch");
  assert.equal(modelCalls, 0);
  const saved = await request(app, "GET", "/api/threads/project-a-thread");
  assert.equal(saved.json.thread.projectId, sessionA.workspaceId);
  assert.equal(saved.json.thread.turns.length, 0, "Rejected project switches do not persist an unexecuted prompt");
});
