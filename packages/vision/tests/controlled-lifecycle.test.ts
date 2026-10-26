import assert from "node:assert/strict";
import test from "node:test";
import { PlaywrightBrowserRuntime } from "../src/browser-runtime.ts";
import { AutonomousBrowserTask } from "../src/index.ts";
import { createWorld, type ResourceId, type WorkerId, type TaskId } from "@mediobot-v2/domain";
import type { Page, CDPSession } from "playwright";

interface WindowGeometry {
  innerWidth: number;
  innerHeight: number;
  outerWidth: number;
  outerHeight: number;
  screenX: number;
  screenY: number;
}

async function getGeometry(page: Page): Promise<WindowGeometry> {
  return page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    screenX: window.screenX,
    screenY: window.screenY,
  }));
}

test("CONTROLLED STEP 3: Sequential headed lifecycle maintains single browser process and stable window", {
  skip: process.env.MEDIOBOT_ALLOW_HEADED_TESTS !== "1" ? "set MEDIOBOT_ALLOW_HEADED_TESTS=1 to run graphical browser tests" : false,
}, async () => {
  const runtime = new PlaywrightBrowserRuntime({
    headless: false,
  });

  let browserPid: number | undefined;
  let geomA: WindowGeometry | undefined;
  let geomB: WindowGeometry | undefined;
  let cdpBoundsA: any = undefined;
  let cdpBoundsB: any = undefined;

  assert.equal(runtime.launchCount, 0, "No browser launched before first acquisition");

  // --- Task A ---
  {
    const sessionA = await runtime.acquireSession({
      resourceId: "resource-seq-A" as ResourceId,
      workerId: "worker-A" as WorkerId,
      taskId: "task-A" as TaskId,
    });

    assert.equal(runtime.launchCount, 1, "Chromium launched exactly once for Task A");
    assert.equal(runtime.closeCount, 0, "Browser has not been closed");
    assert.equal(runtime.activeSessionCount, 1, "Exactly one active session");

    const browser = runtime.underlyingBrowser!;
    assert.ok(browser.isConnected(), "Underlying browser is connected");
    assert.equal(browser.contexts().length, 1, "Exactly one context in browser");

    const pageA = sessionA.page;
    await pageA.setContent("<html><body><button id='btnA'>Action A</button></body></html>");

    // Measure geometry
    geomA = await getGeometry(pageA);
    browserPid = (browser as any)._process?.pid ?? (browser as any).process?.()?.pid;

    try {
      const cdp = await sessionA.context.newCDPSession(pageA);
      const targetInfo = await cdp.send("Browser.getWindowForTarget");
      cdpBoundsA = await cdp.send("Browser.getWindowBounds", { windowId: targetInfo.windowId });
    } catch {
      // CDP Browser domain might not be supported in all headed setups
    }

    // Perform an observation and action
    const obs = await sessionA.observe(new AbortController().signal);
    assert.equal(obs.elements.length, 1);
    assert.equal(obs.elements[0]?.name, "Action A");

    // Release session A
    await runtime.releaseSession("resource-seq-A" as ResourceId);

    assert.equal(runtime.activeSessionCount, 0, "Session A is released");
    assert.equal(browser.contexts().length, 0, "Context A closed; zero contexts leaked");
    assert.ok(browser.isConnected(), "Browser process remains alive after Task A release");
    assert.equal(runtime.launchCount, 1, "Launch count remains 1");
    assert.equal(runtime.closeCount, 0, "Browser close count remains 0");
  }

  // --- Task B ---
  {
    const sessionB = await runtime.acquireSession({
      resourceId: "resource-seq-B" as ResourceId,
      workerId: "worker-B" as WorkerId,
      taskId: "task-B" as TaskId,
    });

    assert.equal(runtime.launchCount, 1, "No new Chromium launch for Task B; reused persistent browser");
    assert.equal(runtime.closeCount, 0, "No browser.close between tasks");
    assert.equal(runtime.activeSessionCount, 1, "Exactly one active session for Task B");

    const browser = runtime.underlyingBrowser!;
    assert.ok(browser.isConnected(), "Browser remains connected");
    assert.equal(browser.contexts().length, 1, "Exactly one context in browser for Task B");

    const currentPid = (browser as any)._process?.pid ?? (browser as any).process?.()?.pid;
    if (browserPid && currentPid) {
      assert.equal(currentPid, browserPid, "Browser PID is identical across tasks");
    }

    const pageB = sessionB.page;
    await pageB.setContent("<html><body><button id='btnB'>Action B</button></body></html>");

    geomB = await getGeometry(pageB);

    try {
      const cdp = await sessionB.context.newCDPSession(pageB);
      const targetInfo = await cdp.send("Browser.getWindowForTarget");
      cdpBoundsB = await cdp.send("Browser.getWindowBounds", { windowId: targetInfo.windowId });
    } catch {}

    const obs = await sessionB.observe(new AbortController().signal);
    assert.equal(obs.elements.length, 1);
    assert.equal(obs.elements[0]?.name, "Action B");

    // Release session B
    await sessionB.close();

    assert.equal(runtime.activeSessionCount, 0, "Session B released");
    assert.equal(browser.contexts().length, 0, "Context B closed; zero contexts leaked");
    assert.ok(browser.isConnected(), "Browser remains alive after Task B release");
    assert.equal(runtime.launchCount, 1, "Launch count is still 1");
    assert.equal(runtime.closeCount, 0, "Close count is still 0");
  }

  // --- Final Runtime Shutdown ---
  await runtime.shutdown();
  assert.equal(runtime.launchCount, 1, "Final launch count is 1");
  assert.equal(runtime.closeCount, 1, "Final close count is 1");
  assert.equal(runtime.isRunning, false, "Runtime is not running after shutdown");

  // Output geometry measurements for audit
  console.log("GEOMETRY TELEMETRY:", JSON.stringify({
    browserPid,
    taskA: { geom: geomA, cdpBounds: cdpBoundsA },
    taskB: { geom: geomB, cdpBounds: cdpBoundsB },
    viewportMatch: geomA?.innerWidth === geomB?.innerWidth && geomA?.innerHeight === geomB?.innerHeight,
    outerWindowMatch: geomA?.outerWidth === geomB?.outerWidth && geomA?.outerHeight === geomB?.outerHeight,
  }, null, 2));

  assert.equal(geomA?.innerWidth, 1280, "Task A viewport width is 1280");
  assert.equal(geomA?.innerHeight, 720, "Task A viewport height is 720");
  assert.equal(geomB?.innerWidth, 1280, "Task B viewport width is 1280");
  assert.equal(geomB?.innerHeight, 720, "Task B viewport height is 720");
});

test("CONTROLLED STEP 4: Bounded concurrent isolation with two sessions in one browser", async () => {
  const runtime = new PlaywrightBrowserRuntime({
    headless: false,
  });

  const sessionA = await runtime.acquireSession({
    resourceId: "concurrent-res-A" as ResourceId,
    workerId: "worker-A" as WorkerId,
    taskId: "task-A" as TaskId,
  });

  const sessionB = await runtime.acquireSession({
    resourceId: "concurrent-res-B" as ResourceId,
    workerId: "worker-B" as WorkerId,
    taskId: "task-B" as TaskId,
  });

  assert.equal(runtime.launchCount, 1, "Exactly one Chromium launch for both concurrent sessions");
  assert.equal(runtime.activeSessionCount, 2, "Two active sessions tracked");
  const browser = runtime.underlyingBrowser!;
  assert.equal(browser.contexts().length, 2, "Two isolated BrowserContexts in the shared browser");

  // Different fixture state
  await sessionA.page.setContent(
    "<html><body><button id='btnA'>Button A</button><span id='countA'>0</span>" +
    "<script>document.getElementById('btnA').onclick = () => { document.getElementById('countA').textContent = 'clickedA'; };</script></body></html>"
  );

  await sessionB.page.setContent(
    "<html><body><button id='btnB'>Button B</button><span id='countB'>0</span>" +
    "<script>document.getElementById('btnB').onclick = () => { document.getElementById('countB').textContent = 'clickedB'; };</script></body></html>"
  );

  // Independent observations
  const obsA = await sessionA.observe(new AbortController().signal);
  const obsB = await sessionB.observe(new AbortController().signal);

  assert.equal(obsA.elements.length, 1);
  assert.equal(obsA.elements[0]?.name, "Button A");
  assert.equal(obsB.elements.length, 1);
  assert.equal(obsB.elements[0]?.name, "Button B");

  // Action in A does not affect B
  const targetA = obsA.elements[0]!.id;
  await sessionA.execute({ type: "click", targetId: targetA, observationRevision: obsA.revision }, obsA, new AbortController().signal);

  const textA = await sessionA.page.locator("#countA").innerText();
  const textB = await sessionB.page.locator("#countB").innerText();
  assert.equal(textA, "clickedA", "Session A state was mutated by action");
  assert.equal(textB, "0", "Session B state was completely untouched by action in Session A");

  // Closing A does not terminate B
  await sessionA.close();
  assert.equal(runtime.activeSessionCount, 1, "One active session remains after A closed");
  assert.equal(browser.contexts().length, 1, "One BrowserContext remains in browser");
  assert.ok(!sessionB.page.isClosed(), "Session B page is alive and functional");

  // Action in B works after A was closed
  const targetB = obsB.elements[0]!.id;
  await sessionB.execute({ type: "click", targetId: targetB, observationRevision: obsB.revision }, obsB, new AbortController().signal);
  const textBAfter = await sessionB.page.locator("#countB").innerText();
  assert.equal(textBAfter, "clickedB", "Session B executed successfully after Session A closed");

  // Cancellation isolation: canceling an operation in B does not terminate browser
  const abortCtrl = new AbortController();
  abortCtrl.abort();
  const cancelResult = await sessionB.execute(
    { type: "click", targetId: targetB, observationRevision: obsB.revision },
    obsB,
    abortCtrl.signal
  );
  assert.equal(cancelResult.state, "cancelled", "Cancelled execution returned cancelled state");
  assert.ok(browser.isConnected(), "Shared browser process remains alive after cancellation");

  // Release session B
  await sessionB.close();
  assert.equal(runtime.activeSessionCount, 0, "Zero active sessions remain");
  assert.equal(browser.contexts().length, 0, "Zero contexts leaked");
  assert.ok(browser.isConnected(), "Shared browser process remains alive after both sessions closed");

  // Final runtime shutdown
  await runtime.shutdown();
  assert.equal(runtime.launchCount, 1, "Launch count is 1");
  assert.equal(runtime.closeCount, 1, "Close count is 1");
  assert.ok(!browser.isConnected(), "Browser closed on runtime shutdown");
});

