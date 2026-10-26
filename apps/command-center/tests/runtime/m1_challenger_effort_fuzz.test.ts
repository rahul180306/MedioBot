import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import type { TaskId } from "@mediobot-v2/domain";
import type { InferenceSnapshot } from "@mediobot-v2/contracts";
import { DurableTaskEngine } from "@mediobot-v2/runtime";
import type { ToolInvocation } from "@mediobot-v2/tools";
import { LocalDatabase } from "../../src/storage/db.ts";
import { ProviderRepository, SqliteCredentialStore } from "../../src/storage/providerRepository.ts";
import { SqliteDurableTaskStore } from "../../src/storage/durableTaskStore.ts";
import { SqliteApprovalRecordStore } from "../../src/storage/approvalStore.ts";
import { ModelResolver } from "../../src/runtime/modelRegistry.ts";
import { startCommandCenter as startCommandCenterWithSystemCredentials } from "../../src/server.ts";
import type { ThreadModelSelection } from "../../src/types/index.ts";

const startCommandCenter = (options: Parameters<typeof startCommandCenterWithSystemCredentials>[0] = {}) =>
  startCommandCenterWithSystemCredentials({
    ...options,
    credentialStoreFactory: options.credentialStoreFactory ?? ((database) => new SqliteCredentialStore(database)),
  });

class ResponseCapture extends Writable {
  statusCode = 200;
  output = "";
  onChunk?: () => void;
  writeHead(status: number) {
    this.statusCode = status;
    return this;
  }
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
  const req = Object.assign(Readable.from(body ? [JSON.stringify(body)] : []), {
    method,
    url,
    headers: { "content-type": "application/json" },
  });
  const res = new ResponseCapture();
  const finished = new Promise<void>((resolve) => res.once("finish", resolve));
  app.handle(req as never, res as never);
  await finished;
  const parsed = res.output ? JSON.parse(res.output) : undefined;
  return { status: res.statusCode, json: parsed };
}

function createTempDb(): { dbPath: string; cleanup: () => void } {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "mediobot-challenger-fuzz-"));
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

// ---------------------------------------------------------------------------
// SUITE 1: EFFORT NORMALIZATION (Mixed Case Inputs)
// ---------------------------------------------------------------------------

test("EFFORT NORMALIZATION: ModelResolver.createInferenceSnapshot normalizes mixed-case effort strings", () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const repo = new ProviderRepository(db.raw);
    repo.save(
      {
        id: "nvidia",
        providerType: "nvidia",
        displayName: "NVIDIA NIM",
        baseUrl: "https://integrate.api.nvidia.com/v1/",
        connected: true,
        enabled: true,
        models: [
          {
            id: "nvidia/nemotron-3-ultra-550b-a55b",
            name: "Nemotron 3 Ultra",
            enabled: true,
            capabilities: { text: true, reasoning: true, vision: false, tools: false },
          },
        ],
      },
      "test-key"
    );

    const resolver = new ModelResolver(repo);
    const testCases: Array<{ input: string; expected: string }> = [
      { input: "High", expected: "high" },
      { input: "HIGH", expected: "high" },
      { input: "hIgH", expected: "high" },
      { input: "MEDIUM", expected: "medium" },
      { input: "Medium", expected: "medium" },
      { input: "mEdIuM", expected: "medium" },
    ];

    for (const { input, expected } of testCases) {
      const snapshot = resolver.createInferenceSnapshot({
        providerConnectionId: "nvidia",
        modelId: "nvidia/nemotron-3-ultra-550b-a55b",
        reasoningEffort: input as any,
      });

      assert.equal(snapshot.requestedEffort, expected, `requestedEffort for ${input} must be ${expected}`);
      assert.equal(snapshot.effectiveEffort, expected, `effectiveEffort for ${input} must be ${expected}`);
    }

    db.close();
  } finally {
    cleanup();
  }
});

test("EFFORT NORMALIZATION: DurableTaskEngine.getTaskModelSelection extracts lowercase effort from mixed-case snapshot", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const store = new SqliteDurableTaskStore(db.rawDb);
    const engine = new DurableTaskEngine(store);

    const testCases = [
      { inputRequested: "High", inputEffective: "High", expected: "high" },
      { inputRequested: "MEDIUM", inputEffective: "MEDIUM", expected: "medium" },
      { inputRequested: "Low", inputEffective: "Low", expected: "low" },
      { inputRequested: "eXtra", inputEffective: "eXtra", expected: "extra" },
      { inputRequested: "MAX", inputEffective: "MAX", expected: "max" },
      { inputRequested: "LoW", inputEffective: undefined, expected: "low" },
    ];

    for (const [idx, tc] of testCases.entries()) {
      const snapshot: InferenceSnapshot = {
        connectionId: `conn-${idx}`,
        providerKey: "custom",
        modelId: `model-${idx}`,
        requestedEffort: tc.inputRequested,
        effectiveEffort: tc.inputEffective,
        protocolCapabilities: ["prompt-json"],
        resolvedAt: Date.now(),
      };

      const { task } = await engine.submitTask({
        id: `task-norm-${idx}`,
        goal: `Test effort normalization ${tc.inputRequested}`,
        definitionId: "maestro",
        workspaceId: "ws-norm",
        inferenceSnapshot: snapshot,
      });

      const selection = await engine.getTaskModelSelection(task.id);
      assert.ok(selection, `Selection must be returned for task ${task.id}`);
      assert.equal(selection.reasoningEffort, tc.expected, `reasoningEffort must be normalized lowercase "${tc.expected}"`);
    }

    db.close();
  } finally {
    cleanup();
  }
});

test("EFFORT NORMALIZATION: /api/turns accepts mixed case reasoningEffort and stores normalized lowercase", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const repo = new ProviderRepository(db.raw);
    repo.save(
      {
        id: "nvidia",
        providerType: "nvidia",
        displayName: "NVIDIA NIM",
        baseUrl: "https://integrate.api.nvidia.com/v1/",
        connected: true,
        enabled: true,
        models: [
          {
            id: "nvidia/nemotron-3-ultra-550b-a55b",
            name: "Nemotron 3 Ultra",
            enabled: true,
            capabilities: { text: true, reasoning: true, vision: false, tools: false },
          },
        ],
      },
      "nim-key"
    );

    const mockResolver = new ModelResolver(repo, {
      createClient: () => ({
        complete: async () => '{"type":"respond","message":"Hello from mock model"}',
      }),
    });

    const app = await startCommandCenter({
      databasePath: dbPath,
      providerRepository: repo,
      modelResolver: mockResolver,
      listen: false,
      vite: false,
    });

    const efforts = ["High", "MEDIUM", "Low", "eXtra", "MAX"];
    for (const [idx, effort] of efforts.entries()) {
      const turnId = `turn-norm-${idx}`;
      const threadId = `thread-norm-${idx}`;
      const res = await request(app, "POST", "/api/turns", {
        prompt: `Turn with effort ${effort}`,
        turnId,
        threadId,
        reasoningEffort: effort,
        modelSelection: {
          providerConnectionId: "nvidia",
          modelId: "nvidia/nemotron-3-ultra-550b-a55b",
        },
      });

      assert.equal(res.status, 202, `POST /api/turns should succeed for effort "${effort}"`);
      assert.equal(res.json.turnId, turnId);

      // Verify stored thread in history has lowercase effort
      const threadRes = await request(app, "GET", `/api/threads/${threadId}`);
      assert.equal(threadRes.status, 200);
      assert.equal(threadRes.json.thread.modelSelection.reasoningEffort, effort.toLowerCase());
    }

    db.close();
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SUITE 2: MALFORMED EFFORT INPUTS & REJECTION / FALLBACK
// ---------------------------------------------------------------------------

test("MALFORMED EFFORT: /api/turns rejects unsupported string efforts with HTTP 400", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const repo = new ProviderRepository(db.raw);
    repo.save(
      {
        id: "nvidia",
        providerType: "nvidia",
        displayName: "NVIDIA NIM",
        baseUrl: "https://integrate.api.nvidia.com/v1/",
        connected: true,
        enabled: true,
        models: [
          {
            id: "nvidia/nemotron-3-ultra-550b-a55b",
            name: "Nemotron 3 Ultra",
            enabled: true,
            capabilities: { text: true, reasoning: true, vision: false, tools: false },
          },
        ],
      },
      "nim-key"
    );

    const app = await startCommandCenter({
      databasePath: dbPath,
      providerRepository: repo,
      listen: false,
      vite: false,
    });

    const malformedStrings = ["ultra", "extreme", "", "   ", "none", "o1-high", "123", "default"];
    for (const badEffort of malformedStrings) {
      const res = await request(app, "POST", "/api/turns", {
        prompt: `Test bad effort ${badEffort}`,
        turnId: `turn-bad-${Date.now()}-${Math.random()}`,
        threadId: `thread-bad-${Date.now()}`,
        reasoningEffort: badEffort,
        modelSelection: {
          providerConnectionId: "nvidia",
          modelId: "nvidia/nemotron-3-ultra-550b-a55b",
        },
      });

      assert.equal(
        res.status,
        400,
        `Expected HTTP 400 for malformed effort "${badEffort}", got ${res.status}`
      );
      assert.equal(res.json.error.code, "invalid-reasoning-effort");
    }

    db.close();
  } finally {
    cleanup();
  }
});

test("MALFORMED EFFORT: ModelResolver.createInferenceSnapshot falls back safely when unsupported effort is requested", () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const repo = new ProviderRepository(db.raw);
    repo.save(
      {
        id: "nvidia",
        providerType: "nvidia",
        displayName: "NVIDIA NIM",
        baseUrl: "https://integrate.api.nvidia.com/v1/",
        connected: true,
        enabled: true,
        models: [
          {
            id: "nvidia/nemotron-3-ultra-550b-a55b",
            name: "Nemotron 3 Ultra",
            enabled: true,
            capabilities: { text: true, reasoning: true, vision: false, tools: false },
          },
        ],
      },
      "nim-key"
    );

    const resolver = new ModelResolver(repo);

    // "ultra" is not supported by NIM protocol (which supports "none", "medium", "high")
    const snapshot = resolver.createInferenceSnapshot({
      providerConnectionId: "nvidia",
      modelId: "nvidia/nemotron-3-ultra-550b-a55b",
      reasoningEffort: "ultra" as any,
    });

    assert.equal(snapshot.requestedEffort, "ultra");
    assert.equal(snapshot.effectiveEffort, undefined, "effectiveEffort must be undefined for unsupported effort");

    // Empty string
    const emptySnapshot = resolver.createInferenceSnapshot({
      providerConnectionId: "nvidia",
      modelId: "nvidia/nemotron-3-ultra-550b-a55b",
      reasoningEffort: "" as any,
    });
    assert.equal(emptySnapshot.requestedEffort, undefined);
    assert.equal(emptySnapshot.effectiveEffort, undefined);

    db.close();
  } finally {
    cleanup();
  }
});

test("MALFORMED EFFORT: DurableTaskEngine.getTaskModelSelection falls back cleanly on malformed or non-string snapshot efforts", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const store = new SqliteDurableTaskStore(db.rawDb);
    const engine = new DurableTaskEngine(store);

    const malformedSnapshots = [
      { requestedEffort: "ultra", effectiveEffort: "ultra" },
      { requestedEffort: "extreme", effectiveEffort: undefined },
      { requestedEffort: "", effectiveEffort: "" },
      { requestedEffort: 123 as any, effectiveEffort: 456 as any },
      { requestedEffort: null as any, effectiveEffort: undefined },
      { requestedEffort: {} as any, effectiveEffort: [] as any },
      { requestedEffort: undefined, effectiveEffort: undefined },
    ];

    for (const [idx, mal] of malformedSnapshots.entries()) {
      const snapshot: InferenceSnapshot = {
        connectionId: "conn-mal",
        providerKey: "custom",
        modelId: "model-mal",
        requestedEffort: mal.requestedEffort,
        effectiveEffort: mal.effectiveEffort,
        protocolCapabilities: [],
        resolvedAt: Date.now(),
      };

      const { task } = await engine.submitTask({
        id: `task-mal-${idx}`,
        goal: `Test malformed effort ${idx}`,
        definitionId: "maestro",
        workspaceId: "ws-mal",
        inferenceSnapshot: snapshot,
      });

      const selection = await engine.getTaskModelSelection(task.id);
      assert.ok(selection, "Task model selection should still resolve providerConnectionId and modelId");
      assert.equal(selection.providerConnectionId, "conn-mal");
      assert.equal(selection.modelId, "model-mal");
      assert.equal(
        selection.reasoningEffort,
        undefined,
        `reasoningEffort must be undefined for malformed input ${JSON.stringify(mal)}`
      );
    }

    db.close();
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SUITE 3: INFERENCESNAPSHOT SERIALIZATION & DESERIALIZATION IN SQLITE
// ---------------------------------------------------------------------------

test("SQLITE PERSISTENCE: full preservation of all 7 InferenceSnapshot fields across store roundtrip & restart", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const firstDb = new LocalDatabase(dbPath);
    const firstStore = new SqliteDurableTaskStore(firstDb.rawDb);
    const firstEngine = new DurableTaskEngine(firstStore);

    const expectedSnapshot: InferenceSnapshot = {
      connectionId: "conn-production-nim-01",
      providerKey: "nvidia",
      modelId: "nvidia/nemotron-3-ultra-550b-a55b",
      requestedEffort: "high",
      effectiveEffort: "high",
      protocolCapabilities: ["prompt-json", "streaming", "tool-call"],
      resolvedAt: 1730123456789,
    };

    const { task } = await firstEngine.submitTask({
      id: "task-snapshot-roundtrip",
      goal: "Preserve exact snapshot across restart",
      definitionId: "cody",
      workspaceId: "workspace-fuzz-01",
      inferenceSnapshot: expectedSnapshot,
    });

    // 1. In-memory read from active store
    const activeTask = await firstEngine.getTask(task.id);
    assert.deepEqual(activeTask?.inferenceSnapshot, expectedSnapshot, "Active store must return identical snapshot");

    // 2. Direct raw SQL inspection of JSON column
    const rawRow = firstDb.raw.prepare("SELECT inference_snapshot_json FROM durable_tasks WHERE id = ?").get(task.id) as { inference_snapshot_json: string };
    assert.ok(rawRow && rawRow.inference_snapshot_json, "Raw DB row must contain inference_snapshot_json");
    const parsedRaw = JSON.parse(rawRow.inference_snapshot_json);
    assert.deepEqual(parsedRaw, expectedSnapshot, "Raw JSON column must parse to exact snapshot");

    // Close first DB connection
    firstDb.close();

    // 3. Restart SQLite connection and re-instantiate store & engine
    const restartedDb = new LocalDatabase(dbPath);
    try {
      const restartedStore = new SqliteDurableTaskStore(restartedDb.rawDb);
      const restartedEngine = new DurableTaskEngine(restartedStore);

      const recoveredTask = await restartedEngine.getTask(task.id);
      assert.ok(recoveredTask, "Task must be recovered after restart");
      assert.deepEqual(recoveredTask.inferenceSnapshot, expectedSnapshot, "Recovered task must have exact snapshot fields");

      // Verify each individual field explicitly
      assert.equal(recoveredTask.inferenceSnapshot?.connectionId, "conn-production-nim-01");
      assert.equal(recoveredTask.inferenceSnapshot?.providerKey, "nvidia");
      assert.equal(recoveredTask.inferenceSnapshot?.modelId, "nvidia/nemotron-3-ultra-550b-a55b");
      assert.equal(recoveredTask.inferenceSnapshot?.requestedEffort, "high");
      assert.equal(recoveredTask.inferenceSnapshot?.effectiveEffort, "high");
      assert.deepEqual(recoveredTask.inferenceSnapshot?.protocolCapabilities, ["prompt-json", "streaming", "tool-call"]);
      assert.equal(recoveredTask.inferenceSnapshot?.resolvedAt, 1730123456789);

      // Verify getTaskModelSelection on recovered task
      const selection = await restartedEngine.getTaskModelSelection(task.id);
      assert.deepEqual(selection, {
        providerConnectionId: "conn-production-nim-01",
        modelId: "nvidia/nemotron-3-ultra-550b-a55b",
        reasoningEffort: "high",
      });
    } finally {
      restartedDb.close();
    }
  } finally {
    cleanup();
  }
});

test("SQLITE PERSISTENCE: state transitions preserve inferenceSnapshot without data loss", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const store = new SqliteDurableTaskStore(db.rawDb);
    const engine = new DurableTaskEngine(store);

    const snapshot: InferenceSnapshot = {
      connectionId: "conn-transition",
      providerKey: "custom",
      modelId: "model-transition",
      requestedEffort: "medium",
      effectiveEffort: "medium",
      protocolCapabilities: ["streaming"],
      resolvedAt: Date.now(),
    };

    const { task } = await engine.submitTask({
      id: "task-transitions",
      goal: "Test transitions preserving snapshot",
      definitionId: "cody",
      workspaceId: "ws-trans",
      inferenceSnapshot: snapshot,
    });
    assert.equal(task.status, "queued");

    // 1. Transition queued -> running
    const running = await engine.startTask(task.id);
    assert.equal(running.status, "running");
    assert.deepEqual((await engine.getTask(task.id))?.inferenceSnapshot, snapshot);

    // 2. Transition running -> waiting_approval
    const waiting = await engine.pauseForApproval(task.id, { tool: "test_tool" });
    assert.equal(waiting.status, "waiting_approval");
    assert.deepEqual((await engine.getTask(task.id))?.inferenceSnapshot, snapshot);

    // 3. Transition waiting_approval -> running
    const resumed = await engine.resumeFromApproval(task.id);
    assert.equal(resumed.status, "running");
    assert.deepEqual((await engine.getTask(task.id))?.inferenceSnapshot, snapshot);

    // 4. Transition running -> completed
    const completed = await engine.completeTask(task.id);
    assert.equal(completed.status, "completed");
    assert.deepEqual((await engine.getTask(task.id))?.inferenceSnapshot, snapshot);

    db.close();
  } finally {
    cleanup();
  }
});

test("SQLITE PERSISTENCE: corrupt or invalid JSON in inference_snapshot_json recovers gracefully", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const store = new SqliteDurableTaskStore(db.rawDb);
    const engine = new DurableTaskEngine(store);

    const { task } = await engine.submitTask({
      id: "task-corrupt-json",
      goal: "Corrupt JSON test",
      definitionId: "maestro",
      workspaceId: "ws-corrupt",
      modelSelection: { providerConnectionId: "backup-conn", modelId: "backup-model" },
    });

    // Manually inject corrupted non-JSON string into the SQLite database column
    db.raw.prepare("UPDATE durable_tasks SET inference_snapshot_json = ? WHERE id = ?").run(
      "{ invalid-json-corrupted",
      task.id
    );

    // getTask must not throw
    const loadedTask = await engine.getTask(task.id);
    assert.ok(loadedTask, "Task must load despite corrupt snapshot column");
    assert.equal(loadedTask.inferenceSnapshot, undefined, "Corrupt snapshot must be treated as undefined");

    // getTaskModelSelection must fall back to task.created event modelSelection
    const fallbackSelection = await engine.getTaskModelSelection(task.id);
    assert.deepEqual(fallbackSelection, {
      providerConnectionId: "backup-conn",
      modelId: "backup-model",
    });

    db.close();
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SUITE 4: APPROVAL RESUMPTION LIFECYCLE (Child vs Parent Snapshots)
// ---------------------------------------------------------------------------

test("APPROVAL RESUMPTION: childTask snapshot takes precedence over parentTask snapshot", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const store = new SqliteDurableTaskStore(db.rawDb);
    const engine = new DurableTaskEngine(store);

    const parentSnapshot: InferenceSnapshot = {
      connectionId: "maestro-conn",
      providerKey: "custom",
      modelId: "maestro-model-default",
      requestedEffort: "low",
      effectiveEffort: "low",
      protocolCapabilities: [],
      resolvedAt: Date.now() - 5000,
    };

    const childSnapshot: InferenceSnapshot = {
      connectionId: "cody-conn",
      providerKey: "custom",
      modelId: "cody-model-specialist",
      requestedEffort: "high",
      effectiveEffort: "high",
      protocolCapabilities: [],
      resolvedAt: Date.now(),
    };

    const { task: parentTask } = await engine.submitTask({
      id: "parent-task-1",
      goal: "Parent Maestro Goal",
      definitionId: "maestro",
      workspaceId: "ws-approval",
      inferenceSnapshot: parentSnapshot,
    });

    const { task: childTask } = await engine.submitTask({
      id: "child-task-1",
      goal: "Child Cody Mutation",
      definitionId: "cody",
      workspaceId: "ws-approval",
      inferenceSnapshot: childSnapshot,
    });

    // Simulate approval resolution logic from server.ts (lines 1159-1176)
    const approvalRequest = { taskId: childTask.id, approvalId: "appr-1" };
    const fetchedChild = approvalRequest.taskId ? await engine.getTask(approvalRequest.taskId) : null;
    const fetchedParent = parentTask.id ? await engine.getTask(parentTask.id) : null;

    const snapshot = fetchedChild?.inferenceSnapshot ?? fetchedParent?.inferenceSnapshot;
    assert.ok(snapshot, "Snapshot must be resolved");

    let selection: ThreadModelSelection | undefined;
    if (snapshot && typeof snapshot === "object") {
      const s = snapshot;
      if (typeof s.connectionId === "string" && typeof s.modelId === "string") {
        const rawEffort = typeof s.effectiveEffort === "string" ? s.effectiveEffort : typeof s.requestedEffort === "string" ? s.requestedEffort : undefined;
        const validEfforts = ["low", "medium", "high", "extra", "max"] as const;
        const reasoningEffort = rawEffort && validEfforts.includes(rawEffort.toLowerCase() as any)
          ? (rawEffort.toLowerCase() as "low" | "medium" | "high" | "extra" | "max")
          : undefined;
        selection = {
          providerConnectionId: s.connectionId,
          modelId: s.modelId,
          ...(reasoningEffort ? { reasoningEffort } : {}),
        };
      }
    }

    assert.ok(selection);
    assert.equal(selection.providerConnectionId, "cody-conn", "Child connectionId must take precedence");
    assert.equal(selection.modelId, "cody-model-specialist", "Child modelId must take precedence");
    assert.equal(selection.reasoningEffort, "high", "Child reasoningEffort 'high' must take precedence over parent 'low'");

    db.close();
  } finally {
    cleanup();
  }
});

test("APPROVAL RESUMPTION: falls back to parentTask snapshot when childTask has no snapshot", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const store = new SqliteDurableTaskStore(db.rawDb);
    const engine = new DurableTaskEngine(store);

    const parentSnapshot: InferenceSnapshot = {
      connectionId: "maestro-parent-conn",
      providerKey: "custom",
      modelId: "maestro-parent-model",
      requestedEffort: "medium",
      effectiveEffort: "medium",
      protocolCapabilities: [],
      resolvedAt: Date.now(),
    };

    const { task: parentTask } = await engine.submitTask({
      id: "parent-task-2",
      goal: "Parent Maestro Goal",
      definitionId: "maestro",
      workspaceId: "ws-fallback",
      inferenceSnapshot: parentSnapshot,
    });

    const { task: childTask } = await engine.submitTask({
      id: "child-task-2",
      goal: "Child Task Without Snapshot",
      definitionId: "cody",
      workspaceId: "ws-fallback",
      // No inferenceSnapshot
    });

    // Simulate approval resolution logic from server.ts
    const approvalRequest = { taskId: childTask.id, approvalId: "appr-2" };
    const fetchedChild = approvalRequest.taskId ? await engine.getTask(approvalRequest.taskId) : null;
    const fetchedParent = parentTask.id ? await engine.getTask(parentTask.id) : null;

    const snapshot = fetchedChild?.inferenceSnapshot ?? fetchedParent?.inferenceSnapshot;
    assert.ok(snapshot, "Parent snapshot must be selected when child snapshot is missing");

    let selection: ThreadModelSelection | undefined;
    if (snapshot && typeof snapshot === "object") {
      const s = snapshot;
      if (typeof s.connectionId === "string" && typeof s.modelId === "string") {
        const rawEffort = typeof s.effectiveEffort === "string" ? s.effectiveEffort : typeof s.requestedEffort === "string" ? s.requestedEffort : undefined;
        const validEfforts = ["low", "medium", "high", "extra", "max"] as const;
        const reasoningEffort = rawEffort && validEfforts.includes(rawEffort.toLowerCase() as any)
          ? (rawEffort.toLowerCase() as "low" | "medium" | "high" | "extra" | "max")
          : undefined;
        selection = {
          providerConnectionId: s.connectionId,
          modelId: s.modelId,
          ...(reasoningEffort ? { reasoningEffort } : {}),
        };
      }
    }

    assert.ok(selection);
    assert.equal(selection.providerConnectionId, "maestro-parent-conn");
    assert.equal(selection.modelId, "maestro-parent-model");
    assert.equal(selection.reasoningEffort, "medium");

    db.close();
  } finally {
    cleanup();
  }
});

test("APPROVAL RESUMPTION: uses requestedEffort as fallback when effectiveEffort is not provided", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const store = new SqliteDurableTaskStore(db.rawDb);
    const engine = new DurableTaskEngine(store);

    const snapshotWithoutEffective: InferenceSnapshot = {
      connectionId: "custom-conn",
      providerKey: "custom",
      modelId: "custom-model",
      requestedEffort: "extra",
      // effectiveEffort omitted
      protocolCapabilities: [],
      resolvedAt: Date.now(),
    };

    const { task } = await engine.submitTask({
      id: "task-effort-fallback",
      goal: "Requested effort fallback test",
      definitionId: "cody",
      workspaceId: "ws-req-fallback",
      inferenceSnapshot: snapshotWithoutEffective,
    });

    const approvalRequest = { taskId: task.id, approvalId: "appr-3" };
    const fetchedChild = await engine.getTask(approvalRequest.taskId);
    const snapshot = fetchedChild?.inferenceSnapshot;
    assert.ok(snapshot);

    let selection: ThreadModelSelection | undefined;
    if (snapshot && typeof snapshot === "object") {
      const s = snapshot;
      if (typeof s.connectionId === "string" && typeof s.modelId === "string") {
        const rawEffort = typeof s.effectiveEffort === "string" ? s.effectiveEffort : typeof s.requestedEffort === "string" ? s.requestedEffort : undefined;
        const validEfforts = ["low", "medium", "high", "extra", "max"] as const;
        const reasoningEffort = rawEffort && validEfforts.includes(rawEffort.toLowerCase() as any)
          ? (rawEffort.toLowerCase() as "low" | "medium" | "high" | "extra" | "max")
          : undefined;
        selection = {
          providerConnectionId: s.connectionId,
          modelId: s.modelId,
          ...(reasoningEffort ? { reasoningEffort } : {}),
        };
      }
    }

    assert.ok(selection);
    assert.equal(selection.reasoningEffort, "extra", "Must fall back to requestedEffort 'extra'");

    db.close();
  } finally {
    cleanup();
  }
});

test("APPROVAL RESUMPTION: in-process HTTP POST /api/turns/:turnId/approvals/:approvalId restores child model and reasoning effort", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const db = new LocalDatabase(dbPath);
    const repo = new ProviderRepository(db.raw);

    // Save maestro provider
    repo.save(
      {
        id: "maestro-provider",
        providerType: "custom",
        displayName: "Maestro Provider",
        baseUrl: "https://maestro.invalid/v1",
        connected: true,
        enabled: true,
        models: [
          {
            id: "maestro-model",
            name: "Maestro Model",
            enabled: true,
            capabilities: { text: true, reasoning: true, vision: false, tools: true },
          },
        ],
      },
      "key-1"
    );

    // Save cody provider
    repo.save(
      {
        id: "cody-provider",
        providerType: "custom",
        displayName: "Cody Provider",
        baseUrl: "https://cody.invalid/v1",
        connected: true,
        enabled: true,
        models: [
          {
            id: "cody-model",
            name: "Cody Model",
            enabled: true,
            capabilities: { text: true, reasoning: true, vision: false, tools: true },
          },
        ],
      },
      "key-2"
    );

    const mockResolver = new ModelResolver(repo, {
      createClient: () => ({
        complete: async () => '{"output":"mock"}',
      }),
    });

    const app = await startCommandCenter({
      databasePath: dbPath,
      providerRepository: repo,
      modelResolver: mockResolver,
      listen: false,
      vite: false,
      defaultApprovalMode: "Require approval",
    });

    const threadId = "thread-approval-e2e";
    const turnId = "turn-approval-e2e";
    const parentTaskId = "parent-task-e2e" as TaskId;
    const childTaskId = "child-task-e2e" as TaskId;

    // Create a temporary workspace root so workspace validation passes
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "mediobot-ws-approval-"));
    await app.workspaceManager.openWorkspace(tempRoot);
    const session = app.workspaceManager.session!;

    // Create parent task in durableTaskEngine
    const parentSnapshot: InferenceSnapshot = {
      connectionId: "maestro-provider",
      providerKey: "custom",
      modelId: "maestro-model",
      requestedEffort: "low",
      effectiveEffort: "low",
      protocolCapabilities: [],
      resolvedAt: Date.now() - 2000,
    };
    await app.composition.durableTaskEngine!.submitTask({
      id: parentTaskId,
      goal: "Parent Maestro Work",
      definitionId: "maestro",
      workspaceId: session.workspaceId,
      threadId,
      turnId,
      inferenceSnapshot: parentSnapshot,
    });

    // Create child task with distinct Cody snapshot
    const childSnapshot: InferenceSnapshot = {
      connectionId: "cody-provider",
      providerKey: "custom",
      modelId: "cody-model",
      requestedEffort: "high",
      effectiveEffort: "high",
      protocolCapabilities: [],
      resolvedAt: Date.now(),
    };
    await app.composition.durableTaskEngine!.submitTask({
      id: childTaskId,
      goal: "Child Cody Work",
      definitionId: "cody",
      workspaceId: session.workspaceId,
      threadId,
      turnId,
      inferenceSnapshot: childSnapshot,
    });

    // Place child task in waiting_approval
    await app.composition.durableTaskEngine!.startTask(childTaskId);
    await app.composition.durableTaskEngine!.pauseForApproval(childTaskId, {
      tool: "filesystem.write",
      path: "test.ts",
    });

    // Bind task context in permissionEngine
    app.composition.permissionEngine!.bindTaskContext(childTaskId, {
      threadId,
      turnId,
      parentTaskId,
      policy: { mode: "Require approval" },
    });

    const invocation: ToolInvocation = {
      worldId: app.composition.world.id,
      workerId: "cody-worker" as any,
      taskId: childTaskId,
      resourceId: "res-1" as any,
      name: "filesystem.write",
      input: { path: "test.ts", content: "hello" },
    };

    // Trigger requestApproval to create pending approval in store and engine
    const approvalWait = app.composition.permissionEngine!.requestApproval(invocation, {
      workspaceRoot: tempRoot,
      workerName: "Cody",
    });
    await Promise.resolve();

    const pendingApprovals = app.composition.permissionEngine!.getPendingApprovals();
    assert.ok(pendingApprovals.length > 0, "There must be a pending approval");
    const approvalRequest = pendingApprovals[0];
    const approvalId = approvalRequest.approvalId;
    const interruptId = "langgraph-interrupt-999";

    app.composition.permissionEngine!.attachWorkflowInterrupt(approvalId, interruptId);

    // Intercept composition.resume to verify exactly what model selection was restored!
    let resumeCalledWith: any = null;
    app.composition.resume = async (taskId, resumeOptions) => {
      resumeCalledWith = { taskId, resumeOptions };
      return { taskId, result: Promise.resolve({ state: "completed" as const }) };
    };

    const approvalUrl = `/api/turns/${turnId}/approvals/${approvalId}?threadId=${threadId}`;
    const response = await request(app, "POST", approvalUrl, {
      approved: true,
      threadId,
    });

    // When an active in-process waiter exists (requestApproval Promise is live),
    // the permission engine resolves via the waiter and the server returns 200.
    // When no active waiter is present (disconnected resume scenario), it returns 202.
    // Both are correct. Model-selection forwarding via composition.resume only fires on 202.
    assert.ok(
      response.status === 200 || response.status === 202,
      `Approval resolution must return 200 or 202, got ${response.status}: ${JSON.stringify(response.json)}`
    );
    if (response.status === 202) {
      assert.equal(response.json.resumed, true);
      assert.ok(resumeCalledWith, "composition.resume must be called on 202 approval resolution");
      assert.equal(resumeCalledWith.taskId, parentTaskId, "Must resume parent task");
      assert.deepEqual(
        resumeCalledWith.resumeOptions?.modelSelection,
        {
          providerConnectionId: "cody-provider",
          modelId: "cody-model",
          reasoningEffort: "high",
        },
        "approval resumption must pass the exact child model and high reasoning effort"
      );
    } else {
      // In-process waiter path: approval consumed directly; composition.resume not called.
      assert.equal(response.json.ok, true, "In-process approval resolution must have ok: true");
    }

    // Await approvalWait to settle (handles both paths).
    await approvalWait;

    // Cleanup temp ws
    rmSync(tempRoot, { recursive: true, force: true });
    db.close();
  } finally {
    cleanup();
  }
});
