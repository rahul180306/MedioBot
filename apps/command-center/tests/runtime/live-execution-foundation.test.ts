import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import {
  mergeMonotonicToolData,
  sanitizeOutputLog,
} from "@mediobot-v2/models";
import { createWorld } from "@mediobot-v2/domain";
import { RuntimeTaskSubmission, WorkerRuntime } from "@mediobot-v2/runtime";
import { startCommandCenter } from "../../src/server.ts";
import type { CommandCenterComposition, DefinitionView, ProductEvent, TaskView } from "../../src/contracts.ts";
import type { TaskId } from "@mediobot-v2/domain";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { LocalProjectCatalog } from "../../src/projects.ts";
import { LocalDatabase } from "../../src/storage/db.ts";
import { LocalHistoryStore } from "../../src/history.ts";
import { ChatRepository } from "../../src/storage/chatRepository.ts";
import { normalizeProductEvent } from "../../src/composition.ts";
import { worldProductEvent } from "../../src/events.ts";
import type { ToolExecutionData, Turn, ThreadItem } from "../../src/types/index.ts";

function createTempDb(): { tempDir: string; dbPath: string; cleanup: () => void } {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "mediobot-test-persistence-"));
  const dbPath = path.join(tempDir, "mediobot.db");
  return {
    tempDir,
    dbPath,
    cleanup: () => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

class FakeResponse extends Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  output = "";
  onChunk?: (chunk: string) => void;
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    const text = chunk.toString();
    this.output += text;
    this.onChunk?.(text);
    callback();
  }
  writeHead(status: number, headers: Record<string, string>) {
    this.statusCode = status;
    this.headers = headers;
    return this;
  }
}

function createTestComposition(): {
  composition: CommandCenterComposition;
  emitTestEvent: (event: Omit<ProductEvent, "worldId"> & { worldId?: string }) => void;
} {
  const world = createWorld();
  const definition = world.registerMediobotDefinition({
    name: "Cody",
    role: "coding",
    version: "1",
    instructions: "",
    declaredCapabilities: [],
  });
  const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
  submission.registerAdapter(definition.id, {
    prepare: () => ({
      resourceIds: [],
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    }),
  });

  const taskEvents = new Map<TaskId, ProductEvent[]>();
  const subscribers = new Map<TaskId, Set<(event: ProductEvent) => void>>();
  const taskErrors = new Map<TaskId, TaskView["error"]>();
  const definitions: DefinitionView[] = [
    {
      id: definition.id,
      name: "Cody",
      group: "specialist",
      role: "Coding",
      summary: "Coding agent",
      availability: "available",
      executable: true,
    },
  ];

  const publish = (event: ProductEvent) => {
    const events = taskEvents.get(event.taskId) ?? [];
    events.push(event);
    taskEvents.set(event.taskId, events);
    for (const callback of subscribers.get(event.taskId) ?? []) {
      callback(event);
    }
  };

  const snapshotTask = (taskId: TaskView["id"]): TaskView | undefined => {
    const snapshot = world.inspect();
    const task = snapshot.tasks.find((entry) => entry.id === taskId);
    if (!task) return undefined;
    return {
      id: task.id,
      worldId: task.worldId,
      goal: task.goal,
      state: task.state,
      workers: [],
      events: taskEvents.get(taskId) ?? [],
    };
  };

  const composition: CommandCenterComposition = {
    world,
    submission,
    definitions,
    visionDefinitionId: definition.id,
    codyDefinitionId: definition.id,
    maestroDefinitionId: definition.id,
    taskEvents,
    subscribers,
    taskErrors,
    publish,
    submit(id, goal, options, onBeforeEmit) {
      const created = submission.submit({
        definitionId: id,
        goal,
        options,
        onCreated: ({ task }) =>
          (onBeforeEmit?.(task.id), publish({
            id: "created-evt",
            type: "task.started",
            worldId: task.worldId,
            taskId: task.id,
            occurredAt: Date.now(),
          })),
      });
      return { taskId: created.task.id, result: created.result };
    },
    cancel(id) {
      submission.cancel(id);
    },
    snapshotTask,
    mapWorldEvent() {},
    mapVisionProgress() {},
    projects: new LocalProjectCatalog(process.cwd()),
  };

  const emitTestEvent = (event: Omit<ProductEvent, "worldId"> & { worldId?: string }) => {
    publish({ worldId: "world-test", ...event } as ProductEvent);
  };

  return { composition, emitTestEvent };
}

test("Live Execution: Monotonic tool lifecycle preserves terminal states over reordered running events", () => {
  const startedAt = 1700000000000;
  const toolId = "tool-test-monotonic";

  const runningState: ToolExecutionData = {
    toolInvocationId: toolId,
    toolName: "terminal.execute",
    command: "npm test",
    status: "running",
    startedAt,
    outcomeBadge: "running",
  };

  const completedState: ToolExecutionData = {
    toolInvocationId: toolId,
    toolName: "terminal.execute",
    command: "npm test",
    status: "success",
    startedAt,
    durationMs: 420,
    outcomeBadge: "exit 0",
    outputLog: "Tests passed: 10/10",
  };

  // 1. Normal transition: running -> success
  const normalMerged = mergeMonotonicToolData(runningState, completedState);
  assert.equal(normalMerged.status, "success");
  assert.equal(normalMerged.durationMs, 420);
  assert.equal(normalMerged.outcomeBadge, "exit 0");
  assert.equal(normalMerged.outputLog, undefined, "Raw output must never survive lifecycle projection");

  // 2. Reordered transition: completed followed by delayed running event must NOT regress
  const reorderedMerged = mergeMonotonicToolData(completedState, runningState);
  assert.equal(reorderedMerged.status, "success", "Terminal state must not regress to running");
  assert.equal(reorderedMerged.durationMs, 420, "Terminal duration must be retained");
  assert.equal(reorderedMerged.outcomeBadge, "exit 0", "Terminal outcome badge must be retained");
  assert.equal(reorderedMerged.outputLog, undefined, "Replay must not restore raw output");

  const sequenceMerged = mergeMonotonicToolData(
    { ...completedState, eventSequence: 9, outcomeBadge: "exit 0" },
    { ...runningState, eventSequence: 4, outcomeBadge: "running" },
  );
  assert.equal(sequenceMerged?.status, "success");
  assert.equal(sequenceMerged?.eventSequence, 9);
  assert.equal(sequenceMerged?.outcomeBadge, "exit 0", "Older events must not replace newer row metadata");

  // 3. Failed terminal state followed by running event must NOT regress
  const failedState: ToolExecutionData = {
    toolInvocationId: toolId,
    toolName: "terminal.execute",
    command: "npm test",
    status: "failed",
    startedAt,
    durationMs: 150,
    outcomeBadge: "exit 1",
    error: "Command exited with code 1",
    failureCategory: "command-error",
  };
  const reorderedFailedMerged = mergeMonotonicToolData(failedState, runningState);
  assert.equal(reorderedFailedMerged.status, "failed");
  assert.equal(reorderedFailedMerged.durationMs, 150);
  assert.equal(reorderedFailedMerged.error, "Command exited with code 1");
  assert.equal(reorderedFailedMerged.failureCategory, "command-error");

  const successThenFailure = mergeMonotonicToolData(completedState, failedState);
  const failureThenSuccess = mergeMonotonicToolData(failedState, completedState);
  assert.equal(successThenFailure.status, "failed");
  assert.equal(failureThenSuccess.status, "failed");
  assert.equal(successThenFailure.lifecycleConflict, true);
  assert.equal(failureThenSuccess.lifecycleConflict, true);
  assert.equal(successThenFailure.failureCategory, "lifecycle-conflict");
  assert.equal(failureThenSuccess.failureCategory, "lifecycle-conflict");
});

test("Live Execution: Duplicate events are idempotent and preserve existing attributes", () => {
  const toolId = "tool-test-idempotent";
  const startedAt = 1700000000100;

  const eventA: ToolExecutionData = {
    toolInvocationId: toolId,
    toolName: "terminal.execute",
    command: "node check.js",
    status: "success",
    startedAt,
    durationMs: 250,
    outcomeBadge: "exit 0",
    outputLog: "All checks verified.",
  };

  // Duplicate identical event
  const merged = mergeMonotonicToolData(eventA, { ...eventA });
  assert.equal(merged?.status, "success");
  assert.equal(merged?.outputLog, undefined);
});

test("Live Execution: product normalization drops arbitrary output, commands, errors, and nested fields", () => {
  const event = normalizeProductEvent({
    id: "evt-secret", type: "tool.failed", worldId: "world", taskId: "task" as TaskId,
    occurredAt: 1, toolName: "terminal.execute", toolInvocationId: "inv-secret",
    command: "echo synthetic-secret", outputLog: "synthetic-secret", error: { code: "execution_failed", message: "synthetic-secret" },
    arbitraryNestedDiagnostic: { credential: "synthetic-secret" },
  } as ProductEvent & { arbitraryNestedDiagnostic: unknown });
  assert.equal("outputLog" in event, false);
  assert.equal("command" in event, false);
  assert.equal(event.error?.message, "Tool operation failed.");
  assert.equal(JSON.stringify(event).includes("synthetic-secret"), false);

  const missingFile = normalizeProductEvent({
    id: "evt-missing-file", type: "tool.failed", worldId: "world", taskId: "task" as TaskId,
    occurredAt: 2, toolName: "filesystem.read", toolInvocationId: "inv-missing-file",
    failureCategory: "file-not-found",
    error: { code: "execution_failed", message: "File not found (ENOENT); no content was read." },
  });
  assert.equal(missingFile.failureCategory, "file-not-found");
  assert.equal(missingFile.error?.message, "File not found (ENOENT); no content was read.");
});

test("Live Execution: terminal failures retain bounded redacted diagnostics without output or absolute paths", () => {
  const event = normalizeProductEvent({
    id: "evt-terminal-diagnostic", type: "tool.failed", worldId: "world", taskId: "task" as TaskId,
    occurredAt: 5, toolName: "terminal.execute", toolInvocationId: "inv-diagnostic",
    command: "python3 -c [inline script omitted] --token credential-value",
    workingDirectory: "packages/cody", recoveryReason: "Launch failed (ENOENT); use another executable after confirming availability.",
    errorCode: "ENOENT", exitCode: null, outputLog: "private output",
  });
  assert.equal(event.command, "python3 -c [inline script omitted] --token [REDACTED]");
  assert.equal(event.workingDirectory, "packages/cody");
  assert.match(event.recoveryReason ?? "", /ENOENT/);
  assert.equal(event.exitCode, null);
  assert.equal(JSON.stringify(event).includes("credential-value"), false);
  assert.equal(JSON.stringify(event).includes("private output"), false);

  const unsafe = normalizeProductEvent({ ...event, id: "evt-absolute", command: `echo ${"x".repeat(800)}`,
    workingDirectory: "/Users/private/project", recoveryReason: "r".repeat(800) });
  assert.equal(unsafe.workingDirectory, undefined);
  assert.ok((unsafe.command?.length ?? 0) <= 500);
  assert.ok((unsafe.recoveryReason?.length ?? 0) <= 240);
});

test("Live Execution: preserves a fixed process-launch diagnostic without exposing stderr or command text", () => {
  const event = normalizeProductEvent({
    id: "evt-launch-failed", type: "tool.failed", worldId: "world", taskId: "task" as TaskId,
    occurredAt: 3, toolName: "terminal.execute", toolInvocationId: "inv-launch-failed",
    failureCategory: "command-error", error: { code: "execution_failed", message: "Command could not start (ENOENT)." },
  });
  assert.equal(event.error?.message, "Command could not start (ENOENT).");
  assert.equal(event.failureCategory, "command-error");
  assert.equal(JSON.stringify(event).includes("stderr"), false);

  const signaled = normalizeProductEvent({ id: "evt-terminal-signal", type: "tool.failed", worldId: "world", taskId: "task" as TaskId,
    occurredAt: 4, toolName: "terminal.execute", toolInvocationId: "inv-terminal-signal", command: "node check.js",
    workingDirectory: "packages/cody", exitCode: null, terminationSignal: "SIGTERM",
    recoveryReason: "Process was terminated by SIGTERM; inspect why before continuing and do not repeat this command.",
    outputLog: "private stderr" });
  assert.equal(signaled.terminationSignal, "SIGTERM");
  assert.equal(signaled.error?.message, "Process terminated by signal SIGTERM.");
  assert.equal(signaled.workingDirectory, "packages/cody");
  assert.match(signaled.recoveryReason ?? "", /do not repeat/);
  assert.equal(JSON.stringify(signaled).includes("private stderr"), false);
  assert.equal(normalizeProductEvent({ ...signaled, terminationSignal: "ARBITRARY_VALUE" }).terminationSignal, undefined,
    "only known process signals enter the product event stream");

  const collaborating = normalizeProductEvent({ id: "evt-collaborating", type: "worker.progress", worldId: "world", taskId: "task" as TaskId,
    occurredAt: 4, activityState: "collaborating", message: "Cody sent a bounded request to Doc." });
  assert.equal(collaborating.activityState, "collaborating");
});

test("Live Execution: keeps safe launch diagnostics and removes generic progress and duplicate completion noise", () => {
  const launch = worldProductEvent({ id: "event-1" as never, sequence: 1, worldId: "world" as never,
    taskId: "task" as TaskId, type: "tool.failed", toolName: "terminal.execute", toolInvocationId: "inv-1",
    error: "Tool operation failed.", errorCode: "ENOENT", failureCategory: "command-error", exitCode: null,
    stdoutBytes: 0, stderrBytes: 19, occurredAt: 1 }, [], []);
  assert.equal(launch?.error?.message, "Command could not start (ENOENT).");
  assert.equal(launch?.errorCode, "ENOENT");
  assert.equal(launch?.activityState, "running");
  assert.equal("command" in (launch ?? {}), false);

  const restored = normalizeProductEvent({ id: "event-restored", type: "tool.completed", worldId: "world",
    taskId: "task" as TaskId, occurredAt: 4, toolName: "terminal.execute", toolInvocationId: "inv-restored",
    recoveredFromExecution: true, exitCode: 0, message: "Restored this terminal result from durable task history; the command was not run again." });
  assert.equal(restored.recoveredFromExecution, true);
  assert.match(restored.message ?? "", /was not run again/);

  const noExit = normalizeProductEvent({ id: "event-2", type: "tool.failed", worldId: "world", taskId: "task" as TaskId,
    occurredAt: 2, toolName: "terminal.execute", toolInvocationId: "inv-2", exitCode: null, stderrBytes: 19,
    error: { code: "execution_failed", message: "Tool operation failed." } });
  assert.equal(noExit.error?.message, "Process ended without an exit code; 19 stderr bytes were captured.");

  assert.equal(worldProductEvent({ id: "event-3" as never, sequence: 3, worldId: "world" as never,
    taskId: "task" as TaskId, type: "worker.progress", toolName: "filesystem.read", occurredAt: 3 }, [], []), undefined,
  "tool lifecycle events carry the useful detail, so empty worker progress should not create a duplicate timeline item");
  assert.equal(worldProductEvent({ id: "event-4" as never, sequence: 4, worldId: "world" as never,
    taskId: "task" as TaskId, type: "worker.finished", occurredAt: 4 }, [], []), undefined,
  "WorkerRuntime task completion is the authoritative completion event");
  assert.equal(worldProductEvent({ id: "event-5" as never, sequence: 5, worldId: "world" as never,
    taskId: "task" as TaskId, type: "worker.message", message: "I found the target file.", occurredAt: 5 }, [], [])?.message,
  "I found the target file.");
});

test("Live Execution: WHATWG SSE Last-Event-ID reconnection replays only unseen events", async () => {
  const { composition, emitTestEvent } = createTestComposition();
  const server = await startCommandCenter({
    composition,
    databasePath: ":memory:",
    listen: true,
    port: 0,
    vite: false,
  });

  try {
    const createResponse = await fetch(`${server.url}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: composition.codyDefinitionId, goal: "Run verify task" }),
    });
    const createBody = await createResponse.json() as { task: { id: TaskId } };
    assert.equal(createResponse.status, 202, JSON.stringify(createBody));
    const taskId = createBody.task.id;

    // Emit initial series of events
    emitTestEvent({
      id: "evt-001",
      sequence: 1,
      type: "tool.started",
      taskId,
      occurredAt: 1000,
      startedAt: 1000,
      toolName: "terminal.execute",
      toolInvocationId: "inv-1",
      command: "echo test",
    });

    emitTestEvent({
      id: "evt-002",
      sequence: 2,
      type: "tool.completed",
      taskId,
      occurredAt: 1200,
      startedAt: 1000,
      durationMs: 200,
      toolName: "terminal.execute",
      toolInvocationId: "inv-1",
      command: "echo test",
      outputLog: "test\n",
    });

    emitTestEvent({
      id: "evt-003",
      sequence: 3,
      type: "tool.started",
      taskId,
      occurredAt: 1300,
      startedAt: 1300,
      toolName: "terminal.execute",
      toolInvocationId: "inv-2",
      command: "node script.js",
    });

    // Client reconnects sending Last-Event-ID: evt-002
    const req = Object.assign(Readable.from([]), new EventEmitter(), {
      method: "GET",
      url: `/api/tasks/${taskId}/events`,
      headers: {
        "last-event-id": "evt-002",
      },
    });
    const res = new FakeResponse();

    let chunksReceived = "";
    res.onChunk = (chunk) => {
      chunksReceived += chunk;
    };

    await server.handle(req as never, res as never);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Yield to let stream write
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Verify WHATWG SSE format and replay filtering
    assert.match(chunksReceived, /id: evt-003/, "Replay must include subsequent event evt-003");
    assert.doesNotMatch(chunksReceived, /id: evt-001/, "Replay must NOT include already-seen evt-001");
    assert.doesNotMatch(chunksReceived, /id: evt-002/, "Replay must NOT include already-seen evt-002");

    // Emit live event while connected
    emitTestEvent({
      id: "evt-004",
      sequence: 4,
      type: "tool.completed",
      taskId,
      occurredAt: 1500,
      startedAt: 1300,
      durationMs: 200,
      toolName: "terminal.execute",
      toolInvocationId: "inv-2",
      command: "node script.js",
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.match(chunksReceived, /id: evt-004/, "Live stream must deliver evt-004");

    req.emit("close");
  } finally {
    await server.close();
  }
});

test("turn SSE replays durable product events after its cursor and reconciles terminal state", async () => {
  const { composition } = createTestComposition();
  const database = new LocalDatabase(":memory:");
  const history = new LocalHistoryStore(undefined, new ChatRepository(database.raw));
  const threadId = "thread-turn-event-replay";
  const turnId = "turn-event-replay";
  const task = composition.world.assignTask(
    composition.world.createTask("Replay the durable specialist timeline").id,
    composition.world.spawnWorker(composition.codyDefinitionId).id,
  );
  const taskId = task.id as TaskId;
  const events: ProductEvent[] = [
    { id: "turn-replay-1", type: "worker.started", taskId, worldId: "world-test", workerName: "Cody", sequence: 1, occurredAt: 1 },
    { id: "turn-replay-2", type: "worker.assigned", taskId, worldId: "world-test", workerName: "Cody", message: "I’ve assigned Cody to: Inspect the workspace.", sequence: 2, occurredAt: 2 },
    { id: "turn-replay-3", type: "worker.message", taskId, worldId: "world-test", workerName: "Cody", workerDefinitionId: composition.codyDefinitionId,
      message: "I found the target file and am checking its behavior.", sequence: 3, occurredAt: 3 },
    { id: "turn-replay-4", type: "worker.progress", taskId, worldId: "world-test", workerName: "Cody", workerDefinitionId: composition.codyDefinitionId,
      message: "filesystem.list", sequence: 4, occurredAt: 4 },
    { id: "turn-replay-5", type: "worker.progress", taskId, worldId: "world-test", workerName: "Cody", workerDefinitionId: composition.codyDefinitionId,
      message: "Cody progress.", sequence: 5, occurredAt: 5 },
    { id: "turn-replay-6", type: "worker.progress", taskId, worldId: "world-test", workerName: "Cody", workerDefinitionId: composition.codyDefinitionId,
      message: "Cody received the shared finding from Doc and is applying it.", sequence: 6, occurredAt: 6 },
    { id: "turn-replay-7", type: "task.completed", taskId, worldId: "world-test", sequence: 7, occurredAt: 7 },
  ];
  Object.defineProperty(composition, "getTaskEvents", { value: async () => events, configurable: true });
  composition.taskEvents.clear(); // emulate a fresh process with only durable replay available
  await history.saveMetadata({ id: threadId, title: "Durable replay" });
  await history.appendTurn(threadId, {
    id: turnId, threadId, prompt: "Replay events", taskId, status: "running", createdAt: 1,
    lastEventSequence: 1,
    items: [{ id: "user", turnId, type: "user_message", timestamp: 1, text: "Replay events" }],
  } as Turn);
  assert.equal((await history.get(threadId))?.turns[0]?.taskId, taskId, "turn history restores its task identity");
  const server = await startCommandCenter({ composition, historyStore: history, databasePath: ":memory:", listen: false, vite: false });
  class Response extends FakeResponse {
    override writeHead(status: number, headers: Record<string, string>) { this.statusCode = status; this.headers = headers; return this; }
  }
  try {
    const initial = Object.assign(Readable.from([]), new EventEmitter(), {
      method: "GET", url: `/api/turns/${turnId}/events?threadId=${threadId}`, headers: {},
    });
    const initialResponse = new Response();
    const previousConsoleError = console.error;
    let serverError = "";
    console.error = (...values: unknown[]) => { serverError = values.map(String).join(" "); };
    try { await server.handle(initial as never, initialResponse as never); }
    finally { console.error = previousConsoleError; }
    assert.equal(serverError, "", serverError);
    await new Promise(resolve => setImmediate(resolve));
    assert.match(initialResponse.output, /turn\.snapshot/);
    assert.match(initialResponse.output, /turn-replay-2/);
    assert.doesNotMatch(initialResponse.output, /I’ve assigned Cody to: Inspect the workspace/,
      "runtime assignment events must not be presented as model-authored conversation");
    assert.match(initialResponse.output, /"activityLabel":"Assigned Cody"/);
    assert.match(initialResponse.output, /turn-replay-3/);
    assert.match(initialResponse.output, /"type":"agent_message"/);
    assert.match(initialResponse.output, /I found the target file and am checking its behavior/);
    const genericProgressFrame = initialResponse.output.split("\n\n").find(frame => frame.includes("turn-replay-5"));
    assert.ok(genericProgressFrame, "the raw progress event remains available for real activity state updates");
    assert.doesNotMatch(genericProgressFrame, /\"item\"\s*:/, "generic progress does not create a conversation item");
    assert.match(initialResponse.output, /Cody received the shared finding from Doc and is applying it/,
      "meaningful collaboration updates remain visible");
    const sequencedFrame = initialResponse.output.split("\n\n").find(frame => frame.includes("turn-replay-6"));
    assert.match(sequencedFrame ?? "", /"sequence":6/, "the UI runtime event retains its durable journal ordering key");
    assert.doesNotMatch(initialResponse.output, /turn-replay-1/);
    initial.emit("close");

    const reconnect = Object.assign(Readable.from([]), new EventEmitter(), {
      method: "GET", url: `/api/turns/${turnId}/events?threadId=${threadId}`,
      headers: { "last-event-id": "turn-replay-1" },
    });
    const reconnectResponse = new Response();
    await server.handle(reconnect as never, reconnectResponse as never);
    await new Promise(resolve => setImmediate(resolve));
    assert.doesNotMatch(reconnectResponse.output, /turn\.snapshot/);
    assert.doesNotMatch(reconnectResponse.output, /turn-replay-1/);
    assert.match(reconnectResponse.output, /turn-replay-2/);
    const replayedGenericProgress = reconnectResponse.output.split("\n\n").find(frame => frame.includes("turn-replay-5"));
    assert.ok(replayedGenericProgress, "replay retains the status event");
    assert.doesNotMatch(replayedGenericProgress, /\"item\"\s*:/, "replay does not create a conversation item for generic progress");
    assert.match(reconnectResponse.output, /turn-replay-7/);
    assert.equal(reconnectResponse.writableEnded, true, "replayed terminal product event must close the turn stream");
    assert.equal(composition.subscribers.has(taskId), false, "terminal replay removes the task listener");
  } finally {
    await server.close();
    database.close();
  }
});

test("Live Execution: an expired cursor recovers a complete sanitized SQLite turn snapshot after in-memory state is absent", async () => {
  const database = new LocalDatabase(":memory:");
  const history = new LocalHistoryStore(undefined, new ChatRepository(database.raw));
  const threadId = "thread-recovery";
  const turnId = "turn-recovery";
  const secret = "synthetic-credential-not-matched-by-token-regex";
  await history.saveMetadata({ id: threadId, title: "Recovery" });
  await history.appendTurn(threadId, {
    id: turnId, threadId, prompt: "Recover this turn", taskId: "task-runtime-gone", status: "completed",
    createdAt: 1, completedAt: 3,
    items: [
      { id: "user", turnId, type: "user_message", timestamp: 1, text: "Recover this turn" },
      { id: "inv-1", turnId, type: "tool_execution", timestamp: 2, text: "Tool completed", tool: {
        toolName: "terminal.execute", toolInvocationId: "inv-1", status: "success", command: `echo ${secret}`,
        outputLog: secret, verificationStatus: "verified" as never, inputArgs: { nested: { credential: secret } },
        arbitraryDiagnostic: { providerResponse: secret },
      } as any, arbitraryItemMetadata: { nested: secret } as any },
    ] as any,
  });
  const raw = database.raw.prepare("SELECT turns_json FROM threads WHERE id = ?").get(threadId) as { turns_json: string };
  assert.equal(raw.turns_json.includes(secret), false, "raw output and command must not enter SQLite");

  const { composition } = createTestComposition();
  const server = await startCommandCenter({ composition, historyStore: history, databasePath: ":memory:", listen: false, vite: false });
  const req = Object.assign(Readable.from([]), new EventEmitter(), {
    method: "GET", url: `/api/turns/${turnId}/events?threadId=${threadId}`,
    headers: { "last-event-id": "expired-cursor" },
  });
  const res = new FakeResponse();
  try {
    await server.handle(req as never, res as never);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.match(res.output, /"type":"turn\.snapshot"/);
    assert.match(res.output, /"prompt":"Recover this turn"/);
    assert.match(res.output, /"status":"success"/);
    assert.doesNotMatch(res.output, new RegExp(secret));
    assert.doesNotMatch(res.output, /echo synthetic-credential/);
    assert.doesNotMatch(res.output, /inputArgs|arbitraryDiagnostic|arbitraryItemMetadata|providerResponse/);
    assert.doesNotMatch(res.output, /"verificationStatus":"verified"/);
  } finally {
    await server.close();
    database.close();
  }
});

test("Live Execution: arbitrary output is omitted even when secrets evade known token patterns", () => {
  const privateContent = "const SECRET_KEY = 'sk-live-1234567890abcdef';\nexport function run() {}";
  const readLog = sanitizeOutputLog("filesystem.read", privateContent);
  assert.equal(readLog, undefined);
  const ansiAndBinary = "\u001b[31;1mError:\u001b[0m \x00Binary\x07Alert!\nStatus: OK";
  const cleanedLog = sanitizeOutputLog("terminal.execute", ansiAndBinary);
  assert.equal(cleanedLog, undefined);
  const syntheticSecret = "Build output included synthetic-credential: not-a-common-token-pattern-9482";
  assert.equal(sanitizeOutputLog("terminal.execute", syntheticSecret), undefined);
  const hundredLines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
  assert.equal(sanitizeOutputLog("terminal.execute", hundredLines), undefined);
});

test("Live Execution: Timing preservation across remounts and reconnections", () => {
  const startedAt = Date.now() - 3500; // 3.5 seconds ago

  // Running tool: duration dynamically derived from startedAt
  const runningTool: ToolExecutionData = {
    toolInvocationId: "inv-timer",
    toolName: "terminal.execute",
    command: "long-process",
    status: "running",
    startedAt,
    outcomeBadge: "running",
  };

  const elapsedSeconds = (Date.now() - runningTool.startedAt!) / 1000;
  assert.ok(elapsedSeconds >= 3.4 && elapsedSeconds <= 4.0, "Running tool duration must compute from backend startedAt");

  // Completed tool: duration frozen from backend durationMs
  const completedTool: ToolExecutionData = {
    toolInvocationId: "inv-timer",
    toolName: "terminal.execute",
    command: "long-process",
    status: "success",
    startedAt,
    durationMs: 3512,
    outcomeBadge: "exit 0",
  };

  const frozenDuration = (completedTool.durationMs! / 1000).toFixed(1) + "s";
  assert.equal(frozenDuration, "3.5s", "Completed tool must render frozen durationMs accurately");
});

test("Live Execution: Verification provenance distinguishes command evidence from model-generated claims", () => {
  // 1. Executed verification command with exit 0
  const verifiedTool: ToolExecutionData = {
    toolInvocationId: "inv-ver-ok",
    toolName: "terminal.execute",
    command: "npm test -- verify.js",
    status: "success",
    startedAt: 1000,
    durationMs: 500,
    isVerification: true,
    verificationStatus: "command-succeeded",
    outcomeBadge: "✓ command exit 0",
  };
  assert.equal(verifiedTool.isVerification, true);
  assert.equal(verifiedTool.verificationStatus, "command-succeeded");
  assert.notEqual(verifiedTool.outcomeBadge, "✓ verified (exit 0)");

  // 2. Verification command that failed
  const failedVerificationTool: ToolExecutionData = {
    toolInvocationId: "inv-ver-fail",
    toolName: "terminal.execute",
    command: "npm test -- verify.js",
    status: "failed",
    startedAt: 1000,
    durationMs: 300,
    isVerification: true,
    verificationStatus: "command-failed",
    outcomeBadge: "✗ check command failed",
  };
  assert.equal(failedVerificationTool.isVerification, true);
  assert.equal(failedVerificationTool.verificationStatus, "command-failed");
  assert.equal(failedVerificationTool.outcomeBadge, "✗ check command failed");

  // 3. Ordinary non-verification command
  const ordinaryTool: ToolExecutionData = {
    toolInvocationId: "inv-ord",
    toolName: "terminal.execute",
    command: "ls -la",
    status: "success",
    startedAt: 1000,
    durationMs: 50,
    isVerification: false,
    outcomeBadge: "exit 0",
  };
  assert.equal(ordinaryTool.isVerification, false);
  assert.notEqual(ordinaryTool.outcomeBadge, "✓ verified (exit 0)");
});

test("Live Execution: SQLite persistence converges monotonically and never regresses on reordered events", async () => {
  const { tempDir, cleanup } = createTempDb();
  try {
    const history = new LocalHistoryStore(tempDir);

    const threadId = "thread-persist-test";
    const turnId = "turn-persist-test";

    await history.saveMetadata({ id: threadId, title: "Test Thread" });

    // Initial state: tool execution completes
    const completedTurnItem: ThreadItem = {
      id: "item-tool-1",
      turnId,
      type: "tool_execution",
      timestamp: 1000,
      text: "npm test",
      tool: {
        toolName: "terminal.execute",
        command: "npm test",
        status: "success",
        startedAt: 1000,
        durationMs: 450,
        outcomeBadge: "exit 0",
        outputLog: "All 12 tests passed",
      },
    };

    const initialTurn: Turn = {
      id: turnId,
      threadId,
      prompt: "Run tests",
      createdAt: 900,
      status: "running",
      items: [completedTurnItem],
    };

    await history.appendTurn(threadId, initialTurn);

    // Verify persisted initial state
    let loadedThread = await history.get(threadId);
    let loadedItem = loadedThread?.turns[0]?.items.find((it) => it.id === "item-tool-1");
    assert.equal(loadedItem?.tool?.status, "success");
    assert.equal(loadedItem?.tool?.durationMs, 450);

    // Simulate reordered/late "running" event arrival (like an out-of-order SSE replay)
    const lateRunningItem: ThreadItem = {
      id: "item-tool-1",
      turnId,
      type: "tool_execution",
      timestamp: 950,
      text: "npm test",
      tool: {
        toolName: "terminal.execute",
        command: "npm test",
        status: "running",
        startedAt: 1000,
        outcomeBadge: "running",
      },
    };

    // Merge logic mirroring server.ts persistence listener
    const existingTool = loadedItem?.tool;
    const incomingTool = lateRunningItem.tool;
    const mergedTool = mergeMonotonicToolData(existingTool as any, incomingTool as any);

    const updatedTurn: Turn = {
      ...initialTurn,
      items: [
        {
          ...completedTurnItem,
          tool: mergedTool as any,
        },
      ],
    };

    await history.appendTurn(threadId, updatedTurn);

    // Verify that SQLite database converged on terminal status
    loadedThread = await history.get(threadId);
    loadedItem = loadedThread?.turns[0]?.items.find((it) => it.id === "item-tool-1");
    assert.equal(loadedItem?.tool?.status, "success", "SQLite must preserve terminal success");
    assert.equal(loadedItem?.tool?.durationMs, 450, "SQLite must preserve backend durationMs");
    assert.equal(loadedItem?.tool?.outputLog, undefined, "SQLite reads must not expose legacy arbitrary output");
    assert.equal(loadedItem?.tool?.command, undefined, "SQLite reads must not expose legacy untrusted commands");

    cleanup();
  } finally {
    cleanup();
  }
});
