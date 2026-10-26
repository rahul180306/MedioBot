import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { TaskId } from "@mediobot-v2/domain";
import { Crawl4AiRuntime } from "../src/crawl4ai-runtime.ts";
import { ResourceGovernor } from "../src/resource-governor.ts";

describe("P1 Cancellation Settlement & Lease Retention", () => {
  it("fast cancellation honestly acknowledges settlement and releases lease", async () => {
    let slowTimer: NodeJS.Timeout | undefined;
    const server = http.createServer((req, res) => {
      slowTimer = setTimeout(() => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Delayed</h1>");
      }, 3000);
      req.on("close", () => {
        if (slowTimer) clearTimeout(slowTimer);
      });
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const governor = new ResourceGovernor();
    const runtime = new Crawl4AiRuntime({
      pythonExecutable: "/Users/rahulkarthikt/Documents/mediobot/mediobot-v2/.venv/bin/python3",
      defaultTimeoutMs: 10000,
      resourceGovernor: governor,
    });

    await runtime.ping();

    const controller = new AbortController();

    // Start crawl with renderJs to acquire browser lease
    const crawlPromise = runtime.crawl(
      {
        url: `${baseUrl}/slow`,
        taskId: "task-c1" as TaskId,
        renderJs: true,
        allowedDestinations: [baseUrl],
      },
      controller.signal
    );

    // Abort while slow request is in-flight
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();

    try {
      await crawlPromise;
      assert.fail("Expected cancellation rejection");
    } catch (err: any) {
      assert.match(err.message, /cancel|abort/i);
    }

    // Give worker time to complete settlement
    await new Promise((r) => setTimeout(r, 200));

    // Browser session lease should be cleanly released upon confirmed settlement
    assert.equal(
      governor.activeCategoryCount("browser-session"),
      0,
      "Lease must be released on settled cancellation"
    );

    await runtime.shutdown();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("unsettled or timeout cancellation retains lease in governor until process exit", async () => {
    const governor = new ResourceGovernor();

    const runtime = new Crawl4AiRuntime({
      pythonExecutable: "/Users/rahulkarthikt/Documents/mediobot/mediobot-v2/.venv/bin/python3",
      defaultTimeoutMs: 10000,
      resourceGovernor: governor,
    });

    await runtime.ping();

    // Mock sendCancelAndAwaitSettlement to simulate an unsettled/timeout cancellation
    (runtime as any).sendCancelAndAwaitSettlement = async () => {
      return { settled: false, state: "cancellation_timeout" };
    };

    const controller = new AbortController();
    const crawlPromise = runtime.crawl(
      {
        url: "raw:<html><body>Simulated Timeout</body></html>",
        taskId: "task-unsettled" as TaskId,
        renderJs: true,
      },
      controller.signal
    );

    await new Promise((r) => setTimeout(r, 5));
    controller.abort();

    try {
      await crawlPromise;
      assert.fail("Expected abort rejection");
    } catch (err: any) {
      assert.match(err.message, /cancel|abort/i);
      assert.equal(err.cancelSettled, false);
      assert.equal(err.cancelState, "cancellation_timeout");
    }

    // Since cancellation was unsettled, the lease MUST be retained!
    assert.equal(
      governor.activeCategoryCount("browser-session"),
      1,
      "Lease must be retained when cancellation has not settled"
    );
    assert.equal(runtime.retainedLeasesCount, 1);

    // Upon shutdown (or supervised termination), retained leases are released
    await runtime.shutdown();
    assert.equal(governor.activeCategoryCount("browser-session"), 0);
  });

  it("protocol reader remains responsive for concurrent siblings while cancellation runs", async () => {
    let slowTimer: NodeJS.Timeout | undefined;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (url.pathname === "/slow") {
        slowTimer = setTimeout(() => {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<h1>Slow</h1>");
        }, 5000);
        req.on("close", () => {
          if (slowTimer) clearTimeout(slowTimer);
        });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><head><title>Sibling</title></head><body>Sibling content</body></html>");
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const governor = new ResourceGovernor();
    const runtime = new Crawl4AiRuntime({
      pythonExecutable: "/Users/rahulkarthikt/Documents/mediobot/mediobot-v2/.venv/bin/python3",
      defaultTimeoutMs: 15000,
      resourceGovernor: governor,
    });

    await runtime.ping();

    // 1. Launch slow task with abort signal
    const controller = new AbortController();
    const cancelledCrawl = runtime.crawl(
      {
        url: `${baseUrl}/slow`,
        taskId: "task-cancel-sibling" as TaskId,
        renderJs: false,
        preferHttp: true,
        allowedDestinations: [baseUrl],
      },
      controller.signal
    );

    // Attach catch handler immediately
    const caughtCancelledCrawl = cancelledCrawl.catch((err) => err);

    await new Promise((r) => setTimeout(r, 50));
    controller.abort();

    // 2. Immediately launch a sibling crawl
    const siblingCrawl = await runtime.crawl({
      url: `${baseUrl}/sibling`,
      taskId: "task-active-sibling" as TaskId,
      renderJs: false,
      preferHttp: true,
      allowedDestinations: [baseUrl],
    });

    // Sibling must succeed immediately without being blocked by cancellation handling
    assert.equal(siblingCrawl.success, true);
    assert.equal(siblingCrawl.title, "Sibling");

    const err = await caughtCancelledCrawl;
    assert.match(err.message, /cancel|abort/i);

    await runtime.shutdown();
    await new Promise<void>((r) => server.close(() => r()));
  });
});
