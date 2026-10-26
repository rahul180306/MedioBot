import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttachmentStore, MAX_ATTACHMENT_BYTES } from "../../src/storage/attachmentStore.ts";

test("attachment store uses opaque bounded paths and validates image bytes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mediobot-attachments-"));
  try {
    const store = new AttachmentStore(directory);
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1]);
    const metadata = await store.save("../../private.png", "image/png", png);
    assert.equal(metadata.name, "private.png");
    assert.match(metadata.id, /^[0-9a-f-]{36}$/i);
    assert.deepEqual((await store.get(metadata.id))?.bytes, png);
    assert.equal(await store.get("../../private.png"), undefined);
    await assert.rejects(store.save("bad.png", "image/png", Buffer.from("not an image")), /could not be validated/);
    await assert.rejects(store.save("large.txt", "text/plain", Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)), /5 MB/);
    await store.remove(metadata.id);
    assert.equal(await store.get(metadata.id), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
