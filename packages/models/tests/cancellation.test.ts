import test from "node:test";
import assert from "node:assert/strict";
import { ModelProviderError, OpenAICompatibleStructuredClient } from "../src/index.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const payload = { choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 99 } };
const request = (signal: AbortSignal) => ({ system: "JSON", input: "hello", signal });
const hasCode = (code: string) => (error: unknown) => {
  assert.ok(error instanceof ModelProviderError);
  assert.equal(error.code, code);
  if (code === "timeout") {
    assert.ok(error.diagnostic && typeof error.diagnostic === "object");
    assert.ok("phase" in error.diagnostic);
  } else if (code !== "cancelled") assert.equal(error.diagnostic, undefined);
  assert.doesNotMatch(error.message, /PRIVATE/);
  return true;
};

test("pre-aborted requests never dispatch", async () => {
  let calls = 0;
  const client = new OpenAICompatibleStructuredClient({ apiKey: "", modelId: "test", fetch: async () => {
    calls++;
    return Response.json(payload);
  } });
  const controller = new AbortController();
  controller.abort("PRIVATE reason");
  await assert.rejects(client.complete(request(controller.signal)), hasCode("cancelled"));
  assert.equal(calls, 0);
  assert.equal(client.usage(), undefined);
});

for (const phase of ["fetch", "body"] as const) {
  for (const outcome of ["success", "failure"] as const) {
    test(`abort during ${phase} settles before noncooperative late ${outcome}`, { timeout: 1000 }, async () => {
      const pending = deferred<any>();
      const started = deferred<void>();
      let bodyCalls = 0;
      const response = { ok: true, json: () => {
        bodyCalls++;
        started.resolve();
        return phase === "body" ? pending.promise : Promise.resolve(payload);
      } } as Response;
      let calls = 0;
      const client = new OpenAICompatibleStructuredClient({ apiKey: "", modelId: "test", fetch: async () => {
        if (++calls === 1) return Response.json({ ...payload, usage: { prompt_tokens: 7 } });
        if (phase === "fetch") started.resolve();
        return phase === "fetch" ? pending.promise : response;
      } });
      await client.complete(request(new AbortController().signal));
      const controller = new AbortController();
      const completion = client.complete(request(controller.signal));
      const rejected = assert.rejects(completion, hasCode("cancelled"));
      await started.promise;
      controller.abort("PRIVATE reason");
      await rejected;
      if (outcome === "success") pending.resolve(phase === "fetch" ? response : payload);
      else pending.reject(new Error("PRIVATE failure"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(client.usage(), { inputTokens: 7 });
      assert.equal(bodyCalls, phase === "fetch" ? 0 : 1);
    });
  }
  test(`timeout bounds noncooperative ${phase}`, { timeout: 1000 }, async () => {
    const client = new OpenAICompatibleStructuredClient({ apiKey: "", modelId: "test", timeoutMs: 5,
      fetch: async () => phase === "fetch" ? new Promise<Response>(() => {})
        : { ok: true, json: () => new Promise(() => {}) } as Response });
    await assert.rejects(client.complete(request(new AbortController().signal)), hasCode("timeout"));
    assert.equal(client.usage(), undefined);
  });
}

test("invalid HTTP JSON is sanitized invalid-response; body I/O stays transport", async () => {
  for (const [response, code] of [
    [new Response("PRIVATE malformed JSON"), "invalid-response"],
    [Response.json(null), "invalid-response"],
    [{ ok: true, json: async () => { throw new TypeError("PRIVATE I/O failure"); } }, "transport"],
  ] as const) {
    const client = new OpenAICompatibleStructuredClient({ apiKey: "", modelId: "test", fetch: async () => response as Response });
    await assert.rejects(client.complete(request(new AbortController().signal)), hasCode(code));
  }
});

test("stream metrics separate delayed response headers from first generated content", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"}}]}\n\n'));
    controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
    controller.close();
  } });
  const client = new OpenAICompatibleStructuredClient({ apiKey: "", modelId: "test", maxRetries: 0, fetch: async () => {
    await new Promise(resolve => setTimeout(resolve, 15));
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  } });
  assert.equal(await client.complete(request(new AbortController().signal)), '{"ok":true}');
  const metrics = client.metrics()!;
  assert.ok(metrics.ttfbMs !== undefined && metrics.ttfbMs >= 10);
  assert.ok(metrics.ttftMs !== undefined && metrics.ttftMs >= metrics.ttfbMs);
  assert.ok(metrics.durationMs >= metrics.ttftMs!);
});

test("idle streamed response times out distinctly from the overall request deadline", async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode(": connected\n\n"));
  } });
  const client = new OpenAICompatibleStructuredClient({ apiKey: "", modelId: "test", timeoutMs: 200, idleTimeoutMs: 10,
    maxRetries: 0, fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }) });
  await assert.rejects(client.complete(request(new AbortController().signal)), (error: unknown) => {
    assert.ok(error instanceof ModelProviderError);
    assert.equal(error.code, "timeout");
    assert.match(error.message, /became idle/);
    assert.deepEqual(error.diagnostic && (error.diagnostic as { phase: string }).phase, "body");
    return true;
  });
});

test("retry after stream interruption is allowed only before any content reaches the caller", async () => {
  for (const partial of [false, true]) {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      if (calls === 1) {
        const body = new ReadableStream<Uint8Array>({ start(controller) {
          if (partial) controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
          setTimeout(() => controller.error(Object.assign(new TypeError("fetch failed"), { code: "ECONNRESET" })), partial ? 10 : 0);
        } });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"}}]}\n\n'));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); controller.close();
      } });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
    const output: string[] = [];
    const client = new OpenAICompatibleStructuredClient({ apiKey: "", modelId: "test", maxRetries: 1, fetch: fetcher });
    if (partial) {
      await assert.rejects(client.complete({ ...request(new AbortController().signal), onProgress: chunk => output.push(chunk) }));
      assert.equal(calls, 1);
      assert.deepEqual(output, ["partial"]);
    } else {
      assert.equal(await client.complete(request(new AbortController().signal)), '{"ok":true}');
      assert.equal(calls, 2);
    }
  }
});

test("malformed SSE payloads fail as invalid responses instead of silently succeeding", async () => {
  for (const source of [
    "data: {not-json}\n\ndata: [DONE]\n\n",
    'data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"}}]}\n\ndata: {not-json}\n\ndata: [DONE]\n\n',
  ]) {
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(source)); controller.close();
    } });
    const client = new OpenAICompatibleStructuredClient({ apiKey: "", modelId: "test", maxRetries: 0,
      fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }) });
    await assert.rejects(client.complete(request(new AbortController().signal)), hasCode("invalid-response"));
  }
});

for (const phase of ["fetch", "body"] as const) {
  test(`abort accompanying a resolved ${phase} cannot return success`, async () => {
    const controller = new AbortController();
    const client = new OpenAICompatibleStructuredClient({ apiKey: "", modelId: "test", fetch: async () => {
      if (phase === "fetch") controller.abort();
      return { ok: true, json: async () => {
        controller.abort();
        return payload;
      } } as Response;
    } });
    await assert.rejects(client.complete(request(controller.signal)), hasCode("cancelled"));
    assert.equal(client.usage(), undefined);
  });
}

test("completion cleans up timeout and cancellation listeners on every exit", async (t) => {
  const clear = t.mock.method(globalThis, "clearTimeout");
  for (const outcome of ["success", "transport", "invalid-response", "cancelled", "timeout"] as const) {
    const controller = new AbortController();
    const add = t.mock.method(controller.signal, "addEventListener");
    const remove = t.mock.method(controller.signal, "removeEventListener");
    let transportSignal: AbortSignal | undefined;
    let removeTransport: ReturnType<typeof t.mock.method> | undefined;
    const client = new OpenAICompatibleStructuredClient({ apiKey: "", modelId: "test", timeoutMs: 5,
      fetch: async (_url, init) => {
        transportSignal = init!.signal!;
        removeTransport = t.mock.method(transportSignal, "removeEventListener");
        if (outcome === "cancelled") controller.abort();
        if (outcome === "timeout") return new Promise<Response>(() => {});
        if (outcome === "transport") throw new Error("PRIVATE failure");
        return outcome === "invalid-response" ? new Response("PRIVATE invalid") : Response.json(payload);
      } });
    const before = clear.mock.callCount();
    const completion = client.complete(request(controller.signal));
    if (outcome === "success") assert.equal(await completion, '{"ok":true}');
    else await assert.rejects(completion, hasCode(outcome));
    assert.ok(clear.mock.callCount() > before, "request and response-read timeout handles are cleaned up");
    assert.equal(remove.mock.callCount(), 1);
    assert.equal(remove.mock.calls[0]!.arguments[1], add.mock.calls[0]!.arguments[1]);
    assert.equal(removeTransport!.mock.callCount(), 1);
    if (outcome === "success") {
      controller.abort();
      assert.equal(transportSignal!.aborted, false);
    }
  }
});
