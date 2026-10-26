import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Crawl4AiRuntime } from "../src/crawl4ai-runtime.ts";
import type { TaskId } from "@mediobot-v2/contracts";

test("SSRF Security: Browser subresources targeting unauthorized local destinations receive zero connections", async () => {
  let forbiddenHits = 0;

  // Forbidden server (simulating internal service on another port)
  const forbiddenServer = http.createServer((req, res) => {
    forbiddenHits++;
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end();
  });
  await new Promise<void>((resolve) => forbiddenServer.listen(0, "127.0.0.1", () => resolve()));
  const forbiddenPort = (forbiddenServer.address() as AddressInfo).port;

  // Allowed server serving page with subresource pointing to forbidden server
  const allowedServer = http.createServer((req, res) => {
    if (req.url === "/page") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`
        <!DOCTYPE html>
        <html>
          <head><title>Test Page</title></head>
          <body>
            <h1>Allowed Content Header</h1>
            <p>This is safe allowed text.</p>
            <img src="http://127.0.0.1:${forbiddenPort}/secret-image.png" alt="probe" />
            <iframe src="http://169.254.169.254/latest/meta-data"></iframe>
          </body>
        </html>
      `);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => allowedServer.listen(0, "127.0.0.1", () => resolve()));
  const allowedPort = (allowedServer.address() as AddressInfo).port;
  const allowedBaseUrl = `http://127.0.0.1:${allowedPort}`;

  const runtime = new Crawl4AiRuntime();
  try {
    const result = await runtime.crawl({
      url: `${allowedBaseUrl}/page`,
      taskId: "subresource-test" as TaskId,
      renderJs: true,
      cacheMode: "bypass",
      allowedDestinations: [allowedBaseUrl],
    });

    assert.equal(result.success, true, "Allowed main frame crawl must succeed");
    assert.ok(result.markdown.includes("Allowed Content Header"), "Allowed content was parsed");
    assert.equal(forbiddenHits, 0, "Forbidden destination must receive ZERO connections from subresources");
  } finally {
    await runtime.shutdown();
    await new Promise<void>((resolve) => forbiddenServer.close(() => resolve()));
    await new Promise<void>((resolve) => allowedServer.close(() => resolve()));
  }
});
