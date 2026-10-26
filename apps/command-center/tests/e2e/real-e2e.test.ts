import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium, type Browser } from "playwright";
import { startCommandCenter } from "../../src/server.ts";
import { LocalHistoryStore } from "../../src/history.ts";
import { LocalProjectCatalog } from "../../src/projects.ts";
import { worldProductEvent } from "../../src/events.ts";
import { createWorld, type TaskId } from "@mediobot-v2/domain";
import { RuntimeTaskSubmission, WorkerRuntime } from "@mediobot-v2/runtime";
import { ToolRuntime } from "@mediobot-v2/tools";
import { createMaestroCodyExecution, MaestroDecisionProvider } from "@mediobot-v2/maestro";
import { CodyDecisionProvider, type CodyAction } from "@mediobot-v2/cody";
import type { CommandCenterComposition, DefinitionView, ProductEvent, TaskView } from "../../src/contracts.ts";

let browser: Browser;

before(async () => {
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
});

const fixedMath = "export const square = (x: number) => x * x;\n";
const verificationClaim = "Square regression checks pass for positive, negative, and zero inputs";

function createDeterministicRuntimeComposition(workspaceRoot: string, catalog: LocalProjectCatalog): CommandCenterComposition {
  const world = createWorld();
  const runtime = new WorkerRuntime(world);
  const submission = new RuntimeTaskSubmission(world, runtime);
  const tools = new ToolRuntime(world);
  const taskEvents = new Map<TaskId, ProductEvent[]>();
  const subscribers = new Map<TaskId, Set<(event: ProductEvent) => void>>();
  const taskErrors = new Map<TaskId, TaskView["error"]>();

  const publish = (event: ProductEvent) => {
    const list = taskEvents.get(event.taskId) ?? [];
    list.push(event);
    taskEvents.set(event.taskId, list);
    for (const sub of subscribers.get(event.taskId) ?? []) sub(event);
  };

  let codyDefinitionId = "";
  // Only model decisions are scripted: the generic Cody adapter executes real tools.
  const actions: CodyAction[] = [
    { type: "read", path: "src/nested/math.ts" },
    { type: "write", path: "src/nested/math.ts", content: fixedMath },
    { type: "run", command: process.execPath, args: ["--experimental-strip-types", "--test", "math.test.mjs"], cwd: ".", verification: verificationClaim },
    { type: "finish", summary: "Cody completed edits and verification passed." },
  ];
  let actionIndex = 0;
  const execution = createMaestroCodyExecution({
    world,
    runtime,
    tools,
    maestroDefinition: { id: "maestro", name: "Maestro", role: "orchestration", version: "test", instructions: "Test coordinator." },
    maestroDecisions: new MaestroDecisionProvider({
      complete: async ({ input }) => {
        let userGoal = "";
        try { userGoal = (JSON.parse(input) as { userGoal?: string }).userGoal ?? ""; } catch {}
        if (userGoal.includes("Fix math test")) {
          return JSON.stringify({ type: "delegate", definitionId: codyDefinitionId, objective: "Fix math test and verify.",
            relevantContextRefs: [], constraints: [], expectedOutcome: "The math test passes.", evidenceExpectations: ["Test result"] });
        }
        return JSON.stringify({ type: "respond", message: "Maestro received your task: I will coordinate the project work.", basis: "conversation", evidenceRefs: [] });
      },
    }),
    codyDecisions: new CodyDecisionProvider({
      complete: async () => {
        const action = actions[actionIndex++];
        assert.ok(action, "Cody requested an unexpected extra model decision");
        return JSON.stringify(action);
      },
    }),
    onUserMessage: (message, identity) => {
      publish({
        id: crypto.randomUUID(),
        type: "maestro.responded",
        worldId: world.id,
        taskId: identity.taskId,
        workerId: identity.workerId,
        workerName: "Maestro",
        occurredAt: Date.now(),
        message,
      });
    },
    onCodyDiagnostic: () => {},
  });

  codyDefinitionId = execution.codyDefinitionId;
  submission.registerAdapter(execution.maestroDefinitionId, execution.adapter);

  const definitions: DefinitionView[] = [
    { id: execution.maestroDefinitionId, name: "Maestro", group: "orchestrator", role: "Team orchestration", summary: "Assign work", availability: "available", executable: true },
    { id: execution.codyDefinitionId, name: "Cody", group: "specialist", role: "Software engineering", summary: "Coding worker", availability: "development", executable: false },
  ];

  const snapshotTask = (taskId: TaskId): TaskView | undefined => {
    const snap = world.inspect();
    const task = snap.tasks.find((t) => t.id === taskId);
    if (!task) return undefined;
    const worker = snap.workers.find((w) => w.id === task.assignedWorkerId);
    return {
      id: task.id,
      worldId: task.worldId,
      goal: task.goal,
      state: task.state,
      workers: worker ? [{ id: worker.id, taskId: task.id, definitionId: worker.definitionId, name: worker.definitionId === execution.codyDefinitionId ? "Cody" : "Maestro", state: worker.state }] : [],
      events: taskEvents.get(taskId) ?? [],
    };
  };

  return {
    world,
    submission,
    definitions,
    visionDefinitionId: execution.maestroDefinitionId,
    taskEvents,
    subscribers,
    taskErrors,
    publish,
    submit(definitionId, goal, options = {}, onBeforeEmit) {
      const created = submission.submit({
        definitionId,
        goal,
        options: { workspaceRoot, ...options },
        onCreated: ({ task }) => {
          onBeforeEmit?.(task.id);
          publish({ id: "created", type: "task.started", worldId: task.worldId, taskId: task.id, occurredAt: Date.now() });
        },
        onEvent: (event) => {
          const snapshot = world.inspect();
          const mapped = worldProductEvent(event, snapshot.definitions, snapshot.workers, snapshot.tasks);
          if (mapped) publish(mapped);
        },
      });
      return { taskId: created.task.id, result: created.result };
    },
    cancel(taskId) {
      submission.cancel(taskId);
    },
    snapshotTask,
    mapWorldEvent() {},
    mapVisionProgress() {},
    decideMaestroTurn(goal, options, signal) {
      return execution.adapter.decideTurn(world, execution.maestroDefinitionId, goal, { workspaceRoot, ...options }, signal);
    },
    maestroDefinitionId: execution.maestroDefinitionId,
    codyDefinitionId: execution.codyDefinitionId,
    projects: catalog,
  };
}

test("Phase 21 deterministic-model browser E2E: complete 32-step scenario with real Explorer, Editor, Maestro, Cody tools, and History persistence", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mediobot-e2e-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));

  const projectDir = path.join(tempDir, "disposable-project");
  await mkdir(path.join(projectDir, "src", "nested"), { recursive: true });
  await writeFile(path.join(projectDir, "README.md"), "# Disposable Project\n");
  await writeFile(path.join(projectDir, "src", "index.ts"), "export const hello = 'world';\n");
  await writeFile(path.join(projectDir, "src", "nested", "math.ts"), "export const square = (x: number) => x + x;\n");
  await writeFile(path.join(projectDir, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(path.join(projectDir, "math.test.mjs"), [
    "import assert from 'node:assert/strict';",
    "import { square } from './src/nested/math.ts';",
    "assert.equal(square(3), 9);",
    "assert.equal(square(-4), 16);",
    "assert.equal(square(0), 0);",
  ].join("\n"));

  const catalog = new LocalProjectCatalog();
  const addedProject = await catalog.add(projectDir);
  const historyStore = new LocalHistoryStore(tempDir);

  const composition = createDeterministicRuntimeComposition(projectDir, catalog);
  const dbPath = path.join(tempDir, "e2e.sqlite");
  let app = await startCommandCenter({
    workspaceRoot: projectDir,
    databasePath: dbPath,
    composition,
    historyStore,
    listen: true,
    port: 0,
    vite: true,
  });

  t.after(async () => {
    await app.close();
  });

  const baseUrl = app.url!;
  const projectsResponse = await fetch(`${baseUrl}/api/projects`);
  assert.equal(projectsResponse.status, 200);
  const { projects } = await projectsResponse.json() as { projects: Array<{ id: string; path: string }> };
  assert.equal(projects.length, 1);
  assert.equal(projects[0]?.path, addedProject.path);
  const selectedProjectId = projects[0]!.id;
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  t.after(async () => {
    await page.close();
  });

  // Step 1: Launch MedioBot
  await page.goto(baseUrl);
  await page.getByRole("heading", { name: /What Should we Build with\s+Mediobot/i }).waitFor();

  // Open Explorer drawer via NavRail
  await page.locator('button[title="Home / New Chat"]').click();

  // Step 2 & 3: Selected project is source of truth & confirm real files appear
  await page.getByText("README.md").waitFor();
  await page.getByText("src").waitFor();

  // Step 4: Expand nested folders
  await page.getByText("src").click();
  await page.getByText("nested").waitFor();
  await page.getByText("nested").click();
  await page.getByText("math.ts").waitFor();

  // Step 5: Collapse All (recursively collapses deeply nested folders)
  await page.locator('button[title="Collapse All"]').click();
  assert.equal(await page.getByText("math.ts").isVisible(), false);

  // Step 6: Create folder
  // Expand src again to create folder inside it
  await page.getByText("src").click();
  await page.locator('button[title="New Folder"]').click();
  const folderInput = page.locator('input[placeholder="Folder name..."]');
  await folderInput.waitFor();
  await folderInput.fill("components");
  await folderInput.press("Enter");
  await page.getByText("components").waitFor();

  // Step 7: Create file inside it
  await page.getByText("components").click();
  await page.locator('button[title="New File"]').click();
  const fileInput = page.locator('input[placeholder="File name..."]');
  await fileInput.waitFor();
  await fileInput.fill("Card.tsx");
  await fileInput.press("Enter");
  const explorer = page.locator("aside").filter({ has: page.getByRole("button", { name: "New File" }) });
  await explorer.getByText("Card.tsx", { exact: true }).waitFor();

  // Confirm file exists on disk
  assert.equal(await readFile(path.join(projectDir, "src", "components", "Card.tsx"), "utf8"), "");

  // Step 8: Open file
  await explorer.getByText("Card.tsx", { exact: true }).click();
  await page.getByText("src/components/Card.tsx").waitFor();

  // Step 9: Edit file
  const editorContent = page.locator('.cm-content');
  await editorContent.waitFor();
  await editorContent.fill("export const Card = () => <div>Card Content</div>;\n");

  // Dirty indicator
  await page.locator('[aria-label="Unsaved changes"]').waitFor();

  // Step 10: Save
  await page.locator('button[title*="Save file"]').click();
  await page.getByText("Saved").first().waitFor();

  // Confirm file on disk updated
  assert.equal(
    await readFile(path.join(projectDir, "src", "components", "Card.tsx"), "utf8"),
    "export const Card = () => <div>Card Content</div>;\n"
  );

  // Step 11: Rename file
  page.on("dialog", async (dialog) => {
    if (dialog.type() === "prompt") await dialog.accept("Badge.tsx");
    else if (dialog.type() === "confirm") await dialog.accept();
  });

  const renameFileBtn = page.getByTitle("Rename Card.tsx");
  await renameFileBtn.click({ force: true });
  const inlineRename = page.locator('aside input');
  if (await inlineRename.isVisible({ timeout: 1000 }).catch(() => false)) {
    await inlineRename.fill("Badge.tsx");
    await inlineRename.press("Enter");
  }
  await page.locator('aside').getByText("Badge.tsx", { exact: true }).waitFor();

  // Confirm disk file renamed
  assert.equal(
    await readFile(path.join(projectDir, "src", "components", "Badge.tsx"), "utf8"),
    "export const Card = () => <div>Card Content</div>;\n"
  );

  // Step 12: Refresh
  await page.locator('button[title="Refresh Explorer"]').click();
  await page.locator('aside').getByText("Badge.tsx", { exact: true }).waitFor();

  // Close editor tab to return to Home composer
  await page.locator('button[title="Close file tab"]').click();
  await page.getByPlaceholder("Do anything").waitFor();

  // Step 14, 15, 16: Exercise a direct conversational reply without asking Maestro to assert uninspected project facts.
  await page.getByPlaceholder("Do anything").fill("What is the purpose of a regression test?");
  await page.getByPlaceholder("Do anything").press("Enter");
  await page.getByText("What is the purpose of a regression test?").first().waitFor();
  await page.getByText("Maestro received your task: I will coordinate the project work.").waitFor();

  // Step 17, 18, 19, 20, 21: Send coding task requiring Cody -> real delegation -> progress & verification -> result
  await page.getByPlaceholder("Do anything").fill("Fix math test with Cody");
  await page.getByPlaceholder("Do anything").press("Enter");
  await page.getByText("Fix math test with Cody").waitFor();
  await page.getByText("Cody completed edits and verification passed.").waitFor({ timeout: 10000 });
  assert.equal(await readFile(path.join(projectDir, "src", "nested", "math.ts"), "utf8"), fixedMath);
  const snapshot = composition.world.inspect();
  const codyWorker = snapshot.workers.find((worker) => worker.definitionId === composition.codyDefinitionId);
  assert.ok(codyWorker);
  const codyTask = snapshot.tasks.find((task) => task.assignedWorkerId === codyWorker.id);
  assert.ok(codyTask);
  assert.equal(codyTask.state, "completed");
  const evidence = snapshot.evidence.filter((entry) => entry.taskId === codyTask.id && entry.workerId === codyWorker.id);
  const proofs = evidence.filter((entry) => entry.source.type === "coding-verification");
  assert.equal(proofs.length, 1);
  const proof = proofs[0]!;
  assert.equal(proof.kind, "command-execution");
  assert.equal(proof.validity, "observed");
  assert.equal(proof.claim, undefined);
  assert.ok(proof.source.reference);
  const command = evidence.find((entry) => entry.source.type === "coding-tool" && entry.source.reference === proof.source.reference);
  assert.ok(command);
  assert.equal(command.kind, "tool-result");
  assert.match(command.content, /^terminal\.execute completed; exitCode=0;/);
  assert.ok(evidence.some((entry) => entry.source.type === "workspace-diff" && entry.source.reference === "src/nested/math.ts"));
  assert.equal(evidence.find((entry) => entry.source.type === "cody-summary")?.validity, "observed");

  // Step 22: Open History
  await page.locator('button[title="Threads & History"]').click();
  // History shows the created thread
  const threadItem = page.getByText(/What is the purpose of a regression test/i).first();
  await threadItem.waitFor();

  // Step 23, 24, 25: Open it -> confirm exact conversation restores
  await threadItem.click();
  await page.getByText("What is the purpose of a regression test?").last().waitFor();
  await page.getByText("Cody completed edits and verification passed.").waitFor();

  // Step 26: Hard refresh
  await page.reload();
  await page.locator('button[title="Threads & History"]').click();
  await page.getByText(/What is the purpose of a regression test/i).first().waitFor();
  await page.getByText(/What is the purpose of a regression test/i).first().click();
  await page.getByText("Cody completed edits and verification passed.").waitFor();

  // Step 28, 29: Restart app / server
  await app.close();
  const reloadedHistoryStore = new LocalHistoryStore(tempDir);
  const reloadedApp = await startCommandCenter({
    workspaceRoot: projectDir,
    databasePath: dbPath,
    composition: createDeterministicRuntimeComposition(projectDir, catalog),
    historyStore: reloadedHistoryStore,
    listen: true,
    port: 0,
    vite: true,
  });
  t.after(async () => {
    await reloadedApp.close();
  });

  const reloadedUrl = reloadedApp.url!;
  await page.goto(reloadedUrl);
  await page.locator('button[title="Threads & History"]').click();
  await page.getByText(/What is the purpose of a regression test/i).first().waitFor();
  await page.getByText(/What is the purpose of a regression test/i).first().click();
  await page.getByText("Cody completed edits and verification passed.").waitFor();

  // Step 30, 31: Continue the old conversation on the SAME thread
  const turnPromise = page.waitForResponse((res) => res.url().includes("/api/turns") && res.request().method() === "POST");
  await page.getByPlaceholder("Do anything").fill("What is the purpose of a regression test?");
  await page.getByPlaceholder("Do anything").press("Enter");
  await page.getByText("What is the purpose of a regression test?").last().waitFor();
  const turnResponse = await turnPromise;
  assert.ok([200, 202].includes(turnResponse.status()), "A completed direct turn may use either supported compatibility status.");
  assert.equal((await turnResponse.json()).direct, true);

  // Verify history list still has only 1 thread (no duplicate thread created)
  const threadsAfterContinuation = await reloadedHistoryStore.list();
  assert.equal(threadsAfterContinuation.length, 1);
  assert.equal(threadsAfterContinuation[0]?.turns.length, 3);

  // Step 32: Project association remains correct
  assert.equal(threadsAfterContinuation[0]?.projectId, selectedProjectId);

  // Failure scenario: Inaccessible historical project
  // Delete the project folder externally
  await rm(projectDir, { recursive: true, force: true });
  await page.reload();
  await page.locator('button[title="Threads & History"]').click();
  await page.getByText(/What is the purpose of a regression test/i).first().click();
  // Does not crash! Shows conversation and graceful fallback
  await page.getByText("What is the purpose of a regression test?").last().waitFor();
});
