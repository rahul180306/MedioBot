import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { WorkspaceScanner } from "../src/scanner.ts";

function createTempWorkspace(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pie-scanner-ws-"));
  return {
    root,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

test("Scenario 4: Nested directories", async () => {
  const { root, cleanup } = createTempWorkspace();
  try {
    fs.mkdirSync(path.join(root, "src", "core", "utils"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "index.ts"), "export const a = 1;");
    fs.writeFileSync(path.join(root, "src", "core", "service.ts"), "export const s = 2;");
    fs.writeFileSync(path.join(root, "src", "core", "utils", "math.ts"), "export const m = 3;");

    const scanner = new WorkspaceScanner(root);
    await scanner.init();
    const files = await scanner.scan();

    const paths = files.map((f) => f.relativePath).sort();
    assert.deepEqual(paths, [
      "src/core/service.ts",
      "src/core/utils/math.ts",
      "src/index.ts",
    ]);
  } finally {
    cleanup();
  }
});

test("Scenario 14: Path traversal protection", async () => {
  const nonExistent = path.join(os.tmpdir(), "non-existent-pie-dir-9999");
  const scanner = new WorkspaceScanner(nonExistent);

  await assert.rejects(
    async () => {
      await scanner.init();
    },
    /Workspace root does not exist/,
    "Must reject non-existent workspace root"
  );
});

test("Scenario 15: Symlink containment", async () => {
  const ws = createTempWorkspace();
  const outside = createTempWorkspace();

  try {
    // Write a secret file outside the workspace
    const outsideSecret = path.join(outside.root, "external_secret.txt");
    fs.writeFileSync(outsideSecret, "TOP_SECRET_OUTSIDE_DATA");

    // Write a valid internal file inside the workspace
    fs.mkdirSync(path.join(ws.root, "src"), { recursive: true });
    fs.writeFileSync(path.join(ws.root, "src", "internal.ts"), "export const ok = true;");

    // Create an internal symlink pointing within workspace
    fs.symlinkSync(
      path.join(ws.root, "src", "internal.ts"),
      path.join(ws.root, "src", "symlink_internal.ts")
    );

    // Create an escaping symlink pointing outside workspace
    fs.symlinkSync(
      outsideSecret,
      path.join(ws.root, "src", "symlink_escaping.ts")
    );

    const scanner = new WorkspaceScanner(ws.root);
    await scanner.init();
    const files = await scanner.scan();

    const paths = files.map((f) => f.relativePath);

    assert.ok(paths.includes("src/internal.ts"), "Internal file must be indexed");
    assert.ok(paths.includes("src/symlink_internal.ts"), "Internal symlink within workspace must be indexed");
    assert.ok(
      !paths.includes("src/symlink_escaping.ts"),
      "Escaping symlink pointing outside workspace MUST be skipped"
    );
  } finally {
    ws.cleanup();
    outside.cleanup();
  }
});
