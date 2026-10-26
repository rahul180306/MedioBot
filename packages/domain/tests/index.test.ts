import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createWorld } from "../src/index.ts";

const capability = {
  kind: "resource",
  name: "browser",
  description: "May use browser resources",
} as const;

function setup() {
  const world = createWorld();
  const definition = world.registerMediobotDefinition({
    name: "Vision",
    role: "vision",
    version: "1.0.0",
    instructions: "Inspect visual information.",
    declaredCapabilities: [capability],
  });
  return { world, definition };
}

describe("V2 world ownership foundation", () => {
  it("rejects illegal task lifecycle transitions without mutating terminal state", () => {
    const { world, definition } = setup();
    const worker = world.spawnWorker(definition.id);
    const task = world.assignTask(world.createTask("Run once").id, worker.id);
    world.setTaskState(task.id, "running");
    world.setTaskState(task.id, "completed");

    assert.throws(() => world.setTaskState(task.id, "running"), /Illegal Task transition: completed -> running/);
    assert.equal(world.inspect().tasks.find(entry => entry.id === task.id)?.state, "completed");
  });

  it("allows approval suspension and resumption but not execution after cancellation", () => {
    const { world, definition } = setup();
    const worker = world.spawnWorker(definition.id);
    const task = world.assignTask(world.createTask("Wait for approval").id, worker.id);
    world.setTaskState(task.id, "running");
    world.setTaskState(task.id, "waiting_approval");
    world.setTaskState(task.id, "running");
    world.setTaskState(task.id, "cancelled");

    assert.throws(() => world.setTaskState(task.id, "running"), /Illegal Task transition: cancelled -> running/);
    assert.equal(world.inspect().tasks.find(entry => entry.id === task.id)?.state, "cancelled");
  });

  it("supports a distinct user pause and safe resumption lifecycle", () => {
    const { world, definition } = setup();
    const worker = world.spawnWorker(definition.id);
    const task = world.assignTask(world.createTask("Pause and resume").id, worker.id);
    world.setTaskState(task.id, "running");
    world.setTaskState(task.id, "paused");
    assert.throws(() => world.setTaskState(task.id, "completed"), /Illegal Task transition: paused -> completed/);
    world.setTaskState(task.id, "running");
    world.setTaskState(task.id, "completed");
    assert.equal(world.inspect().tasks.find(entry => entry.id === task.id)?.state, "completed");
  });

  it("prevents reuse of stopped workers and released resources", () => {
    const { world, definition } = setup();
    const worker = world.spawnWorker(definition.id);
    world.setWorkerState(worker.id, "stopped");
    assert.throws(() => world.setWorkerState(worker.id, "busy"), /Illegal Worker transition: stopped -> busy/);

    const resource = world.registerResource({ kind: "terminal", owner: { type: "worker", worldId: world.id, workerId: worker.id } });
    world.setResourceState(resource.id, "released");
    assert.throws(() => world.setResourceState(resource.id, "available"), /Illegal Resource transition: released -> available/);
    assert.equal(world.inspect().resources.find(entry => entry.id === resource.id)?.state, "released");
  });

  it("creates independent workers from one definition", () => {
    const { world, definition } = setup();
    const first = world.spawnWorker(definition.id);
    const second = world.spawnWorker(definition.id);

    world.setWorkerState(first.id, "busy");

    assert.notEqual(first.id, second.id);
    assert.equal(world.inspect().workers.find((worker) => worker.id === first.id)?.state, "busy");
    assert.equal(world.inspect().workers.find((worker) => worker.id === second.id)?.state, "idle");
  });

  it("drains and disables a Mediobot without losing identity or interrupting owned history", () => {
    const { world, definition } = setup();
    const worker = world.spawnWorker(definition.id);
    const task = world.assignTask(world.createTask("Finish the current assignment").id, worker.id);
    world.setTaskState(task.id, "running");

    world.setMediobotLifecycleState(definition.id, "draining");
    assert.equal(world.inspect().definitions.find(entry => entry.id === definition.id)?.lifecycleState, "draining");
    assert.throws(() => world.spawnWorker(definition.id), /not active/i);
    assert.throws(() => world.setMediobotLifecycleState(definition.id, "disabled"), /active work/i);

    world.setTaskState(task.id, "completed");
    world.setMediobotLifecycleState(definition.id, "disabled");
    assert.throws(() => world.spawnWorker(definition.id), /not active/i);
    assert.equal(world.inspect().definitions.find(entry => entry.id === definition.id)?.name, "Vision",
      "disabled identity remains available for historical attribution");
    world.setMediobotLifecycleState(definition.id, "active");
    assert.equal(world.spawnWorker(definition.id).definitionId, definition.id);
  });

  it("allows two workers to own separate browser contexts", () => {
    const { world, definition } = setup();
    const first = world.spawnWorker(definition.id);
    const second = world.spawnWorker(definition.id);

    const firstContext = world.registerResource({
      kind: "browser-context",
      owner: { type: "worker", worldId: world.id, workerId: first.id },
    });
    const secondContext = world.registerResource({
      kind: "browser-context",
      owner: { type: "worker", worldId: world.id, workerId: second.id },
    });

    assert.notEqual(firstContext.id, secondContext.id);
    assert.deepEqual(firstContext.owner, { type: "worker", worldId: world.id, workerId: first.id });
    assert.deepEqual(secondContext.owner, { type: "worker", worldId: world.id, workerId: second.id });
  });

  it("does not return another worker's resources", () => {
    const { world, definition } = setup();
    const first = world.spawnWorker(definition.id);
    const second = world.spawnWorker(definition.id);
    const resource = world.registerResource({
      kind: "browser-page",
      owner: { type: "worker", worldId: world.id, workerId: first.id },
    });

    assert.deepEqual(world.getResourcesByOwner({ type: "worker", worldId: world.id, workerId: first.id }), [resource]);
    assert.deepEqual(world.getResourcesByOwner({ type: "worker", worldId: world.id, workerId: second.id }), []);
    assert.deepEqual(world.getResourceOwner(resource.id), resource.owner);
  });

  it("does not expose mutable ownership records", () => {
    const { world, definition } = setup();
    const first = world.spawnWorker(definition.id);
    const second = world.spawnWorker(definition.id);
    const resource = world.registerResource({
      kind: "browser-page",
      owner: { type: "worker", worldId: world.id, workerId: first.id },
    });

    (resource.owner as { workerId: string }).workerId = second.id;

    assert.deepEqual(world.getResourceOwner(resource.id), {
      type: "worker",
      worldId: world.id,
      workerId: first.id,
    });
  });

  it("keeps tasks assigned to different workers independently attributable", () => {
    const { world, definition } = setup();
    const first = world.spawnWorker(definition.id);
    const second = world.spawnWorker(definition.id);
    const firstTask = world.createTask("Inspect screenshot");
    const secondTask = world.createTask("Read page structure");

    const assignedFirst = world.assignTask(firstTask.id, first.id);
    const assignedSecond = world.assignTask(secondTask.id, second.id);

    assert.equal(assignedFirst.assignedWorkerId, first.id);
    assert.equal(assignedSecond.assignedWorkerId, second.id);
  });

  it("preserves evidence producer and task attribution", () => {
    const { world, definition } = setup();
    const first = world.spawnWorker(definition.id);
    const second = world.spawnWorker(definition.id);
    const firstTask = world.assignTask(world.createTask("Inspect A").id, first.id);
    const secondTask = world.assignTask(world.createTask("Inspect B").id, second.id);

    const evidence = world.recordEvidence({
      taskId: firstTask.id,
      workerId: first.id,
      source: { type: "observation", reference: "frame-1" },
      content: "Button is visible",
    });

    assert.equal(evidence.workerId, first.id);
    assert.equal(evidence.taskId, firstTask.id);
    assert.throws(() => world.recordEvidence({
      taskId: secondTask.id,
      workerId: first.id,
      source: { type: "observation", reference: "frame-2" },
      content: "Wrong producer",
    }), /assigned to the producing worker/i);
  });

  it("retains attribution for interleaved worker events", () => {
    const { world, definition } = setup();
    const first = world.spawnWorker(definition.id);
    const second = world.spawnWorker(definition.id);
    const firstTask = world.assignTask(world.createTask("Task A").id, first.id);
    const secondTask = world.assignTask(world.createTask("Task B").id, second.id);

    const events = [
      world.appendEvent({ type: "task.started", workerId: first.id, taskId: firstTask.id }),
      world.appendEvent({ type: "task.started", workerId: second.id, taskId: secondTask.id }),
      world.appendEvent({ type: "task.progressed", workerId: first.id, taskId: firstTask.id }),
      world.appendEvent({ type: "task.progressed", workerId: second.id, taskId: secondTask.id }),
    ];

    assert.ok(events.every((event) => event.worldId === world.id));
    assert.ok(events.filter((event) => event.workerId === first.id).every((event) => event.taskId === firstTask.id));
    assert.ok(events.filter((event) => event.workerId === second.id).every((event) => event.taskId === secondTask.id));
  });

  it("rejects an event that attributes another worker's resource", () => {
    const { world, definition } = setup();
    const first = world.spawnWorker(definition.id);
    const second = world.spawnWorker(definition.id);
    const firstTask = world.assignTask(world.createTask("Task A").id, first.id);
    const secondResource = world.registerResource({
      kind: "model-session",
      owner: { type: "worker", worldId: world.id, workerId: second.id },
    });

    assert.throws(() => world.appendEvent({
      type: "resource.used",
      workerId: first.id,
      taskId: firstTask.id,
      resourceId: secondResource.id,
    }), /resource owner does not match/i);
  });

  it("keeps task identity independent from worker identity", () => {
    const { world, definition } = setup();
    const worker = world.spawnWorker(definition.id);
    const firstTask = world.createTask("First task");
    const secondTask = world.createTask("Second task");

    assert.notEqual(firstTask.id, worker.id);
    assert.notEqual(secondTask.id, worker.id);
    assert.notEqual(firstTask.id, secondTask.id);
  });

  it("links delegated child tasks to an existing parent without changing their worker identity", () => {
    const { world, definition } = setup();
    const maestro = world.spawnWorker(definition.id);
    const parent = world.createTask("Coordinate coding work");
    const cody = world.spawnWorker(definition.id);
    const child = world.createTask("Inspect and repair the project", parent.id);
    const assignedParent = world.assignTask(parent.id, maestro.id);
    const assignedChild = world.assignTask(child.id, cody.id);
    assert.equal(assignedChild.parentTaskId, assignedParent.id);
    assert.equal(assignedChild.assignedWorkerId, cody.id);
    assert.notEqual(assignedChild.id, assignedParent.id);
    assert.throws(() => world.createTask("orphan", "missing-parent" as typeof parent.id), /does not exist/i);
  });

  it("supports world, worker, and task ownership and artifact attribution", () => {
    const { world, definition } = setup();
    const worker = world.spawnWorker(definition.id);
    const task = world.assignTask(world.createTask("Produce report").id, worker.id);
    const worldResource = world.registerResource({
      kind: "workspace",
      owner: { type: "world", worldId: world.id },
    });
    const taskResource = world.registerResource({
      kind: "terminal",
      owner: { type: "task", worldId: world.id, taskId: task.id },
    });
    const artifact = world.recordArtifact({
      taskId: task.id,
      workerId: worker.id,
      name: "report",
      reference: "memory:report-1",
    });

    assert.deepEqual(world.getResourcesByOwner(worldResource.owner), [worldResource]);
    assert.deepEqual(world.getResourcesByOwner(taskResource.owner), [taskResource]);
    assert.equal(artifact.worldId, world.id);
    assert.equal(artifact.taskId, task.id);
    assert.equal(artifact.workerId, worker.id);
  });

  it("keeps Goal identity and objective independent from Tasks and Workers across replanning", () => {
    const { world, definition } = setup();
    const goal = world.createGoal({ threadId: "thread-1", objective: "Repair the application",
      constraints: [{ text: "Do not change the UI", source: "user", hard: true }],
      successCriteria: [{ id: "build", statement: "The project typechecks" }] });
    const worker = world.spawnWorker(definition.id);
    const task = world.createTask("Run the typecheck");
    const updated = world.updateGoal(goal.id, { subgoals: ["Inspect diagnostics"], blockers: ["Build output pending"], budgetConsumed: 2 });
    assert.notEqual(goal.id, task.id);
    assert.notEqual(goal.id, worker.id);
    assert.equal(updated.objective, "Repair the application");
    assert.deepEqual(updated.constraints.map((constraint) => constraint.text), ["Do not change the UI"]);
    assert.equal(updated.successCriteria[0]?.state, "unknown");
    assert.equal((JSON.parse(JSON.stringify(updated)) as typeof updated).objective, updated.objective,
      "Goal state is plain serializable data suitable for future interruption recovery");
    assert.throws(() => world.updateGoal(goal.id, { status: "satisfied" as never }), /requires evidence-backed/i);
  });

  it("requires evidence for criterion outcomes and only evidence-backed criteria satisfy a Goal", () => {
    const { world, definition } = setup();
    const goal = world.createGoal({ threadId: "thread-2", objective: "Verify the change",
      successCriteria: [{ id: "tests", statement: "Relevant tests pass", evidenceRequirement: {
        kind: "test-result", source: { type: "test-run", reference: "run-1" }, validity: "verified" } }] });
    assert.throws(() => world.supportGoalCriterion(goal.id, "tests", "satisfied", []), /requires supporting evidence/i);
    const worker = world.spawnWorker(definition.id);
    const task = world.assignTask(world.createTask("Run tests").id, worker.id);
    const evidence = world.recordEvidence({ taskId: task.id, workerId: worker.id, goalId: goal.id,
      source: { type: "test-run", reference: "run-1" }, kind: "test-result", claim: "Relevant tests passed", validity: "verified", content: "exit code 0" });
    const satisfied = world.supportGoalCriterion(goal.id, "tests", "satisfied", [evidence.id]);
    assert.equal(satisfied.status, "satisfied");
    assert.deepEqual(satisfied.evidenceIds, [evidence.id]);
    const reopened = world.supportGoalCriterion(goal.id, "tests", "unsatisfied", [evidence.id]);
    assert.equal(reopened.status, "blocked", "a later contrary assessment cannot leave the Goal falsely satisfied");
    assert.equal(world.transitionGoal(goal.id, "active").status, "active");
    assert.equal(world.inspect().evidence[0]?.goalId, goal.id);
    const noEvidenceGoal = world.createGoal({ threadId: "thread-3", objective: "Unknown outcome",
      successCriteria: [{ id: "proof", statement: "Proof exists" }] });
    assert.equal(noEvidenceGoal.successCriteria[0]?.state, "unknown");
    assert.equal(noEvidenceGoal.status, "active");
    const directEvidence = world.recordEvidence({ goalId: noEvidenceGoal.id,
      source: { type: "environment", reference: "manual-check" }, content: "A relevant check is available", kind: "observation" });
    assert.equal(directEvidence.taskId, undefined);
    assert.equal(directEvidence.workerId, undefined);
    assert.deepEqual(world.getGoal(noEvidenceGoal.id).evidenceIds, [directEvidence.id]);
  });

  for (const status of ["cancelled", "failed", "paused", "waiting-user", "blocked"] as const) {
    it(`preserves ${status} when delayed evidence satisfies a required criterion`, () => {
      const { world } = setup();
      const goal = world.createGoal({ threadId: "delayed", objective: "Verify",
        successCriteria: [{ id: "proof", statement: "Verified", evidenceRequirement: {
          kind: "test-result", source: { type: "environment", reference: "delayed" }, validity: "verified" } }] });
      world.updateGoal(goal.id, { status });
      const evidence = world.recordEvidence({ goalId: goal.id, kind: "test-result", validity: "verified",
        source: { type: "environment", reference: "delayed" }, content: "Proof arrived" });
      const updated = world.supportGoalCriterion(goal.id, "proof", "satisfied", [evidence.id]);
      assert.equal(updated.status, status);
      assert.equal(updated.successCriteria[0]?.state, "satisfied");
      assert.deepEqual(updated.successCriteria[0]?.supportingEvidenceIds, [evidence.id]);
      assert.equal(world.supportGoalCriterion(goal.id, "proof", "unsatisfied", [evidence.id]).status, status);
    });
  }

  it("never satisfies an optional-only Goal, even with evidence", () => {
    const { world } = setup();
    const goal = world.createGoal({ threadId: "optional", objective: "Verify",
      successCriteria: [{ id: "optional", statement: "Nice to have", required: false, evidenceRequirement: {
        kind: "test-result", source: { type: "environment", reference: "check" }, validity: "verified" } }] });
    const evidence = world.recordEvidence({ goalId: goal.id, kind: "test-result", validity: "verified",
      source: { type: "environment", reference: "check" }, content: "Checked" });
    for (const state of ["unsatisfied", "satisfied"] as const) {
      assert.equal(world.supportGoalCriterion(goal.id, "optional", state, [evidence.id]).status, "active");
    }
  });

  it("does not equate exhausted budget with success or failure", () => {
    const { world } = setup();
    const goal = world.createGoal({ threadId: "thread-budget", objective: "Investigate", budgetLimit: 1 });
    const exhausted = world.updateGoal(goal.id, { budgetConsumed: 1 });
    assert.equal(exhausted.budget.exhausted, true);
    assert.equal(exhausted.status, "active");
  });

  it("creates bounded outcome-oriented assignments and compact Goal Anchors", () => {
    const { world, definition } = setup();
    const goal = world.createGoal({ threadId: "thread-4", objective: "Fix the build",
      constraints: [{ text: "Preserve unrelated behavior", source: "user", hard: true },
        { text: "Prefer small changes", source: "maestro", hard: false }],
      successCriteria: [{ id: "typecheck", statement: "Typecheck succeeds" }, { id: "tests", statement: "Tests pass" }] });
    const assignment = world.createAssignment({ goalId: goal.id, targetDefinitionId: definition.id,
      objective: "Resolve the TypeScript errors", relevantContextRefs: ["diagnostics:latest"],
      constraints: ["Preserve unrelated behavior"], expectedOutcome: "Project typechecks successfully",
      evidenceExpectations: ["changed files", "typecheck result"] });
    const anchor = world.getGoalAnchor(goal.id);
    assert.equal(assignment.goalId, goal.id);
    assert.equal(assignment.targetDefinitionId, definition.id);
    assert.equal(assignment.objective, "Resolve the TypeScript errors");
    assert.equal("actions" in assignment, false);
    assert.deepEqual(anchor, { goalId: goal.id, objective: "Fix the build", constraints: ["Preserve unrelated behavior"],
      unresolvedCriteria: ["Typecheck succeeds", "Tests pass"], blockers: [] });
    assert.deepEqual(world.getAssignments(goal.id), [assignment]);
  });

  it("contains no platform-specific domain assumptions", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");

    assert.doesNotMatch(source, /macos|windows|darwin|win32|keyboard|playwright|cdp|browser-driver|\\\\|\/Users\//i);
  });
});
