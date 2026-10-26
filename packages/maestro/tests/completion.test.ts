import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { createWorld } from "@mediobot-v2/domain";
import { CodyDecisionProvider } from "@mediobot-v2/cody";
import { RuntimeTaskSubmission, WorkerRuntime } from "@mediobot-v2/runtime";
import { ToolRuntime } from "@mediobot-v2/tools";
import { createMaestroCodyExecution, MaestroDecisionProvider } from "../src/index.ts";
import type { TrustedCompletion } from "../src/index.ts";

for (const mode of ["verified", "unknown", "uncovered", "summary", "cancel", "cancel-before", "cancel-after", "timeout", "mismatch"] as const) {
  it(`trusted completion runtime: ${mode}`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "maestro-policy-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "artifact.txt"), "old");
    const world = createWorld();
    const runtime = new WorkerRuntime(world);
    const submission = new RuntimeTaskSubmission(world, runtime);
    let definitionId = "";
    let action = 0;
    let assessed = 0;
    let delivered = "";
    let entered!: () => void;
    const assessing = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let assessorSignal: AbortSignal | undefined;
    const requirement = { kind: "artifact-check", source: { type: "trusted-verifier", reference: "artifact-v1" }, validity: "verified" as const };
    const completion: TrustedCompletion = {
      timeoutMs: mode === "timeout" ? 5 : 1000,
      createPolicy: (request) => {
        assert.equal(world.inspect().tasks.length, 1, "policy precedes child");
        return { coveredExpectations: mode === "uncovered" ? [] : request.evidenceExpectations,
          criteria: [{ id: "artifact", statement: "artifact contains exact expected text", evidenceRequirement: requirement }] };
      },
      assess: async (context, signal) => {
        assessed++;
        assessorSignal = signal;
        assert.equal(context.result.state, "completed");
        assert.ok(world.inspect().resources.every((r) => r.state !== "available"), "cleanup precedes verifier");
        entered();
        if (mode === "cancel" || mode === "timeout") await pending; // Deliberately ignores abort.
        if (mode === "unknown") return undefined;
        const content = await readFile(path.join(context.workspaceRoot, "artifact.txt"), "utf8");
        return [{ criterionId: "artifact", state: content === "expected" ? "satisfied" : "unsatisfied",
          evidence: { ...requirement, source: mode === "mismatch" ? { type: "cody-summary", reference: "claim" } : requirement.source, content } }];
      },
    };
    const execution = createMaestroCodyExecution({ world, runtime, tools: new ToolRuntime(world), completion,
      maestroDefinition: { id: "maestro", name: "Maestro", role: "orchestration", version: "1", instructions: "Delegate" },
      maestroDecisions: new MaestroDecisionProvider({ complete: async () => JSON.stringify({ type: "delegate", definitionId,
        objective: "Write artifact", expectedOutcome: "Expected artifact", evidenceExpectations: ["current file checked"], constraints: [], relevantContextRefs: [] }) }),
      codyDecisions: new CodyDecisionProvider({ complete: async () => JSON.stringify(mode === "summary"
        ? { type: "finish", summary: "Everything is verified" } : [
          { type: "read", path: "artifact.txt" },
          { type: "write", path: "artifact.txt", content: "expected" },
          { type: "run", command: process.execPath, args: ["-e", "process.exit(0)"], verification: "Worker claim" },
          { type: "finish", summary: "Everything is verified" },
        ][action++]) }),
      onUserMessage: (message, identity) => {
        delivered = message;
        if (mode === "cancel-after") submission.cancel(identity.taskId);
      },
    });
    definitionId = execution.codyDefinitionId;
    submission.registerAdapter(execution.maestroDefinitionId, execution.adapter);
    const submitted = submission.submit({ definitionId: execution.maestroDefinitionId, goal: "Write the expected artifact",
      options: { workspaceRoot: root }, onEvent: (event) => {
        if (mode === "cancel-before" && event.type === "maestro.evidence-received") {
          submission.cancel(world.inspect().tasks.find((task) => !task.parentTaskId)!.id);
        }
      } });
    if (mode === "cancel") { await assessing; submission.cancel(submitted.task.id); }
    const result = await submitted.result;
    const goal = world.inspect().goals[0]!;
    if (mode === "verified") {
      assert.deepEqual(result, { state: "completed" });
      assert.equal(goal.status, "satisfied");
      const proof = world.inspect().evidence.find((e) => e.id === goal.successCriteria[0]!.supportingEvidenceIds[0])!;
      assert.equal(proof.taskId, undefined);
      assert.equal(proof.goalId, goal.id);
      await writeFile(path.join(root, "artifact.txt"), "stale external change");
      world.invalidateEvidence(proof.id);
      assert.equal(world.inspect().goals[0]!.status, "blocked");
      assert.equal(world.inspect().goals[0]!.id, goal.id);
    } else {
      assert.notEqual(goal.status, "satisfied");
      assert.equal(goal.successCriteria[0]!.state, "unknown");
      if (mode.startsWith("cancel")) { assert.equal(result.state, "cancelled"); assert.equal(goal.status, "cancelled"); }
      if (mode === "timeout" || mode === "cancel") {
        assert.equal(assessorSignal?.aborted, true);
        release();
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(world.inspect().goals[0]!.successCriteria[0]!.state, "unknown");
      }
      if (mode === "uncovered" || mode === "summary" || mode === "cancel-before") assert.equal(assessed, 0);
      if (mode === "uncovered") assert.deepEqual(goal.evidenceRequirements, ["current file checked"]);
      if (!mode.startsWith("cancel") && mode !== "summary") assert.match(delivered, /remains unproved/);
    }
  });
}
