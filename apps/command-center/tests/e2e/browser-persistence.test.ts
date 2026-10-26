import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { startCommandCenter } from "../../src/server.ts";
import { LocalDatabase } from "../../src/storage/db.ts";
import { ChatRepository } from "../../src/storage/chatRepository.ts";
import { createFakeComposition } from "../helpers/fakeComposition.ts";

function createConversationComposition(workspaceRoot: string) {
  return {
    ...createFakeComposition({ workspaceRoot }),
    async decideMaestroTurn() {
      return { type: "respond" as const, message: "Deterministic persistence response.", basis: "conversation" as const, evidenceRefs: [] };
    },
  };
}

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let browser: Browser;

before(async () => {
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
});

test("Browser E2E: Chat Transcript Persistence Across Refresh & Server Restart", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mediobot-browser-e2e-"));
  const workspaceRoot = path.join(tempDir, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, "index.ts"), "console.log('hello');\n");

  const dbPath = path.join(tempDir, "isolated-browser-test.db");

  // 1. Start backend server
  let backend = await startCommandCenter({
    workspaceRoot,
    databasePath: dbPath,
    composition: createConversationComposition(workspaceRoot),
    listen: true,
    port: 0,
    vite: false,
  });

  // 2. Start Vite server with proxy to backend
  const vite: ViteDevServer = await createViteServer({
    configFile: path.join(appRoot, "vite.config.ts"),
    root: appRoot,
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      hmr: false,
      proxy: {
        "/api": {
          target: backend.url!,
          changeOrigin: true,
          ws: true,
        },
      },
    },
    appType: "spa",
  });
  await vite.listen();
  const baseUrl = vite.resolvedUrls?.local?.[0] ?? "http://127.0.0.1:5173/";

  t.after(async () => {
    await vite.close();
    await backend.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const page: Page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  t.after(async () => {
    await page.close();
  });

  // Navigate to app
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("textarea", { timeout: 10000 });

  // =========================================================================
  // TEST 1: Send PERSISTENCE_SENTINEL_92841 -> Verify UI -> Verify SQLite -> Reload -> Verify UI
  // =========================================================================
  const composer = page.locator("textarea").first();
  await composer.fill("PERSISTENCE_SENTINEL_92841");
  await composer.press("Enter");

  // Wait for user message to appear in ThreadView
  const transcript = page.getByTestId("thread-scroll-root");
  const userMsgLocator = transcript.getByText("PERSISTENCE_SENTINEL_92841", { exact: true });
  await userMsgLocator.waitFor({ timeout: 10000 });

  // Get active threadId by inspecting SQLite directly
  const localDb = new LocalDatabase(dbPath);
  const chatRepo = new ChatRepository(localDb.raw);
  const deadline = Date.now() + 5000;
  let threadsBeforeReload = chatRepo.list();
  while (!threadsBeforeReload.some((thread) => JSON.stringify(thread.turns).includes("PERSISTENCE_SENTINEL_92841")) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    threadsBeforeReload = chatRepo.list();
  }
  assert.equal(threadsBeforeReload.length >= 1, true, "Thread must be created in SQLite");
  const threadA = threadsBeforeReload[0]!;
  const threadAId = threadA.id;

  // Direct SQLite proof: verify PERSISTENCE_SENTINEL_92841 exists in turns_json BEFORE reload
  const dbThreadBeforeReload = chatRepo.get(threadAId);
  assert.ok(dbThreadBeforeReload, "Thread must exist in SQLite before reload");
  assert.equal(
    JSON.stringify(dbThreadBeforeReload.turns).includes("PERSISTENCE_SENTINEL_92841"),
    true,
    "SQLite turns_json must contain PERSISTENCE_SENTINEL_92841 before reload"
  );

  // Reload the browser page
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("textarea", { timeout: 10000 });
  await page.locator('button[title="Threads & History"]').click();
  await page.getByText("PERSISTENCE_SENTINEL_92841", { exact: true }).first().click();

  // Assert user message PERSISTENCE_SENTINEL_92841 survived reload in ThreadView!
  await page.getByTestId("thread-scroll-root").getByText("PERSISTENCE_SENTINEL_92841", { exact: true }).waitFor({ timeout: 10000 });
  const countAfterReload = await page.getByTestId("thread-scroll-root").getByText("PERSISTENCE_SENTINEL_92841", { exact: true }).count();
  assert.equal(countAfterReload, 1, "Only ONE copy of PERSISTENCE_SENTINEL_92841 must exist in the UI");
  await page.locator('button[title="Threads & History"]').click();

  // =========================================================================
  // TEST 2: Two-Chat Memory Isolation (Chat A: ALPHA_SENTINEL, Chat B: BETA_SENTINEL)
  // =========================================================================
  // Create a second chat via [+] button in TopChrome
  const newChatBtn = page.locator('button[title="New thread (+)"]');
  await newChatBtn.click();
  await page.waitForTimeout(500);

  // Type BETA_SENTINEL in Thread B
  const composerB = page.locator("textarea").first();
  await composerB.fill("BETA_SENTINEL");
  await composerB.press("Enter");

  await page.getByTestId("thread-scroll-root").getByText("BETA_SENTINEL", { exact: true }).waitFor({ timeout: 10000 });

  // In Thread B, ALPHA_SENTINEL (or PERSISTENCE_SENTINEL_92841) must NOT be present
  assert.equal(await page.getByTestId("thread-scroll-root").getByText("PERSISTENCE_SENTINEL_92841", { exact: true }).count(), 0, "Thread B must not contain Thread A content");

  // Switch back to Thread A using persisted history (thread tabs need not use message text as their title).
  await page.locator('button[title="Threads & History"]').click();
  await page.getByText("PERSISTENCE_SENTINEL_92841", { exact: true }).first().click();
  await page.locator('button[title="Threads & History"]').click();

  // In Thread A, BETA_SENTINEL must NOT be present
  await page.getByTestId("thread-scroll-root").getByText("PERSISTENCE_SENTINEL_92841", { exact: true }).waitFor({ timeout: 5000 });
  assert.equal(await page.getByTestId("thread-scroll-root").getByText("BETA_SENTINEL", { exact: true }).count(), 0, "Thread A must not contain Thread B content");

  // Reload page to verify both tabs and their independent conversation transcripts persist
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("textarea", { timeout: 10000 });
  await page.locator('button[title="Threads & History"]').click();
  await page.getByText("PERSISTENCE_SENTINEL_92841", { exact: true }).first().click();

  // Active tab restores Thread A
  await page.getByTestId("thread-scroll-root").getByText("PERSISTENCE_SENTINEL_92841", { exact: true }).waitFor({ timeout: 10000 });
  assert.equal(await page.getByTestId("thread-scroll-root").getByText("BETA_SENTINEL", { exact: true }).count(), 0, "Thread A after reload must still be isolated");

  // Switch to Thread B tab
  await page.getByText("BETA_SENTINEL", { exact: true }).first().click({ force: true });
  await page.locator('button[title="Threads & History"]').click();
  await page.getByTestId("thread-scroll-root").getByText("BETA_SENTINEL", { exact: true }).waitFor({ timeout: 5000 });
  assert.equal(await page.getByTestId("thread-scroll-root").getByText("PERSISTENCE_SENTINEL_92841", { exact: true }).count(), 0, "Thread B after reload must still be isolated");

  // =========================================================================
  // TEST 3: Close Chat Tab and Reopen from History Drawer
  // =========================================================================
  // Close Thread B tab using its close button
  await page.getByTitle("Close tab").last().click();
  await page.waitForTimeout(300);

  // Open Threads & History drawer
  const historyToggle = page.locator('button[title="Threads & History"]');
  await historyToggle.click();
  await page.waitForTimeout(300);

  // Thread B still exists in History drawer
  const historyDrawer = page.locator("aside").filter({ has: page.getByText("New chat", { exact: true }) });
  const historyItemB = historyDrawer.getByText("BETA_SENTINEL", { exact: true });
  await historyItemB.waitFor({ timeout: 5000 });

  // Click historyItemB to reopen
  await historyItemB.click();
  await page.getByTestId("thread-scroll-root").getByText("BETA_SENTINEL", { exact: true }).waitFor({ timeout: 5000 });

  // =========================================================================
  // TEST 4: Server Restart Test (Kill backend, restart pointing to SAME DB, reload)
  // =========================================================================
  await backend.close();

  // Start new server process on same DB
  const restartedBackend = await startCommandCenter({
    workspaceRoot,
    databasePath: dbPath,
    composition: createConversationComposition(workspaceRoot),
    listen: true,
    port: 0,
    vite: false,
  });

  // Update proxy or keep same port
  // Since Vite was proxying to backend.url, let's close Vite and reopen pointing to restartedBackend
  await vite.close();
  const restartedVite = await createViteServer({
    configFile: path.join(appRoot, "vite.config.ts"),
    root: appRoot,
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      hmr: false,
      proxy: {
        "/api": {
          target: restartedBackend.url!,
          changeOrigin: true,
          ws: true,
        },
      },
    },
    appType: "spa",
  });
  await restartedVite.listen();
  const restartedBaseUrl = restartedVite.resolvedUrls?.local?.[0] ?? "http://127.0.0.1:5173/";

  t.after(async () => {
    await restartedVite.close();
    await restartedBackend.close();
  });

  await page.goto(restartedBaseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("textarea", { timeout: 10000 });

  // Conversation transcript survives server restart!
  await page.getByTestId("thread-scroll-root").getByText("PERSISTENCE_SENTINEL_92841", { exact: true }).waitFor({ timeout: 10000 });
  assert.equal(
    await page.getByTestId("thread-scroll-root").getByText("PERSISTENCE_SENTINEL_92841", { exact: true }).isVisible(),
    true,
    "PERSISTENCE_SENTINEL_92841 must survive server restart and render in ThreadView"
  );

  localDb.close();
});
