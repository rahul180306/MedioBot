import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { getMediobotPresentation } from "../../src/features/mediobots/presentation.ts";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let vite: ViteDevServer;
let browser: Browser;
let baseUrl: string;

before(async () => {
  vite = await createServer({ configFile: path.join(appRoot, "vite.config.ts"), root: appRoot,
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false }, appType: "spa" });
  await vite.listen();
  baseUrl = vite.resolvedUrls?.local?.[0] ?? "http://127.0.0.1:5173/";
  browser = await chromium.launch();
});

after(async () => { await browser?.close(); await vite?.close(); });

async function openWorkspace(page: Page, options: { configured?: boolean; definitions?: unknown[]; threads?: unknown[]; tasks?: unknown[]; events?: unknown[]; resourcePlatform?: string;
  groupHistory?: Record<string, unknown[] | (() => unknown[])>; providerConnectRequests?: Array<Record<string, unknown>> } = {}) {
  let turn: { turnId: string; threadId: string; taskId: string } | undefined;
  let attachmentNumber = 0;
  const removedAttachments: string[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/projects" && route.request().method() === "GET") {
      return route.fulfill({ json: { projects: [{ id: "project-local", name: "Fixture", path: "/tmp/fixture", branch: "", branches: [], environment: "Local" }] } });
    }
    if (url.pathname === "/api/workspace" && route.request().method() === "GET") {
      return route.fulfill({
        json: {
          status: "OPEN",
          session: {
            workspaceId: "project-local",
            canonicalRootPath: "/tmp/fixture",
            displayName: "Fixture",
            openedAt: Date.now(),
          },
          uiState: null,
        },
      });
    }
    if (url.pathname === "/api/threads" && route.request().method() === "GET") {
      return route.fulfill({ json: { threads: options.threads ?? [] } });
    }
    if (url.pathname === "/api/definitions") {
      const available = options.configured !== false;
      return route.fulfill({ json: { definitions: options.definitions ?? [
        { id: "maestro", name: "Maestro", group: "orchestrator", role: "Team orchestration", summary: "Assign coding work", availability: available ? "available" : "not-configured", executable: available },
        { id: "cody", name: "Cody", group: "specialist", role: "Software engineering", summary: "Coding worker", availability: "development", executable: false, directConversationAvailable: true },
        { id: "vision", name: "Vision", group: "specialist", role: "Browser", summary: "Browser worker", availability: available ? "available" : "not-configured", executable: available },
        { id: "doc", name: "Doc", group: "specialist", role: "Documentation", summary: "Document work", availability: "unavailable", executable: false },
        { id: "research", name: "Research", group: "specialist", role: "Research", summary: "Web research", availability: "unavailable", executable: false },
        { id: "tester", name: "Tester", group: "specialist", role: "Testing", summary: "Independent testing", availability: "unavailable", executable: false },
      ] } });
    }
    if (url.pathname === "/api/tasks" && route.request().method() === "GET") return route.fulfill({ json: { tasks: options.tasks ?? [] } });
    const groupHistoryMatch = url.pathname.match(/^\/api\/specialists\/([^/]+)\/group-history$/);
    if (groupHistoryMatch && route.request().method() === "GET") {
      const groups = options.groupHistory?.[decodeURIComponent(groupHistoryMatch[1]!)];
      return route.fulfill({ json: { groups: typeof groups === "function" ? groups() : groups ?? [] } });
    }
    if (url.pathname === "/api/attachments" && route.request().method() === "POST") {
      const input = route.request().postDataJSON() as { name: string; type: string; base64: string };
      attachmentNumber++;
      return route.fulfill({ status: 201, json: { attachment: { id: `00000000-0000-4000-8000-${String(attachmentNumber).padStart(12, "0")}`, name: input.name, mimeType: input.type, size: Math.floor(input.base64.length * 3 / 4) } } });
    }
    if (url.pathname.startsWith("/api/attachments/") && route.request().method() === "DELETE") {
      removedAttachments.push(url.pathname.split("/").pop() || "");
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === "/api/turns" && route.request().method() === "POST") {
      if (options.configured === false) return route.fulfill({ status: 409, json: { error: { message: "Mediobot can't start because a text reasoning model is not configured." } } });
      const input = route.request().postDataJSON() as { turnId: string; threadId: string };
      turn = { ...input, taskId: "task-fixture" };
      return route.fulfill({ status: 202, json: { turnId: input.turnId, taskId: "task-fixture" } });
    }
    if (url.pathname === "/api/turns/turn-fixture/events" || url.pathname.endsWith("/events")) {
      const common = { turnId: turn?.turnId ?? "turn-fixture", threadId: turn?.threadId ?? "thread-fixture", timestamp: Date.now() };
      const events = (options.events ?? [
        { ...common, type: "agent.started", payload: { message: "Maestro started", item: { id: "started", turnId: common.turnId, type: "activity", timestamp: Date.now(), text: "Maestro started" } } },
        { ...common, type: "worker.assigned", workerName: "Cody", workerDefinitionId: "cody", taskId: "task-fixture", payload: { message: "Assigned: Fix the failing math test", item: { id: "assigned-cody", turnId: common.turnId, type: "activity", timestamp: Date.now(), text: "Assigned: Fix the failing math test" } } },
        { ...common, type: "worker.started", workerName: "Cody", workerDefinitionId: "cody", taskId: "task-fixture", payload: { message: "Cody started", item: { id: "cody-started", turnId: common.turnId, type: "activity", activityLabel: "Cody started", timestamp: Date.now(), text: "Cody started" } } },
        { ...common, type: "worker.progress", workerName: "Cody", workerDefinitionId: "cody", taskId: "task-fixture", payload: { message: "Cody inspecting the project", item: { id: "cody", turnId: common.turnId, type: "activity", activityLabel: "Cody inspecting the project", timestamp: Date.now(), text: "Cody inspecting the project" } } },
        { ...common, type: "worker.completed", workerName: "Cody", workerDefinitionId: "cody", taskId: "task-fixture", payload: { message: "Cody completed", item: { id: "cody-completed", turnId: common.turnId, type: "activity", activityLabel: "Cody completed", timestamp: Date.now(), text: "Cody completed" } } },
        { ...common, type: "task.completed", payload: { summary: "Task completed." } },
      ]) as Array<{ type: string; threadId?: string; turnId?: string; [key: string]: unknown }>;
      const boundEvents = events.map((event) => ({
        ...event,
        ...(event.threadId === "thread-fixture" ? { threadId: common.threadId } : {}),
        ...(event.turnId === "turn-fixture" ? { turnId: common.turnId } : {}),
      }));
      const body = boundEvents.map((event) => `event: mediobot\ndata: ${JSON.stringify(event)}\n\n`).join("");
      return route.fulfill({ status: 200, contentType: "text/event-stream", body });
    }
    if (url.pathname === "/api/providers" && route.request().method() === "GET") {
      return route.fulfill({
        json: {
          providers: [
            {
              id: "dahl",
              providerType: "dahl",
              displayName: "Dahl",
              baseUrl: "https://api.minimaxi.chat/v1",
              credentialStatus: "configured",
              connected: true,
              enabled: true,
              models: [
                {
                  id: "MiniMaxAI/MiniMax-M2.7",
                  name: "MiniMax M2.7",
                  enabled: true,
                  capabilities: { text: true, reasoning: true, vision: false, tools: true },
                },
              ],
            },
            {
              id: "nvidia",
              providerType: "nvidia",
              displayName: "NVIDIA",
              baseUrl: "https://integrate.api.nvidia.com/v1",
              credentialStatus: "configured",
              connected: true,
              enabled: true,
              models: [
                {
                  id: "google/diffusiongemma-26b-a4b-it",
                  name: "DiffusionGemma",
                  enabled: true,
                  capabilities: { text: true, reasoning: true, vision: true, tools: false },
                },
              ],
            },
          ],
        },
      });
    }
    if (url.pathname === "/api/providers/catalog" && route.request().method() === "GET") {
      return route.fulfill({
        json: {
          catalog: [
            { id: "dahl", name: "Dahl", group: "Popular", iconType: "dahl", defaultModels: [] },
            { id: "nvidia", name: "NVIDIA", group: "Popular", iconType: "nvidia", defaultModels: [] },
            { id: "openrouter", name: "OpenRouter", subtitle: "OpenAI-compatible models", group: "Popular", iconType: "openrouter",
              adapterType: "openai-compatible", requiresApiKey: true, configurableBaseUrl: false,
              defaultBaseUrl: "https://openrouter.ai/api/v1", defaultModels: [] },
          ],
        },
      });
    }
    if (url.pathname === "/api/providers/connect" && route.request().method() === "POST") {
      const connection = route.request().postDataJSON() as Record<string, unknown>;
      options.providerConnectRequests?.push(connection);
      return route.fulfill({ json: { provider: { id: connection.id, connected: true } } });
    }
    if (url.pathname === "/api/models/enabled" && route.request().method() === "GET") {
      return route.fulfill({
        json: {
          models: [
            {
              id: "MiniMaxAI/MiniMax-M2.7",
              name: "MiniMax M2.7",
              providerId: "dahl",
              providerName: "Dahl",
              capabilities: { text: true, reasoning: true, vision: false, tools: true },
            },
            {
              id: "google/diffusiongemma-26b-a4b-it",
              name: "DiffusionGemma",
              providerId: "nvidia",
              providerName: "NVIDIA",
              capabilities: { text: true, reasoning: true, vision: true, tools: false },
            },
          ],
        },
      });
    }
    if (url.pathname === "/api/workspace/ui-state") {
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === "/api/projects/project-local/file" && route.request().method() === "GET") {
      return route.fulfill({ json: { content: "export const editorChunkLoaded = true;\n", hash: "fixture-hash" } });
    }
    if (url.pathname === "/api/system/resources" && route.request().method() === "GET") {
      return route.fulfill({ json: { telemetry: { platform: options.resourcePlatform ?? "darwin", cpuCount: 8, loadAverage1m: 0,
        totalMemoryBytes: 16 * 1024 ** 3, freeMemoryBytes: 8 * 1024 ** 3, usedMemoryPercent: 50,
        systemCpuPercent: 56.1,
        processRssBytes: 123 * 1024 ** 2, processHeapUsedBytes: 80 * 1024 ** 2,
        memoryPressureState: "normal", timestamp: Date.now() }, activeLeases: { executionSlots: 0, modelRequests: 0,
        subprocesses: 0, browserSessions: 0 }, queuedTasksCount: 0, effectiveConcurrencyLimit: 4 } });
    }
    if (url.pathname.endsWith("/cancel") && route.request().method() === "POST") return route.fulfill({ status: 202, json: { accepted: true } });
    if (url.pathname.endsWith("/resume") && route.request().method() === "POST") return route.fulfill({ status: 202, json: { accepted: true } });
    return route.fulfill({ status: 404, json: { error: { message: "Not found." } } });
  });
  await page.goto(baseUrl);
  await page.getByRole("heading", { name: "What Should we Build with Mediobot?" }).waitFor();
}

test("opens with a real project/composer surface and an honest definition roster", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  try {
    await openWorkspace(page);
    assert.equal(await page.locator('button[title="Home / New Chat"]').isVisible(), true);
    assert.equal(await page.getByPlaceholder("Do anything").isVisible(), true);
    await page.getByRole("button", { name: "Library" }).click();
    assert.equal(await page.getByRole("heading", { name: "MedioBots Library" }).isVisible(), true);
    const maestroHeadings = await page.getByRole("heading", { name: "Maestro" }).allTextContents();
    assert.equal(maestroHeadings.length, 1, `expected one Maestro roster identity, found ${JSON.stringify(maestroHeadings)}`);
    assert.equal(await page.getByRole("heading", { name: "Cody" }).count(), 1);
    assert.equal(await page.getByText("Mediobot roster").isVisible(), true);
  } finally { await page.close(); }
});

test("restores a file tab and loads the split editor only when needed", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const editorModuleRequests: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname.endsWith("/features/editor/CodeEditorView.tsx")) editorModuleRequests.push(request.url());
  });
  try {
    await openWorkspace(page);
    assert.equal(editorModuleRequests.length, 0, "Main Chat/home must not request the editor chunk");
    await page.evaluate(() => {
      localStorage.setItem("mediobot_workbench_tabs", JSON.stringify([
        { id: "file:src/main.ts", kind: "file", path: "src/main.ts", name: "main.ts" },
      ]));
      localStorage.setItem("mediobot_active_workbench_tab_id", "file:src/main.ts");
    });
    await page.reload();
    await page.getByText("export const editorChunkLoaded = true;", { exact: true }).waitFor();
    assert.equal(editorModuleRequests.length, 1, "restoring a file tab should load the editor chunk once");
  } finally { await page.close(); }
});

test("resource tooltip labels the measured backend process RSS without claiming total MedioBot memory", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  try {
    await openWorkspace(page);
    await page.getByTitle("MedioBot Resource Governor").hover();
    await page.getByText("Backend process RSS:").waitFor();
    await page.getByText("System CPU:").waitFor();
    await page.getByText("56.1%", { exact: true }).waitFor();
    assert.equal(await page.getByText("MedioBot RAM:", { exact: true }).count(), 0);
    await page.getByText("123 MB", { exact: true }).waitFor();
  } finally { await page.close(); }
});

test("resource tooltip uses measured CPU instead of unsupported Windows load average", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  try {
    await openWorkspace(page, { resourcePlatform: "win32" });
    await page.getByTitle("MedioBot Resource Governor").hover();
    await page.getByText("System CPU:").waitFor();
    await page.getByText("56.1%", { exact: true }).waitFor();
    assert.equal(await page.getByText("Load Avg (1m):", { exact: true }).count(), 0);
  } finally { await page.close(); }
});

test("Mediobot selection is independent from chat identity and has one Maestro row", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const persistedThread = {
    id: "thread-main-stays-main", title: "Main conversation", projectId: "project-local",
    createdAt: Date.now(), updatedAt: Date.now(), model: "No configured model", branch: "main",
    approvalMode: "Approve for me", turns: [{
      id: "turn-main", threadId: "thread-main-stays-main", prompt: "A main conversation prompt",
      status: "completed", createdAt: Date.now(), completedAt: Date.now(), items: [
        { id: "main-transcript-item", turnId: "turn-main", type: "agent_message", timestamp: Date.now(), text: "Main transcript must remain intact" },
      ],
    }],
  };
  try {
    await openWorkspace(page, { threads: [persistedThread] });
    const apiWrites: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "GET" && new URL(request.url()).pathname.startsWith("/api/") && !new URL(request.url()).pathname.endsWith("/ui-state")) {
        apiWrites.push(`${request.method()} ${new URL(request.url()).pathname}`);
      }
    });

    await page.getByTitle("Threads & History").click();
    await page.getByText("Main conversation", { exact: true }).first().click();
    await page.getByText("Main transcript must remain intact", { exact: true }).waitFor();
    await page.getByTitle("Maestro Agents").click();

    assert.equal(await page.getByTestId("mediobot-select-maestro").count(), 1);
    assert.equal(await page.getByTestId("mediobot-select-cody").count(), 1);
    assert.equal(await page.getByTestId("mediobot-select-vision").count(), 1);
    await page.getByTestId("mediobot-select-cody").click();
    await page.getByTestId("mediobot-welcome-cody").waitFor();
    await page.getByText("Hi, I am").waitFor();
    assert.equal(await page.getByText("Main transcript must remain intact", { exact: true }).count(), 0);
    assert.equal(await page.getByPlaceholder("Do anything").count(), 0);
    assert.deepEqual(apiWrites, []);

    await page.getByTitle("Threads & History").click();
    await page.getByText("Main conversation", { exact: true }).first().click();
    await page.getByText("Main transcript must remain intact", { exact: true }).waitFor();
  } finally { await page.close(); }
});

test("legacy duplicate display names collapse onto the first stable definition identity", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  try {
    await openWorkspace(page, { definitions: [
      { id: "maestro", name: "Maestro", group: "orchestrator", role: "Team orchestration", availability: "available" },
      { id: "cody", name: "Cody", group: "specialist", role: "Software engineering", availability: "development" },
      { id: "legacy-maestro-generated-id", name: "Maestro", group: "specialist", role: "orchestration", availability: "available" },
      { id: "vision", name: "Vision", group: "specialist", role: "Browser", availability: "available" },
      { id: "legacy-vision-generated-id", name: "Vision", group: "specialist", role: "visual-browser", availability: "available" },
    ] });
    await page.getByTitle("Maestro Agents").click();
    assert.equal(await page.getByTestId("mediobot-select-maestro").count(), 1);
    assert.equal(await page.getByTestId("mediobot-select-legacy-maestro-generated-id").count(), 0);
    assert.equal(await page.getByTestId("mediobot-select-vision").count(), 1);
    assert.equal(await page.getByTestId("mediobot-select-legacy-vision-generated-id").count(), 0);
    await page.getByTestId("mediobot-select-cody").click();
    assert.equal(await page.getByTestId("mediobot-welcome-cody").count(), 1);
  } finally { await page.close(); }
});

test("specialist conversations and unsent drafts stay isolated while switching bots", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const now = Date.now();
  const codyThread = {
    id: "thread-cody-history", title: "Cody code review", projectId: "project-local", createdAt: now, updatedAt: now,
    turns: [{ id: "turn-cody-history", threadId: "thread-cody-history", prompt: "Review my module", status: "completed", createdAt: now,
      items: [{ id: "cody-reply", turnId: "turn-cody-history", type: "agent_message", timestamp: now,
        actor: { type: "mediobot", mediobotId: "cody", name: "Cody" }, text: "Cody's private conversation finding." }] }],
  };
  const docThread = {
    id: "thread-doc-history", title: "Doc setup notes", projectId: "project-local", createdAt: now + 1, updatedAt: now + 1,
    turns: [{ id: "turn-doc-history", threadId: "thread-doc-history", prompt: "Explain the API", status: "completed", createdAt: now + 1,
      items: [{ id: "doc-reply", turnId: "turn-doc-history", type: "agent_message", timestamp: now + 1,
        actor: { type: "mediobot", mediobotId: "doc", name: "Doc" }, text: "Doc's separate conversation finding." }] }],
  };
  try {
    await openWorkspace(page, { threads: [codyThread, docThread] });
    await page.getByTitle("Maestro Agents").click();
    await page.getByTestId("mediobot-select-cody").click();
    const conversations = page.getByTestId("mediobot-conversations-cody");
    await conversations.getByTestId("mediobot-conversation-thread-cody-history").waitFor();
    assert.equal(await conversations.getByTestId("mediobot-conversation-thread-doc-history").count(), 0);
    const codyComposer = page.getByPlaceholder("Ask Cody...");
    await codyComposer.fill("Cody draft stays here");
    await page.getByTestId("mediobot-select-doc").click();
    assert.equal(await page.getByTestId("mediobot-conversations-doc").getByTestId("mediobot-conversation-thread-doc-history").count(), 1);
    assert.equal(await page.getByPlaceholder("Ask Doc...").inputValue(), "");
    await page.getByPlaceholder("Ask Doc...").fill("Doc draft stays separate");
    await page.getByTestId("mediobot-select-cody").click();
    assert.equal(await page.getByPlaceholder("Ask Cody...").inputValue(), "Cody draft stays here");
    assert.equal(await page.getByTestId("mediobot-conversations-cody").getByTestId("mediobot-conversation-thread-doc-history").count(), 0);
  } finally { await page.close(); }
});

test("a specialist conversation restores its reader position after switching workspaces", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const now = Date.now();
  const items = Array.from({ length: 32 }, (_, index) => ({ id: `cody-long-${index}`, turnId: "turn-cody-long",
    type: "agent_message", timestamp: now + index, actor: { type: "mediobot", mediobotId: "cody", name: "Cody" },
    text: `Cody conversation entry ${index}. ${"Evidence-backed context for restoring this conversation's reading position. ".repeat(5)}` }));
  const thread = { id: "thread-cody-long", title: "Cody long conversation", projectId: "project-local", createdAt: now, updatedAt: now,
    turns: [{ id: "turn-cody-long", threadId: "thread-cody-long", prompt: "Continue the prior review", status: "completed", createdAt: now, items }] };
  try {
    await openWorkspace(page, { threads: [thread] });
    await page.getByTitle("Maestro Agents").click();
    await page.getByTestId("mediobot-select-cody").click();
    await page.getByTestId("mediobot-conversation-thread-cody-long").click();
    const scrollRoot = page.getByTestId("thread-scroll-root");
    await scrollRoot.evaluate(element => { element.scrollTop = 240; element.dispatchEvent(new Event("scroll")); });
    await page.waitForFunction(() => Number(sessionStorage.getItem("mediobot-thread-scroll:thread-cody-long")) > 0);
    await page.getByTestId("mediobot-select-doc").click();
    await page.getByTestId("mediobot-select-cody").click();
    await page.getByTestId("mediobot-conversation-thread-cody-long").click();
    const restored = await page.getByTestId("thread-scroll-root").evaluate(element => element.scrollTop);
    assert.ok(restored > 0 && restored < 1000, `expected restored mid-thread position, received ${restored}`);
  } finally { await page.close(); }
});

test("Mediobot workspace keeps its composer visible and restores its own reading position", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const now = Date.now();
  const threads = Array.from({ length: 4 }, (_, index) => ({ id: `thread-cody-recent-${index}`, title: `Cody conversation ${index}`,
    projectId: "project-local", createdAt: now + index, updatedAt: now + index,
    turns: [{ id: `turn-cody-recent-${index}`, threadId: `thread-cody-recent-${index}`, prompt: `Review notes ${index}`,
      status: "completed", createdAt: now + index, items: [{ id: `item-cody-recent-${index}`, turnId: `turn-cody-recent-${index}`,
        type: "agent_message", timestamp: now + index, actor: { type: "mediobot", mediobotId: "cody", name: "Cody" },
        text: `Evidence from previous Cody work ${index}. ${"Relevant result and source details. ".repeat(12)}` }] }] }));
  const tasks = Array.from({ length: 4 }, (_, index) => ({ id: `task-cody-recent-${index}`, state: "completed",
    goal: `Completed Cody task ${index}. ${"Verified task context. ".repeat(8)}`,
    assignedMediobot: { id: "cody", name: "Cody" }, events: [{ type: "worker.completed", occurredAt: now + index }] }));
  try {
    await openWorkspace(page, { threads, tasks });
    await page.getByTitle("Maestro Agents").click();
    await page.getByTestId("mediobot-select-cody").click();
    const content = page.getByTestId("mediobot-workspace-content-cody");
    await page.waitForFunction(() => {
      const composer = document.querySelector("textarea");
      return Boolean(composer && composer.getBoundingClientRect().bottom <= innerHeight);
    });
    const geometry = await page.evaluate(() => {
      const content = document.querySelector('[data-testid="mediobot-workspace-content-cody"]');
      const composer = document.querySelector("textarea");
      return { contentHeight: content?.clientHeight ?? 0, contentScrollHeight: content?.scrollHeight ?? 0,
        composerBottom: composer?.getBoundingClientRect().bottom ?? Infinity, viewportHeight: innerHeight };
    });
    assert.ok(geometry.contentScrollHeight > geometry.contentHeight, "long workspace history should scroll within its own panel");
    assert.ok(geometry.composerBottom <= geometry.viewportHeight, "composer stays visible at the bottom of the workspace");
    await content.evaluate(element => { element.scrollTop = 120; element.dispatchEvent(new Event("scroll")); });
    await page.waitForFunction(() => Number(sessionStorage.getItem("mediobot-workspace-scroll:cody")) === 120);
    await page.getByTestId("mediobot-select-doc").click();
    await page.getByTestId("mediobot-select-cody").click();
    assert.equal(await content.evaluate(element => element.scrollTop), 120, "switching specialists restores each workspace's position");
  } finally { await page.close(); }
});

test("specialist workspace reflects its durable active assignment", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const now = Date.now();
  try {
    await openWorkspace(page, { tasks: [{ id: "task-cody-active", state: "running", goal: "Implement and verify a prime function",
      assignedMediobot: { id: "cody", name: "Cody" }, events: [
        { type: "worker.started", occurredAt: now },
        { type: "tool.completed", toolName: "filesystem.read", message: "Read the project entry point", occurredAt: now + 1 },
      ], evidence: [{ id: "evidence-cody-source", kind: "filesystem.read", validity: "observed" }],
      artifacts: [{ id: "artifact-prime", mediobotId: "cody", name: "prime_check.py", reference: "prime_check.py", contentHash: "a".repeat(64) }] }] });
    await page.getByTitle("Maestro Agents").click();
    await page.getByTestId("mediobot-select-cody").click();
    const status = page.getByTestId("mediobot-workspace-status-cody");
    await status.getByText("Working").waitFor();
    await page.getByTestId("mediobot-active-assignment-cody").getByText("Implement and verify a prime function").waitFor();
    const history = page.getByTestId("mediobot-task-history-cody");
    await history.getByText("Recent work").waitFor();
    await history.getByText("Used filesystem.read").waitFor();
    await history.getByText("1 evidence records").waitFor();
    await history.getByTestId("mediobot-artifacts-task-cody-active").getByText("Files: prime_check.py").waitFor();
  } finally { await page.close(); }
});

test("specialist workspace projects attributed live activity into recent work", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const now = Date.now();
  try {
    await openWorkspace(page, { events: [
      { type: "worker.assigned", threadId: "thread-fixture", turnId: "turn-fixture", timestamp: now,
        workerName: "Cody", workerDefinitionId: "cody", taskId: "task-cody-parent", executionTaskId: "task-cody-live",
        payload: { message: "Assigned: Inspect the module entry point" } },
      { type: "tool.completed", threadId: "thread-fixture", turnId: "turn-fixture", timestamp: now + 1,
        workerName: "Cody", workerDefinitionId: "cody", taskId: "task-cody-parent", executionTaskId: "task-cody-live",
        payload: { message: "Read the module entry point", tool: { toolName: "filesystem.read", status: "success" },
          item: { id: "live-tool-activity", turnId: "turn-fixture", type: "activity", timestamp: now + 1, text: "Read the module entry point" } } },
    ] });
    await page.getByTitle("Maestro Agents").click();
    await page.getByTestId("mediobot-select-cody").click();
    const liveStream = page.waitForResponse((response) => new URL(response.url()).pathname.startsWith("/api/turns/")
      && new URL(response.url()).pathname.endsWith("/events"));
    await page.getByPlaceholder("Ask Cody...").fill("Inspect the module entry point.");
    await page.getByPlaceholder("Ask Cody...").press("Enter");
    await liveStream;
    await page.getByTestId("mediobot-select-cody").click();
    const history = page.getByTestId("mediobot-task-history-cody");
    await history.getByText("Inspect the module entry point", { exact: true }).waitFor();
    await history.getByText("Used filesystem.read").waitFor();
    await history.getByText("Activity (2)").click();
    await history.getByTestId("mediobot-task-event-task-cody-live-1").getByText("filesystem.read · completed").waitFor();
  } finally { await page.close(); }
});

test("specialist workspace shows only its authorized shared group history", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  try {
    await openWorkspace(page, { groupHistory: {
      "cody": [{ taskId: "task-shared", taskGoal: "Inspect a Node.js setup", groupId: "group-shared", status: "completed",
        messages: [{ id: "msg-doc-1", sequenceNumber: 1, senderSpecialistId: "doc", senderName: "Doc",
          kind: "finding", content: "Doc found the official Node.js introduction and verified its runtime setup instructions.",
          evidenceRefs: ["evidence-node-docs"], createdAt: Date.now() },
        { id: "msg-maestro-2", sequenceNumber: 2, senderSpecialistId: "maestro", senderName: "Maestro",
          kind: "request", content: "Cody, use Doc's verified setup instructions in your summary.",
          evidenceRefs: [], createdAt: Date.now() + 1 }] }],
    } });
    await page.getByTitle("Maestro Agents").click();
    await page.getByTestId("mediobot-select-cody").click();
    const history = page.getByTestId("mediobot-collaboration-history-cody");
    await history.getByText("Doc found the official Node.js introduction").waitFor();
    await history.getByText("Doc · Finding · #1").waitFor();
    await history.getByText("Maestro · Request · #2").waitFor();
    await history.getByText("1 evidence reference").waitFor();
    assert.match(await history.locator('[data-testid="mediobot-shared-message-1"]').getAttribute("class") ?? "", /rounded-lg/);
    assert.match(await history.locator('[data-testid="mediobot-shared-message-1"] > p').nth(1).getAttribute("class") ?? "", /text-\[13px\]/);
  } finally { await page.close(); }
});

test("wide specialist workspace uses readable width for conversations, work, and collaboration", async () => {
  const page = await browser.newPage({ viewport: { width: 2048, height: 1159 } });
  const now = Date.now();
  try {
    const thread = { id: "thread-cody-wide", title: "Cody conversation", projectId: "project-local",
      createdAt: now, updatedAt: now, turns: [{ id: "turn-cody-wide", threadId: "thread-cody-wide",
        prompt: "Review the workspace", status: "completed", createdAt: now, items: [{ id: "item-cody-wide",
          turnId: "turn-cody-wide", type: "agent_message", timestamp: now,
          actor: { type: "mediobot", mediobotId: "cody", name: "Cody" }, text: "Observed workspace evidence." }] }] };
    await openWorkspace(page, { threads: [thread], tasks: [{ id: "task-cody-wide", state: "completed",
      goal: "Inspect the workspace", assignedMediobot: { id: "cody", name: "Cody" },
      events: [{ type: "worker.completed", occurredAt: now }] }], groupHistory: { cody: [{ taskId: "task-cody-wide",
        taskGoal: "Inspect the workspace", groupId: "group-cody-wide", status: "completed", messages: [{
          id: "msg-cody-wide", sequenceNumber: 1, senderSpecialistId: "doc", senderName: "Doc",
          kind: "finding", content: "A useful attributed finding with enough detail to read comfortably.",
          evidenceRefs: ["evidence-wide"], createdAt: now }] }] } });
    const mainComposerWidth = await page.locator('[data-testid="composer-container"]').evaluate(element => element.getBoundingClientRect().width);
    await page.getByTitle("Maestro Agents").click();
    await page.getByTestId("mediobot-select-cody").click();
    assert.ok(mainComposerWidth <= 768, `Main Chat composer keeps its existing max width; got ${mainComposerWidth}`);
    await page.waitForFunction(() => (document.querySelector('[data-testid="composer-container"]')?.getBoundingClientRect().width ?? 0) >= 1100);
    const widths = await page.evaluate(() => [
      "mediobot-conversations-cody", "mediobot-task-history-cody", "mediobot-collaboration-history-cody",
      ].map(id => document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect().width ?? 0)
      .concat(document.querySelector('[data-testid="composer-container"]')?.getBoundingClientRect().width ?? 0));
    assert.equal(widths.length, 4);
    assert.ok(widths.every(width => width >= 1100), `workspace panels should use desktop width; got ${widths.join(", ")}`);
    const specialistPromptBarWidth = await page.locator('[data-testid="composer-container"] .prompt-bar').evaluate(element => element.getBoundingClientRect().width);
    assert.ok(specialistPromptBarWidth >= 1000, `specialist prompt bar should align with the history panels; got ${specialistPromptBarWidth}`);
    const contentOrder = await page.evaluate(() => {
      const collaboration = document.querySelector('[data-testid="mediobot-collaboration-history-cody"]');
      const assignments = document.querySelector('[data-testid="mediobot-task-history-cody"]');
      return collaboration && assignments
        ? Boolean(collaboration.compareDocumentPosition(assignments) & Node.DOCUMENT_POSITION_FOLLOWING)
        : false;
    });
    assert.equal(contentOrder, true, "shared collaboration is presented before historical work");
    assert.equal(await page.getByTitle("Select model").isVisible(), true, "the selected specialist model remains controllable");
    assert.equal(await page.getByLabel("Choose effort").isVisible(), true, "reasoning effort remains controllable");
    await page.screenshot({ path: path.join(os.tmpdir(), "mediobot-v2-mediobot-workspace-2048x1159.png") });
  } finally { await page.close(); }
});

test("specialist workspace refreshes persisted group findings on live collaboration activity", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  let historyRequests = 0;
  let sharedGroups: unknown[] = [];
  const taskId = "task-shared-live";
  try {
    await openWorkspace(page, {
      tasks: [{ id: taskId, state: "running", goal: "Use shared runtime setup findings",
        assignedMediobot: { id: "cody", name: "Cody" }, events: [] }],
      events: [{ type: "worker.progress", threadId: "thread-fixture", turnId: "turn-fixture", timestamp: Date.now(),
        workerName: "Cody", workerDefinitionId: "cody", taskId,
        payload: { message: "Cody received shared finding from Doc (sequence 1)." } }],
      groupHistory: { "cody": () => { historyRequests++; return sharedGroups; } },
    });
    await page.getByTitle("Maestro Agents").click();
    const initialHistory = page.waitForResponse(response => new URL(response.url()).pathname === "/api/specialists/cody/group-history");
    await page.getByTestId("mediobot-select-cody").click();
    await initialHistory;
    sharedGroups = [{ taskId, taskGoal: "Use shared runtime setup findings", groupId: "group-live", status: "active",
      messages: [{ id: "msg-live-1", sequenceNumber: 1, senderSpecialistId: "doc", senderName: "Doc",
        kind: "finding", content: "Doc published the official runtime setup finding during Cody's active task.",
        evidenceRefs: ["ev-live"], createdAt: Date.now() }] }];

    const stream = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/events"));
    await page.getByPlaceholder("Ask Cody...").fill("Continue using the authorized shared information.");
    await page.getByPlaceholder("Ask Cody...").press("Enter");
    await stream;
    await page.waitForTimeout(500);
    assert.ok(historyRequests >= 2, `live collaboration must refresh history (requests=${historyRequests})`);
    await page.getByTestId("mediobot-select-cody").click();
    await page.getByTestId("mediobot-collaboration-history-cody").waitFor();
    const panelText = await page.getByTestId("mediobot-collaboration-history-cody").textContent().catch(() => null);
    assert.match(panelText ?? "", /Doc published the official runtime setup finding/);
  } finally { await page.close(); }
});

test("specialist workspace ignores live assignments from an unrelated thread", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  try {
    await openWorkspace(page, { events: [{
      type: "worker.assigned", threadId: "foreign-thread", turnId: "turn-fixture", timestamp: Date.now(),
      workerName: "Cody", workerDefinitionId: "cody", taskId: "task-foreign-thread",
      payload: { message: "Assigned: This task belongs elsewhere" },
    }] });
    await page.getByTitle("Maestro Agents").click();
    await page.getByTestId("mediobot-select-cody").click();
    const liveStream = page.waitForResponse((response) => new URL(response.url()).pathname.startsWith("/api/turns/")
      && new URL(response.url()).pathname.endsWith("/events"));
    await page.getByPlaceholder("Ask Cody...").fill("Check current assignments.");
    await page.getByPlaceholder("Ask Cody...").press("Enter");
    await liveStream;
    await page.getByTestId("mediobot-select-cody").click();
    assert.equal(await page.getByTestId("mediobot-task-history-cody").count(), 0);
  } finally { await page.close(); }
});

test("one finished assignment does not hide another active assignment for the same specialist", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const now = Date.now();
  try {
    await openWorkspace(page, { tasks: [
      { id: "task-cody-finished", state: "running", goal: "Completed Cody assignment", assignedMediobot: { id: "cody", name: "Cody" }, events: [{ type: "worker.started", occurredAt: now }] },
      { id: "task-cody-still-running", state: "running", goal: "Still active Cody assignment", assignedMediobot: { id: "cody", name: "Cody" }, events: [{ type: "worker.started", occurredAt: now + 1 }] },
    ], events: [
      { type: "worker.completed", threadId: "thread-fixture", turnId: "turn-fixture", timestamp: now + 2,
        workerName: "Cody", workerDefinitionId: "cody", taskId: "task-cody-finished",
        payload: { message: "Cody completed one assignment", item: { id: "cody-one-completed", turnId: "turn-fixture", type: "activity", timestamp: now, text: "Cody completed one assignment" } } },
      { type: "task.completed", threadId: "thread-fixture", turnId: "turn-fixture", timestamp: now + 3, payload: { summary: "One assignment completed." } },
    ] });
    await page.getByTitle("Maestro Agents").click();
    await page.getByTestId("mediobot-select-cody").click();
    const liveStream = page.waitForResponse((response) => new URL(response.url()).pathname.startsWith("/api/turns/")
      && new URL(response.url()).pathname.endsWith("/events"));
    await page.getByPlaceholder("Ask Cody...").fill("Check in on Cody's active work.");
    await page.getByPlaceholder("Ask Cody...").press("Enter");
    await liveStream;
    await page.getByTestId("mediobot-select-cody").click();
    const status = page.getByTestId("mediobot-workspace-status-cody");
    await status.getByText("Working").waitFor();
    await page.getByTestId("mediobot-active-assignment-cody").getByText("Still active Cody assignment").waitFor();
  } finally { await page.close(); }
});

test("canonical Mediobot identities retain their ZIP avatar and accent tokens", () => {
  const expected = [
    ["maestro", "Maestro", "bg-[#f4f4f5]", "text-[#f4f4f5]"],
    ["cody", "Cody", "bg-[#fef08a]", "text-[#fef08a]"],
    ["vision", "Vision", "bg-[#bae6fd]", "text-[#bae6fd]"],
    ["doc", "Doc", "bg-[#4b4a56]", "text-[#a1a1aa]"],
    ["research", "Research", "bg-[#fed7aa]", "text-[#fed7aa]"],
    ["tester", "Tester", "bg-[#ddd6fe]", "text-[#ddd6fe]"],
  ] as const;
  for (const [id, name, avatar, text] of expected) {
    const presentation = getMediobotPresentation(id);
    assert.equal(presentation.displayName, name);
    assert.equal(presentation.avatar, avatar);
    assert.equal(presentation.text, text);
    assert.equal(presentation.id, id);
  }
});

test("conversation timeline attributes user checkpoints and navigates to transcript entries", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.addInitScript(() => {
    const targetWindow = window as typeof window & { __timelineObservers?: Array<{ callback: (entries: unknown[], observer: unknown) => void; targets: Set<Element> }>; __notifyTimelineVisible?: (id: string) => void };
    targetWindow.__timelineObservers = [];
    (targetWindow as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
      callback: (entries: unknown[], observer: unknown) => void;
      targets = new Set<Element>();
      constructor(callback: (entries: unknown[], observer: unknown) => void) { this.callback = callback; targetWindow.__timelineObservers!.push(this); }
      observe(target: Element) { this.targets.add(target); }
      disconnect() { this.targets.clear(); }
      unobserve(target: Element) { this.targets.delete(target); }
    };
    targetWindow.__notifyTimelineVisible = (id: string) => {
      const target = document.getElementById(id);
      for (const observer of targetWindow.__timelineObservers!) if (target && observer.targets.has(target)) {
        observer.callback([{ target, isIntersecting: true, intersectionRatio: 1 }], observer);
      }
    };
  });
  const now = Date.now();
  const itemsTurn1 = [
    { id: "timeline-user-1", turnId: "turn-nav-1", type: "user_message", actor: { type: "user" }, timestamp: now, text: "Please research this" },
    { id: "timeline-v", turnId: "turn-nav-1", type: "activity", actor: { type: "mediobot", mediobotId: "vision", name: "Vision" }, timestamp: now + 1, activityLabel: "Vision opened a page" },
    { id: "timeline-msg", turnId: "turn-nav-1", type: "agent_message", actor: { type: "mediobot", mediobotId: "cody", name: "Cody" }, timestamp: now + 2, text: "Vision inspected the page; this message belongs to Cody." },
  ];
  const itemsTurn2 = [
    { id: "timeline-user-2", turnId: "turn-nav-2", type: "user_message", actor: { type: "user" }, timestamp: now + 3, text: "Now implement the changes" },
    { id: "timeline-end", turnId: "turn-nav-2", type: "activity", actor: { type: "system" }, timestamp: now + 4, activityLabel: "Task completed" },
  ];
  const threads = [{
    id: "thread-nav",
    title: "Timeline fixture",
    createdAt: now,
    updatedAt: now,
    model: "fixture",
    branch: "main",
    approvalMode: "Approve for me",
    turns: [
      { id: "turn-nav-1", threadId: "thread-nav", prompt: "Please research this", status: "completed", createdAt: now, completedAt: now + 2, items: itemsTurn1 },
      { id: "turn-nav-2", threadId: "thread-nav", prompt: "Now implement the changes", status: "completed", createdAt: now + 3, completedAt: now + 4, items: itemsTurn2 },
    ],
  }];
  try {
    await openWorkspace(page, { threads });
    await page.getByTitle("Threads & History").click();
    await page.getByText("Timeline fixture", { exact: true }).first().click();
    await page.getByText("Vision inspected the page; this message belongs to Cody.", { exact: true }).waitFor();
    assert.equal(await page.getByTestId("timeline-navigator").count(), 1);
    assert.equal(await page.getByTestId("timeline-anchor").count(), 2);

    const target = page.locator('#timeline-turn-nav-2-timeline-user-2');
    const scrollBehavior = await target.evaluate((element) => {
      (window as Window & { __scrollBehavior?: string }).__scrollBehavior = undefined;
      element.scrollIntoView = ((options?: ScrollIntoViewOptions) => {
        (window as Window & { __scrollBehavior?: string }).__scrollBehavior = options?.behavior;
      }) as typeof element.scrollIntoView;
      return true;
    });
    assert.equal(scrollBehavior, true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByTestId("timeline-anchor").nth(1).click();
    assert.equal(await page.evaluate(() => (window as Window & { __scrollBehavior?: string }).__scrollBehavior), "auto");
    await page.getByTestId("timeline-anchor").nth(1).focus();
    assert.equal(await page.getByTestId("timeline-preview").isVisible(), true);
    assert.match(await page.getByTestId("timeline-preview").innerText(), /Now implement the changes/);

    const lastTargetId = await page.getByTestId("timeline-anchor").nth(1).getAttribute("data-target-id");
    assert.ok(lastTargetId);
    await page.evaluate((id) => (window as Window & { __notifyTimelineVisible?: (targetId: string) => void }).__notifyTimelineVisible?.(id), lastTargetId);
    await page.waitForFunction((id) => document.querySelector('[data-testid="timeline-anchor"][aria-current="location"]')?.getAttribute('data-target-id') === id, lastTargetId);
  } finally { await page.close(); }
});

test("conversations without user checkpoints omit the timeline navigator", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const now = Date.now();
  const threads = [{ id: "thread-short", title: "Short conversation", createdAt: now, updatedAt: now, model: "fixture", branch: "main", approvalMode: "Approve for me", turns: [{ id: "turn-short", threadId: "thread-short", prompt: "", status: "completed", createdAt: now, items: [
    { id: "short-answer", turnId: "turn-short", type: "agent_message", actor: { type: "mediobot", mediobotId: "maestro", name: "Maestro" }, timestamp: now + 1, text: "Hi there." },
  ] }] }];
  try {
    await openWorkspace(page, { threads });
    await page.getByTitle("Threads & History").click();
    await page.getByText("Short conversation", { exact: true }).first().click();
    await page.getByText("Hi there.", { exact: true }).waitFor();
    assert.equal(await page.getByTestId("timeline-navigator").count(), 0);
  } finally { await page.close(); }
});

test("Composer attaches through file picker, image paste, and drag/drop while preserving text paste", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await openWorkspace(page);
    const input = page.getByPlaceholder("Do anything");
    const textPastePrevented = await input.evaluate((element) => {
      const transfer = new DataTransfer(); transfer.setData("text/plain", "plain clipboard text");
      const paste = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
      element.dispatchEvent(paste);
      return paste.defaultPrevented;
    });
    assert.equal(textPastePrevented, false); // Ordinary text paste remains owned by the browser.
    await input.pressSequentially("question about these files");

    await page.getByLabel("Attach files").click();
    await page.getByLabel("Choose attachments").setInputFiles({ name: "picked.png", mimeType: "image/png", buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) });
    await page.getByText("picked.png", { exact: true }).waitFor();
    await page.getByLabel("Remove picked.png").click();
    await page.getByText("picked.png", { exact: true }).waitFor({ state: "detached" });

    await page.locator("textarea").evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "pasted.png", { type: "image/png" }));
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
    });
    await page.getByText("pasted.png", { exact: true }).waitFor();
    const dropTarget = await page.locator("textarea").evaluateHandle((element) => element.closest(".relative")?.parentElement);
    await page.evaluate((target) => {
      if (!(target instanceof HTMLElement)) throw new Error("Composer drop surface missing");
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "dropped.png", { type: "image/png" }));
      target.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }, dropTarget);
    await page.getByText("dropped.png", { exact: true }).waitFor();
  } finally { await page.close(); }
});

test("submits a natural-language task through Maestro and displays only product-safe activity", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  let requestBody: Record<string, unknown> | undefined;
  try {
    await openWorkspace(page, { tasks: [{ id: "task-fixture", state: "completed", goal: "Fix the failing math test",
      assignedMediobot: { id: "cody", name: "Cody" }, events: [
        { type: "worker.assigned", occurredAt: Date.now() - 2 },
        { type: "worker.completed", occurredAt: Date.now() - 1 },
      ] }] });
    const requests: string[] = [];
    page.on("request", (request) => requests.push(`${request.method()} ${new URL(request.url()).pathname}`));
    await page.route("**/api/turns", async (route) => {
      if (route.request().method() === "POST") requestBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fallback();
    });
    await page.getByPlaceholder("Do anything").fill("Fix the failing math test");
    await page.getByPlaceholder("Do anything").press("Enter");
    await page.getByText("Fix the failing math test", { exact: true }).waitFor();
    await page.locator('[data-timeline-anchor="activity"] summary').click();
    try { await page.getByText("Cody inspecting the project", { exact: true }).waitFor({ timeout: 5000 }); }
    catch (error) { throw new Error(`${error instanceof Error ? error.message : "activity not visible"}\n${await page.locator("body").innerText()}\n${requests.join("\n")}`); }
    assert.equal(requestBody?.definitionId, "maestro");
    assert.equal(requestBody?.projectId, "project-local");
    assert.equal(await page.getByText(/<think>|Authorization:|provider secret/i).count(), 0);
    await page.getByTitle("Maestro Agents").click();
    await page.getByTestId("mediobot-select-cody").click();
    const codyStatus = page.getByTestId("mediobot-workspace-status-cody");
    await codyStatus.getByText("In development").waitFor();
    await codyStatus.getByText("Completed").waitFor();
    assert.equal(await page.getByTestId("mediobot-active-assignment-cody").count(), 0,
      "a completed assignment must be shown in history, not labelled as current work");
    await page.getByTestId("mediobot-task-history-cody").getByText("completed", { exact: true }).waitFor();
  } finally { await page.close(); }
});

test("Stop keeps Main Chat active until a terminal execution event arrives", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const cancelRequests: string[] = [];
  try {
    await openWorkspace(page, { events: [{ type: "agent.started", threadId: "thread-fixture", turnId: "turn-fixture",
      timestamp: Date.now(), payload: {} }] });
    page.on("request", request => {
      if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/cancel")) cancelRequests.push(request.url());
    });
    await page.getByPlaceholder("Do anything").fill("Wait for a bounded operation");
    await page.getByPlaceholder("Do anything").press("Enter");
    await page.getByRole("button", { name: "Stop" }).waitFor();
    await page.getByRole("button", { name: "Stop" }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Stop"]') !== null);
    assert.equal(cancelRequests.length, 1);
    assert.equal(await page.getByRole("button", { name: "Stop" }).isVisible(), true,
      "the UI must keep the turn active while workers/tools are still settling");
  } finally { await page.close(); }
});

test("missing model configuration explains the block without submitting a task", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  let submitted = false;
  try {
    await openWorkspace(page, { configured: false });
    await page.route("**/api/tasks", async (route) => {
      if (route.request().method() === "POST") submitted = true;
      await route.fallback();
    });
    await page.getByPlaceholder("Do anything").fill("Do not create fake work");
    await page.getByPlaceholder("Do anything").press("Enter");
    await page.getByText(/text reasoning model is not configured/i).waitFor();
    assert.equal(submitted, false); // The client blocks early; runtime creates no task.
  } finally { await page.close(); }
});

test("History UI: displays persisted threads, restores conversation, supports continuation on same thread, rename, and delete", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  let savedThread: Record<string, unknown> | undefined;
  let renamedTitle = "";
  let deletedId = "";

  try {
    const persistedThread = {
      id: "thread-history-e2e",
      title: "Existing Coding Session",
      projectId: "project-local",
      createdAt: Date.now() - 60000,
      updatedAt: Date.now() - 60000,
      model: "Configured by local runtime",
      branch: "main",
      approvalMode: "Approve for me",
      turns: [
        {
          id: "turn-h1",
          threadId: "thread-history-e2e",
          prompt: "Analyze the database schema",
          status: "completed",
          currentActivity: "completed",
          createdAt: Date.now() - 60000,
          completedAt: Date.now() - 50000,
          items: [
            { id: "msg-u1", turnId: "turn-h1", type: "user_message", timestamp: Date.now() - 60000, text: "Analyze the database schema" },
            { id: "msg-a1", turnId: "turn-h1", type: "agent_message", timestamp: Date.now() - 50000, text: "The schema has 3 tables." },
          ],
        },
      ],
    };

    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/projects") {
        return route.fulfill({ json: { projects: [{ id: "project-local", name: "Fixture", path: "/tmp/fixture", branch: "main", branches: ["main"], environment: "Local" }] } });
      }
      if (url.pathname === "/api/definitions") {
        return route.fulfill({ json: { definitions: [{ id: "maestro", name: "Maestro", group: "orchestrator", role: "Team orchestration", summary: "Orchestrator", availability: "available", executable: true }] } });
      }
      if (url.pathname === "/api/threads" && route.request().method() === "GET") {
        return route.fulfill({ json: { threads: [persistedThread] } });
      }
      if (url.pathname === "/api/threads/thread-history-e2e" && route.request().method() === "GET") {
        return route.fulfill({ json: { thread: persistedThread } });
      }
      if (url.pathname === "/api/threads" && route.request().method() === "POST") {
        savedThread = route.request().postDataJSON() as Record<string, unknown>;
        return route.fulfill({ status: 200, json: { thread: persistedThread } });
      }
      if (url.pathname.startsWith("/api/threads/") && route.request().method() === "PATCH") {
        const body = route.request().postDataJSON() as { title: string };
        renamedTitle = body.title;
        return route.fulfill({ status: 200, json: { ok: true } });
      }
      if (url.pathname.startsWith("/api/threads/") && route.request().method() === "DELETE") {
        deletedId = url.pathname.split("/").pop() || "";
        return route.fulfill({ status: 200, json: { ok: true } });
      }
      if (url.pathname === "/api/turns" && route.request().method() === "POST") {
        const input = route.request().postDataJSON() as { turnId: string; threadId: string };
        return route.fulfill({ status: 202, json: { turnId: input.turnId, taskId: "task-fixture-2" } });
      }
      if (url.pathname.endsWith("/events")) {
        const events = [
          { type: "task.completed", payload: { summary: "Followup complete." }, turnId: "turn-followup", threadId: "thread-history-e2e", timestamp: Date.now() },
        ];
        return route.fulfill({ status: 200, contentType: "text/event-stream", body: events.map(e => `event: mediobot\ndata: ${JSON.stringify(e)}\n\n`).join("") });
      }
      return route.fulfill({ status: 404, json: { error: { message: "Not found." } } });
    });

    await page.goto(baseUrl);
    await page.getByRole("heading", { name: "What Should we Build with Mediobot?" }).waitFor();

    // 1. Open History tab in sidebar
    await page.locator('button[title="Threads & History"]').click();
    await page.getByText("Existing Coding Session").waitFor();

    // 2. Click the persisted thread -> should restore the conversation into Home
    await page.getByText("Existing Coding Session").click();
    await page.getByText("Analyze the database schema").waitFor();
    await page.getByText("The schema has 3 tables.").waitFor();

    // 3. Continue the conversation on the SAME thread
    await page.getByPlaceholder("Do anything").fill("What is the primary key of each?");
    await page.getByPlaceholder("Do anything").press("Enter");
    await page.getByText("What is the primary key of each?").waitFor();

    // 4. Test rename in history list
    page.on("dialog", async (dialog) => {
      if (dialog.type() === "prompt") await dialog.accept("Renamed Session Title");
      else if (dialog.type() === "confirm") await dialog.accept();
    });

    const renameBtn = page.getByTitle("Rename conversation").first();
    await renameBtn.click({ force: true });
    assert.equal(renamedTitle, "Renamed Session Title");

    // 5. Test delete in history list
    const deleteBtn = page.getByTitle("Delete conversation").first();
    const deleteResponse = page.waitForResponse((response) => response.request().method() === "DELETE"
      && response.url().includes("/api/threads/thread-history-e2e"));
    await deleteBtn.click({ force: true });
    await deleteResponse;
    assert.equal(deletedId, "thread-history-e2e");
  } finally { await page.close(); }
});

test("Model Selector UI: requires explicit thread selection and shows connected models", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const providerConnectRequests: Array<Record<string, unknown>> = [];
  try {
    await openWorkspace(page, { providerConnectRequests });

    // New threads never silently inherit a global/default model.
    const selectorBtn = page.getByTitle("Select model");
    assert.equal(await selectorBtn.isVisible(), true);
    assert.match(await selectorBtn.innerText(), /No configured model/);

    // 2. Open dropdown
    await selectorBtn.click();
    await page.getByPlaceholder("Search models").waitFor();
    assert.equal(await page.getByText("Manage models").isVisible(), true);
    assert.equal(await page.getByText("Dahl").first().isVisible(), true);
    await page.getByText("MiniMax M2.7", { exact: true }).click();
    assert.match(await selectorBtn.innerText(), /MiniMax M2\.7/);

    // 3. Search filter
    await selectorBtn.click();
    await page.getByPlaceholder("Search models").fill("Diffusion");
    await page.getByText("NVIDIA").first().click();
    assert.equal(await page.getByText("DiffusionGemma").isVisible(), true);

    // 4. Click Manage models -> opens settings configuration
    await page.getByText("Manage models").click();
    await page.getByText("Configuration").first().waitFor();
    await page.getByText("Manage Models").first().waitFor();

    // Verify Dahl and NVIDIA appear in Manage Models
    assert.equal(await page.getByText("Dahl").count() > 0, true);
    assert.equal(await page.getByText("NVIDIA").count() > 0, true);

    await page.getByRole("button", { name: /Connect provider/i }).click();
    await page.getByText("OpenRouter", { exact: true }).click();
    await page.getByLabel("OpenRouter model ID").fill("anthropic/claude-sonnet-4.6");
    await page.getByPlaceholder("Paste API key").fill("controlled-ui-fixture-key");
    const connectResponse = page.waitForResponse(response => response.url().includes("/api/providers/connect")
      && response.request().method() === "POST");
    await page.getByRole("button", { name: "Validate and connect" }).click();
    await connectResponse;
    assert.equal(providerConnectRequests.length, 1);
    assert.equal(providerConnectRequests[0]?.providerType, "openrouter");
    assert.equal(providerConnectRequests[0]?.modelId, "anthropic/claude-sonnet-4.6");
    const configuredModel = (providerConnectRequests[0]?.models as Array<{ id: string; capabilities: { tools: boolean } }>)[0];
    assert.equal(configuredModel.id, "anthropic/claude-sonnet-4.6");
    assert.equal(configuredModel.capabilities.tools, false, "Settings must not claim an unverified provider-native tool protocol");
  } finally { await page.close(); }
});

test("restored thread selection resolves by provider and model identity, not the legacy model label", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const persistedThread = {
    id: "thread-restored-model", title: "Restored model thread", projectId: "project-local",
    createdAt: Date.now(), updatedAt: Date.now(), model: "MiniMaxAI/MiniMax-M2.7",
    modelSelection: { providerConnectionId: "dahl", modelId: "MiniMaxAI/MiniMax-M2.7" },
    branch: "main", approvalMode: "Approve for me", turns: [],
  };
  try {
    await openWorkspace(page, { threads: [persistedThread] });
    await page.getByTitle("Threads & History").click();
    await page.getByText("Restored model thread", { exact: true }).click();
    const selector = page.getByTitle("Select model");
    await selector.waitFor();
    assert.match(await selector.innerText(), /MiniMax M2\.7/);
    await selector.click();
    assert.equal(await page.getByText("Saved model unavailable", { exact: false }).count(), 0);
    const minimaxRow = page.getByText("MiniMax M2.7", { exact: true }).last().locator("xpath=../../..");
    assert.match(await minimaxRow.getAttribute("class") ?? "", /bg-\[#25242c\]/);
  } finally { await page.close(); }
});

test("resuming a recovered paused turn clears its stale recovery controls", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const now = Date.now();
  const thread = { id: "thread-paused-recovery", title: "Paused recovery", projectId: "project-local",
    createdAt: now, updatedAt: now, model: "MiniMaxAI/MiniMax-M2.7", branch: "main", approvalMode: "Approve for me",
    turns: [{ id: "turn-paused-recovery", threadId: "thread-paused-recovery", taskId: "task-paused-recovery",
      prompt: "Inspect the project", status: "paused", recoveryState: "paused", createdAt: now, items: [] }] };
  try {
    await openWorkspace(page, { threads: [thread], events: [{ type: "task.resumed", threadId: "thread-paused-recovery",
      turnId: "turn-paused-recovery", taskId: "task-paused-recovery", timestamp: now + 1, payload: {} }] });
    await page.getByTitle("Threads & History").click();
    await page.getByText("Paused recovery", { exact: true }).first().click();
    const resumeResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tasks/task-paused-recovery/resume");
    const eventStream = page.waitForResponse(response => new URL(response.url()).pathname === "/api/turns/turn-paused-recovery/events");
    await page.getByRole("button", { name: "Resume task" }).click();
    await Promise.all([resumeResponse, eventStream]);
    await page.getByText("This task is paused at a saved checkpoint.", { exact: true }).waitFor({ state: "detached" });
    assert.equal(await page.getByRole("button", { name: "Resume task" }).count(), 0);
  } finally { await page.close(); }
});
