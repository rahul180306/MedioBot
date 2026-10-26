import assert from "node:assert/strict";
import test from "node:test";
import { MediobotRuntimeClient } from "../../src/runtime/client.ts";

test("runtime client carries thread and turn identity through submission, events, and cancellation", async () => {
  const requests: string[] = [];
  const requestBodies: string[] = [];
  const eventSources: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalEventSource = (globalThis as { EventSource?: unknown }).EventSource;

  class FakeEventSource {
    onerror: ((event: Event) => void) | null = null;
    readonly url: string;
    constructor(url: string) { this.url = url; eventSources.push(url); }
    addEventListener() {}
    close() {}
  }

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(`${String(input)} ${init?.method ?? "GET"}`);
    if (typeof init?.body === "string") requestBodies.push(init.body);
    return Response.json({ turnId: "shared-turn", taskId: "task-fixture" });
  }) as typeof fetch;
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;

  try {
    const client = new MediobotRuntimeClient();
    const options = { specialistId: "cody", modelSelection: { providerConnectionId: "cody-provider", modelId: "cody-model" } } as Parameters<MediobotRuntimeClient["startTurn"]>[2];
    await client.startTurn("thread-a", "A", options, "shared-turn");
    await client.startTurn("thread-b", "B", options, "shared-turn");
    await client.cancelTurn("thread-a", "shared-turn");

    assert.equal(eventSources.length, 2, "same turnId in separate threads requires separate event sources");
    assert.equal(new URL(eventSources[0]!, "http://localhost").searchParams.get("threadId"), "thread-a");
    assert.equal(new URL(eventSources[1]!, "http://localhost").searchParams.get("threadId"), "thread-b");
    const cancelRequest = requests.find((request) => request.includes("/cancel?"));
    assert.ok(cancelRequest);
    assert.equal(new URL(cancelRequest.split(" ")[0]!, "http://localhost").searchParams.get("threadId"), "thread-a");
    const submitted = JSON.parse(requestBodies[0]!) as Record<string, unknown>;
    assert.equal(submitted.specialistId, "cody");
    assert.deepEqual(submitted.modelSelection, { providerConnectionId: "cody-provider", modelId: "cody-model" });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEventSource === undefined) delete (globalThis as { EventSource?: unknown }).EventSource;
    else (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
  }
});

test("runtime client delivers a replayed approval resolution without closing the live turn stream", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = (globalThis as { EventSource?: unknown }).EventSource;
  const streams: Array<{ closed: boolean; dispatch: (name: string, data: unknown) => void }> = [];

  class FakeEventSource {
    onerror: ((event: Event) => void) | null = null;
    closed = false;
    private readonly listeners = new Map<string, (event: MessageEvent) => void>();
    constructor(_url: string) {
      streams.push({ closed: false, dispatch: (name, data) => this.listeners.get(name)?.({ data: JSON.stringify(data) } as MessageEvent) });
    }
    addEventListener(name: string, listener: EventListenerOrEventListenerObject) {
      this.listeners.set(name, listener as (event: MessageEvent) => void);
    }
    close() {
      this.closed = true;
      const stream = streams.at(-1);
      if (stream) stream.closed = true;
    }
  }

  globalThis.fetch = (async () => Response.json({ turnId: "approval-turn", taskId: "approval-task" })) as typeof fetch;
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  try {
    const client = new MediobotRuntimeClient();
    const received: Array<{ type: string; payload: unknown }> = [];
    client.onEvent(event => received.push(event as { type: string; payload: unknown }));
    await client.startTurn("approval-thread", "run a reviewed write", {} as Parameters<MediobotRuntimeClient["startTurn"]>[2], "approval-turn");

    streams[0]!.dispatch("mediobot", {
      id: "approval-resolved-1", type: "approval.resolved", threadId: "approval-thread", turnId: "approval-turn",
      timestamp: Date.now(), payload: { approval: { approvalId: "approval-1", status: "approved" } },
    });

    assert.equal(received.length, 1, "the approval resolution must pass runtime-event validation and reach subscribers");
    assert.equal(received[0]!.type, "approval.resolved");
    assert.equal((received[0]!.payload as { approval: { approvalId: string } }).approval.approvalId, "approval-1");
    assert.equal(streams[0]!.closed, false, "approval resolution is nonterminal; keep the stream open for resumed work");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEventSource === undefined) delete (globalThis as { EventSource?: unknown }).EventSource;
    else (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
  }
});
