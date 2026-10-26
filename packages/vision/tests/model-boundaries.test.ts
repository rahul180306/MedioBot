// Browser-free regressions: no browser fixtures, launch calls, network clients, or runtime adapters.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelProviderError } from "@mediobot-v2/models";
import { ModelActionValidationError, validateDecision } from "../src/model.ts";
import { createModelPerceptionProvider, PerceptionFailure, safePerceptionFailure } from "../src/perception.ts";
import type { BrowserObservation } from "../src/index.ts";
import type { ResourceId } from "@mediobot-v2/domain";

const observation: BrowserObservation = { revision: 1, fingerprint: "synthetic", url: "about:blank", title: "", text: "",
  elements: [{ id: "e1", role: "button", name: "Edit", enabled: true }] };
const provenance = { resourceId: "synthetic-resource" as ResourceId, revision: 1, fingerprint: "synthetic",
  imageHash: "synthetic-image", width: 10, height: 10 };

test("pure validator permits only known diagnostic names and counts unknown names, including nested keys", () => {
  for (const raw of [
    '{"type":"PatientAlice","PatientBob":"private"}',
    '{"action":{"type":"PatientAlice","PatientBob":"private","targetId":"e1"},"PatientCarol":true}',
    '{"type":"click","targetId":"e1","PatientAlice":true}',
  ]) {
    assert.throws(() => validateDecision(raw, observation), (error: unknown) => {
      assert.ok(error instanceof ModelActionValidationError);
      assert.ok(!/Patient|private/.test(JSON.stringify({ message: error.message, diagnostic: error.diagnostic })));
      assert.equal(error.diagnostic.unknownKeyCount, 1);
      if (error.diagnostic.hasAction) {
        assert.deepEqual(error.diagnostic.nestedKeys, ["targetId", "type"]);
        assert.equal(error.diagnostic.nestedUnknownKeyCount, 1);
        assert.equal(error.diagnostic.nestedType, "unknown");
      } else assert.ok(["click", "unknown"].includes(error.diagnostic.type!));
      return true;
    });
  }
  assert.deepEqual(validateDecision('{"type":"click","targetId":"e1"}', observation),
    { type: "click", targetId: "e1", observationRevision: 1 });
});

test("pure perception encoding shares the supplied PNG buffer and respects its offset and length", async () => {
  const storage = new Uint8Array([99, 1, 2, 3, 88]);
  const bytes = storage.subarray(1, 4);
  const provider = createModelPerceptionProvider({ async complete(request) {
    assert.equal(request.images![0]!.dataUrl, "data:image/png;base64,AQID");
    return '{"facts":[]}';
  } });
  const from = Buffer.from;
  let usedView = false;
  Buffer.from = ((...args: unknown[]) => {
    assert.notEqual(args[0], bytes, "must not make an unzeroed image copy");
    if (args[0] === storage.buffer) {
      assert.deepEqual(args.slice(1), [bytes.byteOffset, bytes.byteLength]); usedView = true;
    }
    return Reflect.apply(from, Buffer, args);
  }) as typeof Buffer.from;
  try {
    assert.deepEqual(await provider.perceive({ observation, provenance, bytes, signal: new AbortController().signal }), []);
    assert.equal(usedView, true);
  } finally { Buffer.from = from; }
});

test("pure perception preserves safe model categories without messages, causes or diagnostic payloads", async () => {
  for (const code of ["authentication", "capacity", "invalid-response"] as const) {
    const provider = createModelPerceptionProvider({ async complete() {
      if (code === "invalid-response") return '{"PatientAlice":"private response"}';
      throw new ModelProviderError(code, "PatientAlice private provider message", { PatientBob: "private" });
    } });
    await assert.rejects(provider.perceive({ observation, provenance, bytes: new Uint8Array([1]),
      signal: new AbortController().signal }), (error: unknown) => {
      assert.ok(error instanceof PerceptionFailure);
      assert.deepEqual(error.diagnostic, { kind: "perception-failure", source: "model", code });
      assert.ok(!/Patient|private/.test(JSON.stringify({ message: error.message, error })));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  const environment = safePerceptionFailure(new Error("PatientAlice private capture failure"));
  assert.deepEqual(environment.diagnostic, { kind: "perception-failure", source: "environment", code: "environment" });
  assert.ok(!environment.message.includes("PatientAlice"));
});

test("pure perception failure normalization rejects arbitrary runtime category strings", () => {
  const untrusted = new ModelProviderError("PatientAlice" as "transport", "PatientBob", { PatientCarol: true });
  const safe = safePerceptionFailure(untrusted);
  assert.deepEqual(safe.diagnostic, { kind: "perception-failure", source: "model", code: "invalid-response" });
  assert.ok(!JSON.stringify({ message: safe.message, safe }).includes("Patient"));
});
