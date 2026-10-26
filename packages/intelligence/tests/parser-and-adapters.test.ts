import { test } from "node:test";
import assert from "node:assert/strict";
import { TypeScriptAdapter } from "../src/adapters/typescript.ts";
import { LanguageAdapterRegistry } from "../src/adapters/registry.ts";

test("Scenario 1: TypeScript symbol extraction", () => {
  const adapter = new TypeScriptAdapter();
  const code = `
    /** Math utilities for vector calculations */
    export interface Vector2D {
      x: number;
      y: number;
    }

    export type Coordinate = [number, number];

    export enum Direction {
      North,
      South,
      East,
      West,
    }

    /** Calculate Euclidean distance */
    export function calculateDistance(a: Vector2D, b: Vector2D): number {
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      return Math.sqrt(dx * dx + dy * dy);
    }

    export class SpatialGrid {
      private readonly size: number;
      constructor(size: number) {
        this.size = size;
      }
      insert(v: Vector2D): void {}
    }

    export const PI = 3.14159;
    let counter = 0;
  `;

  const parsed = adapter.parse("src/math.ts", code);
  assert.equal(parsed.language, "typescript");
  assert.equal(parsed.errors.length, 0);

  const symbolNames = parsed.symbols.map((s) => s.name);
  assert.ok(symbolNames.includes("Vector2D"), "Must extract interface Vector2D");
  assert.ok(symbolNames.includes("Coordinate"), "Must extract type Coordinate");
  assert.ok(symbolNames.includes("Direction"), "Must extract enum Direction");
  assert.ok(symbolNames.includes("calculateDistance"), "Must extract function calculateDistance");
  assert.ok(symbolNames.includes("SpatialGrid"), "Must extract class SpatialGrid");
  assert.ok(symbolNames.includes("insert"), "Must extract method insert");
  assert.ok(symbolNames.includes("PI"), "Must extract const PI");
  assert.ok(symbolNames.includes("counter"), "Must extract let counter");

  const calcDist = parsed.symbols.find((s) => s.name === "calculateDistance")!;
  assert.equal(calcDist.kind, "function");
  assert.equal(calcDist.isExported, true);
  assert.ok(calcDist.startLine > 0, "Must have valid start line");
  assert.ok(calcDist.signature?.includes("calculateDistance"), "Must have signature");
  assert.ok(calcDist.docComment?.includes("Calculate Euclidean distance"), "Must preserve JSDoc docComment");

  const counterSym = parsed.symbols.find((s) => s.name === "counter")!;
  assert.equal(counterSym.isExported, false);
});

test("Scenario 2: JavaScript symbol extraction", () => {
  const adapter = new TypeScriptAdapter();
  const code = `
    function helper(msg) {
      console.log(msg);
    }

    class ServiceRunner {
      run() {
        helper("running");
      }
    }

    module.exports = { ServiceRunner, helper };
  `;

  const parsed = adapter.parse("lib/runner.js", code);
  assert.equal(parsed.language, "javascript");
  assert.equal(parsed.errors.length, 0);

  const names = parsed.symbols.map((s) => s.name);
  assert.ok(names.includes("helper"), "Must extract JS function helper");
  assert.ok(names.includes("ServiceRunner"), "Must extract JS class ServiceRunner");
  assert.ok(names.includes("run"), "Must extract JS method run");
});

test("Scenario 3: Import/export relationship extraction", () => {
  const adapter = new TypeScriptAdapter();
  const code = `
    import defaultClient, { TaskId, createTaskId } from "@mediobot-v2/contracts";
    import type { Evidence } from "@mediobot-v2/domain";
    import * as path from "node:path";
    const fs = require("node:fs");
    const dynamicModule = import("./lazy-loaded");

    export { calculateDistance } from "./math";
    export * from "./helpers";
    export default function main() {}
  `;

  const parsed = adapter.parse("src/index.ts", code);
  assert.equal(parsed.errors.length, 0);

  const contractDep = parsed.dependencies.find((d) => d.importPath === "@mediobot-v2/contracts")!;
  assert.ok(contractDep, "Must track @mediobot-v2/contracts");
  assert.ok(contractDep.importedNames.includes("defaultClient"));
  assert.ok(contractDep.importedNames.includes("TaskId"));
  assert.equal(contractDep.isTypeOnly, false);

  const domainDep = parsed.dependencies.find((d) => d.importPath === "@mediobot-v2/domain")!;
  assert.ok(domainDep, "Must track @mediobot-v2/domain");
  assert.ok(domainDep.isTypeOnly, true);

  const requireDep = parsed.dependencies.find((d) => d.importPath === "node:fs")!;
  assert.ok(requireDep, "Must track require import");

  const dynamicDep = parsed.dependencies.find((d) => d.importPath === "./lazy-loaded")!;
  assert.ok(dynamicDep, "Must track dynamic import");

  const reExportDep = parsed.dependencies.find((d) => d.importPath === "./math")!;
  assert.ok(reExportDep, "Must track re-export");
  assert.ok(reExportDep.importedNames.includes("calculateDistance"));
});

test("Scenario 6: Malformed source files", () => {
  const adapter = new TypeScriptAdapter();
  const brokenCode = `
    export function broken( {
      const a = 12;
      return a
    // Missing closing brace, invalid syntax
  `;

  // Must not throw or crash!
  const parsed = adapter.parse("src/broken.ts", brokenCode);
  assert.equal(parsed.language, "typescript");
  assert.ok(parsed.lineCount > 0);
  // Partial syntax recovery still extracts whatever valid tokens existed
  assert.ok(Array.isArray(parsed.symbols));
});

test("Scenario 8: Unsupported languages", async () => {
  const registry = new LanguageAdapterRegistry();

  const mdFile = await registry.parseFile("docs/README.md", "# Project Title\nDescription text");
  assert.equal(mdFile.language, "md");
  assert.equal(mdFile.symbols.length, 0);
  assert.equal(mdFile.dependencies.length, 0);
  assert.equal(mdFile.errors.length, 0);

  const jsonFile = await registry.parseFile("data/config.json", '{"key": "value"}');
  assert.equal(jsonFile.language, "json");
  assert.equal(jsonFile.symbols.length, 0);
  assert.equal(jsonFile.errors.length, 0);
});
