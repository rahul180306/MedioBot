import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createWorld } from "@mediobot-v2/domain";
import {
  createMaestroCodyExecution,
  MaestroDecisionProvider,
  resolveDurableChildModelSelection,
} from "../src/index.ts";
import { TesterDecisionProvider } from "@mediobot-v2/tester";
import { ToolRuntime } from "@mediobot-v2/tools";
import {
  WorkerRuntime,
  DurableTaskEngine,
  type DurableTaskStore,
  type DurableTaskRecord,
  type DurableTaskEventRecord,
} from "@mediobot-v2/runtime";

class InMemoryDurableTaskStore implements DurableTaskStore {
  tasks = new Map<string, DurableTaskRecord>();
  events: DurableTaskEventRecord[] = [];
  delegations: Array<{ id: string; parentTaskId: string; childTaskId?: string | null; assignedMediobotId: string; assignedMediobotName: string; objective: string; status: "pending" | "active" | "completed" | "failed" | "cancelled"; createdAt: number; updatedAt: number }> = [];
  evidence: Array<{ id: string; taskId: string; kind: string; source: Record<string, unknown>; claim?: string | null; content: string; validity: "observed" | "verified" | "invalidated"; createdAt: number }> = [];
  artifacts = new Map<string, any>();

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

  async searchVerifiedEvidence() {
    return [];
  }

  async upsertArtifact(artifact: any) {
    this.artifacts.set(artifact.id, artifact);
    return { artifact, changed: true };
  }

  async upsertArtifactAndAppendEvent(artifact: any) {
    return this.upsertArtifact(artifact);
  }

  async getArtifacts(taskId: string) {
    return Array.from(this.artifacts.values()).filter((a) => a.taskId === taskId);
  }

  async reconcileInterruptedTasks() {
    return [];
  }
}

describe("P1 Model Routing & Tester Acceptance Verification", () => {
  it("single-delegation Cody routing resolves and executes using Cody's exact configured child model and effort", async () => {
    const world = createWorld();
    const runtime = new WorkerRuntime(world);
    const tools = new ToolRuntime(world);
    const durableTaskEngine = new DurableTaskEngine(new InMemoryDurableTaskStore());

    const capturedModels: string[] = [];

    let codyTurn = 0;
    const codyDecisions: any = {
      decide: async () => {
        codyTurn++;
        if (codyTurn === 1) {
          return { type: "list", path: "." };
        }
        return { type: "finish", summary: "Cody completed successfully" };
      },
      decideTurn: async () => {
        codyTurn++;
        if (codyTurn === 1) {
          return { type: "list", path: "." };
        }
        return { type: "finish", summary: "Cody completed successfully" };
      },
    };

    const maestroDecision = {
      type: "delegate" as const,
      definitionId: "cody",
      objective: "Single delegation task for Cody",
      relevantContextRefs: [],
      constraints: [],
      expectedOutcome: "Success",
      evidenceExpectations: [],
    };

    const maestro = new MaestroDecisionProvider({
      complete: async () => JSON.stringify(maestroDecision),
    });

    const execution = createMaestroCodyExecution({
      world,
      runtime,
      tools,
      maestroDefinition: { id: "maestro", name: "Maestro", role: "orchestration", version: "1" },
      codyDefinition: { id: "cody", name: "Cody", role: "coding", version: "1" },
      maestroDecisions: maestro,
      codyDecisions,
      decisionResolver: {
        resolveDecisions(options) {
          const selection = options?.modelSelection as { modelId?: string } | undefined;
          if (selection?.modelId) capturedModels.push(selection.modelId);
          return {
            maestroDecisions: maestro,
            codyDecisions,
          };
        },
      },
      durableTaskEngine,
    });

    const worker = world.spawnWorker(execution.maestroDefinitionId);
    const task = world.assignTask(world.createTask("Run single delegation Cody").id, worker.id);

    await durableTaskEngine.submitTask({
      id: task.id,
      workspaceId: "workspace-test",
      goal: task.goal,
      definitionId: execution.maestroDefinitionId,
    });
    await durableTaskEngine.startTask(task.id);

    const plan = execution.adapter.prepare({
      world,
      definitionId: execution.maestroDefinitionId,
      workerId: worker.id,
      taskId: task.id,
      goal: "Run single delegation Cody",
      options: {
        workspaceRoot: process.cwd(),
        durableTaskEngine,
        maestroDecision,
        modelSelection: { providerConnectionId: "parent-conn", modelId: "maestro-model-parent", reasoningEffort: "low" },
        assignmentModelSelections: {
          cody: { providerConnectionId: "cody-conn", modelId: "cody-model-child", reasoningEffort: "high" },
        },
      },
    });

    const result = await runtime.run({ ...plan, workerId: worker.id, taskId: task.id });
    assert.equal(result.state, "completed");

    // Assert that Cody was resolved with its child model selection
    const codyResolvedModel = capturedModels[capturedModels.length - 1];
    assert.equal(codyResolvedModel, "cody-model-child", "Cody must resolve with child model cody-model-child");
    assert.notEqual(codyResolvedModel, "maestro-model-parent", "Cody must NOT silently fall back to parent model");

    // Check durable engine delegations
    const delegations = await durableTaskEngine.getDelegations(task.id);
    assert.equal(delegations.length, 1);
    const codyDelegation = delegations[0]!;
    assert.equal(codyDelegation.assignedMediobotId, "cody");

    // Check that child task in durable store stored Cody's model selection
    const childModelSelection = await durableTaskEngine.getTaskModelSelection(codyDelegation.childTaskId!);
    assert.equal(childModelSelection?.modelId, "cody-model-child");
  });

  it("Tester reasoning effort uses Tester's own configured effort, never overridden by parent Maestro's effort", async () => {
    let observedTesterEffort: string | undefined;

    // Tester with default reasoning effort "medium"
    const testerDecisions = new TesterDecisionProvider(
      {
        complete: async (req: any) => {
          observedTesterEffort = req.reasoningEffort;
          return JSON.stringify({
            type: "finish",
            report: {
              status: "failed",
              summary: "Tester finished",
              assertions: [{ name: "test", passed: false }],
            },
          });
        },
      },
      undefined,
      "medium" // Tester's own configured effort
    );

    // Call decide with parent reasoning effort "high"
    await testerDecisions.decide(
      "Test reasoning effort precedence",
      [],
      new AbortController().signal,
      "high" as any // Parent Maestro effort
    );

    // Tester's own configured effort ("medium") must take precedence over parent's effort ("high")
    assert.equal(observedTesterEffort, "medium", "Tester's own configured effort must prevail over parent effort");
  });

  it("Tester missing model selection cleanly records blocked status without throwing ReferenceError", async () => {
    const world = createWorld();
    const runtime = new WorkerRuntime(world);
    const tools = new ToolRuntime(world);
    const durableTaskEngine = new DurableTaskEngine(new InMemoryDurableTaskStore());

    const execution = createMaestroCodyExecution({
      world,
      runtime,
      tools,
      maestroDefinition: { id: "maestro", name: "Maestro", role: "orchestration", version: "1" },
      testerDecisions: new TesterDecisionProvider({
        complete: async () => JSON.stringify({ type: "finish", report: { status: "failed", summary: "ok", assertions: [] } }),
      }),
      codyDecisions: {} as any,
      maestroDecisions: new MaestroDecisionProvider({
        complete: async () => JSON.stringify({ type: "respond", message: "Specialist blocked reported", basis: "conversation", evidenceRefs: [] }),
      }),
      textModelResolver: {
        resolveForOperation: () => ({
          descriptor: { providerId: "provider-test", modelId: "test-model" },
          client: { complete: async () => JSON.stringify({ status: "blocked", summary: "Blocked", evidence: [], blockers: ["Blocked"], unresolved: [] }) },
        }),
      },
      decisionResolver: {
        resolveDecisions() {
          return {};
        },
      },
      durableTaskEngine,
    });

    const testerId = execution.testerDefinitionId;
    const maestroDecision = {
      type: "delegate_text" as const,
      independence: "Independent testing check.",
      assignments: [
        {
          assignmentId: "tester-assign-1",
          definitionId: testerId,
          objective: "Inspect tests",
          relevantContext: "Context for tester",
          relevantContextRefs: [],
          constraints: [],
          expectedOutcome: "Observed tests",
          evidenceExpectations: [],
          requiredCapabilities: ["terminal.execute"],
        },
      ],
    };

    const worker = world.spawnWorker(execution.maestroDefinitionId);
    const task = world.assignTask(world.createTask("Run unconfigured tester").id, worker.id);

    await durableTaskEngine.submitTask({
      id: task.id,
      workspaceId: "workspace-test",
      goal: task.goal,
      definitionId: execution.maestroDefinitionId,
    });
    await durableTaskEngine.startTask(task.id);

    // Do NOT configure tester in assignmentModelSelections, and omit parent model
    const plan = execution.adapter.prepare({
      world,
      definitionId: execution.maestroDefinitionId,
      workerId: worker.id,
      taskId: task.id,
      goal: "Run unconfigured tester",
      options: {
        workspaceRoot: process.cwd(),
        durableTaskEngine,
        maestroDecision,
        assignmentModelSelections: {
          cody: { providerConnectionId: "cody", modelId: "cody-model" },
          // tester is intentionally omitted!
        },
      },
    });

    // Running must NOT throw ReferenceError: Cannot access 'task' before initialization
    const result = await runtime.run({ ...plan, workerId: worker.id, taskId: task.id });
    assert.equal(result.state, "completed");

    const snapshot = world.inspect();
    const testerAssignment = snapshot.assignments.find((a) => a.targetDefinitionId === testerId);
    assert.ok(testerAssignment, "Tester assignment should have been created without ReferenceError");

    // Verify task state was set to failed (blocked) cleanly
    const testerTask = snapshot.tasks.find((t) => t.id !== task.id);
    assert.equal(testerTask?.state, "failed", "Unconfigured tester child task must cleanly fail-closed as blocked");
  });

  it("durable task delegation recovers child model selection without reverting to parent selection", () => {
    const recoveredSelection = resolveDurableChildModelSelection({
      childExists: true,
      savedSelection: { providerConnectionId: "cody-conn", modelId: "cody-saved-model" },
      assignmentOverride: { providerConnectionId: "cody-conn", modelId: "cody-new-override" },
      parentSelection: { providerConnectionId: "maestro-conn", modelId: "maestro-parent-model" },
      allowParentFallback: false,
    });

    assert.equal(recoveredSelection?.modelId, "cody-saved-model", "Existing child must recover its saved model identity");
  });
});
