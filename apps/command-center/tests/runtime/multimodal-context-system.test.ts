import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AttachmentStore } from "../../src/storage/attachmentStore.ts";
import { extractPdfText } from "../../src/storage/pdfExtractor.ts";
import { MultimodalContextIngestion } from "../../src/runtime/contextIngestion.ts";
import { deflateSync } from "node:zlib";

test("Multimodal AttachmentStore - Storage, Sniffing, and Isolation", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mediobot-attach-test-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const store = new AttachmentStore(tempDir);

  // 1. Valid PNG signature sniffing
  const validPngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const pngMeta = await store.save("screenshot.png", "image/png", validPngHeader, {
    workspaceId: "ws-123",
    threadId: "thread-abc",
  });
  assert.equal(pngMeta.name, "screenshot.png");
  assert.equal(pngMeta.mimeType, "image/png");
  assert.equal(pngMeta.kind, "image");
  assert.equal(pngMeta.workspaceId, "ws-123");
  assert.equal(pngMeta.threadId, "thread-abc");

  // 2. Retrieval by ID
  const retrieved = await store.get(pngMeta.id);
  assert.ok(retrieved);
  assert.equal(retrieved.id, pngMeta.id);
  assert.deepEqual(retrieved.bytes, validPngHeader);

  // 3. Workspace Isolation Verification
  const crossWorkspace = await store.get(pngMeta.id, { workspaceId: "ws-DIFFERENT" });
  assert.equal(crossWorkspace, undefined, "Cross-workspace access must be blocked by isolation boundary");

  const matchingWorkspace = await store.get(pngMeta.id, { workspaceId: "ws-123" });
  assert.ok(matchingWorkspace, "Matching workspace must be allowed");

  // 4. Forged image rejection
  const fakePng = Buffer.from("NOT_A_REAL_PNG_CONTENT");
  await assert.rejects(
    async () => {
      await store.save("fake.png", "image/png", fakePng);
    },
    /The image format could not be validated/,
    "Forged image must be rejected"
  );

  // 5. File size limits
  const emptyBuf = Buffer.alloc(0);
  await assert.rejects(async () => {
    await store.save("empty.txt", "text/plain", emptyBuf);
  }, /between 1 byte and 5 MB/);

  const oversizedBuf = Buffer.alloc(6 * 1024 * 1024);
  await assert.rejects(async () => {
    await store.save("huge.txt", "text/plain", oversizedBuf);
  }, /between 1 byte and 5 MB/);

  // 6. Path Traversal ID rejection
  const traversalAttempt = await store.get("../../etc/passwd");
  assert.equal(traversalAttempt, undefined, "Path traversal ID must be safely rejected");

  // 7. Removal
  await store.remove(pngMeta.id);
  const afterRemove = await store.get(pngMeta.id);
  assert.equal(afterRemove, undefined, "Removed attachment must no longer exist");
});

test("PDF Text and Metadata Extractor - Structured Parsing & Decompression", async () => {
  // Construct a synthetic minimal PDF with FlateDecode compressed content stream
  const textStream = "BT /F1 12 Tf 72 712 Td (Specification: Implement Button Component) Tj T* (Requirement 1: Blue background) Tj ET";
  const compressedStream = deflateSync(Buffer.from(textStream, "latin1"));

  const pdfRaw = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>
endobj
4 0 obj
<< /Length ${compressedStream.length} /Filter /FlateDecode >>
stream\r\n`;

  const pdfTail = `\r\nendstream
endobj
5 0 obj
<< /Title (Button Spec Document) /Author (Mediobot Architect) >>
endobj
xref
trailer
<< /Root 1 0 R /Info 5 0 R >>
%%EOF`;

  const fullPdfBuffer = Buffer.concat([
    Buffer.from(pdfRaw, "latin1"),
    compressedStream,
    Buffer.from(pdfTail, "latin1"),
  ]);

  const extracted = extractPdfText(fullPdfBuffer);
  assert.equal(extracted.pageCount, 1);
  assert.equal(extracted.metadata?.title, "Button Spec Document");
  assert.equal(extracted.metadata?.author, "Mediobot Architect");
  assert.ok(extracted.text.includes("Specification: Implement Button Component"), "Must extract compressed BT/ET text");
  assert.ok(extracted.text.includes("Requirement 1: Blue background"), "Must extract multi-line text");

  // Test malformed / non-PDF safety
  const nonPdf = Buffer.from("HELLO WORLD NOT PDF");
  const malformedResult = extractPdfText(nonPdf);
  assert.ok(malformedResult.warning, "Non-PDF should report safe warning without throwing");
});

test("Multimodal Context Ingestion - PDF, Code, Project References, and Routing", async (t) => {
  const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), "mediobot-ws-test-"));
  t.after(async () => {
    await rm(tempWorkspace, { recursive: true, force: true });
  });

  // Create sample project files inside workspace
  await mkdir(path.join(tempWorkspace, "src"), { recursive: true });
  await writeFile(path.join(tempWorkspace, "src", "Button.tsx"), "export const Button = () => <button>Click</button>;", "utf-8");
  await writeFile(path.join(tempWorkspace, ".env"), "SECRET_TOKEN=DO_NOT_LEAK", "utf-8");

  const ingestion = new MultimodalContextIngestion();

  // Test 1: Code attachment and project file reference
  const codeAttachment = {
    id: "11111111-2222-4333-8444-555555555555",
    name: "calculator.ts",
    mimeType: "text/plain",
    size: 50,
    kind: "code" as const,
    createdAt: Date.now(),
    hash: "hash123",
    bytes: Buffer.from("export function add(a: number, b: number) { return a + b; }", "utf-8"),
  };

  const resolved = await ingestion.resolve({
    prompt: "Look at @src/Button.tsx and attached calculator.ts",
    attachments: [codeAttachment],
    workspaceRoot: tempWorkspace,
    selectedModelCapabilities: { text: true, reasoning: true, vision: false, tools: true },
  });

  assert.ok(resolved.promptWithContext.includes("Attached File: calculator.ts"), "Attached code must be ingested");
  assert.ok(resolved.promptWithContext.includes("Project File Reference @src/Button.tsx"), "Safe project file reference must be resolved");
  assert.ok(resolved.promptWithContext.includes("<button>Click</button>"), "Referenced file content must be present");

  // Test 2: Sensitive file reference exclusion (.env)
  const sensitiveResolved = await ingestion.resolve({
    prompt: "Read @.env file please",
    attachments: [],
    workspaceRoot: tempWorkspace,
  });
  assert.ok(!sensitiveResolved.promptWithContext.includes("DO_NOT_LEAK"), ".env must never be read into prompt context");

  // Test 3: Path traversal attempt exclusion
  const traversalResolved = await ingestion.resolve({
    prompt: "Read @../../etc/passwd please",
    attachments: [],
    workspaceRoot: tempWorkspace,
  });
  assert.ok(!traversalResolved.promptWithContext.includes("etc/passwd]:"), "Path traversal must be excluded");
});

test("Multimodal Capability Routing - Vision Specialist Handoff vs Direct Multimodal", async () => {
  // Scenario A: Selected model has vision: true (e.g. DiffusionGemma or multimodal model)
  const visionIngestion = new MultimodalContextIngestion();
  const validPngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const imageAttachment = {
    id: "22222222-3333-4444-8555-666666666666",
    name: "ui.png",
    mimeType: "image/png",
    size: validPngHeader.length,
    kind: "image" as const,
    createdAt: Date.now(),
    hash: "imghash",
    bytes: validPngHeader,
  };

  const directResult = await visionIngestion.resolve({
    prompt: "Implement this UI",
    attachments: [imageAttachment],
    selectedModelCapabilities: { text: true, reasoning: false, vision: true, tools: false },
  });

  assert.equal(directResult.imageInputs.length, 1);
  assert.equal(directResult.imageInputs[0]?.mimeType, "image/png");
  assert.ok(directResult.imageInputs[0]?.dataUrl.startsWith("data:image/png;base64,"));
  assert.equal(directResult.unsupportedError, undefined);

  // Scenario B: Selected model has vision: false and mock vision specialist is registered
  const mockVisionClient = {
    complete: async () => JSON.stringify({ description: "Blue primary button with white label 'Submit'" }),
  };
  const mockResolver = {
    resolveForOperation: (op: string) => {
      if (op === "image-perception") {
        return {
          client: mockVisionClient,
          descriptor: { providerId: "nvidia", modelId: "google/diffusiongemma-26b-a4b-it", capabilities: { text: true, vision: true } },
        };
      }
      throw new Error("unsupported");
    },
  } as any;

  const delegatedIngestion = new MultimodalContextIngestion(mockResolver);
  const delegatedResult = await delegatedIngestion.resolve({
    prompt: "Implement button",
    attachments: [imageAttachment],
    selectedModelCapabilities: { text: true, reasoning: true, vision: false, tools: true }, // Text-only primary model!
  });

  assert.equal(delegatedResult.unsupportedError, undefined, "Must NOT fail with unsupported error when vision specialist is available");
  assert.ok(delegatedResult.visualPerception, "Visual perception findings must be created");
  assert.equal(delegatedResult.visualPerception?.modelId, "google/diffusiongemma-26b-a4b-it");
  assert.ok(delegatedResult.promptWithContext.includes("Visual Perception Analysis from Vision Specialist"), "Prompt must include vision specialist findings");

  // Scenario C: Selected model has vision: false and NO vision model is available
  const emptyIngestion = new MultimodalContextIngestion();
  const failedResult = await emptyIngestion.resolve({
    prompt: "Implement button",
    attachments: [imageAttachment],
    selectedModelCapabilities: { text: true, reasoning: true, vision: false, tools: true },
  });
  assert.ok(failedResult.unsupportedError?.includes("does not support image input"));
});

test("End-to-End HTTP Attachment & Turn API - Upload, Stream GET, Thread Persistence, and Cleanup", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mediobot-http-multimodal-"));
  const dbPath = path.join(tempDir, "mediobot.db");
  const { startCommandCenter } = await import("../../src/server.ts");
  const { createFakeComposition } = await import("../helpers/fakeComposition.ts");

  const fakeComposition = createFakeComposition({
    responseText: "I have analyzed the attachments and implemented the requirements.",
  });
  (fakeComposition as any).decideMaestroTurn = async () => ({
    type: "respond",
    message: "I have analyzed the attachments and implemented the requirements.",
    basis: "conversation",
    evidenceRefs: [],
  });

  const server = await startCommandCenter({
    databasePath: dbPath,
    composition: fakeComposition,
    vite: false,
    listen: true,
    port: 0,
  });

  t.after(async () => {
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const baseUrl = server.url;

  // 1. Upload a PNG attachment via POST /api/attachments
  const validPngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const uploadRes = await fetch(`${baseUrl}/api/attachments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "login_screen.png",
      type: "image/png",
      base64: validPngHeader.toString("base64"),
    }),
  });
  assert.equal(uploadRes.status, 201);
  const uploadData = await uploadRes.json() as { attachment: { id: string; name: string; mimeType: string; size: number } };
  assert.ok(uploadData.attachment.id);
  assert.equal(uploadData.attachment.name, "login_screen.png");
  assert.equal(uploadData.attachment.mimeType, "image/png");
  assert.equal(uploadData.attachment.size, validPngHeader.length);

  // 2. Stream attachment via GET /api/attachments/:id
  const getRes = await fetch(`${baseUrl}/api/attachments/${uploadData.attachment.id}`);
  assert.equal(getRes.status, 200);
  assert.equal(getRes.headers.get("content-type"), "image/png");
  assert.equal(getRes.headers.get("content-length"), String(validPngHeader.length));
  assert.ok(getRes.headers.get("cache-control")?.includes("immutable"));
  assert.ok(getRes.headers.get("content-disposition")?.includes("inline"));
  const receivedBytes = Buffer.from(await getRes.arrayBuffer());
  assert.deepEqual(receivedBytes, validPngHeader);

  // 3. Post a turn referencing image without vision model -> Must return 415
  const turnIdImg = `turn-img-${Date.now()}`;
  const threadIdImg = `thread-img-${Date.now()}`;
  const turnResImg = await fetch(`${baseUrl}/api/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      turnId: turnIdImg,
      threadId: threadIdImg,
      prompt: "Please review this screenshot",
      attachments: [{ id: uploadData.attachment.id, name: uploadData.attachment.name }],
    }),
  });
  assert.equal(turnResImg.status, 415, "Turn with image and no vision model must return 415");

  // 4. Upload code attachment and post turn -> Must return 200
  const codeContent = Buffer.from("export function hello() { return 'world'; }", "utf-8");
  const uploadCodeRes = await fetch(`${baseUrl}/api/attachments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "hello.ts",
      type: "text/plain",
      base64: codeContent.toString("base64"),
    }),
  });
  assert.equal(uploadCodeRes.status, 201);
  const codeUploadData = await uploadCodeRes.json() as { attachment: { id: string; name: string } };

  const turnId = `turn-${Date.now()}`;
  const threadId = `thread-${Date.now()}`;
  const turnRes = await fetch(`${baseUrl}/api/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      turnId,
      threadId,
      prompt: "Please inspect attached code",
      attachments: [{ id: codeUploadData.attachment.id, name: codeUploadData.attachment.name }],
    }),
  });
  assert.ok([200, 202].includes(turnRes.status), "Turn with code attachment must return 200 or 202");

  // 5. Retrieve thread history to verify attachment persistence
  const threadRes = await fetch(`${baseUrl}/api/threads/${threadId}`);
  assert.equal(threadRes.status, 200);
  const threadData = await threadRes.json() as { thread: { turns: Array<{ id: string; items: Array<{ type: string; attachments?: Array<{ id: string; name: string }> }> }> } };
  assert.ok(threadData.thread.turns.length > 0);
  const userMsg = threadData.thread.turns[0]?.items.find((it) => it.type === "user_message");
  assert.ok(userMsg?.attachments && userMsg.attachments.length === 1);
  assert.equal(userMsg.attachments[0]?.id, codeUploadData.attachment.id);
  assert.equal(userMsg.attachments[0]?.name, "hello.ts");

  // 6. Delete attachment via DELETE /api/attachments/:id
  const deleteRes = await fetch(`${baseUrl}/api/attachments/${uploadData.attachment.id}`, {
    method: "DELETE",
  });
  assert.equal(deleteRes.status, 200);

  // Subsequent GET must return 404
  const getAfterDelete = await fetch(`${baseUrl}/api/attachments/${uploadData.attachment.id}`);
  assert.equal(getAfterDelete.status, 404);
});
