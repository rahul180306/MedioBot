import assert from "node:assert/strict";
import test from "node:test";
import { Readable, Writable } from "node:stream";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TaskId } from "@mediobot-v2/domain";
import { startCommandCenter, summarizePreviousTurnExecution } from "../../src/server.ts";
import { LocalDatabase } from "../../src/storage/db.ts";
import { ProviderRepository } from "../../src/storage/providerRepository.ts";
import { ModelResolver } from "../../src/runtime/modelRegistry.ts";

class ResponseCapture extends Writable {
  statusCode = 200;
  output = "";
  onChunk?: () => void;
  writeHead(status: number) { this.statusCode = status; return this; }
  override _write(chunk: Buffer, _: BufferEncoding, callback: () => void) {
    this.output += chunk.toString();
    this.onChunk?.();
    callback();
  }
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
  return new Promise<string>((resolve) => {
    const listener = (event: { type: string }) => {
      if (["task.completed", "task.failed", "task.cancelled"].includes(event.type)) {
        resolve(event.type);
      }
    };
    const subs = app.composition.subscribers.get(id) ?? new Set();
    subs.add(listener);
    app.composition.subscribers.set(id, subs);
  });
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

// ---------------------------------------------------------------------------
// 1. Regression Test: Failed tool with a known error
// ---------------------------------------------------------------------------
test("Regression 1: Failed tool with a known error preserves stable identity, outcome, and safe category", { timeout: 15000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-reg1-"));
  writeFileSync(path.join(root, "calculator.js"), "module.exports = { add: (a, b) => a + b };");
  const { providerRepo, database } = makeProvider(root);

  let codyStep = 0;
  const resolver = new ModelResolver(providerRepo, {
    createClient: () => ({
      complete: async ({ input }: { input: string; system: string }) => {
        const data = JSON.parse(input) as Record<string, unknown>;

        if (typeof data.goal === "string" && Array.isArray(data.recentToolHistory)) {
          codyStep += 1;
          if (codyStep === 1) return JSON.stringify({ type: "read", path: "calculator.js" });
          if (codyStep === 2) {
            return JSON.stringify({
              type: "write",
              path: "calculator.js",
              content: "module.exports = { add: (a, b) => a + b, updated: true };",
            });
          }
          if (codyStep === 3) {
            // Invokes terminal with an absolute path which fails deterministically
            return JSON.stringify({
              type: "run",
              command: "/bin/sh",
              args: ["-c", "exit 1"],
            });
          }
          return JSON.stringify({ type: "finish", summary: "done" });
        }

        const meds = data.availableMediobots as Array<{ definitionId: string; role: string }>;
        const cody = meds.find((m) => m.role === "coding")!;
        return JSON.stringify({
          type: "delegate",
          definitionId: cody.definitionId,
          objective: "Run checks on calculator.js",
          relevantContextRefs: ["calculator.js"],
          constraints: [],
          expectedOutcome: "Checks verified",
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
    threadId: "reg1-thread", turnId: "reg1-turn", prompt: "Test calculator", modelSelection: selection,
  });
  assert.equal(response.status, 202);
  const taskId = response.json.taskId as string;
  const terminal = await awaitTaskCompletion(app, taskId);

  // Turn failed due to tool error
  const saved = await request(app, "GET", "/api/threads/reg1-thread");
  const turn = saved.json.thread.turns[0];
  assert.ok(turn, "Turn must be persisted");
  assert.equal(turn.status, "failed");

  // Find tool execution item
  const toolItem = turn.items.find((it: { type: string; tool?: { status: string; toolName: string } }) =>
    it.type === "tool_execution" && it.tool?.status === "failed"
  );
  assert.ok(toolItem, "Persisted turn must contain failed tool_execution item");
  assert.ok(toolItem.id, "Failed tool item must have stable identity");
  assert.equal(toolItem.tool.status, "failed");
  assert.ok(toolItem.tool.error, "Tool error must be recorded");
  assert.match(toolItem.tool.error, /Process exited with code 1|Absolute paths are not allowed/i);
  assert.ok(toolItem.tool.failureCategory, "Tool failure category must be present");
});

// ---------------------------------------------------------------------------
// 2. Regression Test: Failed tool with unavailable error
// ---------------------------------------------------------------------------
test("Regression 2: Failed step with unavailable error explicitly reports unavailable without inventing reasons", { timeout: 15000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-reg2-"));
  const { providerRepo, database } = makeProvider(root);

  const resolver = new ModelResolver(providerRepo, {
    createClient: () => ({
      complete: async ({ input }: { input: string }) => {
        const data = JSON.parse(input) as Record<string, unknown>;
        if (typeof data.goal === "string" && Array.isArray(data.recentToolHistory)) {
          // Model throws with empty message
          throw new Error("");
        }

        const meds = data.availableMediobots as Array<{ definitionId: string; role: string }>;
        const cody = meds.find((m) => m.role === "coding")!;
        return JSON.stringify({
          type: "delegate",
          definitionId: cody.definitionId,
          objective: "Fail silently",
          relevantContextRefs: [],
          constraints: [],
          expectedOutcome: "Nothing",
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
    threadId: "reg2-thread", turnId: "reg2-turn", prompt: "Fail with uncaptured error", modelSelection: selection,
  });
  assert.equal(response.status, 202);
  const taskId = response.json.taskId as string;
  await awaitTaskCompletion(app, taskId);

  const saved = await request(app, "GET", "/api/threads/reg2-thread");
  const turn = saved.json.thread.turns[0];
  assert.equal(turn.status, "failed");

  // Summary must indicate unavailable rather than inventing an explanation
  const summary = summarizePreviousTurnExecution(turn);
  assert.match(summary, /unavailable/i, "Summary must explicitly declare unavailable error details");
});

// ---------------------------------------------------------------------------
// 3. Regression Test: Successful write followed by failed verification
// ---------------------------------------------------------------------------
test("Regression 3: Successful write followed by failed verification preserves diff evidence and distinguishes partial changes", { timeout: 15000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-reg3-"));
  const calcPath = path.join(root, "calculator.js");
  writeFileSync(calcPath, "function add(a, b) { return 0; }\nmodule.exports = { add };");
  const { providerRepo, database } = makeProvider(root);

  let codyStep = 0;
  const resolver = new ModelResolver(providerRepo, {
    createClient: () => ({
      complete: async ({ input }: { input: string }) => {
        const data = JSON.parse(input) as Record<string, unknown>;

        if (typeof data.goal === "string" && Array.isArray(data.recentToolHistory)) {
          codyStep += 1;
          if (codyStep === 1) return JSON.stringify({ type: "read", path: "calculator.js" });
          if (codyStep === 2) {
            // Successful write
            return JSON.stringify({
              type: "write",
              path: "calculator.js",
              content: "function add(a, b) { return a + b; }\nmodule.exports = { add };",
            });
          }
          if (codyStep === 3) {
            // Failed verification command
            return JSON.stringify({
              type: "run",
              command: "node",
              args: ["-e", "process.exit(1)"],
              verification: "tests pass",
            });
          }
          return JSON.stringify({ type: "finish", summary: "Fixed calculator" });
        }

        const meds = data.availableMediobots as Array<{ definitionId: string; role: string }>;
        const cody = meds.find((m) => m.role === "coding")!;
        return JSON.stringify({
          type: "delegate",
          definitionId: cody.definitionId,
          objective: "Fix add function in calculator.js and verify",
          relevantContextRefs: ["calculator.js"],
          constraints: [],
          expectedOutcome: "calculator.js fixed and verified",
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
    threadId: "reg3-thread", turnId: "reg3-turn", prompt: "Fix calculator.js", modelSelection: selection,
  });
  assert.equal(response.status, 202);
  const taskId = response.json.taskId as string;
  await awaitTaskCompletion(app, taskId);

  // File was written on disk
  const contentOnDisk = readFileSync(calcPath, "utf8");
  assert.match(contentOnDisk, /return a \+ b/);

  // Load persisted turn
  const saved = await request(app, "GET", "/api/threads/reg3-thread");
  const turn = saved.json.thread.turns[0];

  // Diff must be preserved despite later failure!
  const diffItem = turn.items.find((it: { type: string }) => it.type === "diff");
  assert.ok(diffItem, "Diff item for calculator.js must be preserved in turn items");
  assert.equal(diffItem.diff.filePath, "calculator.js");

  // Summary must distinguish partial unverified changes
  const summary = summarizePreviousTurnExecution(turn);
  assert.match(summary, /Partial changes made to 1 file\(s\) \(calculator\.js\)/i);
  assert.doesNotMatch(summary, /No changes made/i);
});

// ---------------------------------------------------------------------------
// 4. Regression Test: Follow-up question after failure
// ---------------------------------------------------------------------------
test("Regression 4: Follow-up question after failure passes factual execution summary without asking user", { timeout: 15000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-reg4-"));
  const calcPath = path.join(root, "calculator.js");
  writeFileSync(calcPath, "function add(a, b) { return 0; }");
  const { providerRepo, database } = makeProvider(root);

  let codyStep = 0;
  let followUpEvidenceReceived: unknown;
  let followUpHistoryReceived: unknown;
  let followUpPromptReceived: string | undefined;
  let followUpMaestroInput: Record<string, unknown> | undefined;
  let followUpMaestroSystem = "";

  const resolver = new ModelResolver(providerRepo, {
    createClient: () => ({
      complete: async ({ input, system }: { input: string; system: string }) => {
        if (system.includes("MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER")) return JSON.stringify({ requiresCurrentProjectEvidence: false });
        const data = JSON.parse(input) as Record<string, unknown>;

        if (typeof data.goal === "string" && Array.isArray(data.recentToolHistory)) {
          codyStep += 1;
          if (codyStep === 1) return JSON.stringify({ type: "read", path: "calculator.js" });
          if (codyStep === 2) {
            return JSON.stringify({
              type: "write",
              path: "calculator.js",
              content: "function add(a, b) { return a + b; }",
            });
          }
          if (codyStep === 3) {
            // Fail via absolute path
            return JSON.stringify({ type: "run", command: "/bin/false", args: [] });
          }
          return JSON.stringify({ type: "finish", summary: "Fixed" });
        }

        // Maestro planning / follow-up
        if (data.relevantEvidence) {
          followUpEvidenceReceived = data.relevantEvidence;
        }
        if (data.recentHistory) followUpHistoryReceived = data.recentHistory;

        const userGoal = String(data.userGoal ?? data.prompt ?? "");
        followUpPromptReceived = userGoal;

        if (userGoal.includes("Why did you fail?")) {
          followUpMaestroInput = data;
          followUpMaestroSystem = system;
          const evidenceRefs = Array.isArray(data.relevantEvidence)
            ? (data.relevantEvidence as Array<{ id: string }>).map((entry) => entry.id)
            : [];
          // Maestro responds directly explaining why it failed using the provided evidence
          return JSON.stringify({
            type: "respond",
            message: "The previous turn failed because /bin/false failed with an absolute path error after modifying calculator.js.",
            basis: "project-evidence",
            evidenceRefs,
          });
        }

        const meds = data.availableMediobots as Array<{ definitionId: string; role: string }>;
        const cody = meds.find((m) => m.role === "coding")!;
        return JSON.stringify({
          type: "delegate",
          definitionId: cody.definitionId,
          objective: "Fix calculator.js",
          relevantContextRefs: ["calculator.js"],
          constraints: [],
          expectedOutcome: "Fixed",
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

  // Turn 1: Fails
  const res1 = await request(app, "POST", "/api/turns", {
    threadId: "reg4-thread", turnId: "reg4-turn-1", prompt: "Fix calculator.js", modelSelection: selection,
  });
  await awaitTaskCompletion(app, res1.json.taskId as string);

  // Turn 2: Follow-up asking why it failed
  const res2 = await request(app, "POST", "/api/turns", {
    threadId: "reg4-thread", turnId: "reg4-turn-2", prompt: "Why did you fail?", modelSelection: selection,
    recentHistory: [{ user: "STALE CLIENT HISTORY", assistant: "This is not the latest durable turn." }],
  });
  assert.ok([200, 202].includes(res2.status), "Direct response turn returns 200 or 202");

  assert.ok(followUpEvidenceReceived, "Maestro must receive relevantEvidence from previous failed turn");
  assert.ok(followUpHistoryReceived, "Maestro must receive conversation continuity from SQLite");
  assert.equal(followUpMaestroInput?.userGoal, "Why did you fail?");
  assert.match(String(followUpMaestroInput?.definitionInstructions), /You own the original goal and final synthesis/);
  assert.match(followUpMaestroSystem, /Structured runtimeState and permissions are authoritative/);
  const followUpWorkspace = followUpMaestroInput?.workspaceState as Record<string, unknown>;
  assert.equal(followUpWorkspace.workspaceId, app.workspaceManager.session?.workspaceId);
  assert.equal(followUpWorkspace.rootPath, realpathSync(root));
  assert.equal(followUpWorkspace.status, "OPEN");
  const followUpRoster = followUpMaestroInput?.availableMediobots as Array<{ definitionId: string; role: string; assignable: boolean; capabilities: string[] }>;
  assert.ok(followUpRoster.find((definition) => definition.role === "coding")?.assignable);
  assert.deepEqual([...(followUpMaestroInput?.assignableDefinitionIds as string[])].sort(),
    followUpRoster.filter((definition) => definition.assignable).map((definition) => definition.definitionId).sort());
  assert.match(JSON.stringify(followUpHistoryReceived), /Fix calculator\.js/);
  assert.doesNotMatch(JSON.stringify(followUpHistoryReceived), /STALE CLIENT HISTORY/);
  const evidenceArray = followUpEvidenceReceived as Array<{ content: string }>;
  assert.ok(evidenceArray.length > 0, "Evidence array must have at least one record");
  assert.match(evidenceArray[0]!.content, /calculator\.js/i, "Evidence must mention calculator.js");
  assert.match(evidenceArray[0]!.content, /failed/i, "Evidence must mention failed status");

  // Verify Maestro responded directly in Turn 2 without asking user
  const saved = await request(app, "GET", "/api/threads/reg4-thread");
  const turn2 = saved.json.thread.turns[1];
  assert.equal(turn2.status, "completed");
  const agentMsg = turn2.items.find((it: { type: string }) => it.type === "agent_message");
  assert.ok(agentMsg, "Maestro response must be saved");
  assert.match(agentMsg.text, /failed because/i);
  assert.doesNotMatch(agentMsg.text, /which tool failed/i, "Maestro must not ask user which tool failed");
});

// ---------------------------------------------------------------------------
// 5. Regression Test: Restart and reload of persisted failure evidence
// ---------------------------------------------------------------------------
test("Regression 5: Restart and reload of persisted failure evidence preserves full fidelity from SQLite", { timeout: 15000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-reg5-"));
  const calcPath = path.join(root, "calculator.js");
  writeFileSync(calcPath, "var x = 1;");
  const { providerRepo, database } = makeProvider(root);

  let codyStep = 0;
  const resolver = new ModelResolver(providerRepo, {
    createClient: () => ({
      complete: async ({ input }: { input: string }) => {
        const data = JSON.parse(input) as Record<string, unknown>;
        if (typeof data.goal === "string" && Array.isArray(data.recentToolHistory)) {
          codyStep += 1;
          if (codyStep === 1) return JSON.stringify({ type: "read", path: "calculator.js" });
          if (codyStep === 2) return JSON.stringify({ type: "write", path: "calculator.js", content: "var x = 2;" });
          if (codyStep === 3) return JSON.stringify({ type: "run", command: "/bin/sh", args: ["-c", "exit 1"] });
          return JSON.stringify({ type: "finish", summary: "done" });
        }
        const meds = data.availableMediobots as Array<{ definitionId: string; role: string }>;
        const cody = meds.find((m) => m.role === "coding")!;
        return JSON.stringify({
          type: "delegate",
          definitionId: cody.definitionId,
          objective: "Change x",
          relevantContextRefs: ["calculator.js"],
          constraints: [],
          expectedOutcome: "done",
          evidenceExpectations: [],
        });
      },
    }),
  });

  // App 1: Run and fail
  const app1 = await startCommandCenter({
    databasePath: path.join(root, "mediobot.db"),
    providerRepository: providerRepo,
    modelResolver: resolver,
    workspaceRoot: root,
    vite: false,
    listen: false,
  });

  const selection = { providerConnectionId: "selected-provider", modelId: "selected-model" };
  const res = await request(app1, "POST", "/api/turns", {
    threadId: "reg5-thread", turnId: "reg5-turn", prompt: "Change x to 2", modelSelection: selection,
  });
  await awaitTaskCompletion(app1, res.json.taskId as string);

  // Close app 1
  await app1.close();

  // App 2: Restart with the same database file
  const app2 = await startCommandCenter({
    databasePath: path.join(root, "mediobot.db"),
    providerRepository: providerRepo,
    modelResolver: resolver,
    workspaceRoot: root,
    vite: false,
    listen: false,
  });
  t.after(async () => { await app2.close(); database.close(); rmSync(root, { recursive: true, force: true }); });

  // Read persisted thread after restart
  const reloaded = await request(app2, "GET", "/api/threads/reg5-thread");
  const turn = reloaded.json.thread.turns[0];
  assert.equal(turn.status, "failed");

  // Diffs intact
  const diffItem = turn.items.find((it: { type: string }) => it.type === "diff");
  assert.ok(diffItem, "Diff item must survive database restart");
  assert.equal(diffItem.diff.filePath, "calculator.js");

  // Failed tool intact
  const failedTool = turn.items.find((it: { type: string; tool?: { status: string } }) =>
    it.type === "tool_execution" && it.tool?.status === "failed"
  );
  assert.ok(failedTool, "Failed tool item must survive database restart");
  assert.ok(failedTool.tool.error, "Tool error must survive database restart");

  // Previous turn execution summary can be derived cleanly from reloaded turn
  const summary = summarizePreviousTurnExecution(turn);
  assert.match(summary, /Partial changes made to 1 file\(s\) \(calculator\.js\)/i);
  assert.match(summary, /Failed tool/i);
});

// ---------------------------------------------------------------------------
// 6. Regression Test: Workspace isolation
// ---------------------------------------------------------------------------
test("Regression 6: Workspace isolation guarantees failure evidence and diffs stay strictly inside active workspace", { timeout: 15000 }, async (t) => {
  const rootA = mkdtempSync(path.join(os.tmpdir(), "mediobot-reg6-a-"));
  const rootB = mkdtempSync(path.join(os.tmpdir(), "mediobot-reg6-b-"));
  writeFileSync(path.join(rootA, "calculator.js"), "module.exports = { a: 1 };");
  writeFileSync(path.join(rootB, "calculator.js"), "module.exports = { b: 2 };");
  const { providerRepo, database } = makeProvider(rootA);

  let codyStep = 0;
  const resolver = new ModelResolver(providerRepo, {
    createClient: () => ({
      complete: async ({ input }: { input: string }) => {
        const data = JSON.parse(input) as Record<string, unknown>;
        if (typeof data.goal === "string" && Array.isArray(data.recentToolHistory)) {
          codyStep += 1;
          if (codyStep === 1) return JSON.stringify({ type: "read", path: "calculator.js" });
          if (codyStep === 2) return JSON.stringify({ type: "write", path: "calculator.js", content: "module.exports = { a: 99 };" });
          if (codyStep === 3) return JSON.stringify({ type: "run", command: "/bin/sh", args: ["-c", "exit 1"] });
          return JSON.stringify({ type: "finish", summary: "done" });
        }
        const meds = data.availableMediobots as Array<{ definitionId: string; role: string }>;
        const cody = meds.find((m) => m.role === "coding")!;
        return JSON.stringify({
          type: "delegate",
          definitionId: cody.definitionId,
          objective: "Change a",
          relevantContextRefs: ["calculator.js"],
          constraints: [],
          expectedOutcome: "done",
          evidenceExpectations: [],
        });
      },
    }),
  });

  const app = await startCommandCenter({
    databasePath: path.join(rootA, "mediobot.db"),
    providerRepository: providerRepo,
    modelResolver: resolver,
    workspaceRoot: rootA,
    vite: false,
    listen: false,
  });
  t.after(async () => {
    await app.close();
    database.close();
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });

  const selection = { providerConnectionId: "selected-provider", modelId: "selected-model" };
  const res = await request(app, "POST", "/api/turns", {
    threadId: "reg6-thread", turnId: "reg6-turn", prompt: "Modify workspace A", modelSelection: selection,
  });
  await awaitTaskCompletion(app, res.json.taskId as string);

  // Root B file must NOT be touched
  assert.equal(readFileSync(path.join(rootB, "calculator.js"), "utf8"), "module.exports = { b: 2 };");

  // Root A file was modified
  assert.equal(readFileSync(path.join(rootA, "calculator.js"), "utf8"), "module.exports = { a: 99 };");

  // Persisted turn in database reflects only workspace A
  const saved = await request(app, "GET", "/api/threads/reg6-thread");
  const turn = saved.json.thread.turns[0];
  const diffItem = turn.items.find((it: { type: string }) => it.type === "diff");
  assert.ok(diffItem);
  assert.equal(diffItem.diff.filePath, "calculator.js");
});
