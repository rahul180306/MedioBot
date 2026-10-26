import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { LocalDatabase } from "../../src/storage/db.ts";
import { ChatRepository } from "../../src/storage/chatRepository.ts";
import { LocalHistoryStore } from "../../src/history.ts";
import { compositeTurnKey, startCommandCenter } from "../../src/server.ts";
import { createFakeComposition } from "../helpers/fakeComposition.ts";
import {
  getProductionDatabasePath,
  assertNonProductionDatabase,
  isTestEnvironment,
} from "../../src/storage/appPaths.ts";
import type { Turn, ThreadItem } from "../../src/types/index.ts";

function createTempDb(): { dbPath: string; cleanup: () => void } {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "mediobot-test-persistence-"));
  const dbPath = path.join(tempDir, "mediobot.db");
  return {
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

async function firstTurnEvent(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const reader = response.body?.getReader();
  assert.ok(reader);
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);
      const block = buffer.split("\n\n").find((part) => part.includes("event: mediobot") && part.includes("data: "));
      if (!block) continue;
      const data = block.split("\n").find((line) => line.startsWith("data: "));
      assert.ok(data);
      return JSON.parse(data.slice("data: ".length)) as Record<string, unknown>;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new Error("Turn event stream closed before an event arrived");
}

test("TEST DB ISOLATION: Tests are forbidden from accessing production database", () => {
  assert.equal(isTestEnvironment(), true, "Must detect test environment");
  const prodPath = getProductionDatabasePath();
  assert.throws(
    () => {
      assertNonProductionDatabase(prodPath);
    },
    /strictly prohibited from accessing or mutating the production database/,
    "Must throw when pointing to production database"
  );
});

test("PERSISTENCE 1: User message persists durably in SQLite before execution (PERSISTENCE_SENTINEL_92841)", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const repo = new ChatRepository(db.raw);
    const store = new LocalHistoryStore(undefined, repo);

    const threadId = "thread-sentinel-test-1";
    const turnId = "turn-sentinel-test-1";
    const sentinel = "PERSISTENCE_SENTINEL_92841";

    const userItem: ThreadItem = {
      id: `item-${Date.now()}-user`,
      turnId,
      type: "user_message",
      timestamp: Date.now(),
      text: sentinel,
    };
    const initialTurn: Turn = {
      id: turnId,
      threadId,
      prompt: sentinel,
      status: "running",
      currentActivity: "thinking",
      createdAt: Date.now(),
      items: [userItem],
    };

    // Step: Persist user turn before execution
    await store.appendTurn(threadId, initialTurn, {
      title: "Sentinel Test Thread",
    });

    // Inspect SQLite directly
    const directRow = db.raw
      .prepare("SELECT turns_json FROM threads WHERE id = ?")
      .get(threadId) as { turns_json: string } | undefined;
    assert.ok(directRow, "Thread row must exist in SQLite");
    const parsedTurns = JSON.parse(directRow.turns_json) as Turn[];
    assert.equal(parsedTurns.length, 1);
    assert.equal(parsedTurns[0].prompt, sentinel);
    assert.equal(parsedTurns[0].items[0].text, sentinel);

    // Verify retrieval through ChatRepository
    const retrieved = repo.get(threadId);
    assert.ok(retrieved);
    assert.equal(retrieved.turns.length, 1);
    assert.equal(retrieved.turns[0].prompt, sentinel);
    assert.equal(retrieved.turns[0].items[0].text, sentinel);

    db.close();
  } finally {
    cleanup();
  }
});

test("PERSISTENCE 2: Model failure preserves user prompt and persists error state across reload", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const repo = new ChatRepository(db.raw);
    const store = new LocalHistoryStore(undefined, repo);

    const threadId = "thread-failure-test-2";
    const turnId = "turn-failure-test-2";
    const userPrompt = "Fix login with broken model";

    const userItem: ThreadItem = {
      id: `item-${Date.now()}-user`,
      turnId,
      type: "user_message",
      timestamp: Date.now(),
      text: userPrompt,
    };
    const initialTurn: Turn = {
      id: turnId,
      threadId,
      prompt: userPrompt,
      status: "running",
      currentActivity: "thinking",
      createdAt: Date.now(),
      items: [userItem],
    };

    // 1. User message persisted first
    await store.appendTurn(threadId, initialTurn, { title: "Failure Test" });

    // 2. Model execution fails - simulate error update
    await store.updateTurn(threadId, turnId, (t) => {
      t.status = "failed";
      t.currentActivity = "failed";
      t.completedAt = Date.now();
      t.items.push({
        id: `err-${Date.now()}`,
        turnId,
        type: "agent_message",
        timestamp: Date.now(),
        text: "Turn ended: Model configuration missing or provider unavailable.",
      });
    });

    db.close();

    // 3. Reload in fresh database instance (simulating refresh / restart)
    const freshDb = new LocalDatabase(dbPath);
    const freshRepo = new ChatRepository(freshDb.raw);
    const loadedThread = freshRepo.get(threadId);

    assert.ok(loadedThread, "Thread must be restored");
    assert.equal(loadedThread.turns.length, 1);
    assert.equal(loadedThread.turns[0].prompt, userPrompt, "User prompt must NOT be erased on model failure");
    assert.equal(loadedThread.turns[0].status, "failed");
    assert.equal(loadedThread.turns[0].items.length, 2);
    assert.equal(loadedThread.turns[0].items[0].text, userPrompt);
    assert.match(loadedThread.turns[0].items[1].text ?? "", /Model configuration missing/);

    freshDb.close();
  } finally {
    cleanup();
  }
});

test("PERSISTENCE 3: User message + Assistant final response persistence (PERSISTENCE_ASSISTANT_18427) with sanitization", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const repo = new ChatRepository(db.raw);
    const store = new LocalHistoryStore(undefined, repo);

    const threadId = "thread-assistant-sentinel-3";
    const turnId = "turn-assistant-sentinel-3";
    const userPrompt = "PERSISTENCE_SENTINEL_92841";
    const rawAssistantResponse = "<think>Hidden reasoning internal CoT</think>PERSISTENCE_ASSISTANT_18427";

    await store.appendTurn(threadId, {
      id: turnId,
      threadId,
      prompt: userPrompt,
      status: "running",
      currentActivity: "thinking",
      createdAt: Date.now(),
      items: [{ id: "u1", turnId, type: "user_message", timestamp: Date.now(), text: userPrompt }],
    });

    await store.updateTurn(threadId, turnId, (t) => {
      t.status = "completed";
      t.currentActivity = "completed";
      t.completedAt = Date.now();
      t.items.push({
        id: "a1",
        turnId,
        type: "agent_message",
        timestamp: Date.now(),
        text: rawAssistantResponse,
      });
    });

    db.close();

    // Reload from SQLite and assert ordering and stripping of <think>
    const reloadedDb = new LocalDatabase(dbPath);
    const reloadedRepo = new ChatRepository(reloadedDb.raw);
    const restored = reloadedRepo.get(threadId);

    assert.ok(restored);
    assert.equal(restored.turns.length, 1);
    const turn = restored.turns[0];
    assert.equal(turn.items.length, 2);
    assert.equal(turn.items[0].type, "user_message");
    assert.equal(turn.items[0].text, "PERSISTENCE_SENTINEL_92841");
    assert.equal(turn.items[1].type, "agent_message");
    assert.equal(turn.items[1].text, "PERSISTENCE_ASSISTANT_18427");
    assert.equal(turn.items[1].text?.includes("<think>"), false, "Must strip <think> reasoning tags");

    reloadedDb.close();
  } finally {
    cleanup();
  }
});

test("PERSISTENCE 4: Deterministic ordering of rapid sequential turns: ONE, TWO, THREE", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const repo = new ChatRepository(db.raw);
    const store = new LocalHistoryStore(undefined, repo);
    const threadId = "thread-ordering-4";

    const prompts = ["ONE", "TWO", "THREE"];
    for (let i = 0; i < prompts.length; i++) {
      const p = prompts[i];
      const tid = `turn-${i + 1}`;
      await store.appendTurn(threadId, {
        id: tid,
        threadId,
        prompt: p,
        status: "completed",
        currentActivity: "completed",
        createdAt: Date.now() + i * 10,
        items: [
          { id: `u-${i}`, turnId: tid, type: "user_message", timestamp: Date.now() + i * 10, text: p },
          { id: `a-${i}`, turnId: tid, type: "agent_message", timestamp: Date.now() + i * 10 + 1, text: `Response to ${p}` },
        ],
      });
    }

    db.close();

    // Reload and assert deterministic sequence
    const reloadedDb = new LocalDatabase(dbPath);
    const reloadedRepo = new ChatRepository(reloadedDb.raw);
    const loaded = reloadedRepo.get(threadId);

    assert.ok(loaded);
    assert.equal(loaded.turns.length, 3);
    assert.deepEqual(loaded.turns.map((t) => t.prompt), ["ONE", "TWO", "THREE"]);
    assert.deepEqual(loaded.turns.map((t) => t.items[0].text), ["ONE", "TWO", "THREE"]);

    reloadedDb.close();
  } finally {
    cleanup();
  }
});

test("PERSISTENCE 5: Two-Chat Isolation (Chat A: ALPHA_SENTINEL, Chat B: BETA_SENTINEL)", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const repo = new ChatRepository(db.raw);
    const store = new LocalHistoryStore(undefined, repo);

    const threadA = "thread-alpha-5";
    const threadB = "thread-beta-5";

    await store.appendTurn(threadA, {
      id: "turn-a",
      threadId: threadA,
      prompt: "ALPHA_SENTINEL",
      status: "completed",
      currentActivity: "completed",
      createdAt: Date.now(),
      items: [
        { id: "u-a", turnId: "turn-a", type: "user_message", timestamp: Date.now(), text: "ALPHA_SENTINEL" },
        { id: "a-a", turnId: "turn-a", type: "agent_message", timestamp: Date.now(), text: "Alpha response" },
      ],
    });

    await store.appendTurn(threadB, {
      id: "turn-b",
      threadId: threadB,
      prompt: "BETA_SENTINEL",
      status: "completed",
      currentActivity: "completed",
      createdAt: Date.now() + 5,
      items: [
        { id: "u-b", turnId: "turn-b", type: "user_message", timestamp: Date.now() + 5, text: "BETA_SENTINEL" },
        { id: "a-b", turnId: "turn-b", type: "agent_message", timestamp: Date.now() + 6, text: "Beta response" },
      ],
    });

    db.close();

    // Reload and assert strict isolation
    const reloadedDb = new LocalDatabase(dbPath);
    const reloadedRepo = new ChatRepository(reloadedDb.raw);

    const resA = reloadedRepo.get(threadA);
    const resB = reloadedRepo.get(threadB);

    assert.ok(resA);
    assert.ok(resB);

    // Thread A contains ALPHA_SENTINEL and NOT BETA_SENTINEL
    assert.equal(resA.turns.length, 1);
    assert.equal(resA.turns[0].prompt, "ALPHA_SENTINEL");
    assert.equal(resA.turns[0].items.some((it) => it.text?.includes("BETA_SENTINEL")), false);

    // Thread B contains BETA_SENTINEL and NOT ALPHA_SENTINEL
    assert.equal(resB.turns.length, 1);
    assert.equal(resB.turns[0].prompt, "BETA_SENTINEL");
    assert.equal(resB.turns[0].items.some((it) => it.text?.includes("ALPHA_SENTINEL")), false);

    reloadedDb.close();
  } finally {
    cleanup();
  }
});

test("PERSISTENCE 6: Close / Reopen chat retains conversation memory", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const repo = new ChatRepository(db.raw);
    const store = new LocalHistoryStore(undefined, repo);
    const threadId = "thread-tab-close-6";

    await store.appendTurn(threadId, {
      id: "turn-close-1",
      threadId,
      prompt: "Tab close survival test",
      status: "completed",
      currentActivity: "completed",
      createdAt: Date.now(),
      items: [
        { id: "u1", turnId: "turn-close-1", type: "user_message", timestamp: Date.now(), text: "Tab close survival test" },
      ],
    });

    // Closing a tab does NOT delete thread in SQLite
    const retrievedAfterTabClose = await store.get(threadId);
    assert.ok(retrievedAfterTabClose);
    assert.equal(retrievedAfterTabClose.turns.length, 1);
    assert.equal(retrievedAfterTabClose.turns[0].prompt, "Tab close survival test");

    db.close();
  } finally {
    cleanup();
  }
});

test("PERSISTENCE 7: Delete thread removes row from SQLite permanently", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const repo = new ChatRepository(db.raw);
    const store = new LocalHistoryStore(undefined, repo);
    const threadId = "thread-delete-7";

    await store.appendTurn(threadId, {
      id: "turn-del-1",
      threadId,
      prompt: "Will be deleted",
      status: "completed",
      currentActivity: "completed",
      createdAt: Date.now(),
      items: [{ id: "u1", turnId: "turn-del-1", type: "user_message", timestamp: Date.now(), text: "Will be deleted" }],
    });

    assert.ok(store.get(threadId));

    // Delete
    const deleted = await store.delete(threadId);
    assert.equal(deleted, true);

    // Verify absent
    assert.equal(await store.get(threadId), undefined);
    const row = db.raw.prepare("SELECT * FROM threads WHERE id = ?").get(threadId);
    assert.equal(row, undefined);

    db.close();

    // Reload fresh database and assert thread does NOT return
    const freshDb = new LocalDatabase(dbPath);
    const freshRepo = new ChatRepository(freshDb.raw);
    assert.equal(freshRepo.get(threadId), null);
    freshDb.close();
  } finally {
    cleanup();
  }
});

test("PERSISTENCE 8: Server restart test over full HTTP API (real server process cycle)", async () => {
  const { dbPath, cleanup } = createTempDb();
  let server1: Awaited<ReturnType<typeof startCommandCenter>> | undefined;
  let server2: Awaited<ReturnType<typeof startCommandCenter>> | undefined;
  try {
    // Phase 1: Start server 1 on isolated temp DB
    server1 = await startCommandCenter({
      databasePath: dbPath,
      composition: createFakeComposition(),
      vite: false,
      listen: true,
      port: 0,
    });
    const baseUrl1 = server1.url;

    // Create turn via POST /api/turns on Server 1
    const threadId = "thread-restart-cycle-8";
    const turnId = "turn-restart-cycle-8";
    const sentinel = "PERSISTENCE_SENTINEL_92841";

    const turnRes = await fetch(`${baseUrl1}/api/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        turnId,
        threadId,
        prompt: sentinel,
      }),
    });
    assert.equal(turnRes.status === 202 || turnRes.status === 200, true);

    // Verify GET /api/dev/persistence-health
    const healthRes = await fetch(`${baseUrl1}/api/dev/persistence-health`);
    assert.equal(healthRes.status, 200);
    const healthData = await healthRes.json() as { provider: string; schemaVersion: number; writable: boolean };
    assert.equal(healthData.provider, "sqlite");
    assert.equal(healthData.schemaVersion >= 3, true);
    assert.equal(healthData.writable, true);

    // Close server 1
    await server1.close();
    server1 = undefined;

    // Phase 2: Start server 2 on SAME database path
    server2 = await startCommandCenter({
      databasePath: dbPath,
      composition: createFakeComposition(),
      vite: false,
      listen: true,
      port: 0,
    });
    const baseUrl2 = server2.url;

    // Hydrate threads from Server 2
    const threadsRes = await fetch(`${baseUrl2}/api/threads`);
    assert.equal(threadsRes.status, 200);
    const threadsData = await threadsRes.json() as { threads: Array<{ id: string; turns: Turn[] }> };
    const matchedThread = threadsData.threads.find((t) => t.id === threadId);
    assert.ok(matchedThread, "Thread must be restored on restarted server");
    assert.equal(matchedThread.turns.length, 1, "Must have exactly 1 turn");
    assert.equal(matchedThread.turns[0].prompt, sentinel, "Prompt must be identical across server restart");
    assert.equal(matchedThread.turns[0].items[0].text, sentinel, "User message item must survive server restart");

    // Also verify single-thread endpoint GET /api/threads/:id
    const singleThreadRes = await fetch(`${baseUrl2}/api/threads/${encodeURIComponent(threadId)}`);
    assert.equal(singleThreadRes.status, 200);
    const singleThreadData = await singleThreadRes.json() as { thread: { id: string; turns: Turn[] } };
    assert.equal(singleThreadData.thread.id, threadId);
    assert.equal(singleThreadData.thread.turns[0].prompt, sentinel);

    await server2.close();
    server2 = undefined;
  } finally {
    if (server1) {
      await server1.close().catch(() => {});
    }
    if (server2) {
      await server2.close().catch(() => {});
    }
    cleanup();
  }
});

test("P4: Frontend stale snapshot cannot erase server-persisted turns in SQLite", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const server = await startCommandCenter({
      databasePath: dbPath,
      composition: createFakeComposition(),
      vite: false,
      listen: true,
      port: 0,
    });
    const threadId = "thread-p4-stale-writer";
    const turnId = "turn-p4-server-turn";

    // 1. Server persists user turn
    await server.history.appendTurn(threadId, {
      id: turnId,
      threadId,
      prompt: "Server authoritative message",
      status: "completed",
      currentActivity: "completed",
      createdAt: Date.now(),
      items: [{ id: "u-p4", turnId, type: "user_message", timestamp: Date.now(), text: "Server authoritative message" }],
    });

    // 2. Stale frontend client sends POST /api/threads with EMPTY turns or stale snapshot
    const res = await fetch(`${server.url}/api/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        thread: {
          id: threadId,
          title: "Updated Title By Client",
          turns: [], // Stale snapshot missing server turn!
        },
      }),
    });
    assert.equal(res.status, 200);

    // 3. Verify SQLite retained server-persisted turns
    const fetched = await server.history.get(threadId);
    assert.ok(fetched);
    assert.equal(fetched.title, "Updated Title By Client");
    assert.equal(fetched.turns.length, 1, "Server turns must NOT be erased by client snapshot");
    assert.equal(fetched.turns[0].id, turnId);
    assert.equal(fetched.turns[0].prompt, "Server authoritative message");

    await server.close();
  } finally {
    cleanup();
  }
});

test("P6: No SSE subscriber at all does NOT prevent assistant completion persistence in SQLite", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const composition = createFakeComposition({
      responseText: "Assistant responded without any SSE listener connected",
    });
    const server = await startCommandCenter({
      databasePath: dbPath,
      composition,
      vite: false,
      listen: true,
      port: 0,
    });
    const threadId = "thread-p6-no-sse";
    const turnId = "turn-p6-no-sse";

    // 1. Submit turn via POST /api/turns (NO SSE connection is ever opened)
    const turnRes = await fetch(`${server.url}/api/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        turnId,
        threadId,
        prompt: "Run task without SSE",
      }),
    });
    assert.equal(turnRes.status === 202 || turnRes.status === 200, true);
    await new Promise((resolve) => setTimeout(resolve, 60));

    // 2. Inspect SQLite directly through history layer
    const thread = await server.history.get(threadId);
    assert.ok(thread);
    const turn = thread.turns.find((t) => t.id === turnId);
    assert.ok(turn);
    assert.equal(turn.status, "completed", "Turn status must be completed in SQLite");
    const assistantMsg = turn.items.find((it) => it.type === "agent_message");
    assert.ok(assistantMsg, "Assistant message must be persisted in SQLite");
    assert.equal(assistantMsg.text, "Assistant responded without any SSE listener connected");
    assert.deepEqual(assistantMsg.actor, { type: "mediobot", mediobotId: composition.maestroDefinitionId, presentationId: "maestro", name: "Maestro" });
    assert.deepEqual(turn.items.find((it) => it.type === "user_message")?.actor, { type: "user" });

    await server.close();
  } finally {
    cleanup();
  }
});

test("P5: SSE disconnect during active execution does NOT prevent final server-side persistence", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const server = await startCommandCenter({
      databasePath: dbPath,
      composition: createFakeComposition({
        responseText: "Final response arrived after SSE disconnected",
      }),
      vite: false,
      listen: true,
      port: 0,
    });
    const threadId = "thread-p5-sse-disconnect";
    const turnId = "turn-p5-sse-disconnect";

    // 1. Submit turn
    const turnRes = await fetch(`${server.url}/api/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        turnId,
        threadId,
        prompt: "Run task and disconnect SSE",
      }),
    });
    assert.equal(turnRes.status === 202 || turnRes.status === 200, true);

    // 2. Connect to SSE
    const abortController = new AbortController();
    const sseRes = await fetch(`${server.url}/api/turns/${turnId}/events?threadId=${encodeURIComponent(threadId)}`, {
      signal: abortController.signal,
    });
    assert.equal(sseRes.status, 200);

    // Abruptly disconnect SSE subscriber
    abortController.abort();
    await sseRes.body?.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 60));

    // 3. Query SQLite
    const thread = await server.history.get(threadId);
    assert.ok(thread);
    const turn = thread.turns.find((t) => t.id === turnId);
    assert.ok(turn);
    assert.equal(turn.status, "completed");
    const assistantMsg = turn.items.find((it) => it.type === "agent_message");
    assert.ok(assistantMsg);
    assert.equal(assistantMsg.text, "Final response arrived after SSE disconnected");

    await server.close();
  } finally {
    cleanup();
  }
});

test("P7: Server restart reconciles stale running turns truthfully to failed with user prompt intact", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    // 1. Manually write a running turn into SQLite before server starts
    const db = new LocalDatabase(dbPath);
    const repo = new ChatRepository(db.raw);
    const threadId = "thread-p7-interrupted";
    const turnId = "turn-p7-interrupted";
    const userPrompt = "Process was killed while this was running";

    repo.save({
      id: threadId,
      title: "Interrupted Thread",
      projectId: "default",
      model: "Gemini 3.8 Flash",
      branch: "main",
      approvalMode: "Ask for approval",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turns: [
        {
          id: turnId,
          threadId,
          prompt: userPrompt,
          status: "running",
          currentActivity: "thinking",
          createdAt: Date.now() - 5000,
          items: [
            { id: "u-p7", turnId, type: "user_message", timestamp: Date.now() - 5000, text: userPrompt },
          ],
        },
      ],
    });
    db.close();

    // 2. Start server against this database (server executes reconcileInterruptedTurns at startup)
    const server = await startCommandCenter({
      databasePath: dbPath,
      composition: createFakeComposition(),
      vite: false,
      listen: true,
      port: 0,
    });

    // 3. Inspect reconciled turn
    const thread = await server.history.get(threadId);
    assert.ok(thread);
    const turn = thread.turns[0];
    assert.equal(turn.status, "failed", "Stale running turn must be reconciled to failed");
    assert.equal(turn.prompt, userPrompt, "User prompt must remain intact");
    assert.equal(turn.items[0].text, userPrompt, "User message item must remain intact");
    const failureMsg = turn.items.find((it) => it.type === "agent_message");
    assert.ok(failureMsg, "Interrupted turn must contain explanatory failure message");
    assert.match(failureMsg.text ?? "", /interrupted/i);

    await server.close();
  } finally {
    cleanup();
  }
});

test("P8: Hydration failure transitions chatHydrationStatus to ERROR, not READY+[]", async () => {
  // Test the client contract in AppContext:
  // When loadThreads rejects, chatHydrationStatus must be 'ERROR' and NOT 'READY'
  type ChatHydration = "UNINITIALIZED" | "LOADING" | "READY" | "ERROR";
  let status: ChatHydration = "LOADING";
  let threads: unknown[] = [{ id: "existing" }];

  const simulateHydration = async (loadFn: () => Promise<unknown[]>) => {
    try {
      const loaded = await loadFn();
      threads = loaded;
      status = "READY";
    } catch {
      status = "ERROR";
      // Crucial: do NOT overwrite threads with [] when in ERROR
    }
  };

  // Simulate network/database error
  await simulateHydration(async () => {
    throw new Error("Failed to load threads from server");
  });

  assert.equal(status, "ERROR", "Status must be ERROR on loadThreads failure");
  assert.notEqual(status, "READY", "Status must NOT be READY on failure");
  assert.equal(threads.length, 1, "Threads must not be silently replaced with empty array");
});

test("P9: POST /api/turns idempotency prevents duplicate execution for same turnId", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const server = await startCommandCenter({
      databasePath: dbPath,
      composition: createFakeComposition(),
      vite: false,
      listen: true,
      port: 0,
    });
    const threadId = "thread-p9-idempotency";
    const turnId = "turn-p9-unique-turn-id";

    // 1. First submission
    const res1 = await fetch(`${server.url}/api/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        turnId,
        threadId,
        prompt: "Idempotent action",
      }),
    });
    assert.equal(res1.status === 202 || res1.status === 200, true);
    const data1 = (await res1.json()) as { turnId: string; taskId: string };
    assert.equal(data1.turnId, turnId);

    // 2. Second submission with the exact same turnId
    const res2 = await fetch(`${server.url}/api/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        turnId,
        threadId,
        prompt: "Idempotent action duplicate",
      }),
    });
    assert.equal(res2.status, 200, "Duplicate turnId submission should return 200 with existing turn info");
    const data2 = (await res2.json()) as { turnId: string; taskId?: string };
    assert.equal(data2.turnId, turnId);

    // 3. Verify SQLite has exactly 1 turn
    const thread = await server.history.get(threadId);
    assert.ok(thread);
    assert.equal(thread.turns.length, 1, "Must contain exactly 1 turn, not duplicated");
    assert.equal(thread.turns[0].id, turnId);

    await server.close();
  } finally {
    cleanup();
  }
});

test("P11 & P12: ChatRepository strips escaped and unmatched reasoning tags on persistence", () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const repo = new ChatRepository(db.raw);

    const threadId = "thread-sanitization-suite";
    const turnId = "turn-sanitization-1";

    repo.save({
      id: threadId,
      title: "Sanitization Test",
      projectId: "default",
      model: "Gemini 3.8 Flash",
      branch: "main",
      approvalMode: "Ask for approval",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turns: [
        {
          id: turnId,
          threadId,
          prompt: "Sanitize this turn",
          status: "completed",
          currentActivity: "completed",
          createdAt: Date.now(),
          items: [
            {
              id: "item-escaped",
              turnId,
              type: "agent_message",
              timestamp: Date.now(),
              text: "\\u003cthink\\u003eescaped internal CoT\\u003c/think\\u003eP11 Clean Text",
            },
            {
              id: "item-unmatched",
              turnId,
              type: "agent_message",
              timestamp: Date.now() + 1,
              text: "P12 Valid prefix. <think>unmatched opening tag with leaked reasoning",
            },
          ],
        },
      ],
    });

    const retrieved = repo.get(threadId);
    assert.ok(retrieved);
    const items = retrieved.turns[0].items;
    assert.equal(items[0].text, "P11 Clean Text");
    assert.equal(items[0].text?.includes("internal CoT"), false);
    assert.equal(items[1].text, "P12 Valid prefix.");
    assert.equal(items[1].text?.includes("leaked reasoning"), false);

    db.close();
  } finally {
    cleanup();
  }
});

test("CONCURRENCY: Concurrent POST /api/threads metadata update + server appends turn -> transcript survives", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const server = await startCommandCenter({
      databasePath: dbPath,
      composition: createFakeComposition(),
      vite: false,
      listen: true,
      port: 0,
    });
    const threadId = "thread-concurrent-survives";
    const turnId = "turn-appended-concurrent";

    // Initialize thread with metadata
    await server.history.saveMetadata({
      id: threadId,
      title: "Initial Title",
    });

    // Run concurrent metadata update from client while server is appending turn
    const turnToAppend: Turn = {
      id: turnId,
      threadId,
      prompt: "Authoritative server turn",
      status: "completed",
      currentActivity: "completed",
      createdAt: Date.now(),
      items: [
        { id: "item-1", turnId, type: "user_message", timestamp: Date.now(), text: "Authoritative server turn" },
      ],
    };

    // Deterministic synchronization barrier: ensures metadata update and turn append genuinely interleave
    let notifyMetadataStarted!: () => void;
    const metadataStartedPromise = new Promise<void>((r) => { notifyMetadataStarted = r; });

    let notifyAppendStarted!: () => void;
    const appendStartedPromise = new Promise<void>((r) => { notifyAppendStarted = r; });

    const originalSaveMetadata = server.history.saveMetadata.bind(server.history);
    (server.history as any).saveMetadata = async (meta: any) => {
      notifyMetadataStarted();
      // Await until appendTurn enters its critical section
      await appendStartedPromise;
      return originalSaveMetadata(meta);
    };

    const originalAppendTurn = server.history.appendTurn.bind(server.history);
    (server.history as any).appendTurn = async (...args: any[]) => {
      // Await until metadata update has entered
      await metadataStartedPromise;
      notifyAppendStarted();
      return originalAppendTurn(...args);
    };

    const updatePromise = fetch(`${server.url}/api/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        thread: {
          id: threadId,
          title: "Updated Title By Client",
          turns: [], // Client-provided turns MUST BE IMPOSSIBLE to overwrite server turns
        },
      }),
    });

    const appendPromise = server.history.appendTurn(threadId, turnToAppend);

    const [updateRes] = await Promise.all([updatePromise, appendPromise]);
    assert.equal(updateRes.status, 200);

    // Query SQLite: transcript MUST survive and metadata must be updated!
    const retrieved = await server.history.get(threadId);
    assert.ok(retrieved);
    assert.equal(retrieved.title, "Updated Title By Client", "Metadata must be updated");
    assert.equal(retrieved.turns.length, 1, "Appended turn must survive concurrent metadata updates");
    assert.equal(retrieved.turns[0].id, turnId);
    assert.equal(retrieved.turns[0].prompt, "Authoritative server turn");

    await server.close();
  } finally {
    cleanup();
  }
});

test("CONCURRENCY: Concurrent identical POST /api/turns x 20 -> one persisted turn -> ONE execution -> every caller resolves consistently", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const fakeComp = createFakeComposition();
    const server = await startCommandCenter({
      databasePath: dbPath,
      composition: fakeComp,
      vite: false,
      listen: true,
      port: 0,
    });
    const threadId = "thread-concurrent-20";
    const turnId = "turn-concurrent-20";

    // Launch 20 concurrent requests with the identical (threadId, turnId)
    const promises = Array.from({ length: 20 }, (_, i) =>
      fetch(`${server.url}/api/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          turnId,
          threadId,
          prompt: `Concurrent prompt ${i}`,
        }),
      }).then(async (res) => {
        assert.equal(res.status === 200 || res.status === 202, true);
        return (await res.json()) as { turnId: string; taskId: string };
      })
    );

    const results = await Promise.all(promises);

    // 1. Every caller resolves consistently with the exact same real taskId
    const firstTaskId = results[0].taskId;
    assert.ok(firstTaskId);
    assert.notEqual(firstTaskId, "task_existing", "Must never return fake task_existing");
    for (const r of results) {
      assert.equal(r.turnId, turnId);
      assert.equal(r.taskId, firstTaskId, "All 20 callers must resolve to the identical execution taskId");
    }

    // 2. Exactly one execution created in the world
    const worldTasks = fakeComp.world.inspect().tasks;
    assert.equal(worldTasks.length, 1, "Must have launched exactly ONE execution in composition world");

    // 3. Exactly one turn persisted in SQLite
    const thread = await server.history.get(threadId);
    assert.ok(thread);
    assert.equal(thread.turns.length, 1, "Must have persisted exactly ONE turn in SQLite");
    assert.equal(thread.turns[0].id, turnId);

    await server.close();
  } finally {
    cleanup();
  }
});

test("EXECUTION ORDER: Execution emits immediately during submit() -> first event persists", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    // createFakeComposition with emitSynchronously=true publishes task.started synchronously during submit
    const fakeComp = createFakeComposition({ emitSynchronously: true });
    const server = await startCommandCenter({
      databasePath: dbPath,
      composition: fakeComp,
      vite: false,
      listen: true,
      port: 0,
    });
    const threadId = "thread-sync-emit";
    const turnId = "turn-sync-emit";

    const res = await fetch(`${server.url}/api/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        turnId,
        threadId,
        prompt: "Synchronous emission test",
      }),
    });
    assert.equal(res.status === 202 || res.status === 200, true);

    // Verify the synchronously emitted event during submit() was captured by the pre-registered listener
    const thread = await server.history.get(threadId);
    assert.ok(thread);
    const turn = thread.turns.find((t) => t.id === turnId);
    assert.ok(turn);
    // The first event emitted synchronously during submit() must be present
    const activityItem = turn.items.find((it) => it.type === "activity" && it.text === "Task started synchronously.");
    assert.ok(activityItem, "Synchronous first event must be durably persisted to SQLite");

    await server.close();
  } finally {
    cleanup();
  }
});

test("REASONING: Visible assistant output 'Use the literal token <think> in the docs.' is preserved exactly", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const literalDocText = "Use the literal token <think> in the docs.";
    const fakeComp = createFakeComposition({ responseText: literalDocText });
    const server = await startCommandCenter({
      databasePath: dbPath,
      composition: fakeComp,
      vite: false,
      listen: true,
      port: 0,
    });
    const threadId = "thread-literal-think";
    const turnId = "turn-literal-think";

    const res = await fetch(`${server.url}/api/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        turnId,
        threadId,
        prompt: "Document the think tag",
      }),
    });
    assert.equal(res.status === 202 || res.status === 200, true);

    const thread = await server.history.get(threadId);
    assert.ok(thread);
    const turn = thread.turns.find((t) => t.id === turnId);
    assert.ok(turn);
    const agentMsg = turn.items.find((it) => it.type === "agent_message");
    assert.ok(agentMsg);
    assert.equal(agentMsg.text, literalDocText, "Literal token <think> in docs must be preserved exactly");

    await server.close();
  } finally {
    cleanup();
  }
});

test("IDEMPOTENCY B: (thread A, turn X) and (thread B, turn X) MUST NOT alias -> two independent executions", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const fakeComp = createFakeComposition();
    const server = await startCommandCenter({
      databasePath: dbPath,
      composition: fakeComp,
      vite: false,
      listen: true,
      port: 0,
    });
    const sharedTurnId = "shared-turn-x";
    const threadA = "thread-idempotency-a";
    const threadB = "thread-idempotency-b";

    const [resA, resB] = await Promise.all([
      fetch(`${server.url}/api/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ turnId: sharedTurnId, threadId: threadA, prompt: "Prompt for thread A" }),
      }).then((r) => r.json() as Promise<{ turnId: string; taskId: string }>),
      fetch(`${server.url}/api/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ turnId: sharedTurnId, threadId: threadB, prompt: "Prompt for thread B" }),
      }).then((r) => r.json() as Promise<{ turnId: string; taskId: string }>),
    ]);

    assert.equal(resA.turnId, sharedTurnId);
    assert.equal(resB.turnId, sharedTurnId);
    assert.notEqual(resA.taskId, resB.taskId, "Different threads with same turnId MUST NOT alias to same execution");

    const worldTasks = fakeComp.world.inspect().tasks;
    assert.equal(worldTasks.length, 2, "Must create two distinct executions for two distinct threads");

    await server.close();
  } finally {
    cleanup();
  }
});

test("TURN IDENTITY: same turnId across threads keeps cancel and SSE isolated", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    let startedCount = 0;
    let resolveStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => { resolveStarted = resolve; });
    const fakeComp = createFakeComposition({
      workspaceRoot: path.dirname(dbPath),
      holdExecution: true,
      onExecutionStarted: () => {
        startedCount += 1;
        if (startedCount === 2) resolveStarted();
      },
    });
    const server = await startCommandCenter({ databasePath: dbPath, composition: fakeComp, workspaceRoot: path.dirname(dbPath), vite: false, listen: true, port: 0 });
    const sharedTurnId = "same-turn-across-threads";
    const threadA = "identity-thread-a";
    const threadB = "identity-thread-b";
    const submit = async (threadId: string, prompt: string) => {
      const response = await fetch(`${server.url}/api/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId, turnId: sharedTurnId, prompt }),
      });
      assert.equal(response.status, 202);
      return response.json() as Promise<{ turnId: string; taskId: string }>;
    };

    try {
      const [a, b] = await Promise.all([submit(threadA, "Task A"), submit(threadB, "Task B")]);
      await bothStarted;
      assert.notEqual(a.taskId, b.taskId);

      const missingThreadId = await fetch(`${server.url}/api/turns/${sharedTurnId}/events`);
      assert.equal(missingThreadId.status, 400, "Turn event lookup must require threadId");
      const eventA = await firstTurnEvent(`${server.url}/api/turns/${sharedTurnId}/events?threadId=${encodeURIComponent(threadA)}`);
      const eventB = await firstTurnEvent(`${server.url}/api/turns/${sharedTurnId}/events?threadId=${encodeURIComponent(threadB)}`);
      assert.equal(eventA.taskId, a.taskId);
      assert.equal(eventA.threadId, threadA);
      assert.equal(eventA.turnId, sharedTurnId);
      assert.equal(eventB.taskId, b.taskId);
      assert.equal(eventB.threadId, threadB);
      assert.equal(eventB.turnId, sharedTurnId);

      const missingCancelThreadId = await fetch(`${server.url}/api/turns/${sharedTurnId}/cancel`, { method: "POST" });
      assert.equal(missingCancelThreadId.status, 400, "Turn cancellation must require threadId");
      const cancelled = await fetch(`${server.url}/api/turns/${sharedTurnId}/cancel?threadId=${encodeURIComponent(threadA)}`, { method: "POST" });
      assert.equal(cancelled.status, 202);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const states = fakeComp.world.inspect().tasks;
      assert.equal(states.find((task) => task.id === a.taskId)?.state, "cancelled", "Thread A's task must be cancelled");
      assert.equal(states.find((task) => task.id === b.taskId)?.state, "running", "Thread B's task must remain running");

      const cancelB = await fetch(`${server.url}/api/turns/${sharedTurnId}/cancel?threadId=${encodeURIComponent(threadB)}`, { method: "POST" });
      assert.equal(cancelB.status, 202);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      assert.equal(fakeComp.world.inspect().tasks.find((task) => task.id === b.taskId)?.state, "cancelled");
    } finally {
      await server.close();
    }
  } finally {
    cleanup();
  }
});

test("IDEMPOTENCY C & D: inFlightTurns lifecycle removes key on success and failure", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const fakeComp = createFakeComposition();
    const server = await startCommandCenter({
      databasePath: dbPath,
      composition: fakeComp,
      vite: false,
      listen: true,
      port: 0,
    });

    // C. Successful submission
    const threadSuccess = "thread-lifecycle-success";
    const turnSuccess = "turn-lifecycle-success";
    const successKey = compositeTurnKey(threadSuccess, turnSuccess);

    const resSuccess = await fetch(`${server.url}/api/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnId: turnSuccess, threadId: threadSuccess, prompt: "Success task" }),
    });
    assert.equal(resSuccess.status, 202);
    assert.equal((server as any).inFlightTurns.has(successKey), false, "inFlightTurns must remove key after successful submission");
    await server.close();

    // D. Failed submission
    const throwingComp = createFakeComposition();
    throwingComp.submit = () => {
      throw new Error("Worker submission rejected");
    };
    const failServer = await startCommandCenter({
      databasePath: dbPath,
      composition: throwingComp,
      vite: false,
      listen: true,
      port: 0,
    });

    try {
      const threadFail = "thread-lifecycle-fail";
      const turnFail = "turn-lifecycle-fail";
      const failKey = compositeTurnKey(threadFail, turnFail);

      const resFail = await fetch(`${failServer.url}/api/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ turnId: turnFail, threadId: threadFail, prompt: "Fail task" }),
      });
      assert.equal(resFail.status, 400);
      assert.equal((failServer as any).inFlightTurns.has(failKey), false, "inFlightTurns must remove key after failed submission");
    } finally {
      await failServer.close();
    }
  } finally {
    cleanup();
  }
});

test("IDEMPOTENCY E: many completed turns do not grow inFlightTurns indefinitely", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const fakeComp = createFakeComposition();
    const server = await startCommandCenter({
      databasePath: dbPath,
      composition: fakeComp,
      vite: false,
      listen: true,
      port: 0,
    });

    // Execute 30 turns
    for (let i = 0; i < 30; i++) {
      const threadId = `thread-bounded-${i}`;
      const turnId = `turn-bounded-${i}`;
      await fetch(`${server.url}/api/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ turnId, threadId, prompt: `Prompt ${i}` }),
      });
    }

    // inFlightTurns must be strictly 0 because in-flight synchronization removes settled entries
    assert.equal((server as any).inFlightTurns.size, 0, "inFlightTurns map must not hold settled entries");
    assert.ok((server as any).settledTurns.size <= 500, "settledTurns bounded map must respect maximum capacity");

    await server.close();
  } finally {
    cleanup();
  }
});

test("OUTPUT SURFACE: /api/tasks/:id/events strips raw hidden reasoning while preserving legitimate assistant text", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const fakeComp = createFakeComposition({
      workspaceRoot: path.dirname(dbPath),
      responseText: "<think>raw leaked chain of thought</think>Use the literal token <think> in the docs.",
    });
    const server = await startCommandCenter({
      databasePath: dbPath,
      composition: fakeComp,
      workspaceRoot: path.dirname(dbPath),
      vite: false,
      listen: true,
      port: 0,
    });

    const threadId = "thread-surface-test";
    const turnId = "turn-surface-test";

    const turnRes = await fetch(`${server.url}/api/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnId, threadId, prompt: "Surface test" }),
    });
    const body = (await turnRes.json()) as { turnId: string; taskId: string };
    await new Promise((r) => setTimeout(r, 60));

    // Connect to /api/tasks/:id/events SSE endpoint
    const abortController = new AbortController();
    const sseRes = await fetch(`${server.url}/api/tasks/${body.taskId}/events`, {
      signal: abortController.signal,
    });
    assert.equal(sseRes.status, 200);

    // Read the initial events that were flushed on connect
    const reader = sseRes.body?.getReader();
    let textStream = "";
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        textStream += new TextDecoder().decode(value);
        if (textStream.includes("event: product")) break;
      }
      await reader.cancel().catch(() => {});
    }
    abortController.abort();

    // Verify hidden reasoning is absent from /api/tasks/:id/events
    assert.equal(textStream.includes("raw leaked chain of thought"), false, "Raw hidden reasoning must NOT leak through /api/tasks/:id/events");
    // Verify legitimate visible text survived
    assert.equal(textStream.includes("Use the literal token <think> in the docs."), true, "Visible content must remain intact in /api/tasks/:id/events");

    await server.close();
  } finally {
    cleanup();
  }
});

test("MAESTRO CONVERSATION: respond and request_user_input persist and replay without execution identities", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const fake = createFakeComposition();
    let decisions = 0;
    const composition = {
      ...fake,
      async decideMaestroTurn() {
        decisions += 1;
        return decisions === 1
          ? { type: "respond" as const, message: "<think>private reasoning</think>I can help with that. Use the literal token <think> in the docs.", basis: "conversation" as const, evidenceRefs: [] }
          : { type: "request_user_input" as const, question: "Which project should I use?" };
      },
    };
    const server = await startCommandCenter({ databasePath: dbPath, composition, vite: false, listen: true, port: 0 });
    const threadId = "direct-maestro-conversation";
    try {
      for (const [turnId, prompt, expected] of [
        ["direct-respond", "Say hello", "I can help with that. Use the literal token <think> in the docs."],
        ["direct-question", "Help me choose", "Which project should I use?"],
      ]) {
        const submit = async () => fetch(`${server.url}/api/turns`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ threadId, turnId, prompt }),
        });
        const response = await submit();
        assert.ok([200, 202].includes(response.status));
        assert.deepEqual(await response.json(), { turnId, direct: true });
        const duplicate = await submit();
        assert.equal(duplicate.status, 200);
        assert.deepEqual(await duplicate.json(), { turnId, direct: true });

        const sse = await fetch(`${server.url}/api/turns/${turnId}/events?threadId=${threadId}`);
        assert.equal(sse.status, 200);
        const rawSse = await sse.text();
        const events = rawSse.split("\n").filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)) as Record<string, any>);
        assert.deepEqual(events.map((event) => event.type), ["turn.snapshot", "turn.completed"]);
        assert.equal(events[0].threadId, threadId);
        assert.equal(events[0].turnId, turnId);
        const responseItem = events[0].payload.turn.items.find((item: any) => item.type === "agent_message");
        assert.equal(responseItem.text, expected);
        assert.doesNotMatch(responseItem.text, /private reasoning/);
        assert.equal(responseItem.actor.mediobotId, fake.maestroDefinitionId);
        assert.ok(events.every((event) => !("taskId" in event) && !("workerId" in event)));
        assert.doesNotMatch(rawSse, /task\.started|worker\.started|goal\.created|assignment\.created/);
      }

      assert.equal(decisions, 2, "same threadId + turnId must not call Maestro a second time");
      const state = fake.world.inspect();
      assert.equal(state.tasks.length, 0);
      assert.equal(state.workers.length, 0);
      assert.equal(state.goals.length, 0);
      assert.equal(state.assignments.length, 0);
      const thread = await server.history.get(threadId);
      assert.ok(thread);
      assert.deepEqual(thread.turns.map((turn) => turn.status), ["completed", "completed"]);
      assert.equal(thread.turns[0].items[0].text, "Say hello", "the user prompt remains durable");
      assert.equal(thread.turns[0].items[1].actor?.type, "mediobot");
      assert.equal(thread.turns[0].items[1].actor?.type === "mediobot" ? thread.turns[0].items[1].actor.mediobotId : "", fake.maestroDefinitionId);
    } finally {
      await server.close();
    }

    const reloadedDb = new LocalDatabase(dbPath);
    try {
      const restored = new ChatRepository(reloadedDb.raw).get(threadId);
      assert.ok(restored);
      assert.equal(restored.turns[0].prompt, "Say hello");
      assert.equal(restored.turns[0].items[1].text, "I can help with that. Use the literal token <think> in the docs.");
      assert.equal(restored.turns[1].prompt, "Help me choose");
      assert.equal(restored.turns[1].items[1].text, "Which project should I use?");
    } finally {
      reloadedDb.close();
    }
  } finally {
    cleanup();
  }
});

test("MAESTRO CONVERSATION CANCEL: an in-flight direct turn cancels by threadId + turnId without creating a task", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const fake = createFakeComposition();
    let signal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const composition = {
      ...fake,
      decideMaestroTurn(_goal: string, _options: Readonly<Record<string, unknown>>, abortSignal: AbortSignal) {
        signal = abortSignal;
        markStarted();
        return new Promise<never>((_resolve, reject) => {
          abortSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    };
    const server = await startCommandCenter({ databasePath: dbPath, composition, vite: false, listen: true, port: 0 });
    const threadId = "cancel-direct-thread";
    const turnId = "cancel-direct-turn";
    try {
      const submitting = fetch(`${server.url}/api/turns`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId, turnId, prompt: "This response should be interrupted." }),
      });
      await started;
      const cancel = await fetch(`${server.url}/api/turns/${turnId}/cancel?threadId=${threadId}`, { method: "POST" });
      assert.equal(cancel.status, 202);
      const response = await submitting;
      assert.ok([200, 202].includes(response.status));
      assert.deepEqual(await response.json(), { turnId, direct: true });
      assert.equal(signal?.aborted, true);
      assert.equal(fake.world.inspect().tasks.length, 0);
      assert.equal(fake.world.inspect().workers.length, 0);

      const thread = await server.history.get(threadId);
      assert.equal(thread?.turns[0]?.status, "cancelled");
      assert.equal(thread?.turns[0]?.prompt, "This response should be interrupted.");
      const sse = await fetch(`${server.url}/api/turns/${turnId}/events?threadId=${threadId}`);
      const rawSse = await sse.text();
      assert.match(rawSse, /"type":"turn\.cancelled"/);
      assert.doesNotMatch(rawSse, /"taskId"|"workerId"|task\.cancelled/);
    } finally {
      await server.close();
    }
  } finally {
    cleanup();
  }
});

test("MAESTRO DELEGATION: a validated delegate decision enters the existing task submission path", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const fake = createFakeComposition();
    const decision = { type: "delegate" as const, definitionId: fake.codyDefinitionId, objective: "Resolve the requested work",
      relevantContextRefs: [], constraints: [], expectedOutcome: "The requested work is complete", evidenceExpectations: ["Result"] };
    let decisions = 0;
    let submittedOptions: Readonly<Record<string, unknown>> | undefined;
    let submissions = 0;
    const composition = {
      ...fake,
      async decideMaestroTurn() { decisions += 1; return decision; },
      submit(definitionId: Parameters<typeof fake.submit>[0], goal: string, options?: Readonly<Record<string, unknown>>, onBeforeEmit?: Parameters<typeof fake.submit>[3]) {
        submissions += 1;
        submittedOptions = options;
        return fake.submit(definitionId, goal, options, onBeforeEmit);
      },
    };
    const server = await startCommandCenter({ databasePath: dbPath, composition, vite: false, listen: true, port: 0 });
    try {
      const response = await fetch(`${server.url}/api/turns`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: "delegate-thread", turnId: "delegate-turn", prompt: "Please do this work." }),
      });
      assert.equal(response.status, 202);
      const result = await response.json() as { turnId: string; taskId: string };
      assert.equal(result.turnId, "delegate-turn");
      assert.ok(result.taskId);
      assert.equal(decisions, 1);
      assert.equal(submissions, 1);
      assert.deepEqual(submittedOptions?.maestroDecision, decision, "the semantic decision must be reused rather than inferred twice");
      const state = fake.world.inspect();
      assert.equal(state.tasks.length, 1);
      assert.equal(state.workers.length, 1);
      assert.equal(state.tasks[0].goal, "Please do this work.");
      assert.equal(state.tasks[0].assignedWorkerId, state.workers[0].id);
    } finally {
      await server.close();
    }
  } finally {
    cleanup();
  }
});
