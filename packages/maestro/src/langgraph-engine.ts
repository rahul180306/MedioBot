import { Annotation, Command, END, interrupt, isGraphBubbleUp, Send, START, StateGraph, task, type BaseCheckpointSaver } from "@langchain/langgraph";
import { WorkerSuspensionError } from "@mediobot-v2/runtime";

export interface LangGraphInterrupt {
  readonly id: string;
  readonly value: unknown;
}

/** Partial outcomes are retained by LangGraph when a task suspends at interrupt(). */
export class LangGraphInterruptedError extends WorkerSuspensionError {
  readonly outcomes: Readonly<Record<string, unknown>>;
  readonly interrupts: ReadonlyArray<LangGraphInterrupt>;

  constructor(outcomes: Readonly<Record<string, unknown>>, interrupts: ReadonlyArray<LangGraphInterrupt>) {
    super("LangGraph workflow is waiting for an explicit resume value.");
    this.name = "LangGraphInterruptedError";
    this.outcomes = outcomes;
    this.interrupts = interrupts;
  }
}

export interface LangGraphParallelExecution<T, R> {
  readonly workflowName: string;
  readonly taskName: string;
  readonly threadId: string;
  readonly namespace?: string;
  readonly tasks: ReadonlyArray<T>;
  readonly taskId: (task: T) => string;
  readonly dependencies?: (task: T) => ReadonlyArray<string>;
  readonly checkpointer: BaseCheckpointSaver;
  readonly outcomeStore?: LangGraphOutcomeStore;
  readonly signal?: AbortSignal;
  readonly resume?: boolean;
  /** Resume payloads keyed by LangGraph interrupt ID; never infer approval from a task status. */
  readonly resumeValues?: Readonly<Record<string, unknown>>;
  /** Trusted cooperative pause request checked only after the current assignment batch settles. */
  readonly shouldPause?: () => boolean;
  readonly retryPolicy?: (input: T) => { readonly maxAttempts: number; readonly backoffMs?: number; readonly shouldRetry?: (error: unknown) => boolean };
  /** Trusted caller admission. Must authorize and durably record assignment identity before it is added to the graph. */
  readonly authorizeTaskExpansion?: (parent: T, proposed: T, signal?: AbortSignal) => Promise<void>;
  /**
   * `interruptTask` suspends the LangGraph task. The callback may be replayed
   * from its beginning on resume, so code before an interrupt must be replay-safe.
   */
  readonly execute: (input: T, signal?: AbortSignal, completedOutcomes?: Readonly<Record<string, R>>,
    interruptTask?: (value: unknown) => unknown, isControlSignal?: (error: unknown) => boolean,
    addTask?: (input: T) => Promise<string>,
    runDynamicTasks?: (inputs: ReadonlyArray<T>) => Promise<ReadonlyArray<R>>,
    addTasks?: (inputs: ReadonlyArray<T>) => Promise<ReadonlyArray<string>>) => Promise<R>;
}

type ExecutionItem<T> = { readonly id: string; readonly input: T };
const MAX_LANGGRAPH_TASKS = 12;

export interface LangGraphOutcomeStore {
  get(workflowName: string, threadId: string, namespace: string, taskId: string): unknown | undefined;
  put(workflowName: string, threadId: string, namespace: string, taskId: string, value: unknown): void;
  registerTask(workflowName: string, threadId: string, namespace: string, taskId: string, input: unknown): void;
  registerTasks(workflowName: string, threadId: string, namespace: string,
    tasks: ReadonlyArray<{ readonly taskId: string; readonly input: unknown }>): void;
  listTasks(workflowName: string, threadId: string, namespace: string): ReadonlyArray<{ readonly taskId: string; readonly input: unknown }>;
}

export interface LangGraphOutcomeDatabase {
  exec(sql: string): void;
  prepare(sql: string): { get(...values: unknown[]): unknown; run(...values: unknown[]): unknown; all(...values: unknown[]): unknown[] };
}

/** Stores only completed task results in the application's existing SQLite database. */
export function sqliteLangGraphOutcomeStore(database: LangGraphOutcomeDatabase): LangGraphOutcomeStore {
  database.exec(`CREATE TABLE IF NOT EXISTS langgraph_task_outcomes (
    workflow_name TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    task_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (workflow_name, thread_id, checkpoint_ns, task_id)
  );
  CREATE TABLE IF NOT EXISTS langgraph_task_registry (
    workflow_name TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    task_id TEXT NOT NULL,
    input_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (workflow_name, thread_id, checkpoint_ns, task_id)
  )`);
  const select = database.prepare(`SELECT payload_json FROM langgraph_task_outcomes
    WHERE workflow_name = ? AND thread_id = ? AND checkpoint_ns = ? AND task_id = ?`);
  const insert = database.prepare(`INSERT INTO langgraph_task_outcomes
    (workflow_name, thread_id, checkpoint_ns, task_id, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(workflow_name, thread_id, checkpoint_ns, task_id)
    DO NOTHING`);
  const selectTasks = database.prepare(`SELECT task_id, input_json FROM langgraph_task_registry
    WHERE workflow_name = ? AND thread_id = ? AND checkpoint_ns = ? ORDER BY created_at ASC, task_id ASC`);
  const insertTask = database.prepare(`INSERT INTO langgraph_task_registry
    (workflow_name, thread_id, checkpoint_ns, task_id, input_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(workflow_name, thread_id, checkpoint_ns, task_id) DO NOTHING`);
  const selectTask = database.prepare(`SELECT input_json FROM langgraph_task_registry
    WHERE workflow_name = ? AND thread_id = ? AND checkpoint_ns = ? AND task_id = ?`);
  return {
    get(workflowName, threadId, namespace, taskId) {
      const row = select.get(workflowName, threadId, namespace, taskId) as { payload_json?: string } | undefined;
      if (!row?.payload_json) return undefined;
      return JSON.parse(row.payload_json);
    },
    put(workflowName, threadId, namespace, taskId, value) {
      const payload = JSON.stringify(value);
      if (payload.length > 128_000) throw new Error("LangGraph task outcome exceeds the 128 KB persistence limit.");
      insert.run(workflowName, threadId, namespace, taskId, payload, Date.now());
    },
    registerTask(workflowName, threadId, namespace, taskId, input) {
      this.registerTasks(workflowName, threadId, namespace, [{ taskId, input }]);
    },
    registerTasks(workflowName, threadId, namespace, tasks) {
      const encoded = tasks.map(({ taskId, input }) => {
        const payload = JSON.stringify(input);
        if (!payload || payload.length > 128_000) throw new Error("LangGraph task input exceeds the 128 KB persistence limit.");
        return { taskId, payload };
      });
      // The saver and outcome registry can share a SQLite connection while a
      // graph node is active. SAVEPOINT composes with an outer transaction;
      // BEGIN IMMEDIATE would fail with a nested-transaction error there.
      database.exec("SAVEPOINT langgraph_task_expansion");
      try {
        for (const { taskId, payload } of encoded) {
          insertTask.run(workflowName, threadId, namespace, taskId, payload, Date.now());
          const persisted = selectTask.get(workflowName, threadId, namespace, taskId) as { input_json?: string } | undefined;
          if (persisted?.input_json !== payload) throw new Error(`Conflicting durable LangGraph task payload for id ${taskId}.`);
        }
        database.exec("RELEASE SAVEPOINT langgraph_task_expansion");
      } catch (error) {
        try {
          database.exec("ROLLBACK TO SAVEPOINT langgraph_task_expansion");
          database.exec("RELEASE SAVEPOINT langgraph_task_expansion");
        } catch { /* Preserve the original write failure. */ }
        throw error;
      }
    },
    listTasks(workflowName, threadId, namespace) {
      return (selectTasks.all(workflowName, threadId, namespace) as Array<{ task_id: string; input_json: string }>).map(row => ({
        taskId: row.task_id, input: JSON.parse(row.input_json),
      }));
    },
  };
}

/** LangGraph is the workflow scheduler and the task-result checkpoint boundary. */
export class LangGraphExecutionEngine {
  async runParallel<T, R>(options: LangGraphParallelExecution<T, R>): Promise<ReadonlyArray<R>> {
    // `checkpoint_ns` is reserved by LangGraph for nested graph namespaces;
    // setting an application namespace here makes the SQLite checkpointer
    // write the root workflow under `""`, so direct recovery lookup misses it.
    // Application workflow isolation lives in workflowName/threadId/outcome keys.
    const configurable = { thread_id: options.threadId };
    const config = { configurable, ...(options.signal ? { signal: options.signal } : {}) };
    const saved = options.resume ? await options.checkpointer.getTuple(config) : undefined;
    const savedItems = (saved?.checkpoint.channel_values as { items?: unknown } | undefined)?.items;
    const registeredTasks = options.outcomeStore?.listTasks(options.workflowName, options.threadId, options.namespace ?? "") ?? [];
    const initialTasks = [...options.tasks, ...registeredTasks.map(item => item.input as T),
      ...(Array.isArray(savedItems) ? (savedItems as ExecutionItem<T>[]).map(item => item.input) : [])];
    const items = new Map<string, ExecutionItem<T>>();
    const dependencies = new Map<string, string[]>();
    type TaskResult = Promise<{ readonly result: R; readonly additions: ReadonlyArray<ExecutionItem<T>> }>;
    const taskById = new Map<string, (completedOutcomes?: Record<string, R>) => Promise<TaskResult>>();
    const taskInputs = new Map<string, string>();
    for (const [id, parents] of dependencies) {
      if (parents.some(parent => !items.has(parent) || parent === id)) throw new Error(`Invalid dependency for LangGraph task ${id}.`);
    }
    const register = (input: T, additions?: ExecutionItem<T>[]) => {
      const id = options.taskId(input);
      const fingerprint = JSON.stringify(input);
      const existing = items.get(id);
      if (existing) {
        if (taskInputs.get(id) !== fingerprint) throw new Error(`Conflicting LangGraph task payload for id ${id}.`);
        return id;
      }
      if (items.size >= MAX_LANGGRAPH_TASKS) throw new Error(`LangGraph workflow task budget of ${MAX_LANGGRAPH_TASKS} exceeded.`);
      const parents = [...(options.dependencies?.(input) ?? [])];
      if (additions && parents.some(parent => !items.has(parent) || parent === id)) {
        throw new Error(`Dynamic LangGraph task ${id} must depend only on previously authorized tasks.`);
      }
      const item = { id, input };
      items.set(id, item);
      taskInputs.set(id, fingerprint);
      dependencies.set(id, parents);
      taskById.set(id, task<[completedOutcomes?: Record<string, R>], TaskResult>({ name: `${options.taskName}-${id}` }, async (completedOutcomes) => {
        const persisted = options.outcomeStore?.get(options.workflowName, options.threadId, options.namespace ?? "", id);
        if (persisted !== undefined) return { result: persisted as R, additions: [] as ExecutionItem<T>[] };
        const policy = options.retryPolicy?.(input);
        const maxAttempts = policy?.maxAttempts ?? 1;
        const backoffMs = policy?.backoffMs ?? 0;
        if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5 || !Number.isFinite(backoffMs) || backoffMs < 0 || backoffMs > 5_000) {
          throw new Error("LangGraph retry policy must use 1 to 5 attempts and a backoff from 0 to 5000 ms.");
        }
        const additions: ExecutionItem<T>[] = [];
        const addTasks = async (dynamicInputs: ReadonlyArray<T>) => {
          if (!options.outcomeStore) throw new Error("Runtime task expansion requires durable task storage.");
          if (dynamicInputs.length < 1 || dynamicInputs.length > 3) {
            throw new Error("A durable LangGraph expansion must contain one to three tasks.");
          }
          const dynamicIds = dynamicInputs.map(options.taskId);
          if (new Set(dynamicIds).size !== dynamicIds.length) throw new Error("A LangGraph expansion cannot contain duplicate task IDs.");
          const batchIds = new Set<string>();
          const toPersist: Array<{ taskId: string; input: T }> = [];
          for (const dynamicInput of dynamicInputs) {
            const dynamicId = options.taskId(dynamicInput);
            const fingerprint = JSON.stringify(dynamicInput);
            const existing = items.get(dynamicId);
            if (existing) {
              if (taskInputs.get(dynamicId) !== fingerprint) throw new Error(`Conflicting LangGraph task payload for id ${dynamicId}.`);
              // A task can exist in the durable registry while the parent node's
              // graph update was interrupted. Re-emit it on node replay.
              if (!additions.some(item => item.id === dynamicId)) additions.push(existing);
              batchIds.add(dynamicId);
              continue;
            }
            const parents = options.dependencies?.(dynamicInput) ?? [];
            if (parents.some(parent => (!items.has(parent) && !batchIds.has(parent)) || parent === dynamicId)) {
              throw new Error(`Dynamic LangGraph task ${dynamicId} must depend only on previously authorized tasks.`);
            }
            if (items.size + toPersist.length >= MAX_LANGGRAPH_TASKS) throw new Error(`LangGraph workflow task budget of ${MAX_LANGGRAPH_TASKS} exceeded.`);
            if (!options.authorizeTaskExpansion) throw new Error("Runtime task expansion requires trusted Maestro authorization.");
            await options.authorizeTaskExpansion(input, dynamicInput, options.signal);
            options.signal?.throwIfAborted();
            toPersist.push({ taskId: dynamicId, input: dynamicInput });
            batchIds.add(dynamicId);
          }
          // This registry closes the crash window before LangGraph commits the
          // node's updated item list. Register the entire approved batch in one
          // transaction so recovery cannot observe only its helper or continuation.
          options.outcomeStore.registerTasks(options.workflowName, options.threadId, options.namespace ?? "", toPersist);
          for (const { input: dynamicInput } of toPersist) register(dynamicInput, additions);
          return dynamicIds;
        };
        const addTask = async (dynamicInput: T) => (await addTasks([dynamicInput]))[0]!;
        const runDynamicTasks = async (dynamicInputs: ReadonlyArray<T>): Promise<ReadonlyArray<R>> => {
          if (dynamicInputs.length < 1 || dynamicInputs.length > 2) {
            throw new Error("A bounded LangGraph expansion must contain one or two tasks.");
          }
          const dynamicIds = dynamicInputs.map(options.taskId);
          if (new Set(dynamicIds).size !== dynamicIds.length) throw new Error("A dynamic LangGraph batch cannot contain duplicate task IDs.");
          if (dynamicIds.some(id => options.tasks.some(initial => options.taskId(initial) === id))) {
            throw new Error("A LangGraph expansion cannot rerun an assignment that is already part of the active workflow.");
          }
          const batchIds = new Set(dynamicIds);
          for (const dynamicInput of dynamicInputs) {
            const externalDependency = (options.dependencies?.(dynamicInput) ?? []).find(parent => !batchIds.has(parent));
            if (externalDependency) throw new Error(`A bounded nested expansion cannot depend on an external workflow task: ${externalDependency}.`);
          }
          const dynamicThreadId = `${options.threadId}:dynamic:${dynamicInputs.map(options.taskId).join(",")}`;
          const dynamicWorkflowName = `${options.workflowName}:dynamic`;
          if (items.size + dynamicInputs.length > MAX_LANGGRAPH_TASKS) {
            throw new Error(`LangGraph workflow task budget of ${MAX_LANGGRAPH_TASKS} exceeded.`);
          }
          if (!options.outcomeStore || !options.authorizeTaskExpansion) {
            throw new Error("Nested runtime assignments require durable task storage and trusted Maestro authorization.");
          }
          for (const dynamicInput of dynamicInputs) {
            await options.authorizeTaskExpansion(input, dynamicInput, options.signal);
            options.signal?.throwIfAborted();
          }
          // Nested assistance has its own checkpoint thread. Registering it in
          // the parent registry would schedule the same specialist again as a
          // top-level task after restart while Cody also resumes the nested graph.
          options.outcomeStore.registerTasks(dynamicWorkflowName, dynamicThreadId, options.namespace ?? "",
            dynamicInputs.map(dynamicInput => ({ taskId: options.taskId(dynamicInput), input: dynamicInput })));
          const results = await this.runParallel<T, R>({
            workflowName: dynamicWorkflowName, taskName: `${options.taskName}-dynamic`,
            threadId: dynamicThreadId, namespace: options.namespace, tasks: dynamicInputs,
            taskId: options.taskId, dependencies: options.dependencies, checkpointer: options.checkpointer,
            outcomeStore: options.outcomeStore, signal: options.signal, resume: true, shouldPause: options.shouldPause,
            // Runtime expansion is deliberately disabled inside an expansion. This keeps
            // the nested branch bounded and prevents recursive, unreviewed delegation.
            execute: (dynamicInput, signal, outcomes, interruptDynamic, isControlDynamic) =>
              options.execute(dynamicInput, signal, outcomes, interruptDynamic, isControlDynamic),
          });
          return results;
        };
        let attempt = 0;
        while (true) {
          options.signal?.throwIfAborted();
          try {
            const result = await options.execute(input, options.signal, completedOutcomes, interrupt, isGraphBubbleUp, addTask, runDynamicTasks, addTasks);
            options.outcomeStore?.put(options.workflowName, options.threadId, options.namespace ?? "", id, result);
            return { result, additions };
          } catch (error) {
            if (isGraphBubbleUp(error)) throw error;
            attempt++;
            if (attempt >= maxAttempts || policy?.shouldRetry?.(error) !== true || options.signal?.aborted) throw error;
            if (backoffMs) await waitForRetry(backoffMs, options.signal);
          }
        }
      }));
      additions?.push(item);
      return id;
    };
    for (const input of initialTasks) register(input);
    const validateDag = () => {
      for (const [id, parents] of dependencies) if (parents.some(parent => !items.has(parent) || parent === id)) {
        throw new Error(`Invalid dependency for LangGraph task ${id}.`);
      }
      const unresolved = new Set(items.keys());
      const validated = new Set<string>();
      while (unresolved.size) {
        const newlyReady = [...unresolved].filter(id => dependencies.get(id)!.every(parent => validated.has(parent)));
        if (!newlyReady.length) throw new Error("LangGraph task dependencies contain a cycle.");
        for (const id of newlyReady) { unresolved.delete(id); validated.add(id); }
      }
    };
    validateDag();
    const State = Annotation.Root({
      items: Annotation<ReadonlyArray<ExecutionItem<T>>>({ reducer: (current, update) => {
        const merged = new Map(current.map(item => [item.id, item]));
        for (const item of update) {
          const prior = merged.get(item.id);
          if (prior && taskInputs.get(item.id) !== JSON.stringify(item.input)) throw new Error(`Conflicting LangGraph state item ${item.id}.`);
          merged.set(item.id, item);
        }
        return [...merged.values()];
      }, default: () => [] }),
      outcomes: Annotation<Record<string, R>>({ reducer: (current, update) => ({ ...current, ...update }), default: () => ({}) }),
    });
    type StateValue = typeof State.State;
    const graph = new StateGraph(State)
      .addNode("dispatch", async (state: StateValue) => {
        const hasPendingAssignments = state.items.some(item => !Object.hasOwn(state.outcomes, item.id));
        if (hasPendingAssignments && options.shouldPause?.()) {
          interrupt({ kind: "user-pause", requestedAt: Date.now() });
        }
        return {};
      })
      .addNode("execute-task", async ({ taskId, outcomes }: { readonly taskId: string; readonly outcomes: Record<string, R> }) => {
        const itemTask = taskById.get(taskId);
        if (!itemTask) throw new Error(`Unknown LangGraph task: ${taskId}`);
        const execution = await itemTask(outcomes) as { result: R; additions: ExecutionItem<T>[] };
        return { outcomes: { [taskId]: execution.result }, items: execution.additions };
      }, { input: Annotation.Root({ taskId: Annotation<string>(), outcomes: Annotation<Record<string, R>>() }) });
    graph.addEdge(START, "dispatch");
    graph.addConditionalEdges("dispatch", (state: StateValue) => {
      const ready = state.items.filter(item => {
        const parents = dependencies.get(item.id);
        if (!parents) throw new Error(`LangGraph task ${item.id} was restored without an authorized task registration.`);
        return !Object.hasOwn(state.outcomes, item.id) && parents.every(dependency => Object.hasOwn(state.outcomes, dependency));
      });
      if (!ready.length && state.items.some(item => !Object.hasOwn(state.outcomes, item.id))) {
        throw new Error("LangGraph workflow cannot advance because a required dependency did not complete.");
      }
      return ready.length ? ready.map(item => new Send("execute-task", { taskId: item.id, outcomes: state.outcomes })) : END;
    });
    graph.addEdge("execute-task", "dispatch");
    const workflow = graph.compile({ name: options.workflowName, checkpointer: options.checkpointer });
    if (options.resumeValues && (!options.resume || !saved)) throw new Error("LangGraph resume values require a saved workflow checkpoint.");
    const input = options.resumeValues
      ? new Command({ resume: options.resumeValues }) as never
      : saved ? null : { items: [...items.values()], outcomes: {} };
    const result = await workflow.invoke(input, config) as StateValue & { readonly __interrupt__?: ReadonlyArray<LangGraphInterrupt> };
    if (result.__interrupt__?.length) {
      throw new LangGraphInterruptedError(result.outcomes ?? {}, result.__interrupt__);
    }
    const finalItems = result.items ?? [...items.values()];
    const unfinished = finalItems.filter(item => !Object.hasOwn(result.outcomes ?? {}, item.id));
    if (unfinished.length) {
      throw new Error(`LangGraph workflow ended without completing or interrupting task(s): ${unfinished.map(item => item.id).join(", ")}.`);
    }
    return finalItems.flatMap(item => Object.hasOwn(result.outcomes, item.id) ? [result.outcomes[item.id]!] : []);
  }
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, delayMs);
    const abort = () => { clearTimeout(timer); cleanup(); reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError")); };
    const cleanup = () => signal?.removeEventListener("abort", abort);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
