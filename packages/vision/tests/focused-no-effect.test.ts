import assert from "node:assert/strict";
import test from "node:test";
import { PlaywrightBrowserRuntime } from "../src/browser-runtime.ts";
import { AutonomousBrowserTask } from "../src/index.ts";
import { createWorld } from "@mediobot-v2/domain";

test("CONTROLLED STEP 5: Focused no-effect recovery scenario", {
  skip: process.env.MEDIOBOT_ALLOW_HEADED_TESTS !== "1" ? "set MEDIOBOT_ALLOW_HEADED_TESTS=1 to run graphical browser tests" : false,
}, async () => {
  const runtime = new PlaywrightBrowserRuntime({
    headless: false,
  });

  try {
    for (const required of [true, false]) {
      const world = createWorld();
      const definition = world.registerMediobotDefinition({
        name: "Hybrid test",
        role: "browser",
        version: "1",
        instructions: "Use observations",
        declaredCapabilities: [{ kind: "resource", name: "browser-page" }],
      });
      const worker = world.spawnWorker(definition.id);
      const task = world.assignTask(world.createTask("Choose blue").id, worker.id);
      const resource = world.registerResource({
        kind: "browser-page",
        owner: { type: "worker", worldId: world.id, workerId: worker.id },
      });
      world.setWorkerState(worker.id, "busy");
      world.setTaskState(task.id, "running");
      world.setResourceState(resource.id, "in-use");

      const session = await runtime.acquireSession({
        resourceId: resource.id,
        workerId: worker.id,
        taskId: task.id,
      });
      await session.page.setContent('<button aria-label="Only">Only</button>');

      let calls = 0;
      const runner = new AutonomousBrowserTask({
        world,
        workerId: worker.id,
        taskId: task.id,
        resourceId: session.resourceId,
        observations: session,
        executor: session,
        maxSteps: 5,
        visual: {
          policy: { required, onNoEffect: true, maxCalls: 1 },
          captures: session,
          provider: { async perceive() { calls++; return []; } },
        },
        decisions: {
          async decide(_g, o) {
            return { type: "click", targetId: "e1", observationRevision: o.revision };
          },
        },
      });

      const result = await runner.run("Try");
      console.log(`NO-EFFECT RUN (required=${required}):`, {
        state: result.state,
        calls,
        error: "error" in result ? (result as any).error : undefined,
        diagnostic: "diagnostic" in result ? result.diagnostic : undefined,
      });

      await session.close();

      assert.equal(result.state, "failed");
      assert.equal(calls, 1);
      if (result.state === "failed") {
        assert.match(
          (result as any).error,
          required ? /budget exhausted/ : /no observable progress/
        );
      }
    }
  } finally {
    await runtime.shutdown();
  }
});
