import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalHistoryStore } from "../../src/history.ts";
import type { Thread, Turn } from "../../src/types/index.ts";

test("LocalHistoryStore persists threads, turns, and survives store re-instantiation (restart)", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mediobot-history-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const store1 = new LocalHistoryStore(directory);
  const initial = await store1.list();
  assert.equal(initial.length, 0);

  const thread1: Thread = {
    id: "thread-test-1",
    title: "Test Thread One",
    projectId: "project-123",
    createdAt: 1000,
    updatedAt: 1000,
    model: "Configured by local runtime",
    branch: "main",
    approvalMode: "Approve for me",
    turns: [],
  };

  const saved = await store1.save(thread1);
  assert.equal(saved.id, "thread-test-1");
  assert.equal(saved.title, "Test Thread One");

  const turn1: Turn = {
    id: "turn-test-1",
    threadId: "thread-test-1",
    prompt: "Create an index file",
    status: "running",
    currentActivity: "thinking",
    createdAt: 1005,
    items: [
      { id: "msg-1", turnId: "turn-test-1", type: "user_message", timestamp: 1005, text: "Create an index file" },
    ],
  };

  await store1.appendTurn("thread-test-1", turn1);
  let retrieved = await store1.get("thread-test-1");
  assert.ok(retrieved);
  assert.equal(retrieved.turns.length, 1);
  assert.equal(retrieved.turns[0]?.prompt, "Create an index file");

  // Update turn with completion item and status
  await store1.updateTurn("thread-test-1", "turn-test-1", (turn) => {
    turn.status = "completed";
    turn.completedAt = 1050;
    turn.items.push({ id: "msg-2", turnId: "turn-test-1", type: "agent_message", timestamp: 1050, text: "File created successfully." });
  });

  retrieved = await store1.get("thread-test-1");
  assert.ok(retrieved);
  assert.equal(retrieved.turns[0]?.status, "completed");
  assert.equal(retrieved.turns[0]?.items.length, 2);

  // RESTART SIMULATION: Create a brand new store instance pointing to the same folder
  const store2 = new LocalHistoryStore(directory);
  const reloadedList = await store2.list();
  assert.equal(reloadedList.length, 1);
  assert.equal(reloadedList[0]?.id, "thread-test-1");
  assert.equal(reloadedList[0]?.title, "Test Thread One");
  assert.equal(reloadedList[0]?.turns.length, 1);
  assert.equal(reloadedList[0]?.turns[0]?.status, "completed");
  assert.equal(reloadedList[0]?.turns[0]?.items[1]?.text, "File created successfully.");

  // Test rename title
  const renameOk = await store2.updateTitle("thread-test-1", "Updated Thread Title");
  assert.equal(renameOk, true);
  const renamed = await store2.get("thread-test-1");
  assert.equal(renamed?.title, "Updated Thread Title");

  // Test delete
  const deleteOk = await store2.delete("thread-test-1");
  assert.equal(deleteOk, true);
  const afterDelete = await store2.list();
  assert.equal(afterDelete.length, 0);

  // Restart again to confirm delete is durable
  const store3 = new LocalHistoryStore(directory);
  const list3 = await store3.list();
  assert.equal(list3.length, 0);
});

test("LocalHistoryStore recovers gracefully from corrupt json file", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mediobot-history-corrupt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const dotMediobot = path.join(directory, ".mediobot");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dotMediobot, { recursive: true });
  await writeFile(path.join(dotMediobot, "history.json"), "NOT VALID JSON {{{{");

  const store = new LocalHistoryStore(directory);
  const list = await store.list();
  assert.deepEqual(list, []);

  // Can still save new threads
  await store.save({
    id: "thread-new",
    title: "Fresh Start",
    projectId: "proj-1",
    createdAt: 2000,
    updatedAt: 2000,
    model: "test-model",
    branch: "main",
    approvalMode: "Approve for me",
    turns: [],
  });

  const newList = await store.list();
  assert.equal(newList.length, 1);
  assert.equal(newList[0]?.title, "Fresh Start");
});
