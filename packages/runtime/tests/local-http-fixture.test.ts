import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { TaskId } from "@mediobot-v2/domain";
import { Crawl4AiRuntime } from "../src/crawl4ai-runtime.ts";

test("Crawl4AiRuntime: real HTTP extraction, redirect following, SSRF redirect blocking, and cancellation with local fixture", async () => {
  // Create a controlled local HTTP server
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname === "/article") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html>
<head><title>Controlled Local Article</title></head>
<body>
  <h1>Controlled Local Article</h1>
  <p>Real extracted paragraph over local HTTP fixture.</p>
  <a href="/target">Read More</a>
</body>
</html>`);
      return;
    }

    if (url.pathname === "/redirect-safe") {
      res.writeHead(302, { Location: "/article" });
      res.end();
      return;
    }

    if (url.pathname === "/redirect-metadata") {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
      return;
    }

    if (url.pathname === "/slow") {
      // Intentionally delay to test cancellation
      const timer = setTimeout(() => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Slow Content</h1>");
      }, 5000);
      req.on("close", () => clearTimeout(timer));
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const runtime = new Crawl4AiRuntime();

  try {
    // 1. Real HTTP extraction over local network
    const articleRes = await runtime.crawl({
      url: `${baseUrl}/article`,
      taskId: "task-fixture-1" as TaskId,
      cacheMode: "bypass",
      allowedDestinations: [baseUrl],
    });

    assert.equal(articleRes.success, true, "Real HTTP crawl must succeed");
    assert.ok(articleRes.markdown.includes("Controlled Local Article"), "Extracted markdown must contain page heading");
    assert.ok(articleRes.markdown.includes("Real extracted paragraph over local HTTP fixture."), "Extracted markdown must contain body text");
    assert.equal(articleRes.title, "Controlled Local Article");
    assert.ok(articleRes.provenance);
    assert.ok(articleRes.provenance.contentHash.length > 0);

    // 2. Safe redirect following
    const redirectRes = await runtime.crawl({
      url: `${baseUrl}/redirect-safe`,
      taskId: "task-fixture-2" as TaskId,
      cacheMode: "bypass",
      allowedDestinations: [baseUrl],
    });

    assert.equal(redirectRes.success, true, "Safe redirect must succeed");
    assert.ok(redirectRes.markdown.includes("Controlled Local Article"), "Redirect target content must be extracted");

    // 3. Malicious redirect to private metadata service must be blocked
    const metadataRes = await runtime.crawl({
      url: `${baseUrl}/redirect-metadata`,
      taskId: "task-fixture-3" as TaskId,
      cacheMode: "bypass",
      allowedDestinations: [baseUrl],
    });

    assert.equal(metadataRes.success, false, "Redirect to metadata IP must be blocked");
    assert.match(
      metadataRes.errorMessage ?? "",
      /SSRF blocked|browser session was not admitted|failed/i,
      "Blocked redirect must report security failure",
    );

    // 4. In-flight request cancellation without terminating shared worker
    const controller = new AbortController();
    const slowPromise = runtime.crawl(
      {
        url: `${baseUrl}/slow`,
        taskId: "task-fixture-4" as TaskId,
        cacheMode: "bypass",
      allowedDestinations: [baseUrl],
      },
      controller.signal,
    );

    // Abort after 50ms while request is in-flight
    setTimeout(() => controller.abort(), 50);

    await assert.rejects(slowPromise, /aborted|cancelled/i);

    // Verify worker is still healthy after cancellation by performing another crawl
    const postCancelRes = await runtime.crawl({
      url: `${baseUrl}/article`,
      taskId: "task-fixture-5" as TaskId,
      cacheMode: "bypass",
      allowedDestinations: [baseUrl],
    });
    assert.equal(postCancelRes.success, true, "Worker must remain healthy and process subsequent requests after cancellation");
  } finally {
    await runtime.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
