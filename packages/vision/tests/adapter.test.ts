import assert from "node:assert/strict";
import test from "node:test";
import { createWorld } from "@mediobot-v2/domain";
import { RuntimeTaskSubmission, WorkerRuntime } from "@mediobot-v2/runtime";
import { VisionExecutionAdapter } from "../src/adapter.ts";
import type { BrowserObservation } from "../src/index.ts";

test("Vision adapter starts from its owned blank page and closes it through runtime execution", async () => {
  const world = createWorld();
  const definition = world.registerMediobotDefinition({ name: "Vision", role: "browser", version: "1", instructions: "", declaredCapabilities: [] });
  let currentUrl = "about:blank";
  let observedInitialUrl: string | undefined;
  let closed = false;
  const observation: BrowserObservation = { revision: 1, fingerprint: "blank", url: currentUrl, title: "", text: "", elements: [] };
  const adapter = new VisionExecutionAdapter({ decisions: { decide: async (_goal, current) => ({ type: "finish", observationRevision: current.revision }) },
    goalVerifier: { verify: async () => "verified" },
    browserFactory: async () => ({
      observe: async () => { observedInitialUrl = currentUrl; return observation; },
      execute: async () => { throw new Error("finish must not execute a browser action"); },
      close: async () => { closed = true; },
    }) });
  const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
  submission.registerAdapter(definition.id, adapter);
  const submitted = submission.submit({ definitionId: definition.id, goal: "Inspect the blank page" });
  assert.deepEqual(await submitted.result, { state: "completed" });
  assert.equal(observedInitialUrl, "about:blank");
  assert.equal(closed, true);
  assert.equal(world.inspect().resources[0]?.state, "released");
});

test("the conservative default verifier prevents a finish request from completing an unverified task", async () => {
  const world = createWorld();
  const definition = world.registerMediobotDefinition({ name: "Vision", role: "browser", version: "1", instructions: "", declaredCapabilities: [] });
  let closed = false;
  const adapter = new VisionExecutionAdapter({ decisions: { decide: async (_goal, current) => ({ type: "finish", observationRevision: current.revision }) },
    browserFactory: async () => ({
      observe: async () => ({ revision: 1, fingerprint: "blank", url: "about:blank", title: "", text: "", elements: [] }),
      execute: async () => ({ state: "accepted" }),
      close: async () => { closed = true; },
    }) });
  const submission = new RuntimeTaskSubmission(world, new WorkerRuntime(world));
  submission.registerAdapter(definition.id, adapter);
  const submitted = submission.submit({ definitionId: definition.id, goal: "Inspect the blank page" });
  assert.deepEqual(await submitted.result, { state: "failed", error: "Vision could not complete the task." });
  assert.equal(closed, true);
  assert.equal(world.inspect().tasks[0]?.state, "failed");
  assert.equal(world.inspect().events.some((event) => event.type === "vision.goal-verified"), false);
});
