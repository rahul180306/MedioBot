/** One bounded reproduction; never launches a browser or retries the scenario. */
import { chromium, type Page } from "playwright";
import { createWorld } from "@mediobot-v2/domain";
import { AutonomousBrowserTask, PlaywrightBrowserPage } from "../src/index.ts";

const { endpoint } = await (await fetch("http://127.0.0.1:47139/endpoint")).json() as { endpoint: string };
const browser = await chromium.connect(endpoint);
const world = createWorld();
const definition = world.registerMediobotDefinition({ name: "Controlled repro", role: "test", version: "1", instructions: "Test", declaredCapabilities: [] });
const worker = world.spawnWorker(definition.id);
const task = world.assignTask(world.createTask("Try").id, worker.id);
const resource = world.registerResource({ kind: "browser-page", owner: { type: "worker", workerId: worker.id, worldId: world.id } });
world.setWorkerState(worker.id, "busy"); world.setTaskState(task.id, "running"); world.setResourceState(resource.id, "in-use");
const driver = await PlaywrightBrowserPage.launch({ browser, resourceId: resource.id });
const page = (driver as unknown as { page: Page }).page;
const images: Buffer[] = [];
const captureTimings: number[] = [];
const screenshot = page.screenshot.bind(page);
page.screenshot = async (...args: Parameters<Page["screenshot"]>) => {
  const result = await screenshot(...args);
  images.push(Buffer.from(result)); captureTimings.push(performance.now());
  return result;
};
try {
  await page.setContent('<button aria-label="Only">Only</button>');
  if (process.argv.includes("--settling-control")) await page.evaluate(() => {
    const button = document.querySelector("button")!;
    // Generic transient press feedback, with no semantic outcome or DOM mutation.
    button.onclick = () => button.animate([{ backgroundColor: "rgb(255,0,0)" },
      { backgroundColor: "rgb(0,0,255)" }], { duration: 300 });
  });
  if (process.argv.includes("--delayed-pixels")) await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 80; canvas.height = 80;
    document.body.append(canvas);
    const ctx = canvas.getContext("2d")!;
    document.querySelector("button")!.onclick = () => {
      let frame = 0;
      const timer = setInterval(() => {
        ctx.fillStyle = `rgb(${frame++ * 20},0,0)`; ctx.fillRect(0,0,80,80);
        if (frame === 12) { clearInterval(timer); ctx.clearRect(0,0,80,80); }
      }, 20);
    };
  });
  let calls = 0;
  const runner = new AutonomousBrowserTask({ world, taskId: task.id, workerId: worker.id, resourceId: resource.id,
    observations: driver, executor: driver, maxSteps: 5,
    visual: { policy: { onNoEffect: true, maxCalls: 1 }, captures: { async withViewportCapture(o, s, consume) {
      if (process.argv.includes("--native-hover")) {
        await page.bringToFront();
        const box = await page.locator("button").boundingBox();
        await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      }
      return driver.withViewportCapture(o, s, consume);
    } },
      provider: { async perceive() { calls++; return []; } } },
    decisions: { async decide(_g, o) { return { type: "click", targetId: "e1", observationRevision: o.revision }; } },
  });
  const result = await runner.run("Try");
  console.log(JSON.stringify({ state: result.state, error: result.state === "failed" ? result.error : undefined,
    diagnostic: result.state === "failed" ? result.diagnostic : undefined, calls, pageAlive: !page.isClosed(),
    attempts: result.evidence.map(e => ({ revision: e.actionObservationRevision, after: e.afterObservation?.revision,
      execution: e.execution, effect: e.effect, changed: e.changed })), captureCount: images.length,
    captureIntervalsMs: captureTimings.slice(1).map((t,i) => Math.round(t - captureTimings[i]!)) }));
  if (images.length >= 2 && !page.isClosed()) {
    const diff = await page.evaluate(async ([a,b]) => {
      const decode = async (data: string) => {
        const img = new Image(); img.src = data; await img.decode();
        const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext("2d")!; ctx.drawImage(img,0,0);
        return { width: img.width, data: ctx.getImageData(0,0,img.width,img.height).data };
      };
      const x = await decode(a!), y = await decode(b!);
      let pixels = 0, minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
      for (let i=0;i<x.data.length;i+=4) if ([0,1,2,3].some(c=>x.data[i+c]!==y.data[i+c])) {
        pixels++; const px = i/4%x.width, py = Math.floor(i/4/x.width);
        minX=Math.min(minX,px);minY=Math.min(minY,py);maxX=Math.max(maxX,px);maxY=Math.max(maxY,py);
      }
      const button = document.querySelector("button")!;
      return { pixels, bounds: pixels ? {minX,minY,maxX,maxY} : null,
        buttonBounds: button.getBoundingClientRect().toJSON(), focused: document.activeElement === button,
        hovered: button.matches(":hover"), active: button.matches(":active"), animations: document.getAnimations().length };
    }, images.slice(0,2).map(b=>`data:image/png;base64,${b.toString("base64")}`));
    console.log(JSON.stringify({ pngByteEqual: images[0]!.equals(images[1]!), diff }));
  }
} finally {
  images.forEach(image => image.fill(0));
  await driver.close();
  console.log(JSON.stringify({ contextCountAfterCleanup: browser.contexts().length, browserAlive: browser.isConnected() }));
  await browser.close(); // Disconnect this client; the bounded session owner retains the process.
}
