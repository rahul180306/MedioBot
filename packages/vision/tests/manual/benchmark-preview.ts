import { chromium } from "playwright";
import { startBenchmarkServer } from "../fixtures/benchmark-app.ts";

async function main(): Promise<void> {
  const server = await startBenchmarkServer();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let interrupt: (() => void) | undefined;
  try {
    browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();
    await page.goto(server.url, { waitUntil: "domcontentloaded" });
    console.log("Records benchmark preview is open. Inspect or interact with the local application; press Ctrl+C to close.");
    await new Promise<void>((resolve) => {
      interrupt = resolve;
      process.once("SIGINT", interrupt);
    });
  } finally {
    if (interrupt) process.removeListener("SIGINT", interrupt);
    await browser?.close();
    await server.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Could not open the local benchmark preview");
  process.exitCode = 1;
});
