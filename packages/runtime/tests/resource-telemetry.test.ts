import assert from "node:assert/strict";
import test from "node:test";
import { calculateSystemCpuPercent, SystemResourceTelemetryCollector } from "../src/resource-telemetry.ts";

test("system CPU utilization uses portable per-core time deltas", () => {
  const before = [
    { user: 100, nice: 0, sys: 40, idle: 800, irq: 10 },
    { user: 200, nice: 0, sys: 50, idle: 700, irq: 50 },
  ];
  const after = [
    { user: 120, nice: 0, sys: 50, idle: 865, irq: 15 },
    { user: 220, nice: 0, sys: 60, idle: 765, irq: 55 },
  ];
  assert.equal(calculateSystemCpuPercent(before, after), 35);
  assert.equal(calculateSystemCpuPercent(before, after.slice(0, 1)), undefined,
    "CPU topology changes must not produce a misleading utilization sample");
  assert.equal(calculateSystemCpuPercent(before, before), undefined,
    "zero-duration CPU counters are not a valid sample");
  assert.equal(calculateSystemCpuPercent(before, [{ user: 99, nice: 0, sys: 40, idle: 800, irq: 10 }, after[1]!]), undefined,
    "counter resets must not produce a misleading utilization sample");
});

test("system telemetry reports backend process RSS without claiming an unmeasured process-tree total", () => {
  const telemetry = new SystemResourceTelemetryCollector().collect(true);

  assert.ok(telemetry.processRssBytes > 0, "the current backend process RSS should be measured");
  assert.equal(telemetry.managedProcessTreeRssBytes, undefined,
    "a single-process RSS sample must not be labeled as a managed process-tree total");
});

test("system CPU admission sample waits for a complete sampling interval", () => {
  const collector = new SystemResourceTelemetryCollector({ sampleIntervalMs: 60_000 });
  const first = collector.collect(true);
  assert.equal(first.systemCpuPercent, undefined,
    "a tiny startup delta must not trigger CPU-based admission throttling");
});
