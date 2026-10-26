import assert from "node:assert/strict";
import test from "node:test";
import { toolOutputFallback } from "../../src/features/activity/toolExecutionFallback.ts";

test("filesystem tool cards do not present omitted output as terminal output", () => {
  assert.equal(toolOutputFallback("filesystem.read", "success"), "Filesystem operation completed.");
  assert.equal(toolOutputFallback("filesystem.write", "running"), "Filesystem operation in progress...");
  assert.equal(toolOutputFallback("filesystem.read", "failed"), "Filesystem operation failed.");
  assert.equal(toolOutputFallback("terminal.execute", "running"), "Executing process...");
  assert.equal(toolOutputFallback("terminal.execute", "success"), "No output captured.");
});
