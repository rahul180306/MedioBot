import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { DurableTaskEngine } from "@mediobot-v2/runtime";
import type { TaskId } from "@mediobot-v2/domain";
import { createComposition } from "../../src/composition.ts";
import { SqliteDurableTaskStore } from "../../src/storage/durableTaskStore.ts";
import { LocalDatabase } from "../../src/storage/db.ts";
import { startCommandCenter } from "../../src/server.ts";
import type { ProductEvent } from "../../src/contracts.ts";

test("product events are journaled before publish and replay from SQLite after composition restart", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mediobot-product-event-journal-"));
  const databasePath = path.join(directory, "mediobot.db");
  const workspaceId = `ws-${createHash("sha256").update(realpathSync(directory)).digest("hex").slice(0, 20)}`;
  let firstDatabase: LocalDatabase | undefined;
  let firstComposition: ReturnType<typeof createComposition> | undefined;
  let restartedDatabase: LocalDatabase | undefined;
  let restartedComposition: ReturnType<typeof createComposition> | undefined;
  try {
    firstDatabase = new LocalDatabase(databasePath);
    const firstEngine = new DurableTaskEngine(new SqliteDurableTaskStore(firstDatabase.rawDb));
    const { task } = await firstEngine.submitTask({ id: "task-event-journal" as TaskId,
      goal: "Persist product events", definitionId: "cody", workspaceId, threadId: "thread-journal" });
    const taskId = task.id as TaskId;
    firstComposition = createComposition({ durableTaskEngine: firstEngine });
    let persistedBeforePublish = true;
    firstComposition.subscribers.set(taskId, new Set([() => {
      const rows = firstDatabase!.rawDb.prepare("SELECT COUNT(*) AS count FROM durable_task_events WHERE task_id = ? AND event_type = 'product.event'")
        .get(taskId) as { count: number };
      persistedBeforePublish &&= rows.count > 0;
    }]));
    const events: ProductEvent[] = [
      { id: "product-event-1", type: "task.created", taskId, worldId: "world-journal", occurredAt: 1 },
      { id: "product-event-2", type: "worker.started", taskId, worldId: "world-journal", workerName: "Cody", occurredAt: 2 },
      { id: "product-event-3", type: "tool.completed", taskId, worldId: "world-journal", toolName: "filesystem.read",
        outputLog: "sensitive raw output is intentionally omitted", occurredAt: 3 },
    ];
    events.forEach(event => firstComposition!.publish(event));
    const live = await firstComposition.getTaskEvents!(taskId);
    assert.deepEqual(live.map(event => event.id), events.map(event => event.id));
    assert.ok(live.every((event, index) => index === 0 || event.sequence! > live[index - 1]!.sequence!));
    assert.equal(live[2]?.outputLog, undefined, "the journal stores the safe product projection, not raw tool output");
    assert.equal(persistedBeforePublish, true, "subscribers must only see an event after its SQLite append completes");
    await firstEngine.appendEvent(taskId, "product.event", { schemaVersion: 1, event: {
      id: "unknown-product-event", type: "unrecognized.event", taskId, worldId: "world-journal", occurredAt: 4,
    } });
    const boundedTask = (await firstEngine.submitTask({ id: "task-event-journal-bounded" as TaskId,
      goal: "Bound product event history", definitionId: "cody", workspaceId, threadId: "thread-journal" })).task;
    for (let index = 0; index < 205; index++) firstComposition.publish({ id: `bounded-event-${index}`,
      type: "worker.progress", taskId: boundedTask.id as TaskId, worldId: "world-journal", message: "progress", occurredAt: index });
    const boundedHistory = await firstComposition.getTaskEvents!(boundedTask.id as TaskId);
    assert.equal(boundedHistory.length, 200);
    assert.equal(boundedHistory[0]?.id, "bounded-event-5");
    assert.equal((firstDatabase.rawDb.prepare("SELECT COUNT(*) AS count FROM durable_task_events WHERE task_id = ? AND event_type = 'product.event'")
      .get(boundedTask.id) as { count: number }).count, 200, "durable product event retention is bounded per task");
    await firstComposition.shutdown?.();
    firstComposition = undefined;
    firstDatabase.close();
    firstDatabase = undefined;

    restartedDatabase = new LocalDatabase(databasePath);
    const restartedEngine = new DurableTaskEngine(new SqliteDurableTaskStore(restartedDatabase.rawDb));
    restartedComposition = createComposition({ durableTaskEngine: restartedEngine });
    assert.equal(restartedComposition.taskEvents.size, 0, "a fresh composition starts without process-local replay state");
    const replayed = await restartedComposition.getTaskEvents!(taskId);
    assert.deepEqual(replayed.map(event => event.id), events.map(event => event.id));
    assert.deepEqual(replayed.map(event => event.sequence), live.map(event => event.sequence));
    const app = await startCommandCenter({ composition: restartedComposition, databasePath: path.join(directory, "server.db"),
      workspaceRoot: directory, vite: false, listen: false });
    try {
      const req = Object.assign(Readable.from([]), new EventEmitter(), {
        method: "GET", url: `/api/tasks/${taskId}/events`, headers: {},
      });
      class Response extends Writable {
        output = "";
        statusCode = 200;
        headers: Record<string, string> = {};
        override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
          this.output += chunk.toString(); callback();
        }
        writeHead(status: number, headers: Record<string, string>) { this.statusCode = status; this.headers = headers; return this; }
      }
      const response = new Response();
      await app.handle(req as never, response as never);
      for (let attempt = 0; attempt < 20 && !response.output.includes("product-event-1"); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(response.output.includes("product-event-1"), response.output);
      assert.ok(response.output.includes("product-event-3"));
      assert.match(response.output, /event: product/);
      response.emit("close");
      const replayRequest = Object.assign(Readable.from([]), new EventEmitter(), {
        method: "GET", url: `/api/tasks/${taskId}/events`, headers: { "last-event-id": "product-event-2" },
      });
      const replayResponse = new Response();
      await app.handle(replayRequest as never, replayResponse as never);
      for (let attempt = 0; attempt < 20 && !replayResponse.output.includes("product-event-3"); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(replayResponse.output.includes("product-event-1"), false);
      assert.equal(replayResponse.output.includes("product-event-2"), false);
      assert.ok(replayResponse.output.includes("product-event-3"));
      replayResponse.emit("close");

      const staleReplay = await restartedComposition.getTaskEvents!(taskId);
      const originalGetTaskEvents = restartedComposition.getTaskEvents!;
      let replayStarted!: () => void;
      let releaseReplay!: () => void;
      const replayHasStarted = new Promise<void>(resolve => { replayStarted = resolve; });
      const replayGate = new Promise<void>(resolve => { releaseReplay = resolve; });
      Object.defineProperty(restartedComposition, "getTaskEvents", { configurable: true, value: async () => {
        replayStarted();
        await replayGate;
        return staleReplay;
      } });
      const racingRequest = Object.assign(Readable.from([]), new EventEmitter(), {
        method: "GET", url: `/api/tasks/${taskId}/events`, headers: {},
      });
      const racingResponse = new Response();
      const racingHandler = app.handle(racingRequest as never, racingResponse as never);
      await replayHasStarted;
      assert.equal(restartedComposition.subscribers.get(taskId)?.size, 1, "SSE listener must be registered before history retrieval");
      restartedComposition.publish({ id: "product-event-during-sse-replay", type: "worker.progress", taskId,
        worldId: "world-journal", workerName: "Cody", message: "arrived while history was loading", occurredAt: 4 });
      await restartedComposition.flushTaskEvents!(taskId);
      assert.ok((await originalGetTaskEvents(taskId)).some(event => event.id === "product-event-during-sse-replay"), "racing event must be durable");
      releaseReplay();
      await racingHandler;
      for (let attempt = 0; attempt < 20 && !racingResponse.output.includes("product-event-during-sse-replay"); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(racingResponse.output.match(/id: product-event-during-sse-replay\n/g)?.length, 1,
        `events committed during history loading must be delivered once, without a replay/subscription gap; output: ${racingResponse.output}`);
      racingResponse.emit("close");
      Object.defineProperty(restartedComposition, "getTaskEvents", { configurable: true, value: originalGetTaskEvents });

      await restartedEngine.startTask(taskId);
      await restartedEngine.completeTask(taskId);
      restartedComposition.publish({ id: "product-event-terminal", type: "task.completed", taskId,
        worldId: "world-journal", occurredAt: 5 });
      await restartedComposition.flushTaskEvents!(taskId);
      assert.ok((await originalGetTaskEvents(taskId)).some(event => event.id === "product-event-terminal"), "terminal event must be in replay history");
      const terminalRequest = Object.assign(Readable.from([]), new EventEmitter(), {
        method: "GET", url: `/api/tasks/${taskId}/events`, headers: {},
      });
      const terminalResponse = new Response();
      await app.handle(terminalRequest as never, terminalResponse as never);
      for (let attempt = 0; attempt < 20 && !terminalResponse.writableEnded; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(terminalResponse.writableEnded, true,
        `replaying a terminal task event must end its SSE stream; status=${terminalResponse.statusCode} output=${terminalResponse.output}`);
      assert.equal(restartedComposition.subscribers.has(taskId), false, "terminal replay must remove its listener");
    } finally { await app.close(); }
  } finally {
    await restartedComposition?.shutdown?.();
    restartedDatabase?.close();
    await firstComposition?.shutdown?.();
    firstDatabase?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
