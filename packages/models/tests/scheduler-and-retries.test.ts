import test from "node:test";
import assert from "node:assert/strict";
import {
  type ModelAdmissionPort,
  ProviderRequestScheduler,
  OpenAICompatibleStructuredClient,
  ModelProviderError,
  parseRetryAfter,
  computeBackoffDelay,
} from "../src/index.ts";

test("parseRetryAfter parses numeric seconds and HTTP-date strings", () => {
  assert.equal(parseRetryAfter("5"), 5000);
  assert.equal(parseRetryAfter("0.5"), 500);
  assert.equal(parseRetryAfter(""), undefined);
  assert.equal(parseRetryAfter(undefined), undefined);
  assert.equal(parseRetryAfter("invalid"), undefined);

  // Future date
  const futureDate = new Date(Date.now() + 10_000).toUTCString();
  const parsedFuture = parseRetryAfter(futureDate);
  assert.ok(typeof parsedFuture === "number" && parsedFuture >= 8000 && parsedFuture <= 11000);
});

test("computeBackoffDelay respects retryAfter and bounds exponential backoff with jitter", () => {
  assert.equal(computeBackoffDelay(0, 3000), 3000);
  const delay0 = computeBackoffDelay(0);
  assert.ok(delay0 >= 500 && delay0 <= 800);
  const delay2 = computeBackoffDelay(2);
  assert.ok(delay2 >= 2000 && delay2 <= 2500);
});

test("ProviderRequestScheduler allows concurrent requests up to limit per provider", async () => {
  const scheduler = new ProviderRequestScheduler({
    defaultConcurrency: 2,
    concurrencyLimits: { dahl: 3, nvidia: 1 },
  });

  let dahlActive = 0;
  let dahlMaxActive = 0;
  let nvidiaActive = 0;
  let nvidiaMaxActive = 0;

  const runDahl = () => scheduler.schedule({
    providerKey: "dahl",
    execute: async () => {
      dahlActive++;
      dahlMaxActive = Math.max(dahlMaxActive, dahlActive);
      await new Promise((r) => setTimeout(r, 20));
      dahlActive--;
      return "dahl-done";
    },
  });

  const runNvidia = () => scheduler.schedule({
    providerKey: "nvidia",
    execute: async () => {
      nvidiaActive++;
      nvidiaMaxActive = Math.max(nvidiaMaxActive, nvidiaActive);
      await new Promise((r) => setTimeout(r, 20));
      nvidiaActive--;
      return "nvidia-done";
    },
  });

  // Launch 4 dahl and 3 nvidia concurrently
  const [d1, d2, d3, d4, n1, n2, n3] = await Promise.all([
    runDahl(), runDahl(), runDahl(), runDahl(),
    runNvidia(), runNvidia(), runNvidia(),
  ]);

  assert.equal(d1, "dahl-done");
  assert.equal(d4, "dahl-done");
  assert.equal(n1, "nvidia-done");
  assert.equal(n3, "nvidia-done");

  assert.equal(dahlMaxActive, 3, "Dahl concurrency limit respected at 3");
  assert.equal(nvidiaMaxActive, 1, "Nvidia concurrency limit respected at 1");
  assert.equal(scheduler.getProviderStatus("dahl").activeRequests, 0);
  assert.equal(scheduler.getProviderStatus("nvidia").activeRequests, 0);
});

test("ProviderRequestScheduler allows NVIDIA requests to execute concurrently by default without unintended serialization", async () => {
  // Without hardcoded nvidia=1 heuristic, nvidia requests use defaultConcurrency
  const scheduler = new ProviderRequestScheduler({
    defaultConcurrency: 3,
  });

  let nvidiaActive = 0;
  let nvidiaMaxActive = 0;

  const runNvidia = () => scheduler.schedule({
    providerKey: "nvidia",
    providerType: "nvidia",
    execute: async () => {
      nvidiaActive++;
      nvidiaMaxActive = Math.max(nvidiaMaxActive, nvidiaActive);
      await new Promise((r) => setTimeout(r, 20));
      nvidiaActive--;
      return "nvidia-concurrent-done";
    },
  });

  const [n1, n2, n3] = await Promise.all([runNvidia(), runNvidia(), runNvidia()]);
  assert.equal(n1, "nvidia-concurrent-done");
  assert.equal(n2, "nvidia-concurrent-done");
  assert.equal(n3, "nvidia-concurrent-done");
  assert.equal(nvidiaMaxActive, 3, "NVIDIA requests executed concurrently up to default limit 3");
  assert.equal(scheduler.getProviderStatus("nvidia").activeRequests, 0);
});

test("ProviderRequestScheduler allows explicit per-connection capacity for NVIDIA", async () => {
  const scheduler = new ProviderRequestScheduler({
    defaultConcurrency: 4,
    concurrencyLimits: { "nvidia-limited": 2 },
  });

  let active = 0;
  let maxActive = 0;

  const runTask = () => scheduler.schedule({
    providerKey: "nvidia-limited",
    providerType: "nvidia",
    execute: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return "done";
    },
  });

  await Promise.all([runTask(), runTask(), runTask(), runTask()]);
  assert.equal(maxActive, 2, "Explicit per-connection capacity of 2 was strictly respected");
});

test("ProviderRequestScheduler allows independent providers to proceed without cross-provider blocking", async () => {
  const scheduler = new ProviderRequestScheduler({
    concurrencyLimits: { saturated: 1, available: 2 },
  });

  let availableStarted = false;

  const saturatedTask = scheduler.schedule({
    providerKey: "saturated",
    execute: async () => {
      await new Promise((r) => setTimeout(r, 50));
      return "sat-1";
    },
  });

  const availableTask = scheduler.schedule({
    providerKey: "available",
    execute: async () => {
      availableStarted = true;
      return "avail-1";
    },
  });

  const availResult = await availableTask;
  assert.equal(availResult, "avail-1");
  assert.equal(availableStarted, true, "Available provider was not blocked by saturated provider");

  const satResult = await saturatedTask;
  assert.equal(satResult, "sat-1");
});

test("ProviderRequestScheduler cancels queued request when signal is aborted", async () => {
  const scheduler = new ProviderRequestScheduler({
    defaultConcurrency: 1,
  });

  // Occupy the 1 slot
  let releaseSlot!: () => void;
  const slowPromise = scheduler.schedule({
    providerKey: "prov",
    execute: () => new Promise<string>((r) => { releaseSlot = () => r("slow-done"); }),
  });

  // Queue second request with abort controller
  const controller = new AbortController();
  const queuedPromise = scheduler.schedule({
    providerKey: "prov",
    signal: controller.signal,
    execute: async () => "queued-done",
  });

  assert.equal(scheduler.getProviderStatus("prov").queuedRequests, 1);

  // Abort while queued
  controller.abort();

  await assert.rejects(queuedPromise, (err: unknown) => {
    assert.ok(err instanceof ModelProviderError);
    assert.equal(err.code, "cancelled");
    return true;
  });

  assert.equal(scheduler.getProviderStatus("prov").queuedRequests, 0, "Queued request removed on abort");

  // Release first request
  releaseSlot();
  const res = await slowPromise;
  assert.equal(res, "slow-done");
  assert.equal(scheduler.getProviderStatus("prov").activeRequests, 0);
});

test("ProviderRequestScheduler rejects with capacity error when queue is full", async () => {
  const scheduler = new ProviderRequestScheduler({
    defaultConcurrency: 1,
    maxQueueSize: 2,
  });

  let releaseSlot!: () => void;
  const slowPromise = scheduler.schedule({
    providerKey: "prov",
    execute: () => new Promise<string>((r) => { releaseSlot = () => r("done"); }),
  });

  // Fill queue to capacity (2 items)
  const q1 = scheduler.schedule({ providerKey: "prov", execute: async () => "q1" });
  const q2 = scheduler.schedule({ providerKey: "prov", execute: async () => "q2" });

  assert.equal(scheduler.getProviderStatus("prov").queuedRequests, 2);

  // 3rd queued item should be rejected immediately due to bounded queue
  await assert.rejects(
    scheduler.schedule({ providerKey: "prov", execute: async () => "q3" }),
    (err: unknown) => {
      assert.ok(err instanceof ModelProviderError);
      assert.equal(err.code, "capacity");
      return true;
    }
  );

  releaseSlot();
  await Promise.all([slowPromise, q1, q2]);
});

test("OpenAICompatibleStructuredClient retries on 429 and succeeds when under maxRetries", async () => {
  let attempts = 0;
  const client = new OpenAICompatibleStructuredClient({
    apiKey: "test",
    modelId: "test-model",
    maxRetries: 2,
    fetch: async () => {
      attempts++;
      if (attempts === 1) {
        return new Response("Rate limit exceeded", {
          status: 429,
          headers: { "retry-after": "0.05" },
        });
      }
      return Response.json({ choices: [{ message: { content: '{"status":"ok"}' } }] });
    },
  });

  const res = await client.complete({ system: "system", input: "input", signal: new AbortController().signal });
  assert.equal(res, '{"status":"ok"}');
  assert.equal(attempts, 2, "Retried once after 429");
});

test("OpenAICompatibleStructuredClient does NOT retry on authentication failure (401/403)", async () => {
  let attempts = 0;
  const client = new OpenAICompatibleStructuredClient({
    apiKey: "bad-key",
    modelId: "test-model",
    maxRetries: 3,
    fetch: async () => {
      attempts++;
      return new Response("Unauthorized", { status: 401 });
    },
  });

  await assert.rejects(
    client.complete({ system: "system", input: "input", signal: new AbortController().signal }),
    (err: unknown) => {
      assert.ok(err instanceof ModelProviderError);
      assert.equal(err.code, "authentication");
      return true;
    }
  );
  assert.equal(attempts, 1, "Never retries 401");
});

test("OpenAICompatibleStructuredClient does NOT retry after partial stream tokens have been emitted", async () => {
  let attempts = 0;
  const streamBody = new ReadableStream({
    start(controller) {
      // Send one valid chunk that emits visible content
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial output"}}]}\n\n'));
      // Then send a 503 error chunk mid-stream
      controller.enqueue(new TextEncoder().encode('data: {"error":{"code":503,"message":"capacity drop mid-stream"}}\n\n'));
    },
  });

  const emittedChunks: string[] = [];
  const client = new OpenAICompatibleStructuredClient({
    apiKey: "test",
    modelId: "test-model",
    stream: true,
    maxRetries: 3,
    fetch: async () => {
      attempts++;
      return new Response(streamBody, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  await assert.rejects(
    client.complete({
      system: "system",
      input: "input",
      signal: new AbortController().signal,
      onProgress: (chunk) => emittedChunks.push(chunk),
    }),
    (err: unknown) => {
      assert.ok(err instanceof ModelProviderError);
      return true;
    }
  );

  assert.equal(emittedChunks.length, 1);
  assert.equal(emittedChunks[0], "partial output");
  assert.equal(attempts, 1, "Did not retry because partial tokens were already emitted");
});

test("OpenAICompatibleStructuredClient classifies and retries a pre-content streaming server error", async () => {
  let attempts = 0;
  const client = new OpenAICompatibleStructuredClient({ apiKey: "test", modelId: "test-model", stream: true, maxRetries: 1,
    fetch: async () => {
      attempts++;
      const payload = attempts === 1
        ? 'data: {"error":{"code":500,"message":"Internal server error"}}\n\n'
        : 'data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"}}]}\n\ndata: [DONE]\n\n';
      return new Response(payload, { headers: { "content-type": "text/event-stream" } });
    } });
  assert.equal(await client.complete({ system: "system", input: "input", signal: new AbortController().signal }), '{"ok":true}');
  assert.equal(attempts, 2);
});

test("streaming server errors after visible content are classified as transport and are not replayed", async () => {
  let attempts = 0;
  const client = new OpenAICompatibleStructuredClient({ apiKey: "test", modelId: "test-model", stream: true, maxRetries: 2,
    fetch: async () => {
      attempts++;
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: {"error":{"code":500,"message":"Internal server error"}}\n\n'));
      } });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    } });
  await assert.rejects(client.complete({ system: "system", input: "input", signal: new AbortController().signal }),
    error => error instanceof ModelProviderError && error.code === "transport");
  assert.equal(attempts, 1);
});

test("G05: parseRetryAfter uncapped >60s and guards negative/overflow inputs", () => {
  // Numeric > 60s
  assert.equal(parseRetryAfter("120"), 120_000, "120s must not be truncated to 60s");
  assert.equal(parseRetryAfter("300"), 300_000, "300s must not be truncated to 60s");
  // Negative values must not fall through to Date.parse
  assert.equal(parseRetryAfter("-10"), undefined, "Negative seconds must return undefined");
  assert.equal(parseRetryAfter("-1"), undefined);
  // Zero seconds bounded to 50ms min
  assert.equal(parseRetryAfter("0"), 50);
  // HTTP date > 60s
  const futureDate = new Date(Date.now() + 90_000).toUTCString();
  const parsed = parseRetryAfter(futureDate);
  assert.ok(typeof parsed === "number" && parsed >= 85_000 && parsed <= 95_000, "HTTP-date > 60s must not be capped");
  // Past date bounded to 50ms
  const pastDate = new Date(Date.now() - 30_000).toUTCString();
  assert.equal(parseRetryAfter(pastDate), 50);
});

test("G05: computeBackoffDelay does not truncate server-specified Retry-After", () => {
  assert.equal(computeBackoffDelay(0, 120_000), 120_000, "Server delay must not be capped at 10s");
  assert.equal(computeBackoffDelay(2, 45_000), 45_000, "Server delay must be honored uncapped");
  // Exponential backoff without retryAfter remains bounded at 10s
  const delay10 = computeBackoffDelay(10);
  assert.ok(delay10 <= 10_000, "Exponential backoff must be bounded at maxDelayMs");
});

test("G05: ProviderRequestScheduler sets provider cooldown and releases capacity during backoff", async () => {
  const scheduler = new ProviderRequestScheduler({ defaultConcurrency: 1 });
  
  let attempts = 0;
  const task = scheduler.schedule({
    providerKey: "test-prov",
    execute: async () => {
      attempts++;
      if (attempts === 1) {
        // First attempt triggers backoff
        await scheduler.sleepWithBackoff("test-prov", 50);
        attempts++;
      }
      return "success";
    },
  });

  // Give microtask tick to enter sleepWithBackoff
  await new Promise((r) => setTimeout(r, 10));

  // During backoff, active count must be 0 (released permit) and provider must be cooling down
  const status = scheduler.getProviderStatus("test-prov");
  assert.equal(status.activeRequests, 0, "Capacity permit must be released during backoff");
  assert.ok(status.cooldownUntil && status.cooldownUntil > Date.now(), "Provider cooldown must be recorded");

  const res = await task;
  assert.equal(res, "success");
  assert.equal(attempts, 2);
  assert.equal(scheduler.getProviderStatus("test-prov").activeRequests, 0);
});

test("G05: OpenAICompatibleStructuredClient throws when Retry-After exceeds remaining request deadline", async () => {
  const client = new OpenAICompatibleStructuredClient({
    apiKey: "test",
    modelId: "test-model",
    timeoutMs: 1000,
    maxRetries: 2,
    fetch: async () => {
      return new Response("Rate limit exceeded", {
        status: 429,
        headers: { "retry-after": "120" }, // 120s wait with 1s request deadline
      });
    },
  });

  await assert.rejects(
    client.complete({ system: "sys", input: "in", signal: new AbortController().signal }),
    (err: unknown) => {
      assert.ok(err instanceof ModelProviderError);
      assert.equal(err.code, "timeout");
      assert.match(err.message, /exceeds remaining deadline/);
      return true;
    }
  );
});

test("G05: Cancellation during cooldown immediately settles with cancelled error", async () => {
  const scheduler = new ProviderRequestScheduler({ defaultConcurrency: 1 });
  const controller = new AbortController();

  const promise = scheduler.schedule({
    providerKey: "prov",
    signal: controller.signal,
    execute: async () => {
      await scheduler.sleepWithBackoff("prov", 10_000, controller.signal);
      return "should-not-reach";
    },
  });

  await new Promise((r) => setTimeout(r, 10));
  controller.abort();

  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof ModelProviderError);
    assert.equal(err.code, "cancelled");
    return true;
  });

  assert.equal(scheduler.getProviderStatus("prov").activeRequests, 0, "No leaked permit on cancelled cooldown");
});

test("ProviderRequestScheduler coordinates with ModelAdmissionPort and wakes on capacity change", async () => {
  let governorCapacityGranted = false;
  let capacityListener: (() => void) | undefined;
  let leaseReleased = false;

  const mockAdmissionPort = {
    tryAcquire: () => {
      if (!governorCapacityGranted) {
        return { granted: false as const };
      }
      return {
        granted: true as const,
        leaseId: "mock-lease-1",
        release: () => { leaseReleased = true; },
      };
    },
    release: () => { leaseReleased = true; },
    subscribeCapacityChange: (listener: () => void) => {
      capacityListener = listener;
      return () => { capacityListener = undefined; };
    },
  };

  const scheduler = new ProviderRequestScheduler({
    defaultConcurrency: 4,
    admissionPort: mockAdmissionPort,
  });

  let taskExecuted = false;
  const taskPromise = scheduler.schedule({
    providerKey: "test-prov",
    execute: async () => {
      taskExecuted = true;
      return "admitted-and-run";
    },
  });

  await new Promise((r) => setTimeout(r, 10));
  assert.equal(taskExecuted, false, "Task must not execute while Governor denies admission");
  assert.equal(scheduler.getProviderStatus("test-prov").activeRequests, 0);
  assert.equal(scheduler.getProviderStatus("test-prov").queuedRequests, 1);

  // Now Governor frees capacity and fires capacity notification
  governorCapacityGranted = true;
  capacityListener?.();

  const result = await taskPromise;
  assert.equal(result, "admitted-and-run");
  assert.equal(taskExecuted, true);
  assert.equal(leaseReleased, true, "Governor lease must be released on completion");
  assert.equal(scheduler.getProviderStatus("test-prov").activeRequests, 0);
  assert.equal(scheduler.getProviderStatus("test-prov").queuedRequests, 0);
});

test("G04/G05: sleepWithBackoff coordinates with ModelAdmissionPort without deadlocks or lease leaks", async () => {
  const activeLeases = new Set<string>();
  let leaseCounter = 0;
  const mockPort: ModelAdmissionPort = {
    tryAcquire: (attempt) => {
      // Enforce max 1 concurrent model request per provider (reproducing Finding 1 / Finding 2 condition)
      let activeForConn = 0;
      for (const id of activeLeases) {
        if (id.startsWith(`lease-${attempt.connectionId}-`)) activeForConn++;
      }
      if (activeForConn >= 1) {
        return { granted: false as const };
      }
      const id = `lease-${attempt.connectionId}-${++leaseCounter}`;
      activeLeases.add(id);
      return {
        granted: true as const,
        leaseId: id,
        release: () => { activeLeases.delete(id); },
      };
    },
    release: (leaseId: string) => {
      activeLeases.delete(leaseId);
    },
    subscribeCapacityChange: () => () => {},
  };

  const scheduler = new ProviderRequestScheduler({
    defaultConcurrency: 1,
    admissionPort: mockPort,
  });

  const timer = setTimeout(() => {
    assert.fail("DEADLOCK: sleepWithBackoff failed to resolve within timeout");
  }, 3000);

  const res = await scheduler.schedule({
    providerKey: "test",
    execute: async () => {
      assert.equal(activeLeases.size, 1, "Initial lease #1 held in execute");
      await scheduler.sleepWithBackoff("test", 20);
      assert.equal(activeLeases.size, 1, "Re-acquired lease #2 held after sleepWithBackoff");
      return "ok";
    },
  });

  clearTimeout(timer);
  assert.equal(res, "ok");
  assert.equal(activeLeases.size, 0, "All leases must be released when scheduled task finishes");
  assert.equal(scheduler.getProviderStatus("test").activeRequests, 0, "Active requests count must be 0");
});

test("G04/G05: sleepWithBackoff with explicit currentLease and leaseRef does not leak leases or deadlock", async () => {
  const activeLeases = new Set<string>();
  let leaseCounter = 0;
  const mockPort: ModelAdmissionPort = {
    tryAcquire: (attempt) => {
      let activeForConn = 0;
      for (const id of activeLeases) {
        if (id.startsWith(`lease-${attempt.connectionId}-`)) activeForConn++;
      }
      if (activeForConn >= 1) {
        return { granted: false as const };
      }
      const id = `lease-${attempt.connectionId}-${++leaseCounter}`;
      activeLeases.add(id);
      return {
        granted: true as const,
        leaseId: id,
        release: () => { activeLeases.delete(id); },
      };
    },
    release: (leaseId: string) => {
      activeLeases.delete(leaseId);
    },
    subscribeCapacityChange: () => () => {},
  };

  const scheduler = new ProviderRequestScheduler({
    defaultConcurrency: 1,
    admissionPort: mockPort,
  });

  const leaseRef: { current?: (() => void) | undefined } = {};
  const res = await scheduler.schedule({
    providerKey: "prov-ref",
    leaseRef,
    execute: async () => {
      assert.ok(typeof leaseRef.current === "function", "leaseRef.current must hold initial lease");
      const currentLease = leaseRef.current;
      leaseRef.current = undefined;
      const newLease = await scheduler.sleepWithBackoff("prov-ref", 20, undefined, currentLease);
      leaseRef.current = newLease;
      assert.ok(typeof newLease === "function", "sleepWithBackoff must return replacement lease");
      assert.equal(activeLeases.size, 1, "Single lease active after backoff re-acquire");
      return "ok-ref";
    },
  });

  assert.equal(res, "ok-ref");
  assert.equal(activeLeases.size, 0, "No leases leaked after completion with leaseRef");
  assert.equal(scheduler.getProviderStatus("prov-ref").activeRequests, 0);
});


