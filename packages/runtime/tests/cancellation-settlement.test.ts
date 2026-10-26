import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import type { TaskId } from "@mediobot-v2/domain";
import { Crawl4AiRuntime } from "../src/crawl4ai-runtime.ts";
import { ResourceGovernor } from "../src/index.ts";

test("Crawl4AI cancellation settlement: slow operation cancels and settles before lease release, unaffected sibling completes", async (t) => {
  let slowConnections = 0;
  let fastConnections = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/slow") {
      slowConnections++;
      const timer = setTimeout(() => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body>Slow Response</body></html>");
      }, 3000);
      req.on("close", () => {
        clearTimeout(timer);
      });
      return;
    }

    if (req.url === "/fast") {
      fastConnections++;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>Fast Sibling Response</body></html>");
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const governor = new ResourceGovernor();
  const runtime = new Crawl4AiRuntime({ resourceGovernor: governor, defaultTimeoutMs: 10000 });
  t.after(async () => {
    await runtime.shutdown();
  });

  let slowLeaseReleased = false;

  const originalRelease = governor.releaseLease.bind(governor);
  governor.releaseLease = (leaseId) => {
    slowLeaseReleased = true;
    return originalRelease(leaseId);
  };

  const controller = new AbortController();

  // Start slow crawl
  const slowPromise = runtime.crawl(
    {
      url: `${baseUrl}/slow`,
      taskId: "task-slow" as TaskId,
      renderJs: true,
      allowedDestinations: [baseUrl],
    },
    controller.signal
  );

  // Start concurrent sibling crawl
  const fastPromise = runtime.crawl({
    url: `${baseUrl}/fast`,
    taskId: "task-fast" as TaskId,
    renderJs: false,
    allowedDestinations: [baseUrl],
  });

  // Wait a short delay for both requests to reach Python worker
  await new Promise((r) => setTimeout(r, 100));

  // Verify lease was acquired for browser request
  assert.ok(governor.activeCategoryCount("browser-session") >= 1, "Browser session lease must be active for slow request");

  // Now abort slow request
  assert.equal(slowLeaseReleased, false, "Lease must not be released before abort");
  controller.abort();

  // Await slow request settlement
  await assert.rejects(slowPromise, (err: Error) => {
    assert.match(err.message, /aborted|cancelled/i);
    return true;
  });

  // Verify the lease was released after settlement
  assert.equal(slowLeaseReleased, true, "Lease must be released after cancellation settlement");

  // Verify unaffected sibling finishes successfully with valid content
  const fastResult = await fastPromise;
  assert.ok(fastResult, "Fast sibling must resolve");
  assert.match(fastResult.markdown, /Fast Sibling Response/);
  assert.equal(fastConnections, 1, "Fast sibling must have received exactly one connection");

  // Verify governor has 0 active leases
  assert.equal(governor.activeLeasesCount, 0, "All leases must be released");
});

test("Crawl4AI cache key distinguishes waitForSelector, workspaceId, and allowedDestinations", async () => {
  const runtime = new Crawl4AiRuntime();
  try {
    const req1 = {
      url: "raw:<html><body><h1>Title 1</h1></body></html>",
      taskId: "task-1" as TaskId,
      waitForSelector: "#selector-a",
      workspaceId: "ws-1",
    };
    const req2 = {
      url: "raw:<html><body><h1>Title 1</h1></body></html>",
      taskId: "task-1" as TaskId,
      waitForSelector: "#selector-b",
      workspaceId: "ws-1",
    };
    const req3 = {
      url: "raw:<html><body><h1>Title 1</h1></body></html>",
      taskId: "task-1" as TaskId,
      waitForSelector: "#selector-a",
      workspaceId: "ws-2",
    };

    const res1 = await runtime.crawl(req1);
    assert.equal(res1.cached, false);

    // Second crawl of req1 SHOULD hit cache!
    const res1Cached = await runtime.crawl(req1);
    assert.equal(res1Cached.cached, true, "Same request must hit cache");

    // Crawl req2 (different waitForSelector) -> must NOT hit cache
    const res2 = await runtime.crawl(req2);
    assert.equal(res2.cached, false, "Different waitForSelector must produce a cache miss");

    // Crawl req3 (different workspaceId) -> must NOT hit cache
    const res3 = await runtime.crawl(req3);
    assert.equal(res3.cached, false, "Different workspaceId must produce a cache miss");
  } finally {
    await runtime.shutdown();
  }
});
