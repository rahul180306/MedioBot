import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as productionApi from "@mediobot-v2/maestro";

test("the package root exposes the active LangGraph engine and isolates the legacy scheduler", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    exports: Record<string, string>;
  };
  assert.equal(packageJson.exports["."], "./src/index.ts");
  assert.equal(packageJson.exports["./legacy-orchestrator"], "./src/orchestrator.ts");
  assert.ok("LangGraphExecutionEngine" in productionApi);
  assert.ok(!("MaestroOrchestrator" in productionApi));
});

test("the legacy scheduler remains available through its explicit rollback subpath", async () => {
  const rollbackApi = await import("@mediobot-v2/maestro/legacy-orchestrator");
  assert.equal(typeof rollbackApi.MaestroOrchestrator, "function");
});
