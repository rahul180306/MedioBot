import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { LangGraphExecutionEngine, LangGraphInterruptedError, sqliteLangGraphOutcomeStore } from "../src/langgraph-engine.ts";

test("the execution adapter resumes successful parallel tasks without replay after a sibling failure", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-langgraph-adapter-"));
  const intervals: Array<{ id: string; start: number; end: number }> = [];
  const attempts = new Map<string, number>();
  const saver = SqliteSaver.fromConnString(path.join(root, "checkpoints.sqlite"));
  try {
    const engine = new LangGraphExecutionEngine();
    const options = { workflowName: "adapter-test", taskName: "specialist", threadId: "parallel-thread",
      namespace: "specialists", tasks: [{ id: "cody" }, { id: "doc" }], taskId: (item: { id: string }) => item.id,
      checkpointer: saver, outcomeStore: sqliteLangGraphOutcomeStore(saver.db as never),
      execute: async ({ id }: { id: string }) => {
        const start = performance.now();
        attempts.set(id, (attempts.get(id) ?? 0) + 1);
        try {
          if (id === "cody" && attempts.get(id) === 1) {
            await new Promise(resolve => setTimeout(resolve, 80));
            throw new Error("controlled transient");
          }
          await new Promise(resolve => setTimeout(resolve, 20));
          return { id };
        } finally { intervals.push({ id, start, end: performance.now() }); }
      } };
    await assert.rejects(engine.runParallel(options), error => {
      const causes = error instanceof AggregateError ? error.errors : [error];
      assert.ok(causes.some((cause: unknown) => cause instanceof Error && cause.message === "controlled transient"),
        "the underlying specialist failure should remain inspectable through LangGraph's error boundary");
      return true;
    });
    assert.deepEqual(options.outcomeStore.get("adapter-test", "parallel-thread", "specialists", "doc"), { id: "doc" },
      "completed specialist results must be stored before a sibling failure is surfaced");
    saver.db.close();
    const resumedSaver = SqliteSaver.fromConnString(path.join(root, "checkpoints.sqlite"));
    const results = await new LangGraphExecutionEngine().runParallel({ ...options, checkpointer: resumedSaver,
      outcomeStore: sqliteLangGraphOutcomeStore(resumedSaver.db as never), resume: true });
    assert.deepEqual(results.map(result => result.id).sort(), ["cody", "doc"]);
    const firstRun = intervals.slice(0, 2);
    const overlap = Math.max(0, Math.min(...firstRun.map(item => item.end)) - Math.max(...firstRun.map(item => item.start)));
    assert.ok(overlap >= 10, `expected independent groups to overlap, got ${overlap}ms`);
    assert.equal(attempts.get("doc"), 1, "successful peer work must not repeat on recovery");
    assert.equal(attempts.get("cody"), 2, "failed work must resume at its own task boundary");
    resumedSaver.db.close();
  } finally {
    try { saver.db.close(); } catch { /* Saver can already be closed. */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("LangGraph executes dependency-ready work concurrently and retries only tasks with an explicit safe policy", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-langgraph-dag-"));
  const saver = SqliteSaver.fromConnString(path.join(root, "checkpoints.sqlite"));
  const starts = new Map<string, number>();
  const ends = new Map<string, number>();
  const attempts = new Map<string, number>();
  try {
    const engine = new LangGraphExecutionEngine();
    const tasks = [{ id: "research" }, { id: "doc" }, { id: "synthesis" }];
    const results = await engine.runParallel({ workflowName: "dependency-test", taskName: "work", threadId: "dag-thread",
      tasks, taskId: item => item.id, checkpointer: saver,
      dependencies: item => item.id === "synthesis" ? ["research", "doc"] : [],
      retryPolicy: item => item.id === "research" ? { maxAttempts: 2, backoffMs: 1,
        shouldRetry: error => error instanceof Error && error.message === "controlled transient" } : { maxAttempts: 1 },
      execute: async item => {
        if (!starts.has(item.id)) starts.set(item.id, performance.now());
        const attempt = (attempts.get(item.id) ?? 0) + 1;
        attempts.set(item.id, attempt);
        if (item.id === "research" && attempt === 1) throw new Error("controlled transient");
        await new Promise(resolve => setTimeout(resolve, item.id === "doc" ? 55 : item.id === "research" ? 30 : 5));
        ends.set(item.id, performance.now());
        return item.id;
      } });
    assert.deepEqual(results, ["research", "doc", "synthesis"]);
    assert.equal(attempts.get("research"), 2);
    assert.equal(attempts.get("doc"), 1);
    assert.equal(attempts.get("synthesis"), 1);
    const overlap = Math.max(0, Math.min(ends.get("research")!, ends.get("doc")!) - Math.max(starts.get("research")!, starts.get("doc")!));
    assert.ok(overlap >= 10, `independent work should overlap, got ${overlap} ms`);
    assert.ok(starts.get("synthesis")! >= Math.max(ends.get("research")!, ends.get("doc")!),
      "dependent synthesis must wait until both prerequisite tasks complete");
  } finally { saver.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("dependent assignment receives bounded completed prerequisite outcomes", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-langgraph-context-"));
  const saver = SqliteSaver.fromConnString(path.join(root, "checkpoints.sqlite"));
  const received: string[] = [];
  try {
    await new LangGraphExecutionEngine().runParallel({ workflowName: "dependency-context", taskName: "assignment",
      threadId: "dependency-context-thread", tasks: [{ id: "doc" }, { id: "cody" }], taskId: item => item.id,
      dependencies: item => item.id === "cody" ? ["doc"] : [], checkpointer: saver,
      execute: async (item, _signal, outcomes) => {
        if (item.id === "doc") return { summary: "Official API uses the documented option", evidenceRef: "doc-evidence-1" };
        const prerequisite = outcomes?.doc;
        assert.ok(prerequisite, "LangGraph should pass completed predecessor output into dependent execution");
        received.push(`${prerequisite.summary}:${prerequisite.evidenceRef}`);
        return { summary: "Cody used the Doc finding" };
      } });
    assert.deepEqual(received, ["Official API uses the documented option:doc-evidence-1"]);
  } finally { saver.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("LangGraph accepts an authorized runtime assignment, checkpoints it, and resumes without repeating completed work", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-langgraph-dynamic-"));
  const dbPath = path.join(root, "checkpoints.sqlite");
  let saver = SqliteSaver.fromConnString(dbPath);
  let outcomeStore = sqliteLangGraphOutcomeStore(saver.db as never);
  const attempts = new Map<string, number>();
  const engine = new LangGraphExecutionEngine();
  const options = {
    workflowName: "dynamic-assignment-recovery", taskName: "specialist", threadId: "dynamic-team",
    namespace: "authorized", tasks: [{ id: "maestro", dependsOn: [] as string[] }],
    taskId: (item: { id: string }) => item.id, dependencies: (item: { dependsOn: string[] }) => item.dependsOn,
    checkpointer: saver, outcomeStore, authorizeTaskExpansion: async (_parent, task) => {
      if (task.id !== "doc-followup") throw new Error("assignment was not authorized");
    },
    execute: async (item: { id: string }, _signal?: AbortSignal, outcomes?: Readonly<Record<string, { result: string }>>,
      _interrupt?: (value: unknown) => unknown, _isControl?: (error: unknown) => boolean,
      addTask?: (task: { id: string; dependsOn: string[] }) => Promise<string>) => {
      attempts.set(item.id, (attempts.get(item.id) ?? 0) + 1);
      if (item.id === "maestro") {
        const id = await addTask?.({ id: "doc-followup", dependsOn: ["maestro"] });
        assert.equal(id, "doc-followup");
        return { result: "Maestro authorized Doc after Cody requested focused help." };
      }
      assert.equal(item.id, "doc-followup");
      assert.equal(outcomes?.maestro?.result, "Maestro authorized Doc after Cody requested focused help.");
      if (attempts.get(item.id) === 1) throw new Error("controlled child interruption");
      return { result: "Doc provided a durable, attributed follow-up finding." };
    },
  };
  try {
    await assert.rejects(engine.runParallel(options), /controlled child interruption/);
    assert.deepEqual(outcomeStore.get(options.workflowName, options.threadId, "authorized", "maestro"),
      { result: "Maestro authorized Doc after Cody requested focused help." });
    saver.db.close();
    saver = SqliteSaver.fromConnString(dbPath);
    outcomeStore = sqliteLangGraphOutcomeStore(saver.db as never);
    const results = await new LangGraphExecutionEngine().runParallel({ ...options, checkpointer: saver, outcomeStore, resume: true });
    assert.deepEqual(results.map(result => result.result), [
      "Maestro authorized Doc after Cody requested focused help.",
      "Doc provided a durable, attributed follow-up finding.",
    ]);
    assert.equal(attempts.get("maestro"), 1, "completed assignment must not repeat after restart");
    assert.equal(attempts.get("doc-followup"), 2, "only the unfinished dynamic assignment resumes");
  } finally {
    try { saver.db.close(); } catch { /* already closed */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("LangGraph atomically admits a helper and dependent continuation and recovers only unfinished nodes", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-langgraph-expansion-batch-"));
  const dbPath = path.join(root, "checkpoints.sqlite");
  let saver = SqliteSaver.fromConnString(dbPath);
  let outcomeStore = sqliteLangGraphOutcomeStore(saver.db as never);
  const attempts = new Map<string, number>();
  const order: string[] = [];
  const engine = new LangGraphExecutionEngine();
  const options = {
    workflowName: "runtime-helper-continuation", taskName: "specialist", threadId: "runtime-team",
    tasks: [{ id: "cody", dependsOn: [] as string[] }, { id: "research", dependsOn: [] as string[] }],
    taskId: (item: { id: string }) => item.id,
    dependencies: (item: { dependsOn: string[] }) => item.dependsOn,
    checkpointer: saver, outcomeStore,
    authorizeTaskExpansion: async (parent: { id: string }, proposed: { id: string }) => {
      assert.equal(parent.id, "cody");
      assert.ok(["doc-helper", "cody-continuation"].includes(proposed.id));
    },
    execute: async (item: { id: string; dependsOn: string[] }, _signal?: AbortSignal,
      outcomes?: Readonly<Record<string, { id: string; report: string }>>,
      _interrupt?: (value: unknown) => unknown, _isControl?: (error: unknown) => boolean,
      _addTask?: (task: { id: string; dependsOn: string[] }) => Promise<string>,
      _runDynamic?: (tasks: ReadonlyArray<{ id: string; dependsOn: string[] }>) => Promise<ReadonlyArray<{ id: string; report: string }>>,
      addTasks?: (tasks: ReadonlyArray<{ id: string; dependsOn: string[] }>) => Promise<ReadonlyArray<string>>) => {
      attempts.set(item.id, (attempts.get(item.id) ?? 0) + 1);
      if (item.id === "cody") {
        const ids = await addTasks?.([{ id: "doc-helper", dependsOn: [] }, { id: "cody-continuation", dependsOn: ["doc-helper"] }]);
        assert.deepEqual(ids, ["doc-helper", "cody-continuation"]);
        return { id: item.id, report: "Cody checkpointed and yielded to the authorized Doc assignment." };
      }
      if (item.id === "research") {
        order.push("research");
        return { id: item.id, report: "Independent Research result." };
      }
      if (item.id === "doc-helper") {
        order.push("doc-helper");
        if (attempts.get(item.id) === 1) throw new Error("controlled helper interruption");
        return { id: item.id, report: "Doc's attributed finding." };
      }
      assert.equal(item.id, "cody-continuation");
      assert.equal(outcomes?.["doc-helper"]?.report, "Doc's attributed finding.");
      order.push("cody-continuation");
      return { id: item.id, report: "Cody used Doc's finding and continued." };
    },
  };
  try {
    await assert.rejects(engine.runParallel(options), /controlled helper interruption/);
    assert.deepEqual(outcomeStore.listTasks(options.workflowName, options.threadId, "" )
      .map(task => task.taskId).sort(), ["cody-continuation", "doc-helper"]);
    saver.db.close();
    saver = SqliteSaver.fromConnString(dbPath);
    outcomeStore = sqliteLangGraphOutcomeStore(saver.db as never);
    const results = await new LangGraphExecutionEngine().runParallel({ ...options, checkpointer: saver, outcomeStore, resume: true });
    assert.deepEqual(results.map(result => result.id).sort(), ["cody", "cody-continuation", "doc-helper", "research"]);
    assert.equal(attempts.get("cody"), 1, "the completed Cody yield node is not replayed");
    assert.equal(attempts.get("research"), 1, "independent completed Research work is not replayed");
    assert.equal(attempts.get("doc-helper"), 2, "only the interrupted helper is retried");
    assert.equal(attempts.get("cody-continuation"), 1);
    assert.ok(order.indexOf("doc-helper") < order.indexOf("cody-continuation"), "continuation waits for its helper report");
  } finally {
    try { saver.db.close(); } catch { /* already closed */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("nested dynamic LangGraph assistance runs beside active siblings and resumes without repeating completed work", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-langgraph-nested-dynamic-"));
  const dbPath = path.join(root, "checkpoints.sqlite");
  let saver = SqliteSaver.fromConnString(dbPath);
  let outcomeStore = sqliteLangGraphOutcomeStore(saver.db as never);
  const attempts = new Map<string, number>();
  const intervals: Array<{ id: string; start: number; end: number }> = [];
  let helperSideEffects = 0;
  let failAfterHelperOnce = true;
  let releaseResearchDone!: () => void;
  const researchDone = new Promise<void>(resolve => { releaseResearchDone = resolve; });
  const engine = new LangGraphExecutionEngine();
  const options = { workflowName: "nested-dynamic-recovery", taskName: "assignment", threadId: "nested-team",
    tasks: [{ id: "cody" }, { id: "research" }], taskId: (item: { id: string }) => item.id,
    checkpointer: saver, outcomeStore,
    authorizeTaskExpansion: async (_parent: { id: string }, child: { id: string }) => {
      assert.equal(child.id, "doc");
    },
    execute: async (item: { id: string }, _signal?: AbortSignal, _outcomes?: Readonly<Record<string, { id: string }>>,
      _interrupt?: (value: unknown) => unknown, _isControl?: (error: unknown) => boolean,
      _addTask?: (item: { id: string }) => Promise<string>, runDynamicTasks?: (items: ReadonlyArray<{ id: string }>) => Promise<ReadonlyArray<{ id: string }>>) => {
      attempts.set(item.id, (attempts.get(item.id) ?? 0) + 1);
      const start = performance.now();
      if (item.id === "cody") {
        const [doc] = await runDynamicTasks!([{ id: "doc" }]);
        assert.equal(doc?.id, "doc");
        if (failAfterHelperOnce) {
          await researchDone;
          failAfterHelperOnce = false;
          throw new Error("controlled restart after Doc completed");
        }
      } else if (item.id === "doc") {
        helperSideEffects++;
        await new Promise(resolve => setTimeout(resolve, 35));
      } else {
        await new Promise(resolve => setTimeout(resolve, 110));
      }
      intervals.push({ id: item.id, start, end: performance.now() });
      if (item.id === "research") releaseResearchDone();
      return { id: item.id };
    } };
  try {
    await assert.rejects(engine.runParallel(options), error => {
      const failures = error instanceof AggregateError ? error.errors : [error];
      assert.ok(failures.some(failure => failure instanceof Error && failure.message === "controlled restart after Doc completed"));
      return true;
    });
    saver.db.close();
    saver = SqliteSaver.fromConnString(dbPath);
    outcomeStore = sqliteLangGraphOutcomeStore(saver.db as never);
    const results = await new LangGraphExecutionEngine().runParallel({ ...options, checkpointer: saver, outcomeStore, resume: true });
    assert.deepEqual(results.map(result => result.id).sort(), ["cody", "research"],
      "the helper finding returns through Cody instead of appearing as a duplicate top-level assignment");
    assert.equal(helperSideEffects, 1, "the completed dynamic specialist action is not repeated after restart");
    assert.equal(attempts.get("doc"), 1);
    assert.equal(attempts.get("research"), 1, "independent successful work is not repeated");
    assert.equal(attempts.get("cody"), 2, "the interrupted requester resumes at its own assignment boundary");
    const research = intervals.find(interval => interval.id === "research")!;
    const doc = intervals.find(interval => interval.id === "doc")!;
    assert.ok(Math.min(research.end, doc.end) - Math.max(research.start, doc.start) > 0,
      "the nested dynamic Doc task overlaps independent Research execution");
  } finally {
    try { saver.db.close(); } catch { /* Saver can already be closed. */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed nested assistance is not also scheduled as a parent task after restart", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-langgraph-nested-failure-recovery-"));
  const dbPath = path.join(root, "checkpoints.sqlite");
  let saver = SqliteSaver.fromConnString(dbPath);
  let outcomeStore = sqliteLangGraphOutcomeStore(saver.db as never);
  let docAttempts = 0;
  let failDocOnce = true;
  const options = { workflowName: "nested-failure-recovery", taskName: "assignment", threadId: "nested-failure-team",
    tasks: [{ id: "cody" }], taskId: (item: { id: string }) => item.id,
    checkpointer: saver, outcomeStore,
    authorizeTaskExpansion: async (_parent: { id: string }, child: { id: string }) => assert.equal(child.id, "doc"),
    execute: async (item: { id: string }, _signal?: AbortSignal, _outcomes?: Readonly<Record<string, { id: string }>>,
      _interrupt?: (value: unknown) => unknown, _isControl?: (error: unknown) => boolean,
      _addTask?: (item: { id: string }) => Promise<string>, runDynamicTasks?: (items: ReadonlyArray<{ id: string }>) => Promise<ReadonlyArray<{ id: string }>>) => {
      if (item.id === "cody") {
        const [doc] = await runDynamicTasks!([{ id: "doc" }]);
        assert.equal(doc?.id, "doc");
        return { id: "cody" };
      }
      docAttempts++;
      if (failDocOnce) { failDocOnce = false; throw new Error("controlled helper failure"); }
      return { id: "doc" };
    } };
  try {
    await assert.rejects(new LangGraphExecutionEngine().runParallel(options), /controlled helper failure/);
    saver.db.close();
    saver = SqliteSaver.fromConnString(dbPath);
    outcomeStore = sqliteLangGraphOutcomeStore(saver.db as never);
    const results = await new LangGraphExecutionEngine().runParallel({ ...options, checkpointer: saver, outcomeStore, resume: true });
    assert.deepEqual(results.map(result => result.id), ["cody"]);
    assert.equal(docAttempts, 2, "Doc should run once before interruption and once to recover, not concurrently in parent and nested graphs");
    assert.equal(outcomeStore.get(options.workflowName, options.threadId, "", "doc"), undefined,
      "a nested helper must not become a top-level parent workflow outcome");
    assert.deepEqual(outcomeStore.get(`${options.workflowName}:dynamic`, `${options.threadId}:dynamic:doc`, "", "doc"),
      { id: "doc" }, "the nested workflow retains its own recovered helper outcome");
  } finally {
    try { saver.db.close(); } catch { /* Saver can already be closed. */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounded nested expansion rejects a task already active in the parent workflow", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-langgraph-nested-duplicate-"));
  const saver = SqliteSaver.fromConnString(path.join(root, "checkpoints.sqlite"));
  let researchRuns = 0;
  try {
    const results = await new LangGraphExecutionEngine().runParallel({ workflowName: "nested-duplicate", taskName: "assignment",
      threadId: "nested-duplicate-team", tasks: [{ id: "cody" }, { id: "research" }], taskId: (item: { id: string }) => item.id,
      checkpointer: saver,
      execute: async (item: { id: string }, _signal, _outcomes, _interrupt, _control, _addTask,
        runDynamicTasks?: (items: ReadonlyArray<{ id: string }>) => Promise<ReadonlyArray<{ id: string }>>) => {
        if (item.id === "research") { researchRuns++; return { id: item.id }; }
        await assert.rejects(runDynamicTasks!([{ id: "research" }]), /cannot rerun an assignment that is already part of the active workflow/);
        return { id: item.id };
      } });
    assert.deepEqual(results.map(result => result.id).sort(), ["cody", "research"]);
    assert.equal(researchRuns, 1, "the active research assignment is not executed a second time in a nested graph");
  } finally { saver.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a dynamically registered child is reattached after its parent suspends before checkpointing", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-langgraph-dynamic-interrupt-"));
  const dbPath = path.join(root, "checkpoints.sqlite");
  let saver = SqliteSaver.fromConnString(dbPath);
  let outcomeStore = sqliteLangGraphOutcomeStore(saver.db as never);
  let parentAttempts = 0;
  const engine = new LangGraphExecutionEngine();
  const options = {
    workflowName: "dynamic-interrupt-recovery", taskName: "specialist", threadId: "dynamic-interrupt-team",
    tasks: [{ id: "maestro", dependsOn: [] as string[] }],
    taskId: (item: { id: string }) => item.id, dependencies: (item: { dependsOn: string[] }) => item.dependsOn,
    checkpointer: saver, outcomeStore, authorizeTaskExpansion: async (_parent, task) => {
      if (task.id !== "doc") throw new Error("assignment was not authorized");
    },
    execute: async (item: { id: string }, _signal?: AbortSignal, _outcomes?: Readonly<Record<string, string>>,
      interruptTask?: (value: unknown) => unknown, _isControl?: (error: unknown) => boolean,
      addTask?: (task: { id: string; dependsOn: string[] }) => Promise<string>) => {
      if (item.id === "maestro") {
        parentAttempts++;
        await addTask?.({ id: "doc", dependsOn: ["maestro"] });
        const approved = interruptTask?.({ approvalId: "dynamic-approval" }) as { approved?: boolean } | undefined;
        if (!approved?.approved) throw new Error("resume value not applied");
        return "Maestro resumed";
      }
      return "Doc finding";
    },
  };
  try {
    let pending: LangGraphInterruptedError | undefined;
    try { await engine.runParallel(options); } catch (error) {
      if (!(error instanceof LangGraphInterruptedError)) throw error;
      pending = error;
    }
    assert.ok(pending);
    saver.db.close();
    saver = SqliteSaver.fromConnString(dbPath);
    outcomeStore = sqliteLangGraphOutcomeStore(saver.db as never);
    const results = await engine.runParallel({ ...options, checkpointer: saver, outcomeStore, resume: true,
      resumeValues: { [pending.interrupts[0]!.id]: { approved: true } } });
    assert.deepEqual(results, ["Maestro resumed", "Doc finding"]);
    assert.equal(parentAttempts, 2, "LangGraph replays the suspended parent callback");
  } finally {
    try { saver.db.close(); } catch { /* already closed */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rejected dynamic assignment is not left in the durable task registry", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-langgraph-dynamic-invalid-"));
  const saver = SqliteSaver.fromConnString(path.join(root, "checkpoints.sqlite"));
  const outcomeStore = sqliteLangGraphOutcomeStore(saver.db as never);
  try {
    await assert.rejects(new LangGraphExecutionEngine().runParallel({ workflowName: "dynamic-invalid", taskName: "worker",
      threadId: "dynamic-invalid-thread", namespace: "authorized", tasks: [{ id: "maestro", dependsOn: [] as string[] }],
      taskId: item => item.id, dependencies: item => item.dependsOn, checkpointer: saver, outcomeStore,
      authorizeTaskExpansion: async () => { throw new Error("assignment denied by Maestro"); },
      execute: async (_item, _signal, _outcomes, _interrupt, _isControl, addTask) => {
        await addTask?.({ id: "unauthorized", dependsOn: ["maestro"] });
        return "unreachable";
      } }), /assignment denied by Maestro/);
    assert.deepEqual(outcomeStore.listTasks("dynamic-invalid", "dynamic-invalid-thread", "authorized"), []);
  } finally { saver.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("invalid dynamic dependencies are rejected before trusted admission runs", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-langgraph-dynamic-dependency-"));
  const saver = SqliteSaver.fromConnString(path.join(root, "checkpoints.sqlite"));
  const outcomeStore = sqliteLangGraphOutcomeStore(saver.db as never);
  let admissionCalls = 0;
  try {
    await assert.rejects(new LangGraphExecutionEngine().runParallel({ workflowName: "dynamic-dependency", taskName: "worker",
      threadId: "dynamic-dependency-thread", namespace: "authorized", tasks: [{ id: "maestro", dependsOn: [] as string[] }],
      taskId: item => item.id, dependencies: item => item.dependsOn, checkpointer: saver, outcomeStore,
      authorizeTaskExpansion: async () => { admissionCalls++; },
      execute: async (_item, _signal, _outcomes, _interrupt, _isControl, addTask) => {
        await addTask?.({ id: "doc", dependsOn: ["not-authorized"] });
        return "unreachable";
      } }), /previously authorized tasks/);
    assert.equal(admissionCalls, 0);
    assert.deepEqual(outcomeStore.listTasks("dynamic-dependency", "dynamic-dependency-thread", "authorized"), []);
  } finally { saver.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("runtime task expansion stays within a bounded workflow task budget", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-langgraph-dynamic-budget-"));
  const saver = SqliteSaver.fromConnString(path.join(root, "checkpoints.sqlite"));
  const outcomeStore = sqliteLangGraphOutcomeStore(saver.db as never);
  try {
    await assert.rejects(new LangGraphExecutionEngine().runParallel({ workflowName: "dynamic-budget", taskName: "worker",
      threadId: "dynamic-budget-thread", tasks: [{ id: "maestro", dependsOn: [] as string[] }], taskId: item => item.id,
      dependencies: item => item.dependsOn, checkpointer: saver, outcomeStore, authorizeTaskExpansion: async () => {},
      execute: async (_item, _signal, _outcomes, _interrupt, _isControl, addTask) => {
        for (let index = 0; index < 12; index++) {
          await addTask?.({ id: `child-${index}`, dependsOn: ["maestro"] });
        }
        return "unreachable";
      } }), /task budget of 12/);
    assert.equal(outcomeStore.listTasks("dynamic-budget", "dynamic-budget-thread", "").length, 11);
  } finally { saver.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("native LangGraph interrupt resumes by interrupt ID and preserves completed sibling outcomes", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-langgraph-interrupt-"));
  const dbPath = path.join(root, "checkpoints.sqlite");
  let saver = SqliteSaver.fromConnString(dbPath);
  let outcomeStore = sqliteLangGraphOutcomeStore(saver.db as never);
  const attempts = new Map<string, number>();
  const sideEffects: string[] = [];
  const engine = new LangGraphExecutionEngine();
  const options = {
    workflowName: "approval-interrupt-test", taskName: "assignment", threadId: "approval-thread",
    namespace: "specialists", tasks: [{ id: "doc" }, { id: "cody" }], taskId: (item: { id: string }) => item.id,
    checkpointer: saver, outcomeStore,
    retryPolicy: () => ({ maxAttempts: 3, shouldRetry: () => true }),
    execute: async (item: { id: string }, _signal?: AbortSignal, _outcomes?: Readonly<Record<string, unknown>>,
      interruptTask?: (value: unknown) => unknown) => {
      attempts.set(item.id, (attempts.get(item.id) ?? 0) + 1);
      if (item.id === "doc") {
        return { result: "Doc's independent finding" };
      }
      // LangGraph replays the interrupted callback from its beginning. Keep all
      // pre-resume work replay-safe and do not perform the side effect until the
      // specific interrupt has returned an explicit resume value.
      const checkpointDeadline = Date.now() + 2_000;
      while (outcomeStore.get("approval-interrupt-test", "approval-thread", "specialists", "doc") === undefined) {
        if (Date.now() >= checkpointDeadline) throw new Error("Doc outcome was not checkpointed before Cody requested approval.");
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      const approval = interruptTask?.({ approvalId: "approval-1", action: "bounded-write" }) as
        { readonly approved?: boolean } | undefined;
      if (!approval?.approved) throw new Error("Approval resume value was not accepted.");
      sideEffects.push("write-after-approval");
      return { result: "Cody completed after the approved action" };
    },
  };
  try {
    let pending: LangGraphInterruptedError | undefined;
    try { await engine.runParallel(options); }
    catch (error) {
      if (!(error instanceof LangGraphInterruptedError)) throw error;
      pending = error;
    }
    assert.ok(pending, "an unresolved LangGraph interrupt must suspend rather than complete the workflow");
    assert.equal(pending.interrupts.length, 1);
    assert.deepEqual(pending.interrupts[0]?.value, { approvalId: "approval-1", action: "bounded-write" });
    assert.deepEqual(pending.outcomes.doc, { result: "Doc's independent finding" });
    assert.deepEqual(outcomeStore.get("approval-interrupt-test", "approval-thread", "specialists", "doc"),
      { result: "Doc's independent finding" });
    assert.equal(attempts.get("cody"), 1, "LangGraph control-flow interrupts must bypass the retry policy");
    assert.equal(sideEffects.length, 0, "the gated side effect must not happen before approval");
    saver.db.close();
    saver = SqliteSaver.fromConnString(dbPath);
    outcomeStore = sqliteLangGraphOutcomeStore(saver.db as never);
    await new LangGraphExecutionEngine().runParallel({ ...options, checkpointer: saver,
      outcomeStore, resume: true,
      resumeValues: { [pending.interrupts[0]!.id]: { approved: true } } });
    assert.deepEqual(sideEffects, ["write-after-approval"]);
    assert.equal(attempts.get("doc"), 1, "completed sibling outcome must survive interrupt recovery");
    assert.equal(attempts.get("cody"), 2, "the interrupted callback is replayed from its beginning by LangGraph");
    await assert.rejects(new LangGraphExecutionEngine().runParallel({ ...options, threadId: "missing-checkpoint",
      checkpointer: saver, outcomeStore, resume: true, resumeValues: { missing: { approved: true } } }),
    /resume values require a saved workflow checkpoint/);
  } finally {
    try { saver.db.close(); } catch { /* Saver can already be closed. */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("user pause interrupts at a dependency boundary and resumes without repeating completed work", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-langgraph-user-pause-"));
  const dbPath = path.join(root, "checkpoints.sqlite");
  let saver = SqliteSaver.fromConnString(dbPath);
  let outcomeStore = sqliteLangGraphOutcomeStore(saver.db as never);
  let pauseRequested = false;
  const attempts = new Map<string, number>();
  const engine = new LangGraphExecutionEngine();
  const options = {
    workflowName: "user-pause-test", taskName: "assignment", threadId: "user-pause-thread", namespace: "specialists",
    tasks: [{ id: "doc", dependsOn: [] as string[] }, { id: "cody", dependsOn: ["doc"] }],
    taskId: (item: { id: string }) => item.id, dependencies: (item: { dependsOn: string[] }) => item.dependsOn,
    checkpointer: saver, outcomeStore, shouldPause: () => pauseRequested,
    execute: async (item: { id: string }) => {
      attempts.set(item.id, (attempts.get(item.id) ?? 0) + 1);
      if (item.id === "doc") pauseRequested = true;
      return `${item.id}-done`;
    },
  };
  try {
    let pending: LangGraphInterruptedError | undefined;
    try { await engine.runParallel(options); }
    catch (error) { if (!(error instanceof LangGraphInterruptedError)) throw error; pending = error; }
    assert.ok(pending, "user pause should suspend before dispatching the dependent assignment");
    assert.equal(pending.interrupts[0]?.value && (pending.interrupts[0]!.value as { kind?: string }).kind, "user-pause");
    assert.deepEqual(pending.outcomes, { doc: "doc-done" });
    assert.equal(attempts.get("cody"), undefined);

    saver.db.close();
    saver = SqliteSaver.fromConnString(dbPath);
    outcomeStore = sqliteLangGraphOutcomeStore(saver.db as never);
    pauseRequested = false;
    await engine.runParallel({ ...options, checkpointer: saver, outcomeStore, resume: true,
      resumeValues: { [pending.interrupts[0]!.id]: { resumed: true } } });
    assert.equal(attempts.get("doc"), 1);
    assert.equal(attempts.get("cody"), 1);
  } finally {
    try { saver.db.close(); } catch { /* Saver may have been closed before restart. */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("LangGraph does not retry a failed callback unless its policy explicitly classifies the error as safe", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-langgraph-retry-guard-"));
  const saver = SqliteSaver.fromConnString(path.join(root, "checkpoints.sqlite"));
  let attempts = 0;
  try {
    await assert.rejects(new LangGraphExecutionEngine().runParallel({ workflowName: "retry-guard", taskName: "unsafe",
      threadId: "retry-guard-thread", tasks: [{ id: "write" }], taskId: item => item.id, checkpointer: saver,
      retryPolicy: () => ({ maxAttempts: 3 }), execute: async () => { attempts++; throw new Error("ambiguous side effect outcome"); } }),
    /ambiguous side effect outcome/);
    assert.equal(attempts, 1, "an omitted safe-retry predicate must never replay a callback");
  } finally { saver.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("LangGraph cancellation interrupts a retry backoff without starting another attempt", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-langgraph-retry-cancel-"));
  const saver = SqliteSaver.fromConnString(path.join(root, "checkpoints.sqlite"));
  const controller = new AbortController();
  let attempts = 0;
  try {
    const running = new LangGraphExecutionEngine().runParallel({ workflowName: "retry-cancel", taskName: "retry",
      threadId: "retry-cancel-thread", tasks: [{ id: "research" }], taskId: item => item.id, checkpointer: saver,
      signal: controller.signal,
      retryPolicy: () => ({ maxAttempts: 3, backoffMs: 5_000, shouldRetry: () => true }),
      execute: async () => { attempts++; throw new Error("transient read failure"); } });
    setTimeout(() => controller.abort(new Error("cancelled by test")), 10);
    await assert.rejects(running, /cancelled by test/);
    assert.equal(attempts, 1, "cancellation during backoff must prevent the next retry");
  } finally { saver.db.close(); rmSync(root, { recursive: true, force: true }); }
});
