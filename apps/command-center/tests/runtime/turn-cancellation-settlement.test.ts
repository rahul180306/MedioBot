import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import type { TaskId } from "@mediobot-v2/domain";
import { startCommandCenter } from "../../src/server.ts";
import { createFakeComposition } from "../helpers/fakeComposition.ts";

test("Main Chat cancellation stays active until the worker actually settles", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "mediobot-cancel-settlement-"));
  t.after(() => rm(temp, { recursive: true, force: true }));

  let releaseWorker!: () => void;
  let markStarted!: () => void;
  let markCancellationObserved!: () => void;
  const release = new Promise<void>((resolve) => { releaseWorker = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const cancellationObserved = new Promise<void>((resolve) => { markCancellationObserved = resolve; });
  const composition = createFakeComposition({
    holdExecution: true,
    holdAfterCancel: release,
    onExecutionStarted: () => markStarted(),
    onCancellationObserved: () => markCancellationObserved(),
  });
  const app = await startCommandCenter({ databasePath: path.join(temp, "mediobot.db"), composition, vite: false, listen: true, port: 0 });
  t.after(() => app.close());

  const threadId = "turn-cancel-settlement-thread";
  const turnId = "turn-cancel-settlement-turn";
  const submit = await fetch(`${app.url}/api/turns`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId, turnId, prompt: "Run a bounded task and report its outcome." }),
  });
  assert.equal(submit.status, 202);
  await started;

  const before = await app.history.get(threadId);
  assert.equal(before?.turns.find((turn) => turn.id === turnId)?.status, "running");
  const taskId = before?.turns.find((turn) => turn.id === turnId)?.taskId;
  assert.ok(taskId);

  const cancel = await fetch(`${app.url}/api/turns/${turnId}/cancel?threadId=${threadId}`, { method: "POST" });
  assert.equal(cancel.status, 202);
  await cancellationObserved;

  const duringSettlement = await app.history.get(threadId);
  const activeTurn = duringSettlement?.turns.find((turn) => turn.id === turnId);
  assert.equal(activeTurn?.status, "running", "a cancellation request must not be presented as completed cancellation");
  assert.equal(activeTurn?.completedAt, undefined);
  assert.equal(activeTurn?.items.some((item) => item.text === "Task cancelled."), false);

  releaseWorker();
  const deadline = Date.now() + 2_000;
  let finalStatus: string | undefined;
  while (Date.now() < deadline) {
    const thread = await app.history.get(threadId);
    finalStatus = thread?.turns.find((turn) => turn.id === turnId)?.status;
    if (finalStatus === "cancelled") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(finalStatus, "cancelled", "the actual task.cancelled event should settle the turn");
  assert.ok(composition.taskEvents.get(taskId as TaskId)?.some((event) => event.type === "task.cancelled"));

  const lateCancel = await fetch(`${app.url}/api/turns/${turnId}/cancel?threadId=${threadId}`, { method: "POST" });
  assert.equal(lateCancel.status, 409, "a terminal turn must not accept another cancellation request");
  const lateCancelBody = await lateCancel.json() as { error?: { code?: string }; cancellationRequested?: boolean };
  assert.equal(lateCancelBody.cancellationRequested, undefined);
  assert.equal(lateCancelBody.error?.code, "turn-not-running");
});
