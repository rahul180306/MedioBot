import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorld, type EvidenceRequirement, type TaskEvidenceInput } from "../src/index.ts";

function setup() {
  const world = createWorld();
  const definition = world.registerMediobotDefinition({ name: "Verifier", role: "verifier", version: "1",
    instructions: "Verify execution", declaredCapabilities: [] });
  const worker = world.spawnWorker(definition.id);
  const otherWorker = world.spawnWorker(definition.id);
  const task = world.assignTask(world.createTask("Check revision").id, worker.id);
  const otherTask = world.assignTask(world.createTask("Other check").id, otherWorker.id);
  const requirement: EvidenceRequirement = { kind: "execution-check", source: { type: "verifier", reference: "check-1" },
    validity: "verified", workerId: worker.id, taskId: task.id, subject: "workspace", revision: "v2" };
  const goal = world.createGoal({ threadId: "thread", objective: "Verify revision", successCriteria: [
    { id: "check", statement: "Execution verified", evidenceRequirement: requirement }] });
  const input: TaskEvidenceInput = { taskId: task.id, workerId: worker.id, goalId: goal.id,
    kind: requirement.kind, source: { ...requirement.source }, validity: "verified",
    subject: "workspace", revision: "v2", content: "Check passed" };
  return { world, goal, requirement, input, otherTask, otherWorker };
}

describe("typed completion policy", () => {
  it("rejects structural JS evidence with missing producer halves and inherited identity", () => {
    const { world, goal, input } = setup();
    const { taskId, workerId, ...goalOnly } = input;
    const invalid = [
      { ...goalOnly, workerId: "nonexistent" }, { ...goalOnly, workerId }, { ...goalOnly, taskId },
      { ...goalOnly, taskId: undefined, workerId }, { ...goalOnly, taskId, workerId: undefined },
      { ...goalOnly, workerId: undefined },
      Object.assign(Object.create({ workerId }), goalOnly),
      Object.assign(Object.create({ taskId }), { ...goalOnly, workerId }),
      Object.assign(Object.create({ goalId: goal.id }), { taskId, workerId, source: input.source, content: "inherited" }),
    ];
    for (const candidate of invalid) {
      const before = world.inspect();
      assert.throws(() => world.recordEvidence(candidate as TaskEvidenceInput), /both taskId and workerId|own property/);
      assert.deepEqual(world.inspect(), before);
    }
    assert.equal(world.recordEvidence(goalOnly).goalId, goal.id);
  });

  it("validates structural evidence fields and known policy producer pins", () => {
    const { world, input, requirement, otherWorker } = setup();
    for (const fields of [{ source: null }, { source: { type: 1, reference: "check" } },
      { source: { type: "verifier", reference: {} } }, { kind: {} }, { validity: true },
      { content: {} }, { claim: {} }, { artifactReference: {} }, { subject: {} }, { revision: {} }]) {
      assert.throws(() => world.recordEvidence({ ...input, ...fields } as TaskEvidenceInput));
    }
    for (const fields of [{ workerId: "missing" }, { taskId: "missing" }, { workerId: otherWorker.id },
      { source: { type: "verifier", reference: {} } }, { kind: {} }, { validity: {} }]) {
      assert.throws(() => world.createGoal({ threadId: "invalid", objective: "Invalid pin", successCriteria: [
        { id: "check", statement: "Check", evidenceRequirement: { ...requirement, ...fields } as EvidenceRequirement }] }));
    }
    const { workerId, ...rest } = requirement;
    const inherited = Object.assign(Object.create({ workerId }), rest);
    assert.throws(() => world.createGoal({ threadId: "inherited", objective: "Invalid pin", successCriteria: [
      { id: "check", statement: "Check", evidenceRequirement: inherited }] }), /own property/);
    assert.equal(world.inspect().evidence.length, 0);
    assert.equal(world.listGoals().length, 1);
  });

  it("allowlists evidence and policies, dropping nested extras from input and snapshots", () => {
    const { world, input, requirement } = setup();
    const metadata = { nested: { value: "original" } };
    const extraRequirement = { ...requirement, metadata, source: { ...requirement.source, metadata } };
    const goal = world.createGoal({ threadId: "extras", objective: "Normalize policy", successCriteria: [
      { id: "check", statement: "Check", evidenceRequirement: extraRequirement }] });
    const evidence = world.recordEvidence({ ...input, goalId: goal.id, source: { ...input.source, metadata }, metadata } as TaskEvidenceInput);
    metadata.nested.value = "mutated-input";
    for (const snapshot of [goal, world.getGoal(goal.id), world.listGoals().find((entry) => entry.id === goal.id)!,
      world.inspect().goals.find((entry) => entry.id === goal.id)!]) {
      const policy = snapshot.successCriteria[0]!.evidenceRequirement!;
      assert.equal("metadata" in policy, false);
      assert.deepEqual(Object.keys(policy.source).sort(), ["reference", "type"]);
      Object.assign(policy.source, { metadata: { nested: { value: "mutated-snapshot" } } });
      Object.assign(policy, { metadata: { nested: { value: "mutated-policy" } } });
    }
    for (const snapshot of [evidence, world.inspect().evidence[0]!]) {
      assert.equal("metadata" in snapshot, false);
      assert.deepEqual(Object.keys(snapshot.source).sort(), ["reference", "type"]);
      Object.assign(snapshot.source, { metadata: { nested: { value: "mutated-evidence" } } });
    }
    assert.deepEqual(world.getGoal(goal.id).successCriteria[0]!.evidenceRequirement, requirement);
    assert.deepEqual(world.inspect().evidence[0]!.source, requirement.source);
    assert.equal(world.supportGoalCriterion(goal.id, "check", "satisfied", [evidence.id]).status, "satisfied");
  });

  it("fails closed for missing and legacy requirements, including legacy text alongside typed policy", () => {
    for (const typed of [false, true]) {
      for (const legacy of [false, true]) {
        if (typed && !legacy) continue;
        const { world, requirement, input } = setup();
        const goal = world.createGoal({ threadId: "legacy", objective: "Tests pass",
          evidenceRequirements: legacy ? ["Tests must pass"] : [],
          successCriteria: [{ id: "check", statement: "Tests pass",
            ...(typed ? { evidenceRequirement: requirement } : {}) }] });
        const evidence = world.recordEvidence({ ...input, goalId: goal.id });
        assert.throws(() => world.supportGoalCriterion(goal.id, "check", "satisfied", [evidence.id]), /Uncompiled/);
        assert.equal(world.getGoal(goal.id).status, "active");
      }
    }
  });

  it("rejects observed claims, summaries, wrong provenance, producers, subjects and stale revisions atomically", () => {
    const { world, goal, input, otherTask, otherWorker } = setup();
    const mismatches: Partial<TaskEvidenceInput>[] = [
      { validity: "observed" }, { kind: "summary" },
      { source: { type: "model", reference: "check-1" } },
      { source: { type: "verifier", reference: "other-check" } },
      { workerId: otherWorker.id, taskId: otherTask.id },
      { subject: "other-workspace" }, { revision: "v1" },
    ];
    const good = world.recordEvidence(input);
    for (const mismatch of mismatches) {
      const bad = world.recordEvidence({ ...input, ...mismatch });
      const before = world.getGoal(goal.id);
      assert.throws(() => world.supportGoalCriterion(goal.id, "check", "satisfied", [good.id, bad.id]), /does not match/);
      assert.deepEqual(world.getGoal(goal.id), before);
    }
    assert.equal(world.supportGoalCriterion(goal.id, "check", "satisfied", [good.id]).status, "satisfied");
  });

  it("requires explicit validity and permits an explicitly observed-only policy", () => {
    const { world, input, requirement } = setup();
    const goal = world.createGoal({ threadId: "observed", objective: "Observe state", successCriteria: [
      { id: "check", statement: "Observation recorded", evidenceRequirement: { ...requirement, validity: "observed" } }] });
    const { validity: _, ...withoutValidity } = input;
    const unknown = world.recordEvidence({ ...withoutValidity, goalId: goal.id });
    assert.throws(() => world.supportGoalCriterion(goal.id, "check", "satisfied", [unknown.id]), /does not match/);
    const observed = world.recordEvidence({ ...input, goalId: goal.id, validity: "observed" });
    assert.equal(world.supportGoalCriterion(goal.id, "check", "satisfied", [observed.id]).status, "satisfied");
  });

  it("allows one provenance-preserving task association and rejects cross-goal linkage and assessment", () => {
    const { world, input, goal, requirement } = setup();
    const other = world.createGoal({ threadId: "other", objective: "Other", successCriteria: [
      { id: "check", statement: "Other check", evidenceRequirement: requirement }] });
    const { goalId: _, ...unassociated } = input;
    const evidence = world.recordEvidence(unassociated);
    assert.throws(() => world.supportGoalCriterion(goal.id, "check", "satisfied", [evidence.id]), /belong to this goal/);
    world.linkEvidenceToGoal(goal.id, evidence.id);
    world.linkEvidenceToGoal(goal.id, evidence.id);
    assert.deepEqual(world.inspect().evidence.find((entry) => entry.id === evidence.id), { ...evidence, goalId: goal.id });
    assert.deepEqual(world.getGoal(goal.id).evidenceIds, [evidence.id]);
    assert.throws(() => world.linkEvidenceToGoal(other.id, evidence.id), /another goal/);
    assert.throws(() => world.supportGoalCriterion(other.id, "check", "satisfied", [evidence.id]), /belong to this goal/);
    const direct = world.recordEvidence({ goalId: other.id, source: input.source, content: "Other" });
    assert.throws(() => world.linkEvidenceToGoal(goal.id, direct.id), /another goal/);
  });

  for (const terminal of ["cancelled", "failed"] as const) {
    it(`prevents ${terminal} resurrection through either transition API`, () => {
      const { world, goal } = setup();
      world.transitionGoal(goal.id, terminal);
      for (const status of ["active", "blocked", "paused", "waiting-user", terminal === "failed" ? "cancelled" : "failed"] as const) {
        assert.throws(() => world.updateGoal(goal.id, { status, outcome: "must not commit" }), /Illegal Goal transition/);
        assert.throws(() => world.transitionGoal(goal.id, status), /Illegal Goal transition/);
      }
      assert.equal(world.getGoal(goal.id).outcome, undefined);
      assert.equal(world.updateGoal(goal.id, { status: terminal, outcome: "Final" }).status, terminal);
    });
  }

  it("revokes stale proof immediately and requires explicit resume before new proof can satisfy", () => {
    const { world, input, goal } = setup();
    const evidence = world.recordEvidence(input);
    world.supportGoalCriterion(goal.id, "check", "satisfied", [evidence.id]);
    for (const status of ["active", "blocked", "failed", "cancelled", "paused", "waiting-user"] as const) {
      assert.throws(() => world.updateGoal(goal.id, { status }), /Illegal Goal transition/);
      assert.throws(() => world.transitionGoal(goal.id, status), /Illegal Goal transition/);
    }
    const unrelated = world.recordEvidence(input);
    world.invalidateEvidence(unrelated.id);
    assert.equal(world.getGoal(goal.id).status, "satisfied");
    world.invalidateEvidence(evidence.id);
    const invalidated = world.getGoal(goal.id);
    assert.equal(invalidated.status, "blocked");
    assert.equal(invalidated.successCriteria[0]?.state, "unknown");
    assert.deepEqual(invalidated.successCriteria[0]?.supportingEvidenceIds, []);
    assert.throws(() => world.supportGoalCriterion(goal.id, "check", "satisfied", [evidence.id]), /Invalidated/);
    assert.throws(() => world.transitionGoal(goal.id, "satisfied"), /Illegal Goal transition/);
    const fresh = world.recordEvidence(input);
    assert.equal(world.supportGoalCriterion(goal.id, "check", "satisfied", [fresh.id]).status, "blocked");
    world.transitionGoal(goal.id, "active");
    assert.equal(world.transitionGoal(goal.id, "satisfied").status, "satisfied");
  });

  it("validates satisfaction and the nonterminal transition graph", () => {
    const { world, goal } = setup();
    assert.throws(() => world.transitionGoal(goal.id, "satisfied"), /requires evidence-backed/);
    for (const status of ["paused", "blocked", "waiting-user", "active"] as const) {
      assert.equal(world.transitionGoal(goal.id, status).status, status);
    }
  });

  it("detaches nested policy and evidence provenance on input and every snapshot path", () => {
    const { world, goal, requirement, input } = setup();
    const evidence = world.recordEvidence(input);
    (requirement.source as { reference: string }).reference = "mutated-input";
    (input.source as { reference: string }).reference = "mutated-input";
    const snapshots = [goal, world.getGoal(goal.id), world.listGoals()[0]!, world.inspect().goals[0]!];
    for (const snapshot of snapshots) {
      (snapshot.successCriteria[0]!.evidenceRequirement!.source as { reference: string }).reference = "mutated-output";
    }
    (evidence.source as { reference: string }).reference = "mutated-output";
    (world.inspect().evidence[0]!.source as { reference: string }).reference = "mutated-inspection";
    assert.equal(world.supportGoalCriterion(goal.id, "check", "satisfied", [evidence.id]).status, "satisfied");
    const revoked = world.invalidateEvidence(evidence.id);
    (revoked.source as { reference: string }).reference = "mutated-revocation";
    assert.equal(world.inspect().evidence[0]?.source.reference, "check-1");
  });
});
