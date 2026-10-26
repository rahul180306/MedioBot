import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { startBenchmarkServer } from "../fixtures/benchmark-app.ts";
import { benchmarkGoals, benchmarkVerifier, fixturePage, type BenchmarkGoal } from "../fixtures/acceptance-verifier.ts";
import { createWorld } from "@mediobot-v2/domain";
import { AutonomousBrowserTask, ModelDecisionProvider, OpenAICompatibleStructuredClient, PlaywrightBrowserPage,
  resolveDevelopmentModelConfig, type BrowserObservation, type VisionProgressEvent } from "../../src/index.ts";

async function main(): Promise<void> {
  const workspaceEnv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../.env");
  try { process.loadEnvFile(workspaceEnv); } catch { /* environment may be configured externally */ }
  const arg = process.argv.indexOf("--goal");
  const goalNumber = arg >= 0 ? process.argv[arg + 1] : undefined;
  const goal = goalNumber && Object.hasOwn(benchmarkGoals, goalNumber) ? benchmarkGoals[goalNumber as BenchmarkGoal] : undefined;
  if (!goal) throw new Error("Choose one manual goal: --goal 1, --goal 2, or --goal 3");
  const modelConfig = resolveDevelopmentModelConfig();
  const { modelId, apiKey, baseUrl, timeoutMs } = modelConfig.text;
  if (!apiKey) throw new Error("Set DAHL_API_KEY in the local environment before running the manual Vision goal.");

  const server = await startBenchmarkServer();
  const world = createWorld();
  const definition = world.registerMediobotDefinition({ name: "Vision manual acceptance", role: "browser", version: "1",
    instructions: "Use observed browser state to pursue the assigned goal.", declaredCapabilities: [{ kind: "resource", name: "browser-page" }] });
  const worker = world.spawnWorker(definition.id);
  const task = world.assignTask(world.createTask(goal).id, worker.id);
  const resource = world.registerResource({ kind: "browser-page", owner: { type: "worker", worldId: world.id, workerId: worker.id } });
  world.setWorkerState(worker.id, "busy"); world.setTaskState(task.id, "running"); world.setResourceState(resource.id, "in-use");
  const controller = new AbortController();
  const onInterrupt = () => { console.log("Cancellation requested; waiting for Vision cleanup…"); controller.abort(); };
  process.once("SIGINT", onInterrupt);
  let browser: PlaywrightBrowserPage | undefined;
  let runner: AutonomousBrowserTask | undefined;
  let lastObservation: BrowserObservation | undefined;
  const progress: VisionProgressEvent[] = [];
  try {
    browser = await PlaywrightBrowserPage.launch({ resourceId: resource.id, headless: false });
    await browser.navigate(server.url);
    const goalVerifier = await benchmarkVerifier(fixturePage(browser), server.url, goalNumber as BenchmarkGoal);
    const decisions = new ModelDecisionProvider(new OpenAICompatibleStructuredClient({ apiKey, modelId,
      baseUrl, timeoutMs }), (metrics) => console.log(JSON.stringify({ type: "model-context", ...metrics })));
    runner = new AutonomousBrowserTask({ world, workerId: worker.id, taskId: task.id, resourceId: resource.id,
      observations: { observe: async (signal) => { lastObservation = await browser!.observe(signal); return lastObservation; } },
      executor: browser, decisions, goalVerifier, signal: controller.signal, maxSteps: 18, maxHistory: 6,
      providerTimeoutMs: timeoutMs, onProgress: (event) => { progress.push(event); console.log(JSON.stringify(event)); } });
    console.log(`Vision manual run started: goal ${goalNumber}; model ${modelId}; local browser is visible.`);
    console.log(`Goal: ${goal}`);
    const runStarted = performance.now();
    const result = await runner.run(goal);
    const totalMs = performance.now() - runStarted;
    console.log(JSON.stringify({ type: "run-result", state: result.state, steps: result.history.length,
      noEffectSteps: result.history.filter((entry) => entry.progress === "no-effect").length,
      totalMs: Math.round(totalMs) }));
    if (result.state === "failed") console.error(`Failure: ${result.error}`);
    if (result.state !== "completed") {
      const evidence = path.join(os.tmpdir(), `mediobot-vision-${Date.now()}.json`);
      const screenshot = path.join(os.tmpdir(), `mediobot-vision-${Date.now()}.png`);
      try { await browser.saveScreenshot(screenshot); } catch { /* retain diagnostic JSON if screenshot capture fails */ }
      await writeFile(evidence, JSON.stringify({ goalNumber, goal, state: result.state,
        step: result.history.length + 1, lastObservation, progress,
        error: result.state === "failed" ? result.error : undefined,
        diagnostic: result.state === "failed" ? result.diagnostic : undefined, history: result.history, timings: result.timings,
        screenshot }, null, 2));
      console.error(`Local diagnostic evidence: ${evidence}`);
      if (result.state !== "failed") console.error(`Screenshot if captured: ${screenshot}`);
    }
    if (result.state === "failed") process.exitCode = 1;
    else if (result.state === "completed") {
      console.log("Human acceptance required: inspect the visible browser state. Press Enter to close it; Ctrl+C cancels/closes.");
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      await new Promise<void>((resolve) => {
        const onSigint = () => { controller.abort(); resolve(); };
        process.once("SIGINT", onSigint);
        terminal.once("line", resolve);
        terminal.once("close", resolve);
        terminal.once("close", () => process.removeListener("SIGINT", onSigint));
      });
      terminal.close();
    }
  } finally {
    await runner?.close();
    if (!runner) await browser?.close();
    process.removeListener("SIGINT", onInterrupt);
    await server.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Manual runner failed";
  console.error(message);
  process.exitCode = 1;
});
