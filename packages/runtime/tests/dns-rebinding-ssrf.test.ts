import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Crawl4AiRuntime, assertSafeWebDestination } from "../src/crawl4ai-runtime.ts";

describe("P0 SSRF DNS Pinning, Rebinding Rejection & Context Isolation", () => {
  let forbiddenServer: http.Server;
  let forbiddenPort: number;
  let connectionCount = 0;

  before(async () => {
    // Spin up a forbidden local HTTP server to verify ZERO connections occur
    forbiddenServer = http.createServer((req, res) => {
      connectionCount++;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>Forbidden Server Response</body></html>");
    });

    await new Promise<void>((resolve) => {
      forbiddenServer.listen(0, "127.0.0.1", () => {
        const addr = forbiddenServer.address() as { port: number };
        forbiddenPort = addr.port;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => forbiddenServer.close(() => resolve()));
  });

  it("assertSafeWebDestination rejects loopback/private destinations before network access", async () => {
    // Loopback IPv4
    await assert.rejects(
      () => assertSafeWebDestination(`http://127.0.0.1:${forbiddenPort}/`),
      /forbidden/i
    );
    assert.equal(connectionCount, 0, "Zero connections must reach forbidden server");

    // Loopback IPv6
    await assert.rejects(
      () => assertSafeWebDestination(`http://[::1]:${forbiddenPort}/`),
      /forbidden/i
    );
    assert.equal(connectionCount, 0, "Zero connections must reach forbidden server");

    // Cloud metadata
    await assert.rejects(
      () => assertSafeWebDestination("http://169.254.169.254/latest/meta-data/"),
      /metadata/i
    );

    // Private address spaces
    await assert.rejects(() => assertSafeWebDestination("http://10.0.0.1/"), /forbidden/i);
    await assert.rejects(() => assertSafeWebDestination("http://172.16.0.1/"), /forbidden/i);
    await assert.rejects(() => assertSafeWebDestination("http://192.168.1.1/"), /forbidden/i);
  });

  it("rejects DNS resolution failure fail-closed", async () => {
    await assert.rejects(
      () => assertSafeWebDestination("http://non-existent-domain-xyz-404-never-resolves.com/"),
      /DNS resolution/i
    );
  });

  it("Crawl4AiRuntime preflight rejects connection to loopback targets with ZERO socket connections", async () => {
    const runtime = new Crawl4AiRuntime({
      pythonExecutable: "/Users/rahulkarthikt/Documents/mediobot/mediobot-v2/.venv/bin/python3",
      defaultTimeoutMs: 10000,
    });

    const initialCount = connectionCount;

    // Attempt crawl against forbidden server without authorization
    await assert.rejects(
      () => runtime.crawl({
        url: `http://127.0.0.1:${forbiddenPort}/forbidden-path`,
        cacheMode: "bypass",
        allowBrowser: false,
        preferHttp: true,
      }),
      /forbidden/i
    );

    assert.equal(connectionCount, initialCount, "Forbidden target must record ZERO connections");
    await runtime.shutdown();
  });

  it("concurrent crawls with different allowed destinations maintain strict policy isolation", async () => {
    const runtime = new Crawl4AiRuntime({
      pythonExecutable: "/Users/rahulkarthikt/Documents/mediobot/mediobot-v2/.venv/bin/python3",
      defaultTimeoutMs: 10000,
    });

    // Crawl A allows http://127.0.0.1:forbiddenPort
    // Crawl B does NOT allow it
    const crawlAPromise = runtime.crawl({
      url: `http://127.0.0.1:${forbiddenPort}/path-a`,
      allowedDestinations: [`http://127.0.0.1:${forbiddenPort}`],
      cacheMode: "bypass",
      allowBrowser: false,
      preferHttp: true,
    });

    const crawlBPromise = assert.rejects(
      () => runtime.crawl({
        url: `http://127.0.0.1:${forbiddenPort}/path-b`,
        allowedDestinations: ["http://127.0.0.1:9999"], // Does not include forbiddenPort
        cacheMode: "bypass",
        allowBrowser: false,
        preferHttp: true,
      }),
      /forbidden/i
    );

    const [crawlA] = await Promise.all([crawlAPromise, crawlBPromise]);
    assert.equal(crawlA.success, true, "Crawl A with authorized destination should succeed");

    await runtime.shutdown();
  });
});
