import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { isProjectIntelligenceEnabled } from "../src/config.ts";
import { discoverProjectIntelligenceSafe } from "../src/engine.ts";

test("Scenario 17: Feature flag disabled behavior", async () => {
  const originalEnv = process.env.USE_PROJECT_INTELLIGENCE;
  try {
    delete process.env.USE_PROJECT_INTELLIGENCE;
    assert.equal(isProjectIntelligenceEnabled(), false, "Must default to false when undefined");

    process.env.USE_PROJECT_INTELLIGENCE = "false";
    assert.equal(isProjectIntelligenceEnabled(), false, "Must be false when set to 'false'");

    process.env.USE_PROJECT_INTELLIGENCE = "0";
    assert.equal(isProjectIntelligenceEnabled(), false, "Must be false when set to '0'");

    process.env.USE_PROJECT_INTELLIGENCE = "true";
    assert.equal(isProjectIntelligenceEnabled(), true, "Must be true when set to 'true'");

    process.env.USE_PROJECT_INTELLIGENCE = "1";
    assert.equal(isProjectIntelligenceEnabled(), true, "Must be true when set to '1'");
  } finally {
    if (originalEnv !== undefined) {
      process.env.USE_PROJECT_INTELLIGENCE = originalEnv;
    } else {
      delete process.env.USE_PROJECT_INTELLIGENCE;
    }
  }
});

test("Scenario 18: Legacy discovery regression and fallback on error", async () => {
  const originalEnv = process.env.USE_PROJECT_INTELLIGENCE;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pie-fallback-test-"));

  try {
    let legacyCalled = false;
    const mockLegacyFallback = async (root: string) => {
      legacyCalled = true;
      return [
        { name: "project_structure", value: "src/\n  index.ts" },
        { name: "project_manifest", value: '{"name": "test-pkg"}' },
      ];
    };

    // 1. With flag disabled (default): MUST call legacy fallback directly
    process.env.USE_PROJECT_INTELLIGENCE = "false";
    const resDisabled = await discoverProjectIntelligenceSafe(tempDir, mockLegacyFallback);

    assert.equal(legacyCalled, true, "Legacy fallback must be called when flag disabled");
    assert.equal(resDisabled.usedEngine, false);
    assert.equal(resDisabled.records.length, 2);

    // 2. With flag enabled: if engine encounters unrecoverable error, MUST fall back to legacy safely
    process.env.USE_PROJECT_INTELLIGENCE = "true";
    legacyCalled = false;

    // Pass a broken engine that throws
    const brokenEngine = {
      workspaceRoot: tempDir,
      initialize: async () => {},
      fullIndex: async () => {
        throw new Error("Simulated unrecoverable indexing error");
      },
      dispose: async () => {},
    } as any;

    const resError = await discoverProjectIntelligenceSafe(tempDir, mockLegacyFallback, {
      engine: brokenEngine,
    });

    assert.equal(legacyCalled, true, "Must fall back to legacy discovery when engine errors");
    assert.equal(resError.usedEngine, false);
    assert.ok(resError.error?.includes("Simulated unrecoverable indexing error"));
    assert.equal(resError.records.length, 2);
  } finally {
    if (originalEnv !== undefined) {
      process.env.USE_PROJECT_INTELLIGENCE = originalEnv;
    } else {
      delete process.env.USE_PROJECT_INTELLIGENCE;
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});
