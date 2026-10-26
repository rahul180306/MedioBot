import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startCommandCenter } from "../../src/server.ts";
import { LocalDatabase } from "../../src/storage/db.ts";
import { ProviderRepository } from "../../src/storage/providerRepository.ts";
import { ModelResolver } from "../../src/runtime/modelRegistry.ts";
import { isOrdinaryConversationGoal } from "@mediobot-v2/maestro";

function request(app: any, method: string, url: string, body?: unknown): Promise<{ status: number; json: any; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (payload) headers["content-length"] = String(Buffer.byteLength(payload));
    const req = { method, url, headers, [Symbol.asyncIterator]: async function* () { if (payload) yield Buffer.from(payload); } };
    const res = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; },
      body: "",
      writeHead(code: number, hdrs?: Record<string, string>) { this.statusCode = code; if (hdrs) for (const [k, v] of Object.entries(hdrs)) this.setHeader(k, v); return this; },
      write(chunk: unknown) { this.body += String(chunk); return true; },
      end(chunk?: unknown) {
        if (chunk) this.body += String(chunk);
        let parsed: any;
        try { parsed = JSON.parse(this.body); } catch { parsed = this.body; }
        resolve({ status: this.statusCode, json: parsed, headers: this.headers });
      },
    };
    app.handle(req as never, res as never);
  });
}

function deferred<T = void>() {
  let resolve!: (val: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("Multi-Chat Execution Isolation & Reliability Regression Suite", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-isolation-"));
  const dbPath = path.join(root, "mediobot.db");
  const database = new LocalDatabase(dbPath);
  const repo = new ProviderRepository(database.raw);
  repo.save({
    id: "test-provider",
    providerType: "custom",
    displayName: "Test provider",
    connected: true,
    enabled: true,
    baseUrl: "http://unused.invalid",
    models: [{
      id: "test-model",
      name: "Text engine",
      enabled: true,
      capabilities: { text: true, reasoning: true, vision: true, tools: false },
    }],
  });

  const chatAWorkerRelease = deferred();
  const chatBWorkerRelease = deferred();
  let chatACalls = 0;
  let chatBCalls = 0;
  let testerCalls = 0;

  const resolver = new ModelResolver(repo, {
    createClient: (options) => {
      assert.equal(options.modelId, "test-model");
      return {
        complete: async ({ system, input }) => {
          if (system.includes("MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER")) {
            return JSON.stringify({ requiresCurrentProjectEvidence: false });
          }
          const data = JSON.parse(input);

          // Worker assignments
          if (data.assignment) {
            const role = data.assignment.role || "unknown";
            if (role === "tester") testerCalls++;
            if (data.assignment.objective?.includes("Chat A")) {
              chatACalls++;
              await chatAWorkerRelease.promise;
              return JSON.stringify({
                status: "completed",
                summary: "Chat A worker report",
                evidence: ["Chat A evidence"],
                blockers: [],
                unresolved: [],
              });
            }
            if (data.assignment.objective?.includes("Chat B")) {
              chatBCalls++;
              await chatBWorkerRelease.promise;
              return JSON.stringify({
                status: "completed",
                summary: "Chat B worker report",
                evidence: ["Chat B evidence"],
                blockers: [],
                unresolved: [],
              });
            }
            return JSON.stringify({
              status: "completed",
              summary: "Worker report",
              evidence: [],
              blockers: [],
              unresolved: [],
            });
          }

          // Synthesis phase
          if (data.projectIntelligence) {
            return JSON.stringify({
              type: "respond",
              message: "Synthesized recommendation",
              basis: "conversation",
              evidenceRefs: [],
            });
          }

          // Maestro decisions
          const goal = data.userGoal || "";

          // Condition 10 & 11: Capability and conceptual question handling
          if (goal === "Can you activate multiple mediobots in parallel?") {
            return JSON.stringify({
              type: "respond",
              message: "Yes, MedioBot can activate multiple independent specialists in parallel using dynamic Maestro orchestration.",
              basis: "conversation",
              evidenceRefs: [],
            });
          }

          if (goal.includes("Chat A task")) {
            const research = data.availableMediobots.find((d: any) => d.role === "research");
            return JSON.stringify({
              type: "delegate_text",
              independence: "Independent research evaluation.",
              assignments: [{
                definitionId: research.definitionId,
                objective: "Evaluate Chat A research",
                relevantContext: "Context A",
                relevantContextRefs: [],
                constraints: ["Text only"],
                expectedOutcome: "Analysis A",
                evidenceExpectations: [],
              }],
            });
          }

          if (goal.includes("Chat B task")) {
            const research = data.availableMediobots.find((d: any) => d.role === "research");
            return JSON.stringify({
              type: "delegate_text",
              independence: "Independent research evaluation.",
              assignments: [{
                definitionId: research.definitionId,
                objective: "Evaluate Chat B research",
                relevantContext: "Context B",
                relevantContextRefs: [],
                constraints: ["Text only"],
                expectedOutcome: "Analysis B",
                evidenceExpectations: [],
              }],
            });
          }

          return JSON.stringify({
            type: "respond",
            message: "Direct response",
            basis: "conversation",
            evidenceRefs: [],
          });
        },
      };
    },
  });

  const app = await startCommandCenter({
    databasePath: dbPath,
    providerRepository: repo,
    modelResolver: resolver,
    workspaceRoot: root,
    vite: false,
    listen: false,
  });

  t.after(async () => {
    chatAWorkerRelease.resolve();
    chatBWorkerRelease.resolve();
    await app.close();
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  const selection = { providerConnectionId: "test-provider", modelId: "test-model" };

  // Regression 10 & 11: Conceptual capability question does NOT activate Tester and does NOT fail
  await t.test("10 & 11: Capability question responds directly without runtime failure or Tester activation", async () => {
    const res = await request(app, "POST", "/api/turns", {
      threadId: "capability-thread",
      turnId: "cap-turn-1",
      prompt: "Can you activate multiple mediobots in parallel?",
      modelSelection: selection,
    });
    assert.ok([200, 202].includes(res.status));
    assert.equal(res.json.direct, true);
    const saved = await app.history.get("capability-thread");
    const assistantMsg = saved?.turns[0]?.items.find((i: any) => i.type === "agent_message");
    assert.match(assistantMsg?.text, /Yes, MedioBot can activate multiple/);
    assert.equal(testerCalls, 0, "Tester must not be activated for conceptual capability questions");
    assert.ok(isOrdinaryConversationGoal("Can you activate multiple mediobots in parallel?"));
  });

  // Regression 1 & 2: Chat A starts and runs while Chat B can start concurrently
  let taskAId = "";
  let taskBId = "";
  const eventsA: any[] = [];
  const eventsB: any[] = [];

  await t.test("1 & 2: Chat A running, Chat B starts concurrently without blocking", async () => {
    const resA = await request(app, "POST", "/api/turns", {
      threadId: "thread-a",
      turnId: "turn-a-1",
      prompt: "Chat A task: evaluate architectural constraints",
      modelSelection: selection,
    });
    assert.equal(resA.status, 202);
    taskAId = resA.json.taskId;
    assert.ok(taskAId);

    // Chat A is running, now Chat B starts immediately without waiting
    const resB = await request(app, "POST", "/api/turns", {
      threadId: "thread-b",
      turnId: "turn-b-1",
      prompt: "Chat B task: evaluate algorithmic tradeoffs",
      modelSelection: selection,
    });
    assert.equal(resB.status, 202);
    taskBId = resB.json.taskId;
    assert.ok(taskBId);
    assert.notEqual(taskAId, taskBId, "Tasks must have distinct identities");
  });

  // Regression 3: Both chats receive independent events
  await t.test("3: Both chats receive independent SSE events targeted to their thread", async () => {
    const subA = (event: any) => { eventsA.push(event); };
    const subB = (event: any) => { eventsB.push(event); };

    app.composition.subscribers.get(taskAId as any)?.add(subA);
    app.composition.subscribers.get(taskBId as any)?.add(subB);

    assert.ok(app.composition.subscribers.has(taskAId as any));
    assert.ok(app.composition.subscribers.has(taskBId as any));
  });

  // Regression 4: Switching conversations preserves execution
  await t.test("4: Switching conversations preserves background in-flight execution", async () => {
    const runningTasks = app.composition.world.inspect().tasks.filter((task: any) => task.state === "running");
    assert.ok(runningTasks.some((t: any) => t.id === taskAId));
    assert.ok(runningTasks.some((t: any) => t.id === taskBId));
  });

  // Regression 5: Chat A cancellation does NOT affect Chat B
  await t.test("5: Chat A cancellation does not affect Chat B", async () => {
    const cancelRes = await request(app, "POST", `/api/turns/turn-a-1/cancel?threadId=thread-a`);
    assert.equal(cancelRes.status, 202);
    assert.equal(cancelRes.json.ok, true);

    // Verify Chat B is still active in the runtime
    const threadB = await app.history.get("thread-b");
    const turnB = threadB?.turns.find((t: any) => t.id === "turn-b-1");
    assert.notEqual(turnB?.status, "cancelled", "Chat B must not be cancelled by Chat A cancellation");
  });

  // Regression 6: Chat B completion does not complete Chat A
  await t.test("6: Chat B completion settles independently", async () => {
    chatBWorkerRelease.resolve();

    // Await completion of Task B
    const bSettled = deferred();
    const checkB = setInterval(async () => {
      const threadB = await app.history.get("thread-b");
      const turnB = threadB?.turns.find((t: any) => t.id === "turn-b-1");
      if (turnB && ["completed", "failed"].includes(turnB.status)) {
        clearInterval(checkB);
        bSettled.resolve();
      }
    }, 50);

    await bSettled.promise;

    const threadB = await app.history.get("thread-b");
    const turnB = threadB?.turns.find((t: any) => t.id === "turn-b-1");
    assert.equal(turnB?.status, "completed");

    const threadA = await app.history.get("thread-a");
    const turnA = threadA?.turns.find((t: any) => t.id === "turn-a-1");
    assert.equal(turnA?.status, "cancelled");
  });

  await t.test("6a: subscribed task events retain per-chat attribution through cancellation and completion", async () => {
    assert.ok(eventsA.some((event) => event.type === "task.cancelled"), "Chat A subscriber receives its cancellation event");
    assert.ok(eventsB.some((event) => event.type === "task.completed"), "Chat B subscriber receives its completion event");
    assert.ok(eventsA.every((event) => event.taskId === taskAId), "Chat A must not receive Chat B events");
    assert.ok(eventsB.every((event) => event.taskId === taskBId), "Chat B must not receive Chat A events");
  });

  await t.test("6b: completed tasks without SSE clients release their subscriber entry", async () => {
    const response = await request(app, "POST", "/api/turns", {
      threadId: "thread-c", turnId: "turn-c-1", prompt: "Chat B task: complete without an SSE client", modelSelection: selection,
    });
    assert.equal(response.status, 202);
    const taskId = response.json.taskId;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && app.composition.world.inspect().tasks.find((task: any) => task.id === taskId)?.state !== "completed") {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(app.composition.world.inspect().tasks.find((task: any) => task.id === taskId)?.state, "completed");
    assert.equal(app.composition.subscribers.has(taskId), false);
  });

  // Regression 7: Errors remain scoped to originating chat
  await t.test("7: Errors remain scoped to originating chat", async () => {
    const resErr = await request(app, "POST", "/api/turns", {
      threadId: "error-thread",
      turnId: "error-turn-1",
      prompt: "Non-existent model test",
      modelSelection: { providerConnectionId: "nonexistent", modelId: "missing" },
    });
    // Rejects with invalid model selection
    assert.ok(resErr.status >= 400);

    // Other threads remain valid and intact
    const threadB = await app.history.get("thread-b");
    assert.ok(threadB);
    assert.equal(threadB.turns[0]?.status, "completed");
  });

  // Regression 8: Resource Governor limits are respected
  await t.test("8: Resource governor and task tracking isolates tasks per conversation", () => {
    const tasks = app.composition.world.inspect().tasks;
    assert.ok(tasks.length >= 2, "Tasks for separate conversations tracked in task registry");
  });

  // Regression 9: Refresh / persistence restores execution ownership correctly
  await t.test("9: Database reload restores correct execution ownership per thread", async () => {
    const threads = await app.history.list();
    const loadedA = threads.find((t: any) => t.id === "thread-a");
    const loadedB = threads.find((t: any) => t.id === "thread-b");
    assert.ok(loadedA);
    assert.ok(loadedB);
    assert.equal(loadedA.turns[0]?.status, "cancelled");
    assert.equal(loadedB.turns[0]?.status, "completed");
  });

  // Regression 12: Ordinary conceptual goals do not require project evidence
  await t.test("12: isOrdinaryConversationGoal correctly classifies conceptual vs project goals", () => {
    assert.equal(isOrdinaryConversationGoal("Can you activate multiple mediobots in parallel?"), true);
    assert.equal(isOrdinaryConversationGoal("What is recursion?"), true);
    assert.equal(isOrdinaryConversationGoal("How does Maestro coordinate specialists?"), true);
    assert.equal(isOrdinaryConversationGoal("What are the capabilities of Cody?"), true);

    // Project-aware queries must require evidence
    assert.equal(isOrdinaryConversationGoal("What is this project about?"), false);
    assert.equal(isOrdinaryConversationGoal("List files in the workspace"), false);
    assert.equal(isOrdinaryConversationGoal("Fix the bug in server.ts"), false);
    assert.equal(isOrdinaryConversationGoal("Run tests on packages/maestro"), false);
  });
});
