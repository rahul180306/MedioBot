import test from "node:test";
import assert from "node:assert/strict";
import {
  ProviderRequestScheduler,
  ModelProviderError,
  parseRetryAfter,
  computeBackoffDelay,
  type ModelAdmissionPort,
  type ModelAdmissionScope,
  type ModelAdmissionResult,
} from "../src/index.ts";

test("EMPIRICAL CHALLENGE 1: parseRetryAfter RFC 9110 specification conformance & fuzzing", () => {
  // 1.1 HTTP-date in the future (120 seconds ahead)
  const future120 = new Date(Date.now() + 120_000).toUTCString();
  const parsed120 = parseRetryAfter(future120);
  assert.ok(typeof parsed120 === "number", "Parsed HTTP-date must be a number");
  assert.ok(parsed120 >= 118_000 && parsed120 <= 122_000, `Expected ~120,000ms, got ${parsed120}ms`);

  // 1.2 HTTP-date further in the future (3600s, 86400s)
  const futureHour = new Date(Date.now() + 3_600_000).toUTCString();
  const parsedHour = parseRetryAfter(futureHour);
  assert.ok(typeof parsedHour === "number" && parsedHour >= 3_598_000 && parsedHour <= 3_602_000, "1-hour HTTP-date must not be capped");

  const futureDay = new Date(Date.now() + 86_400_000).toUTCString();
  const parsedDay = parseRetryAfter(futureDay);
  assert.ok(typeof parsedDay === "number" && parsedDay >= 86_395_000 && parsedDay <= 86_405_000, "24-hour HTTP-date must not be capped");

  // 1.3 Second-delta > 60 seconds uncapped
  assert.equal(parseRetryAfter("120"), 120_000, "120s must be 120,000ms");
  assert.equal(parseRetryAfter("3600"), 3_600_000, "3600s must be 3,600,000ms");
  assert.equal(parseRetryAfter("86400"), 86_400_000, "86400s must be 86,400,000ms");
  assert.equal(parseRetryAfter("604800"), 604_800_000, "1 week (604800s) must be 604,800,000ms");

  // 1.4 Fractional seconds
  assert.equal(parseRetryAfter("0.5"), 500, "0.5s must be 500ms");
  assert.equal(parseRetryAfter("1.25"), 1250, "1.25s must be 1250ms");
  assert.equal(parseRetryAfter("120.75"), 120_750, "120.75s must be 120,750ms");

  // 1.5 Sub-50ms clamp to minimum
  assert.equal(parseRetryAfter("0"), 50, "0s clamped to 50ms");
  assert.equal(parseRetryAfter("0.01"), 50, "10ms clamped to 50ms");
  assert.equal(parseRetryAfter("0.049"), 50, "49ms clamped to 50ms");
  assert.equal(parseRetryAfter("0.05"), 50, "50ms remains 50ms");

  // 1.6 Negative numbers must return undefined (not negative ms or misparsed dates)
  assert.equal(parseRetryAfter("-10"), undefined, "-10 must be undefined");
  assert.equal(parseRetryAfter("-1"), undefined, "-1 must be undefined");
  assert.equal(parseRetryAfter("-0.5"), undefined, "-0.5 must be undefined");
  assert.equal(parseRetryAfter("-999999"), undefined, "-999999 must be undefined");

  // 1.7 Non-numeric and invalid strings
  assert.equal(parseRetryAfter("invalid"), undefined, "'invalid' must be undefined");
  assert.equal(parseRetryAfter("120s"), undefined, "'120s' (with suffix) must be undefined");
  assert.equal(parseRetryAfter("NaN"), undefined, "'NaN' must be undefined");
  assert.equal(parseRetryAfter("null"), undefined, "'null' must be undefined");
  assert.equal(parseRetryAfter("undefined"), undefined, "'undefined' must be undefined");
  assert.equal(parseRetryAfter(""), undefined, "empty string must be undefined");
  assert.equal(parseRetryAfter("   "), undefined, "whitespace-only must be undefined");
  assert.equal(parseRetryAfter(undefined), undefined, "undefined must be undefined");
  assert.equal(parseRetryAfter(null), undefined, "null must be undefined");

  // 1.8 Whitespace trimming around valid numbers
  assert.equal(parseRetryAfter("   120   "), 120_000, "leading/trailing whitespace must be trimmed");
  assert.equal(parseRetryAfter("\t3600\n"), 3_600_000, "newlines/tabs must be trimmed");

  // 1.9 Infinity and extreme values
  assert.equal(parseRetryAfter("Infinity"), undefined, "'Infinity' must be undefined");
  assert.equal(parseRetryAfter("-Infinity"), undefined, "'-Infinity' must be undefined");

  // 1.10 Past dates clamp to 50ms minimum
  const pastDate = new Date(Date.now() - 60_000).toUTCString();
  assert.equal(parseRetryAfter(pastDate), 50, "Past HTTP-date must clamp to 50ms minimum");
  const ancientDate = new Date("Thu, 01 Jan 1970 00:00:00 GMT").toUTCString();
  assert.equal(parseRetryAfter(ancientDate), 50, "1970 HTTP-date must clamp to 50ms minimum");

  // 1.11 Malformed dates
  assert.equal(parseRetryAfter("Wed, 99 Dec 2026 99:99:99 GMT"), undefined, "Malformed date string must be undefined");
});

test("EMPIRICAL CHALLENGE 2: computeBackoffDelay uncapped Retry-After vs exponential backoff", () => {
  // 2.1 Server-specified retryAfterMs = 45000ms: MUST NOT be capped to 10000ms
  assert.equal(computeBackoffDelay(0, 45_000), 45_000, "retryAfterMs=45,000ms must return exactly 45,000ms");
  assert.equal(computeBackoffDelay(1, 45_000), 45_000, "attempt number must not alter server-specified retryAfterMs");
  assert.equal(computeBackoffDelay(5, 45_000), 45_000, "attempt=5 must not alter server-specified retryAfterMs");

  // 2.2 Server-specified large values (120s, 1hr, 24hr)
  assert.equal(computeBackoffDelay(0, 120_000), 120_000, "120s server delay honored uncapped");
  assert.equal(computeBackoffDelay(0, 3_600_000), 3_600_000, "1hr server delay honored uncapped");
  assert.equal(computeBackoffDelay(0, 86_400_000), 86_400_000, "24hr server delay honored uncapped");

  // 2.3 Sub-50ms retryAfter clamped to 50ms
  assert.equal(computeBackoffDelay(0, 10), 50, "sub-50ms server delay clamped to 50ms");

  // 2.4 Non-positive / invalid retryAfter falls back to exponential backoff
  const fallbackNeg = computeBackoffDelay(0, -100);
  assert.ok(fallbackNeg >= 500 && fallbackNeg <= 750, "negative retryAfter falls back to attempt 0 backoff");

  const fallbackZero = computeBackoffDelay(0, 0);
  assert.ok(fallbackZero >= 500 && fallbackZero <= 750, "zero retryAfter falls back to attempt 0 backoff");

  const fallbackNaN = computeBackoffDelay(0, NaN);
  assert.ok(fallbackNaN >= 500 && fallbackNaN <= 750, "NaN retryAfter falls back to attempt 0 backoff");

  const fallbackInf = computeBackoffDelay(0, Infinity);
  assert.ok(fallbackInf >= 500 && fallbackInf <= 750, "Infinity retryAfter falls back to attempt 0 backoff");

  // 2.5 Exponential backoff progression without retryAfter (bounded by maxDelayMs)
  // Attempt 0: base 500 + jitter [0, 250) -> [500, 750]
  const d0 = computeBackoffDelay(0);
  assert.ok(d0 >= 500 && d0 <= 750, `Attempt 0 in [500, 750], got ${d0}`);

  // Attempt 1: base 1000 + jitter [0, 250) -> [1000, 1250]
  const d1 = computeBackoffDelay(1);
  assert.ok(d1 >= 1000 && d1 <= 1250, `Attempt 1 in [1000, 1250], got ${d1}`);

  // Attempt 2: base 2000 + jitter [0, 250) -> [2000, 2250]
  const d2 = computeBackoffDelay(2);
  assert.ok(d2 >= 2000 && d2 <= 2250, `Attempt 2 in [2000, 2250], got ${d2}`);

  // Attempt 10: 500 * 1024 = 512,000 -> must cap at maxDelayMs (default 10,000ms)
  const d10 = computeBackoffDelay(10);
  assert.equal(d10, 10_000, `High attempt must be capped at 10,000ms, got ${d10}`);

  // Custom baseDelayMs and maxDelayMs
  const custom = computeBackoffDelay(10, undefined, 100, 2000);
  assert.equal(custom, 2000, `Custom maxDelayMs=2000 respected, got ${custom}`);
});

test("EMPIRICAL CHALLENGE 3: Provider cooldown & capacity permit release without cross-provider blocking", async () => {
  const scheduler = new ProviderRequestScheduler({
    concurrencyLimits: { "slow-prov": 1, "fast-prov": 2 },
  });

  const timeline: string[] = [];

  // Launch task on slow-prov that triggers sleepWithBackoff (200ms)
  let slowAttempts = 0;
  const slowTask = scheduler.schedule({
    providerKey: "slow-prov",
    execute: async () => {
      slowAttempts++;
      if (slowAttempts === 1) {
        timeline.push("slow-enter-backoff");
        await scheduler.sleepWithBackoff("slow-prov", 150);
        timeline.push("slow-exit-backoff");
      }
      timeline.push("slow-complete");
      return "slow-done";
    },
  });

  // Give microtick for slow-prov to enter sleepWithBackoff
  await new Promise((r) => setTimeout(r, 20));

  // Verify that during backoff:
  // 1. activeRequests for slow-prov is 0 (permit released)
  const slowStatusDuring = scheduler.getProviderStatus("slow-prov");
  assert.equal(slowStatusDuring.activeRequests, 0, "Capacity permit MUST be released during sleepWithBackoff");
  assert.ok(slowStatusDuring.cooldownUntil && slowStatusDuring.cooldownUntil > Date.now(), "Provider cooldown MUST be set");

  // 2. Fast-prov can execute immediately and is NOT blocked by slow-prov
  const fastTask1 = scheduler.schedule({
    providerKey: "fast-prov",
    execute: async () => {
      timeline.push("fast1-start");
      await new Promise((r) => setTimeout(r, 10));
      timeline.push("fast1-done");
      return "fast1";
    },
  });

  const fastTask2 = scheduler.schedule({
    providerKey: "fast-prov",
    execute: async () => {
      timeline.push("fast2-start");
      await new Promise((r) => setTimeout(r, 10));
      timeline.push("fast2-done");
      return "fast2";
    },
  });

  // 3. A second request on slow-prov dispatched during cooldown MUST be queued
  const slowTask2 = scheduler.schedule({
    providerKey: "slow-prov",
    execute: async () => {
      timeline.push("slow2-complete");
      return "slow2-done";
    },
  });

  const slowStatusQueued = scheduler.getProviderStatus("slow-prov");
  assert.equal(slowStatusQueued.queuedRequests, 1, "New request on cooling-down provider MUST queue");

  // Await fast tasks — they must complete while slow-prov is still in backoff
  const [f1, f2] = await Promise.all([fastTask1, fastTask2]);
  assert.equal(f1, "fast1");
  assert.equal(f2, "fast2");

  // Check timeline order: fast tasks completed BEFORE slow-prov exited backoff
  const slowExitIndex = timeline.indexOf("slow-exit-backoff");
  const fast1DoneIndex = timeline.indexOf("fast1-done");
  const fast2DoneIndex = timeline.indexOf("fast2-done");

  assert.ok(fast1DoneIndex >= 0, "fast1 must have executed");
  assert.ok(fast2DoneIndex >= 0, "fast2 must have executed");
  assert.ok(slowExitIndex === -1, "slow-prov must still be sleeping when fast tasks complete");

  // Await completion of slow tasks
  const [s1, s2] = await Promise.all([slowTask, slowTask2]);
  assert.equal(s1, "slow-done");
  assert.equal(s2, "slow2-done");

  // Verify final scheduler state
  assert.equal(scheduler.getProviderStatus("slow-prov").activeRequests, 0);
  assert.equal(scheduler.getProviderStatus("slow-prov").queuedRequests, 0);
  assert.equal(scheduler.getProviderStatus("fast-prov").activeRequests, 0);
  assert.equal(scheduler.getProviderStatus("fast-prov").queuedRequests, 0);
});

test("EMPIRICAL CHALLENGE 4: Cancellation during cooldown immediately settles without hanging", async () => {
  const scheduler = new ProviderRequestScheduler({ defaultConcurrency: 1 });
  const controller = new AbortController();

  const startTime = performance.now();
  let executedFinally = false;

  const requestPromise = scheduler.schedule({
    providerKey: "cooldown-abort-prov",
    signal: controller.signal,
    execute: async () => {
      try {
        // Sleep for 30 seconds (huge cooldown)
        await scheduler.sleepWithBackoff("cooldown-abort-prov", 30_000, controller.signal);
        return "unreachable";
      } finally {
        executedFinally = true;
      }
    },
  });

  // Wait 15ms to ensure it entered sleepWithBackoff
  await new Promise((r) => setTimeout(r, 15));

  // Trigger abort
  controller.abort();

  // Await rejection
  await assert.rejects(
    requestPromise,
    (err: unknown) => {
      assert.ok(err instanceof ModelProviderError, "Error must be instance of ModelProviderError");
      assert.equal(err.code, "cancelled", "Error code must be 'cancelled'");
      return true;
    }
  );

  const durationMs = performance.now() - startTime;

  // Crucial check: Must have settled in < 200ms, NOT 30,000ms
  assert.ok(
    durationMs < 500,
    `Aborted cooldown must settle immediately: took ${durationMs.toFixed(1)}ms (must be < 500ms)`
  );
  assert.equal(executedFinally, true, "Finally block executed");

  // Verify no dangling permits or corrupted state
  const status = scheduler.getProviderStatus("cooldown-abort-prov");
  assert.equal(status.activeRequests, 0, "Active requests must return to 0");
  assert.equal(status.queuedRequests, 0, "Queue must be empty");

  // Clean up remaining timer
  scheduler.clear();
});

test("EMPIRICAL CHALLENGE 5: Cancellation while queued during provider cooldown", async () => {
  const scheduler = new ProviderRequestScheduler({ defaultConcurrency: 1 });

  // Manually put provider into cooldown for 2000ms
  scheduler.setProviderCooldown("queued-cancel-prov", 2000);

  const controller = new AbortController();
  const queuedStartTime = performance.now();

  const queuedPromise = scheduler.schedule({
    providerKey: "queued-cancel-prov",
    signal: controller.signal,
    execute: async () => "should-not-run",
  });

  assert.equal(scheduler.getProviderStatus("queued-cancel-prov").queuedRequests, 1);

  // Abort after 10ms
  await new Promise((r) => setTimeout(r, 10));
  controller.abort();

  await assert.rejects(queuedPromise, (err: unknown) => {
    assert.ok(err instanceof ModelProviderError);
    assert.equal(err.code, "cancelled");
    return true;
  });

  const durationMs = performance.now() - queuedStartTime;
  assert.ok(durationMs < 200, `Queued cancellation settled in ${durationMs.toFixed(1)}ms (expected < 200ms)`);
  assert.equal(scheduler.getProviderStatus("queued-cancel-prov").queuedRequests, 0, "Queued request removed");

  scheduler.clear();
});

test("EMPIRICAL CHALLENGE 6: ModelAdmissionPort lease lifecycle and capacity change notification", async () => {
  let activeGovernorLeases = 0;
  const maxGovernorCapacity = 2;
  const releasedLeaseIds: string[] = [];
  const listeners = new Set<() => void>();

  const admissionPort: ModelAdmissionPort = {
    tryAcquire(attempt: ModelAdmissionScope): ModelAdmissionResult {
      if (activeGovernorLeases >= maxGovernorCapacity) {
        return { granted: false, retryAfterMs: 50 };
      }
      activeGovernorLeases++;
      const leaseId = `lease-${crypto.randomUUID()}`;
      return {
        granted: true,
        leaseId,
        release: () => {
          activeGovernorLeases--;
          releasedLeaseIds.push(leaseId);
          for (const listener of listeners) listener();
        },
      };
    },
    release(leaseId: string) {
      activeGovernorLeases--;
      releasedLeaseIds.push(leaseId);
      for (const listener of listeners) listener();
    },
    subscribeCapacityChange(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };

  const scheduler = new ProviderRequestScheduler({
    defaultConcurrency: 4,
    admissionPort,
  });

  // Launch 4 tasks when governor only allows 2
  const results: string[] = [];
  const makeTask = (id: string) => scheduler.schedule({
    providerKey: "gov-test-prov",
    taskId: id,
    execute: async () => {
      await new Promise((r) => setTimeout(r, 20));
      results.push(id);
      return id;
    },
  });

  const [t1, t2, t3, t4] = await Promise.all([
    makeTask("task-1"),
    makeTask("task-2"),
    makeTask("task-3"),
    makeTask("task-4"),
  ]);

  assert.equal(results.length, 4, "All 4 tasks must complete eventually");
  assert.equal(releasedLeaseIds.length, 4, "All 4 governor leases must be released");
  assert.equal(activeGovernorLeases, 0, "Zero leaked governor leases");
  assert.equal(scheduler.getProviderStatus("gov-test-prov").activeRequests, 0);
  assert.equal(scheduler.getProviderStatus("gov-test-prov").queuedRequests, 0);
});

test("EMPIRICAL CHALLENGE 7: Concurrent stress test (40 requests, 4 providers, random aborts)", async () => {
  const scheduler = new ProviderRequestScheduler({
    defaultConcurrency: 3,
    concurrencyLimits: { p0: 2, p1: 3, p2: 1, p3: 4 },
  });

  const providers = ["p0", "p1", "p2", "p3"];
  const totalRequests = 40;
  const settledResults: { id: number; status: "success" | "cancelled" | "error" }[] = [];

  const promises: Promise<void>[] = [];

  for (let i = 0; i < totalRequests; i++) {
    const provKey = providers[i % providers.length];
    const shouldAbort = i % 5 === 0; // 20% abort rate
    const controller = new AbortController();

    const p = (async () => {
      if (shouldAbort) {
        // Abort after a short randomized duration
        setTimeout(() => controller.abort(), Math.floor(Math.random() * 20) + 2);
      }

      try {
        await scheduler.schedule({
          providerKey: provKey,
          signal: controller.signal,
          execute: async () => {
            const workMs = Math.floor(Math.random() * 25) + 5;
            await new Promise((r) => setTimeout(r, workMs));
            return `res-${i}`;
          },
        });
        settledResults.push({ id: i, status: "success" });
      } catch (err: unknown) {
        if (err instanceof ModelProviderError && err.code === "cancelled") {
          settledResults.push({ id: i, status: "cancelled" });
        } else {
          settledResults.push({ id: i, status: "error" });
        }
      }
    })();

    promises.push(p);
  }

  await Promise.all(promises);

  assert.equal(settledResults.length, totalRequests, `All ${totalRequests} requests must settle`);
  
  // Verify that all providers returned to 0 active and 0 queued
  for (const prov of providers) {
    const st = scheduler.getProviderStatus(prov);
    assert.equal(st.activeRequests, 0, `Provider ${prov} leaked active permits: ${st.activeRequests}`);
    assert.equal(st.queuedRequests, 0, `Provider ${prov} leaked queued requests: ${st.queuedRequests}`);
  }

  const successCount = settledResults.filter((r) => r.status === "success").length;
  const cancelledCount = settledResults.filter((r) => r.status === "cancelled").length;
  const errorCount = settledResults.filter((r) => r.status === "error").length;

  assert.equal(errorCount, 0, `Unexpected errors during stress: ${errorCount}`);
  assert.ok(successCount > 0, `At least some requests succeeded (${successCount})`);
  assert.ok(cancelledCount > 0, `At least some requests cancelled cleanly (${cancelledCount})`);
});
