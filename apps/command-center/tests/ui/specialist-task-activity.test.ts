import assert from "node:assert/strict";
import test from "node:test";
import { specialistActivityState, specialistAssignmentGoal, specialistTaskActivity, specialistTaskEventLabel, specialistTaskIdentity } from "../../src/features/empty/specialistTaskActivity.ts";
import { mergeAgentTaskHistory } from "../../src/state/specialistTaskHistory.ts";

test("specialist live activity uses child execution identity while retaining parent assignment context", () => {
  const event = { taskId: "parent-maestro-task", executionTaskId: "child-cody-task" };
  assert.equal(specialistTaskIdentity(event), "child-cody-task");
  assert.equal(specialistTaskIdentity({ taskId: "direct-specialist-task" }), "direct-specialist-task");
  assert.equal(specialistAssignmentGoal("I’ve assigned Cody to: Implement the prime function"), "Implement the prime function");
});

test("specialist workspace activity state follows attributed execution and collaboration events", () => {
  assert.equal(specialistActivityState({ type: "worker.assigned", occurredAt: 1 }), "planning");
  assert.equal(specialistActivityState({ type: "tool.started", toolName: "filesystem.read", occurredAt: 2 }), "inspecting");
  assert.equal(specialistActivityState({ type: "tool.started", toolName: "filesystem.write", occurredAt: 3 }), "editing");
  assert.equal(specialistActivityState({ type: "tool.started", toolName: "terminal.execute", activityState: "verifying", occurredAt: 4 }), "verifying");
  assert.equal(specialistActivityState({ type: "worker.progress", activityState: "collaborating", occurredAt: 5 }), "collaborating");
  assert.equal(specialistActivityState({ type: "tool.completed", toolName: "terminal.execute", activityState: "recovered", occurredAt: 6 }), "recovered");
  assert.equal(specialistActivityState({ type: "worker.failed", occurredAt: 7 }), "failed");
  assert.equal(specialistActivityState({ type: "approval.required", occurredAt: 8 }), "waiting_for_approval");
  assert.equal(specialistActivityState({ type: "approval.resolved", occurredAt: 9 }), "thinking");
});

test("specialist activity keeps attributed tools and meaningful lifecycle events while omitting generic progress", () => {
  const activity = specialistTaskActivity([
    { type: "worker.started", occurredAt: 1 },
    { type: "worker.progress", message: "Cody progress.", occurredAt: 2 },
    { type: "tool.completed", toolName: "filesystem.read", occurredAt: 4 },
    { type: "worker.progress", message: "Read the module and found the entry point.", occurredAt: 3 },
    { type: "worker.failed", message: "Command could not start (ENOENT).", occurredAt: 5 },
    { type: "other.telemetry", message: "hidden detail", occurredAt: 6 },
  ]);

  assert.deepEqual(activity.map((event) => event.occurredAt), [1, 3, 4, 5]);
  assert.equal(specialistTaskEventLabel(activity[2]!), "filesystem.read · completed");
  assert.equal(specialistTaskEventLabel(activity[3]!), "Command could not start (ENOENT).");
});

test("specialist activity is bounded but preserves a recent failure diagnostic", () => {
  const events = Array.from({ length: 10 }, (_, index) => ({
    type: index === 2 ? "tool.failed" : "tool.completed", toolName: index === 2 ? "terminal.execute" : `filesystem.read-${index}`,
    ...(index === 2 ? { command: "python3 [arguments redacted]", workingDirectory: ".", errorCode: "ENOENT", recoveryReason: "Use the available interpreter" } : {}),
    occurredAt: index,
  }));
  const activity = specialistTaskActivity(events, 4);

  assert.deepEqual(activity.map((event) => event.occurredAt), [2, 7, 8, 9]);
  assert.equal(specialistTaskEventLabel(activity[0]!), "terminal.execute · failed · python3 [arguments redacted] · cwd=. · ENOENT · Use the available interpreter");
});

test("late durable task hydration keeps newer live specialist events and lifecycle state", () => {
  const durable = [{ id: "child-cody", state: "running", goal: "Implement prime check",
    assignedMediobot: { id: "cody", name: "Cody" },
    events: [{ id: "evt-1", sequence: 1, type: "worker.started", occurredAt: 10, workerDefinitionId: "cody" }] }];
  const live = [{ id: "child-cody", state: "failed", goal: "Implement prime check",
    assignedMediobot: { id: "cody", name: "Cody" },
    events: [
      { id: "evt-1", sequence: 1, type: "worker.started", occurredAt: 10, workerDefinitionId: "cody" },
      { id: "evt-2", sequence: 2, type: "tool.failed", occurredAt: 11, workerDefinitionId: "cody", toolName: "terminal.execute" },
      { id: "evt-3", sequence: 3, type: "worker.failed", occurredAt: 12, workerDefinitionId: "cody", message: "Command could not start (ENOENT)." },
    ],
    artifacts: [{ id: "artifact-1", mediobotId: "cody", name: "prime_check.py", reference: "prime_check.py", contentHash: "a".repeat(64) }],
  }];

  const merged = mergeAgentTaskHistory(durable, live);
  assert.equal(merged[0]?.state, "failed");
  assert.deepEqual(merged[0]?.events?.map((event) => event.id), ["evt-1", "evt-2", "evt-3"]);
  assert.equal(merged[0]?.events?.[2]?.message, "Command could not start (ENOENT).");
  assert.equal(merged[0]?.artifacts?.length, 1);
  assert.deepEqual(mergeAgentTaskHistory(merged, merged)[0]?.events?.map((event) => event.id), ["evt-1", "evt-2", "evt-3"],
    "repeated hydration remains idempotent");
});

test("stale durable snapshots do not erase an active event-backed specialist assignment", () => {
  const live = [{ id: "child-cody", state: "running", goal: "Inspect the module entry point",
    assignedMediobot: { id: "cody", name: "Cody" },
    events: [
      { id: "evt-assigned", sequence: 1, type: "worker.assigned", occurredAt: 10, workerDefinitionId: "cody" },
      { id: "evt-read", sequence: 2, type: "tool.completed", occurredAt: 11, workerDefinitionId: "cody", toolName: "filesystem.read" },
    ] }];

  const merged = mergeAgentTaskHistory([], live);
  assert.equal(merged.length, 1, "a temporarily stale durable listing must not hide active event-backed work");
  assert.equal(merged[0]?.id, "child-cody");
  assert.equal(merged[0]?.state, "running");
  assert.deepEqual(merged[0]?.events?.map((event) => event.id), ["evt-assigned", "evt-read"]);

  assert.deepEqual(mergeAgentTaskHistory([{ ...live[0]!, state: "completed" }], merged)
    .map((task) => [task.id, task.state]), [["child-cody", "completed"]],
  "once SQLite includes the terminal task state, the durable snapshot becomes authoritative");
  assert.deepEqual(mergeAgentTaskHistory([], [{ ...live[0]!, state: "completed" }]), [],
    "terminal live-only tasks are not retained without durable confirmation");
});
