/** Opt-in local browser owner. One process survives diagnosis and code reloads.
 * node --experimental-strip-types packages/vision/tests/controlled-session.ts start|status|stop
 * Other tests connect through this loopback-only endpoint; no arbitrary code endpoint. */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const address = "http://127.0.0.1:47139";
const mode = process.argv[2];
if (mode === "serve") {
  const owner = await chromium.launchServer({ headless: false });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(expiry);
    await owner.close();
    server.close();
  };
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/endpoint") res.end(JSON.stringify({ endpoint: owner.wsEndpoint() }));
    else if (req.url === "/status") res.end(JSON.stringify({ ready: !stopping, browserPid: owner.process().pid }));
    else if (req.url === "/stop" && req.method === "POST") { res.end('{"stopping":true}'); void stop(); }
    else { res.statusCode = 404; res.end("{}"); }
  });
  server.on("error", () => { void stop(); });
  const expiry = setTimeout(() => { void stop(); }, 15 * 60_000);
  process.on("SIGTERM", () => { void stop(); });
  process.on("SIGINT", () => { void stop(); });
  server.listen(47139, "127.0.0.1");
} else if (mode === "start") {
  const existing = await fetch(`${address}/status`).catch(() => undefined);
  if (existing?.ok) throw new Error("Controlled session already running; reuse it");
  spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url), "serve"],
    { detached: true, stdio: "ignore" }).unref();
  let ready = false;
  for (let i = 0; i < 50; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const response = await fetch(`${address}/status`).catch(() => undefined);
    if (response?.ok) { ready = true; break; }
  }
  if (!ready) throw new Error("Controlled browser failed to start; do not relaunch automatically");
  console.log("One controlled browser session ready (15 minute maximum).");
} else if (mode === "stop" || mode === "status") {
  const response = await fetch(`${address}/${mode}`, { method: mode === "stop" ? "POST" : "GET" }).catch(() => undefined);
  console.log(response?.ok ? mode === "stop" ? "Controlled browser cleanup requested." : "Controlled browser is alive."
    : "No controlled browser session is running.");
} else throw new Error("Expected start, status, or stop");
