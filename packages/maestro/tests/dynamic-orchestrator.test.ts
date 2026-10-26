import assert from "node:assert/strict";
import test from "node:test";
import { createWorld } from "@mediobot-v2/domain";
import type { MediobotDefinitionId, TaskId } from "@mediobot-v2/domain";
import {
  DurableTaskEngine,
  ResourceGovernor,
  WorkerRuntime,
} from "@mediobot-v2/runtime";
import type { DurableTaskArtifactRecord, DurableTaskEventRecord, DurableTaskRecord, DurableTaskStore } from "@mediobot-v2/runtime";
import type { IntermediateArtifact, OrchestrationPlanSpec, SupportRequest } from "@mediobot-v2/contracts";
import {
  DynamicSpecialistSelector,
} from "../src/index.ts";
import { MaestroOrchestrator } from "../src/orchestrator.ts";

/** In-memory DurableTaskStore implementation for deterministic unit testing */
class InMemoryDurableTaskStore implements DurableTaskStore {
  tasks = new Map<string, DurableTaskRecord>();
  events: DurableTaskEventRecord[] = [];
  delegations: Array<{ id: string; parentTaskId: string; childTaskId?: string | null; assignedMediobotId: string; assignedMediobotName: string; objective: string; status: "pending" | "active" | "completed" | "failed" | "cancelled"; createdAt: number; updatedAt: number }> = [];
  evidence: Array<{ id: string; taskId: string; kind: string; source: Record<string, unknown>; claim?: string | null; content: string; validity: "observed" | "verified" | "invalidated"; createdAt: number }> = [];
  artifacts = new Map<string, DurableTaskArtifactRecord>();

  async createTask(task: Omit<DurableTaskRecord, "status" | "retryCount" | "createdAt" | "updatedAt">): Promise<DurableTaskRecord> {
    const record: DurableTaskRecord = {
      ...task,
      status: "created",
      retryCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.tasks.set(task.id, record);
    return record;
  }

  async getTask(id: string): Promise<DurableTaskRecord | null> {
    return this.tasks.get(id) ?? null;
  }

  async getByIdempotencyKey(key: string): Promise<DurableTaskRecord | null> {
    for (const t of this.tasks.values()) {
      if (t.idempotencyKey === key) return t;
    }
    return null;
  }

  async updateTask(id: string, updates: Partial<Pick<DurableTaskRecord, "status" | "error" | "retryCount" | "completedAt">>): Promise<DurableTaskRecord> {
    const existing = this.tasks.get(id);
    if (!existing) throw new Error(`Task ${id} not found`);
    const updated: DurableTaskRecord = { ...existing, ...updates, updatedAt: Date.now() };
    this.tasks.set(id, updated);
    return updated;
  }

  async listTasks(): Promise<DurableTaskRecord[]> {
    return Array.from(this.tasks.values());
  }

  async appendEvent(taskId: string, eventType: string, payload: Record<string, unknown>): Promise<DurableTaskEventRecord> {
    const ev: DurableTaskEventRecord = { id: `ev-${Date.now()}-${this.events.length}`, taskId, sequenceNumber: this.events.length + 1, eventType, payload, occurredAt: Date.now() };
    this.events.push(ev);
    return ev;
  }

  async getEvents(taskId: string): Promise<DurableTaskEventRecord[]> {
    return this.events.filter((e) => e.taskId === taskId);
  }

  async createCheckpoint(taskId: string, stepIndex: number, snapshot: Record<string, unknown>) {
    return { id: `cp-${Date.now()}`, taskId, stepIndex, snapshot, createdAt: Date.now() };
  }

  async getCheckpoints() {
    return [];
  }

  async createDelegation(delegation: any) {
    const record = { id: `del-${Date.now()}-${Math.random()}`, ...delegation, createdAt: Date.now(), updatedAt: Date.now() };
    this.delegations.push(record);
    return record;
  }

  async updateDelegation(id: string, updates: any) {
    const match = this.delegations.find((d) => d.id === id);
    if (match) Object.assign(match, updates, { updatedAt: Date.now() });
    return match!;
  }

  async getDelegations(parentTaskId: string) {
    return this.delegations.filter((d) => d.parentTaskId === parentTaskId);
  }

  async addEvidence(ev: any) {
    const record = { id: `evid-${Date.now()}-${Math.random()}`, ...ev, createdAt: Date.now() };
    this.evidence.push(record);
    return record;
  }

  async getEvidence(taskId: string) {
    return this.evidence.filter((e) => e.taskId === taskId);
  }

  async searchVerifiedEvidence(workspaceId: string | null, threadId: string | null, currentTaskId: string, query: string, limit: number) {
    const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])];
    return this.evidence.filter(evidence => {
      if (evidence.taskId === currentTaskId || evidence.validity !== "verified") return false;
      const task = this.tasks.get(evidence.taskId);
      if (!task || (workspaceId ? task.workspaceId !== workspaceId
        : Boolean(task.workspaceId) || task.threadId !== threadId)) return false;
      const haystack = `${evidence.kind} ${evidence.claim ?? ""} ${evidence.content}`.toLowerCase();
      return terms.some(term => haystack.includes(term));
    }).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  async upsertArtifact(artifact: DurableTaskArtifactRecord) {
    const existing = this.artifacts.get(artifact.id);
    const changed = !existing || existing.taskId !== artifact.taskId || existing.workerId !== artifact.workerId
      || existing.mediobotId !== artifact.mediobotId || existing.name !== artifact.name || existing.contentHash !== artifact.contentHash;
    if (changed) this.artifacts.set(artifact.id, artifact);
    return { artifact: this.artifacts.get(artifact.id)!, changed };
  }

  async upsertArtifactAndAppendEvent(artifact: DurableTaskArtifactRecord, eventPayload: Record<string, unknown>) {
    const existing = this.artifacts.get(artifact.id);
    const changed = !existing || existing.taskId !== artifact.taskId || existing.workerId !== artifact.workerId
      || existing.mediobotId !== artifact.mediobotId || existing.name !== artifact.name || existing.contentHash !== artifact.contentHash;
    const hasEvent = this.events.some(event => event.taskId === artifact.taskId && event.eventType === "task.artifact_recorded"
      && event.payload.artifactId === artifact.id);
    if (changed || !hasEvent) await this.appendEvent(artifact.taskId, "task.artifact_recorded", eventPayload);
    if (changed) this.artifacts.set(artifact.id, artifact);
    return { artifact: this.artifacts.get(artifact.id)!, changed };
  }

  async getArtifacts(taskId: string) {
    return [...this.artifacts.values()].filter(artifact => artifact.taskId === taskId);
  }

  async reconcileInterruptedTasks() {
    const interrupted: DurableTaskRecord[] = [];
    for (const [id, t] of this.tasks) {
      if (t.status === "running" || t.status === "queued") {
        const updated: DurableTaskRecord = { ...t, status: "interrupted", updatedAt: Date.now() };
        this.tasks.set(id, updated);
        interrupted.push(updated);
      }
    }
    return interrupted;
  }
}

function createTestHarness(options?: {
  readonly maxGovernorTasks?: number;
  readonly textInferenceDelayMs?: number;
}) {
  const world = createWorld();
  const store = new InMemoryDurableTaskStore();
  const durableEngine = new DurableTaskEngine(store);

  const resourceGovernor = new ResourceGovernor({
    budget: {
      maxConcurrentTasks: options?.maxGovernorTasks ?? 4,
      maxConcurrentTasksPerWorkspace: options?.maxGovernorTasks ?? 4,
      maxConcurrentModelRequests: 8,
      maxConcurrentSubprocesses: 4,
    },
  });

  const runtime = new WorkerRuntime(world, {
    resourceGovernor,
    maxConcurrentExecutions: 8,
  });

  // Register standard definitions
  const codyDef = world.registerMediobotDefinition({
    name: "Cody",
    role: "coding",
    version: "0.1.0",
    instructions: "Software engineer specialist.",
    declaredCapabilities: [{ kind: "resource", name: "workspace" }, { kind: "action", name: "terminal.execute" }, { kind: "action", name: "text-inference" }],
  });

  const docDef = world.registerMediobotDefinition({
    name: "Doc",
    role: "doc",
    version: "0.1.0",
    instructions: "Documentation intelligence specialist.",
    declaredCapabilities: [{ kind: "action", name: "documentation.search" }, { kind: "action", name: "api-reference" }, { kind: "action", name: "text-inference" }],
  });

  const resDef = world.registerMediobotDefinition({
    name: "Research",
    role: "research",
    version: "0.1.0",
    instructions: "Technical research specialist.",
    declaredCapabilities: [{ kind: "action", name: "research" }, { kind: "action", name: "tradeoff-analysis" }, { kind: "action", name: "text-inference" }],
  });

  const testerDef = world.registerMediobotDefinition({
    name: "Tester",
    role: "tester",
    version: "0.1.0",
    instructions: "Independent verification specialist.",
    declaredCapabilities: [{ kind: "action", name: "verification" }, { kind: "action", name: "text-inference" }],
  });

  const orchestrator = new MaestroOrchestrator({
    world,
    runtime,
    resourceGovernor,
    durableTaskEngine: durableEngine,
    textModelResolver: {
      resolveForOperation() {
        return {
          descriptor: { providerId: "test-provider", modelId: "test-model" },
          client: {
            complete: async ({ signal }) => {
              if (options?.textInferenceDelayMs) {
                await new Promise((res) => setTimeout(res, options.textInferenceDelayMs));
              }
              signal.throwIfAborted();
              return "Deterministic verified specialist inference output.";
            },
          },
        };
      },
    },
  });

  return {
    world,
    runtime,
    resourceGovernor,
    durableEngine,
    store,
    orchestrator,
    codyDef,
    docDef,
    resDef,
    testerDef,
  };
}

test("1. Maestro selects specialists based on capabilities without hardcoded roster", () => {
  const selector = new DynamicSpecialistSelector();
  const availableMediobots = [
    { definitionId: "def-cody" as MediobotDefinitionId, name: "Cody", role: "coding", capabilities: ["workspace", "terminal.execute"], assignable: true },
    { definitionId: "def-doc" as MediobotDefinitionId, name: "Doc", role: "doc", capabilities: ["documentation.search", "api-reference"], assignable: true },
    { definitionId: "def-res" as MediobotDefinitionId, name: "Research", role: "research", capabilities: ["tradeoff-analysis"], assignable: true },
    { definitionId: "def-tester" as MediobotDefinitionId, name: "Tester", role: "tester", capabilities: ["verification"], assignable: true },
  ];

  // Case A: Greeting -> No specialist
  const resGreeting = selector.select({
    objective: "Hello, good morning Maestro!",
    availableMediobots,
  });
  assert.equal(resGreeting.requiresSpecialist, false);
  assert.equal(resGreeting.tasks.length, 0);

  // Case B: API Documentation inquiry -> Doc only
  const resDoc = selector.select({
    objective: "Look up the official documentation and API signature for React 19 useActionState hook",
    availableMediobots,
  });
  assert.equal(resDoc.requiresSpecialist, true);
  assert.equal(resDoc.tasks.length, 1);
  assert.equal(resDoc.tasks[0]?.definitionId, "def-doc");

  // Case C: Pure Implementation -> Cody only
  const resCoding = selector.select({
    objective: "Implement a rate limiter class in src/limiter.ts and export it",
    availableMediobots,
  });
  assert.equal(resCoding.requiresSpecialist, true);
  assert.equal(resCoding.tasks.length, 1);
  assert.equal(resCoding.tasks[0]?.definitionId, "def-cody");

  // Case D: Research and Documentation comparison -> Concurrent Doc + Research
  const resMulti = selector.select({
    objective: "Research architectural tradeoffs of Zustand vs Redux Toolkit and verify the latest documentation specs",
    availableMediobots,
  });
  assert.equal(resMulti.requiresSpecialist, true);
  assert.equal(resMulti.tasks.length, 2);
  const defIds = resMulti.tasks.map((t) => t.definitionId);
  assert.ok(defIds.includes("def-doc" as MediobotDefinitionId));
  assert.ok(defIds.includes("def-res" as MediobotDefinitionId));

  // Case E: Sequential dependency: "First check the docs for API syntax, then implement the component"
  const resSeq = selector.select({
    objective: "First check the docs for GSAP timeline syntax, then implement the hero animation component",
    availableMediobots,
  });
  assert.equal(resSeq.requiresSpecialist, true);
  const codyTask = resSeq.tasks.find((t) => t.definitionId === "def-cody");
  const docTask = resSeq.tasks.find((t) => t.definitionId === "def-doc");
  assert.ok(codyTask);
  assert.ok(docTask);
  assert.deepEqual(codyTask.dependencies, [docTask.id]);
});

test("2. Independent specialists execute concurrently with verified overlapping timestamps", async () => {
  const h = createTestHarness();
  const startA = { t: 0 };
  const startB = { t: 0 };

  const plan: OrchestrationPlanSpec = {
    planId: "plan-parallel-proof",
    goal: "Investigate and document in parallel",
    tasks: [
      {
        id: "task-doc-1" as TaskId,
        definitionId: h.docDef.id,
        objective: "Doc task: read API",
      },
      {
        id: "task-res-1" as TaskId,
        definitionId: h.resDef.id,
        objective: "Research task: evaluate tradeoffs",
      },
    ],
  };

  const adapters = new Map([
    [
      h.docDef.id,
      async () => {
        startA.t = performance.now();
        await new Promise((res) => setTimeout(res, 60));
      },
    ],
    [
      h.resDef.id,
      async () => {
        startB.t = performance.now();
        await new Promise((res) => setTimeout(res, 60));
      },
    ],
  ]);

  const result = await h.orchestrator.executePlan(plan, { specialistAdapters: adapters });

  assert.equal(result.status, "completed");
  assert.equal(result.tasks.length, 2);
  assert.ok(result.executionInterval.maxParallelWorkers >= 2, "Must execute with at least 2 parallel workers");
  assert.ok(result.executionInterval.verifiedOverlapMs > 20, `Must verify real overlap: got ${result.executionInterval.verifiedOverlapMs}ms`);

  // Both started nearly simultaneously
  const deltaStart = Math.abs(startA.t - startB.t);
  assert.ok(deltaStart < 30, `Both workers must start concurrently within 30ms: got ${deltaStart}ms`);
});

test("3. Dependent tasks wait for prerequisites", async () => {
  const h = createTestHarness();
  let docCompletedAt = 0;
  let codyStartedAt = 0;

  const plan: OrchestrationPlanSpec = {
    planId: "plan-dependency-proof",
    goal: "Doc prerequisite before Cody",
    tasks: [
      {
        id: "prereq-doc" as TaskId,
        definitionId: h.docDef.id,
        objective: "Prerequisite doc task",
      },
      {
        id: "dependent-cody" as TaskId,
        definitionId: h.codyDef.id,
        objective: "Dependent coding task",
        dependencies: ["prereq-doc" as TaskId],
      },
    ],
  };

  const adapters = new Map([
    [
      h.docDef.id,
      async () => {
        await new Promise((res) => setTimeout(res, 40));
        docCompletedAt = performance.now();
      },
    ],
    [
      h.codyDef.id,
      async () => {
        codyStartedAt = performance.now();
        await new Promise((res) => setTimeout(res, 20));
      },
    ],
  ]);

  const result = await h.orchestrator.executePlan(plan, { specialistAdapters: adapters });

  assert.equal(result.status, "completed");
  assert.ok(codyStartedAt >= docCompletedAt, `Cody (${codyStartedAt}) must start after Doc finishes (${docCompletedAt})`);
});

test("4. A fast specialist delivers a result while slower specialists remain active", async () => {
  const h = createTestHarness();
  let fastDoneTime = 0;
  let slowDoneTime = 0;

  const plan: OrchestrationPlanSpec = {
    planId: "plan-fast-slow",
    goal: "Fast and slow independent specialists",
    tasks: [
      {
        id: "fast-task" as TaskId,
        definitionId: h.docDef.id,
        objective: "Quick documentation lookup",
      },
      {
        id: "slow-task" as TaskId,
        definitionId: h.resDef.id,
        objective: "Long in-depth research",
      },
    ],
  };

  const adapters = new Map([
    [
      h.docDef.id,
      async () => {
        await new Promise((res) => setTimeout(res, 15));
        fastDoneTime = performance.now();
      },
    ],
    [
      h.resDef.id,
      async () => {
        await new Promise((res) => setTimeout(res, 80));
        slowDoneTime = performance.now();
      },
    ],
  ]);

  const result = await h.orchestrator.executePlan(plan, { specialistAdapters: adapters });

  assert.equal(result.status, "completed");
  assert.ok(fastDoneTime < slowDoneTime, "Fast task must complete before slow task");
  const fastState = result.tasks.find((t) => t.taskId === "fast-task");
  const slowState = result.tasks.find((t) => t.taskId === "slow-task");
  assert.equal(fastState?.status, "completed");
  assert.equal(slowState?.status, "completed");
  assert.ok(fastState!.completedAt! < slowState!.completedAt!);
});

test("5. Specialists produce intermediate artifacts and Maestro reacts in real time", async () => {
  const h = createTestHarness();
  const collectedArtifacts: IntermediateArtifact[] = [];

  const plan: OrchestrationPlanSpec = {
    planId: "plan-artifacts",
    goal: "Produce intermediate findings",
    tasks: [
      {
        id: "task-doc-art" as TaskId,
        definitionId: h.docDef.id,
        objective: "Fetch docs and stream findings",
      },
    ],
  };

  const adapters = new Map([
    [
      h.docDef.id,
      async (_ctx: any, _run: any, emit: any) => {
        // 1. Emit provisional finding
        emit({
          kind: "documentation",
          title: "Preliminary API Signature",
          content: "export function useActionState<State>(...)",
          isProvisional: true,
        });

        await new Promise((res) => setTimeout(res, 20));

        // 2. Emit verified final artifact
        emit({
          kind: "api-signature",
          title: "Verified React 19 useActionState Signature",
          content: "const [state, formAction, isPending] = useActionState(fn, initialState, permalink?);",
          isProvisional: false,
        });
      },
    ],
  ]);

  const result = await h.orchestrator.executePlan(plan, {
    specialistAdapters: adapters,
    onArtifact: (a) => collectedArtifacts.push(a),
  });

  assert.equal(result.status, "completed");
  assert.equal(collectedArtifacts.length, 2);
  assert.equal(collectedArtifacts[0]?.isProvisional, true);
  assert.equal(collectedArtifacts[1]?.isProvisional, false);

  // Durable store has evidence recorded
  const evidenceInDb = await h.store.getEvidence("task-doc-art");
  assert.equal(evidenceInDb.length, 2);
  assert.equal(evidenceInDb[0]?.validity, "observed");
  assert.equal(evidenceInDb[1]?.validity, "verified");
});

test("6. Cody can request Doc assistance mid-task", async () => {
  const h = createTestHarness();
  let codyReceivedAnswer = "";

  const plan: OrchestrationPlanSpec = {
    planId: "plan-cody-support",
    goal: "Cody requests support mid-task",
    tasks: [
      {
        id: "cody-initial" as TaskId,
        definitionId: h.codyDef.id,
        objective: "Implement component using unfamiliar API",
      },
    ],
  };

  const adapters = new Map([
    [
      h.codyDef.id,
      async (ctx: any) => {
        const resolution = await ctx.options.orchestrator.requestSupport?.({
          id: "req-cody-1",
          requesterTaskId: ctx.taskId,
          requesterWorkerId: ctx.workerId,
          requesterMediobotId: ctx.definitionId,
          capabilityNeeded: "documentation",
          query: "Official options for GSAP scrollTrigger onUpdate callback",
          requestedAt: Date.now(),
        });
        codyReceivedAnswer = resolution?.answer ?? "";
      },
    ],
    [
      h.docDef.id,
      async (_ctx: any, _run: any, emit: any) => {
        emit({
          kind: "api-signature",
          title: "GSAP scrollTrigger onUpdate options",
          content: "onUpdate: (self) => { const progress = self.progress; }",
          isProvisional: false,
        });
      },
    ],
  ]);

  const result = await h.orchestrator.executePlan(plan, { specialistAdapters: adapters });

  assert.equal(result.status, "completed");
  assert.ok(codyReceivedAnswer.includes("onUpdate: (self) =>"), "Cody must receive the answer from the support request");
});

test("7. Maestro can dynamically schedule Doc", async () => {
  const h = createTestHarness();

  const plan: OrchestrationPlanSpec = {
    planId: "plan-cody-support-scheduling",
    goal: "Verify Maestro dynamically schedules Doc",
    tasks: [
      {
        id: "cody-initial" as TaskId,
        definitionId: h.codyDef.id,
        objective: "Implement component using unfamiliar API",
      },
    ],
  };

  const adapters = new Map([
    [
      h.codyDef.id,
      async (ctx: any) => {
        await ctx.options.orchestrator.requestSupport?.({
          id: "req-cody-sched",
          requesterTaskId: ctx.taskId,
          requesterWorkerId: ctx.workerId,
          requesterMediobotId: ctx.definitionId,
          capabilityNeeded: "documentation",
          query: "Official options for GSAP scrollTrigger onUpdate callback",
          requestedAt: Date.now(),
        });
      },
    ],
    [
      h.docDef.id,
      async (_ctx: any, _run: any, emit: any) => {
        emit({
          kind: "api-signature",
          title: "GSAP scrollTrigger onUpdate options",
          content: "onUpdate: (self) => { const progress = self.progress; }",
          isProvisional: false,
        });
      },
    ],
  ]);

  const result = await h.orchestrator.executePlan(plan, { specialistAdapters: adapters });

  assert.equal(result.status, "completed");
  // Check that Doc task was created dynamically
  const docTaskState = result.tasks.find((t) => t.spec.definitionId === h.docDef.id);
  assert.ok(docTaskState, "Doc task must be dynamically created");
  assert.equal(docTaskState.status, "completed");

  // Check durable delegation record
  const delegations = await h.store.getDelegations("cody-initial");
  assert.ok(delegations.length >= 1, "Must record durable delegation from Cody to Doc");
});

test("recursive identical support requests return unresolved instead of self-waiting", async () => {
  const h = createTestHarness();
  const query = "Official options for GSAP scrollTrigger onUpdate callback";
  let nestedDecision: string | undefined;
  const result = await h.orchestrator.executePlan({
    planId: "plan-support-cycle-guard",
    goal: "Bound recursive specialist support",
    tasks: [{ id: "cody-cycle-parent" as TaskId, definitionId: h.codyDef.id, objective: "Ask Doc" }],
  }, { specialistAdapters: new Map([
    [h.codyDef.id, async (ctx: any) => {
      await ctx.options.orchestrator.requestSupport({ id: "cycle-parent-request", requesterTaskId: ctx.taskId,
        requesterWorkerId: ctx.workerId, requesterMediobotId: ctx.definitionId, capabilityNeeded: "documentation", query, requestedAt: Date.now() });
    }],
    [h.docDef.id, async (ctx: any, _run: any, emit: any) => {
      const nested = await ctx.options.orchestrator.requestSupport({ id: "cycle-child-request", requesterTaskId: ctx.taskId,
        requesterWorkerId: ctx.workerId, requesterMediobotId: ctx.definitionId, capabilityNeeded: "documentation", query, requestedAt: Date.now() });
      nestedDecision = nested.decision;
      emit({ kind: "api-signature", title: "Available API evidence", content: "The callback receives a progress value.", isProvisional: false });
    }],
  ]) });
  assert.equal(nestedDecision, "unnecessary");
  assert.equal(result.status, "completed");
  assert.ok(result.tasks.some(state => state.spec.definitionId === h.docDef.id && state.status === "completed"));
});

test("8. Existing agents continue independently during dynamic delegation", async () => {
  const h = createTestHarness();
  let researchFinishedTime = 0;
  let codyFinishedTime = 0;

  const plan: OrchestrationPlanSpec = {
    planId: "plan-independent-during-delegation",
    goal: "Research continues while Cody requests Doc support",
    tasks: [
      {
        id: "cody-task" as TaskId,
        definitionId: h.codyDef.id,
        objective: "Cody with support",
      },
      {
        id: "independent-research" as TaskId,
        definitionId: h.resDef.id,
        objective: "Independent research task",
      },
    ],
  };

  const adapters = new Map([
    [
      h.codyDef.id,
      async (ctx: any) => {
        await ctx.options.orchestrator.requestSupport?.({
          id: "req-cody-independent",
          requesterTaskId: ctx.taskId,
          requesterWorkerId: ctx.workerId,
          requesterMediobotId: ctx.definitionId,
          capabilityNeeded: "documentation",
          query: "Need Doc investigation",
          requestedAt: Date.now(),
        });
        codyFinishedTime = performance.now();
      },
    ],
    [
      h.docDef.id,
      async (_ctx: any, _run: any, emit: any) => {
        await new Promise((res) => setTimeout(res, 50));
        emit({
          kind: "documentation",
          title: "Doc findings",
          content: "Doc result",
          isProvisional: false,
        });
      },
    ],
    [
      h.resDef.id,
      async () => {
        // Research is quick and finishes independently
        await new Promise((res) => setTimeout(res, 20));
        researchFinishedTime = performance.now();
      },
    ],
  ]);

  const result = await h.orchestrator.executePlan(plan, { specialistAdapters: adapters });

  assert.equal(result.status, "completed");
  assert.ok(researchFinishedTime > 0);
  assert.ok(codyFinishedTime > 0);
  // Research completed on its own timeline without waiting for Cody's delegation to finish
  assert.ok(researchFinishedTime < codyFinishedTime, "Research should finish independently before Cody's delegation completes");
});

test("9. Resource Governor limits are respected during task execution", async () => {
  // Governor limit = 2 concurrent tasks
  const h = createTestHarness({ maxGovernorTasks: 2 });
  let maxConcurrentRunning = 0;
  let currentRunning = 0;

  const plan: OrchestrationPlanSpec = {
    planId: "plan-governor",
    goal: "4 tasks under 2-slot limit",
    tasks: [
      { id: "g-1" as TaskId, definitionId: h.docDef.id, objective: "Task 1" },
      { id: "g-2" as TaskId, definitionId: h.resDef.id, objective: "Task 2" },
      { id: "g-3" as TaskId, definitionId: h.testerDef.id, objective: "Task 3" },
      { id: "g-4" as TaskId, definitionId: h.codyDef.id, objective: "Task 4" },
    ],
  };

  const makeWorker = () => async () => {
    currentRunning++;
    maxConcurrentRunning = Math.max(maxConcurrentRunning, currentRunning);
    await new Promise((res) => setTimeout(res, 30));
    currentRunning--;
  };

  const adapters = new Map([
    [h.docDef.id, makeWorker()],
    [h.resDef.id, makeWorker()],
    [h.testerDef.id, makeWorker()],
    [h.codyDef.id, makeWorker()],
  ]);

  const result = await h.orchestrator.executePlan(plan, { specialistAdapters: adapters });

  assert.equal(result.status, "completed");
  assert.ok(maxConcurrentRunning <= 2, `Max concurrent tasks (${maxConcurrentRunning}) must not exceed governor limit (2)`);
});

test("10. Agent failure does not discard successful work", async () => {
  const h = createTestHarness();

  const plan: OrchestrationPlanSpec = {
    planId: "plan-partial-failure",
    goal: "One succeeds, one fails",
    tasks: [
      { id: "success-task" as TaskId, definitionId: h.docDef.id, objective: "Doc succeeds" },
      { id: "failure-task" as TaskId, definitionId: h.resDef.id, objective: "Research fails" },
    ],
  };

  const adapters = new Map([
    [
      h.docDef.id,
      async (_ctx: any, _run: any, emit: any) => {
        emit({
          kind: "documentation",
          title: "Preserved Successful Evidence",
          content: "Valid documentation content that must not be discarded",
          isProvisional: false,
        });
      },
    ],
    [
      h.resDef.id,
      async () => {
        throw new Error("Simulated network timeout in Research");
      },
    ],
  ]);

  const result = await h.orchestrator.executePlan(plan, { specialistAdapters: adapters });

  assert.equal(result.status, "partial_success");
  const successState = result.tasks.find((t) => t.taskId === "success-task");
  const failState = result.tasks.find((t) => t.taskId === "failure-task");

  assert.equal(successState?.status, "completed");
  assert.equal(failState?.status, "failed");

  // Evidence from successful task was preserved in durable store and in result
  assert.equal(result.intermediateArtifacts.length, 1);
  assert.equal(result.intermediateArtifacts[0]?.title, "Preserved Successful Evidence");

  const preservedEv = await h.store.getEvidence("success-task");
  assert.equal(preservedEv.length, 1);
  assert.equal(preservedEv[0]?.claim, "Preserved Successful Evidence");
});

test("11. Cancellation propagates correctly to running specialists and releases leases", async () => {
  const h = createTestHarness();
  const controller = new AbortController();
  let cancelledCleanly = false;

  const plan: OrchestrationPlanSpec = {
    planId: "plan-cancel",
    goal: "Cancel running task",
    tasks: [
      { id: "long-task" as TaskId, definitionId: h.docDef.id, objective: "Long running doc task" },
    ],
  };

  const adapters = new Map([
    [
      h.docDef.id,
      async (_ctx: any, run: any) => {
        try {
          await new Promise((res, rej) => {
            const timer = setTimeout(res, 5000);
            run.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              rej(new Error("aborted"));
            });
          });
        } catch {
          cancelledCleanly = true;
          throw new Error("aborted");
        }
      },
    ],
  ]);

  setTimeout(() => controller.abort(), 30);
  const result = await h.orchestrator.executePlan(plan, { specialistAdapters: adapters }, controller.signal);

  assert.equal(result.status, "cancelled");
  assert.ok(cancelledCleanly, "Specialist should observe abort signal and terminate cleanly");
  assert.equal(h.resourceGovernor.activeLeasesCount, 0, "All resource governor leases must be released on cancellation");
});

test("12. Restart recovery preserves execution state and reconciles interrupted tasks", async () => {
  const h = createTestHarness();

  // Create a running task directly in durable store as if a crash occurred
  await h.store.createTask({
    id: "task-interrupted-by-crash",
    workspaceId: "ws-1",
    goal: "In-flight task during crash",
    definitionId: h.docDef.id,
    maxRetries: 2,
  });
  await h.store.updateTask("task-interrupted-by-crash", { status: "running" });

  // Add evidence from an already completed task
  await h.store.createTask({
    id: "task-already-completed",
    workspaceId: "ws-1",
    goal: "Completed task before crash",
    definitionId: h.resDef.id,
    maxRetries: 2,
  });
  await h.store.updateTask("task-already-completed", { status: "completed" });
  await h.store.addEvidence({
    taskId: "task-already-completed",
    kind: "research-evidence",
    claim: "Pre-crash verified research",
    content: "Tradeoff analysis preserved across restart",
    validity: "verified",
    source: {},
  });

  // Reconcile on startup
  const reconciled = await h.durableEngine.reconcileOnStartup("ws-1");

  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0]?.id, "task-interrupted-by-crash");
  assert.equal(reconciled[0]?.status, "interrupted");

  // Completed task is unchanged and its evidence is preserved
  const completedTask = await h.store.getTask("task-already-completed");
  assert.equal(completedTask?.status, "completed");
  const ev = await h.store.getEvidence("task-already-completed");
  assert.equal(ev.length, 1);
  assert.equal(ev[0]?.claim, "Pre-crash verified research");
});

test("13. Duplicate delegation requests are prevented via cache and deduplication", async () => {
  const h = createTestHarness();
  let docExecutionCount = 0;

  const plan: OrchestrationPlanSpec = {
    planId: "plan-dedup",
    goal: "Two identical requests should only schedule Doc once",
    tasks: [
      { id: "cody-1" as TaskId, definitionId: h.codyDef.id, objective: "First requester" },
      { id: "cody-2" as TaskId, definitionId: h.codyDef.id, objective: "Second requester" },
    ],
  };

  const adapters = new Map([
    [
      h.codyDef.id,
      async (ctx: any) => {
        // Both request the EXACT same support
        await ctx.options.orchestrator.requestSupport?.({
          id: `req-${ctx.taskId}`,
          requesterTaskId: ctx.taskId,
          requesterWorkerId: ctx.workerId,
          requesterMediobotId: ctx.definitionId,
          capabilityNeeded: "documentation",
          query: "Exactly same query: React 19 useActionState signature",
          requestedAt: Date.now(),
        });
      },
    ],
    [
      h.docDef.id,
      async (_ctx: any, _run: any, emit: any) => {
        docExecutionCount++;
        emit({
          kind: "api-signature",
          title: "useActionState",
          content: "const [state, formAction] = useActionState(...)",
          isProvisional: false,
        });
      },
    ],
  ]);

  const result = await h.orchestrator.executePlan(plan, { specialistAdapters: adapters });

  assert.equal(result.status, "completed");
  assert.equal(docExecutionCount, 1, "Doc specialist must only be scheduled once for duplicate requests");
});

test("14. No hardcoded specialist sequence exists; dynamic DAG structure generated per goal", () => {
  const selector = new DynamicSpecialistSelector();
  const availableMediobots = [
    { definitionId: "def-cody" as MediobotDefinitionId, name: "Cody", role: "coding", capabilities: ["workspace"], assignable: true },
    { definitionId: "def-doc" as MediobotDefinitionId, name: "Doc", role: "doc", capabilities: ["documentation.search"], assignable: true },
    { definitionId: "def-res" as MediobotDefinitionId, name: "Research", role: "research", capabilities: ["tradeoff-analysis"], assignable: true },
    { definitionId: "def-tester" as MediobotDefinitionId, name: "Tester", role: "tester", capabilities: ["verification"], assignable: true },
  ];

  // 1 task plan
  const p1 = selector.select({ objective: "Investigate performance benchmarks for Bun vs Node", availableMediobots });
  assert.equal(p1.tasks.length, 1);
  assert.equal(p1.tasks[0]?.definitionId, "def-res");

  // 2 independent parallel tasks plan
  const p2 = selector.select({ objective: "Read documentation for Vite 6 and investigate tradeoffs of Rolldown", availableMediobots });
  assert.equal(p2.tasks.length, 2);
  assert.equal(p2.tasks[0]?.dependencies?.length ?? 0, 0);
  assert.equal(p2.tasks[1]?.dependencies?.length ?? 0, 0);

  // 3 tasks with dependency DAG
  const p3 = selector.select({
    objective: "First check the documentation for Tailwind v4, then implement the navbar, and verify with tests",
    availableMediobots,
  });
  assert.equal(p3.tasks.length, 3);
  const doc = p3.tasks.find((t) => t.definitionId === "def-doc");
  const cody = p3.tasks.find((t) => t.definitionId === "def-cody");
  const tester = p3.tasks.find((t) => t.definitionId === "def-tester");

  assert.ok(doc && cody && tester);
  assert.deepEqual(cody.dependencies, [doc.id]);
  assert.deepEqual(tester.dependencies, [cody.id]);
});
