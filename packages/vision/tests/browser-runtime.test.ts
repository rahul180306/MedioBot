import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PlaywrightBrowserRuntime } from "../src/browser-runtime.ts";
import type { ResourceId, TaskId } from "@mediobot-v2/domain";
import type { Browser, BrowserContext, Page } from "playwright";

function createMockBrowser() {
  const emitter = new EventEmitter();
  let connected = true;
  let closeCalls = 0;
  let contextCalls = 0;

  const mockPage = {
    on: () => {},
    close: async () => {},
    isClosed: () => false,
  } as unknown as Page;

  const mockContext = {
    newPage: async () => {
      return mockPage;
    },
    close: async () => {},
  } as unknown as BrowserContext;

  const mockBrowser = {
    on: (event: string, listener: (...args: any[]) => void) => {
      emitter.on(event, listener);
      return mockBrowser;
    },
    isConnected: () => connected,
    newContext: async () => {
      contextCalls++;
      return mockContext;
    },
    close: async () => {
      closeCalls++;
      connected = false;
      emitter.emit("disconnected");
    },
    emitDisconnect: () => {
      connected = false;
      emitter.emit("disconnected");
    },
    get closeCalls() { return closeCalls; },
    get contextCalls() { return contextCalls; },
  } as unknown as Browser & { emitDisconnect: () => void; closeCalls: number; contextCalls: number };

  return mockBrowser;
}

test("BrowserRuntime launches browser once across multiple session acquisitions", async () => {
  let launchCalls = 0;
  const mockBrowser = createMockBrowser();
  const runtime = new PlaywrightBrowserRuntime({
    browserLauncher: async () => {
      launchCalls++;
      return mockBrowser;
    },
  });

  assert.equal(runtime.launchCount, 0);
  assert.equal(runtime.isRunning, false);
  assert.equal(runtime.isHealthy(), true);

  const session1 = await runtime.acquireSession({ resourceId: "r1" as ResourceId, taskId: "t1" as TaskId });
  assert.equal(runtime.launchCount, 1);
  assert.equal(runtime.activeSessionCount, 1);
  assert.equal(runtime.isRunning, true);

  const session2 = await runtime.acquireSession({ resourceId: "r2" as ResourceId, taskId: "t2" as TaskId });
  assert.equal(runtime.launchCount, 1);
  assert.equal(runtime.activeSessionCount, 2);

  // Releasing session1 leaves browser alive and session2 intact
  await runtime.releaseSession("r1" as ResourceId);
  assert.equal(runtime.activeSessionCount, 1);
  assert.equal(runtime.isRunning, true);
  assert.equal(mockBrowser.closeCalls, 0);

  // Shutting down closes the browser process
  await runtime.shutdown();
  assert.equal(runtime.closeCount, 1);
  assert.equal(runtime.activeSessionCount, 0);
  assert.equal(runtime.isRunning, false);
  assert.equal(mockBrowser.closeCalls, 1);
});

test("BrowserRuntime rejects duplicate session acquisition for the same resource", async () => {
  const mockBrowser = createMockBrowser();
  const runtime = new PlaywrightBrowserRuntime({
    browserLauncher: async () => mockBrowser,
  });

  await runtime.acquireSession({ resourceId: "r-duplicate" as ResourceId });
  await assert.rejects(
    () => runtime.acquireSession({ resourceId: "r-duplicate" as ResourceId }),
    /already active for resource/
  );
  await runtime.shutdown();
});

test("BrowserRuntime handles truthful disconnection and recovers on next acquisition", async () => {
  let launchCalls = 0;
  let currentBrowser = createMockBrowser();
  const runtime = new PlaywrightBrowserRuntime({
    browserLauncher: async () => {
      launchCalls++;
      currentBrowser = createMockBrowser();
      return currentBrowser;
    },
  });

  await runtime.acquireSession({ resourceId: "r-disc-1" as ResourceId });
  assert.equal(runtime.launchCount, 1);
  assert.equal(runtime.activeSessionCount, 1);

  // Simulate unexpected disconnection (e.g. process crash or user killed window)
  currentBrowser.emitDisconnect();
  assert.equal(runtime.activeSessionCount, 0);
  assert.equal(runtime.isHealthy(), true); // Will recover on next launch

  // Next acquisition truthfully launches a new browser
  await runtime.acquireSession({ resourceId: "r-disc-2" as ResourceId });
  assert.equal(runtime.launchCount, 2);
  assert.equal(runtime.activeSessionCount, 1);

  await runtime.shutdown();
});

test("BrowserRuntime rejects acquisition after shutdown", async () => {
  const mockBrowser = createMockBrowser();
  const runtime = new PlaywrightBrowserRuntime({
    browserLauncher: async () => mockBrowser,
  });

  await runtime.shutdown();
  await assert.rejects(
    () => runtime.acquireSession({ resourceId: "r-after-shutdown" as ResourceId }),
    /shut down/
  );
});
