import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startCommandCenter } from "../../src/server.ts";
import { createComposition } from "../../src/composition.ts";
import { getModelRegistry } from "../../src/runtime/modelRegistry.ts";

test("E2E Native Workspace: direct editing, disk sync, conflict protection, and path containment", async (t) => {
  // 1. Create a disposable workspace directory completely OUTSIDE the repository
  const disposableDir = await mkdtemp(path.join(os.tmpdir(), "mediobot-native-workspace-test-"));
  t.after(() => rm(disposableDir, { recursive: true, force: true }));

  await mkdir(path.join(disposableDir, "src"));
  await writeFile(path.join(disposableDir, "src", "main.ts"), 'console.log("initial version");\n');
  await writeFile(path.join(disposableDir, "package.json"), '{\n  "name": "disposable-app",\n  "version": "1.0.0"\n}\n');

  // Start the command center without an initial workspace root
  const composition = createComposition();
  const app = await startCommandCenter({ composition, vite: false, listen: false });
  t.after(() => app.close());

  // Connect development providers Dahl and NVIDIA via provider repository
  app.providerRepo.save({
    id: "dahl",
    providerType: "dahl",
    displayName: "Dahl",
    baseUrl: "https://api.minimaxi.chat/v1",
    connected: true,
    enabled: true,
    models: [
      {
        id: "MiniMaxAI/MiniMax-M2.7",
        name: "MiniMax M2.7",
        enabled: true,
        capabilities: { text: true, reasoning: true, vision: false, tools: true },
      },
    ],
  }, "test-only-dahl-key");
  app.providerRepo.save({
    id: "nvidia",
    providerType: "nvidia",
    displayName: "NVIDIA",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    connected: true,
    enabled: true,
    models: [
      {
        id: "google/diffusiongemma-26b-a4b-it",
        name: "DiffusionGemma",
        enabled: true,
        capabilities: { text: true, reasoning: true, vision: true, tools: false },
      },
    ],
  }, "test-only-nvidia-key");

  // 2. Model Registry: Central registry must return Dahl and NVIDIA without leaking secrets
  const modelsRes = await request(app, "GET", "/api/models");
  assert.equal(modelsRes.status, 200);
  const { models } = modelsRes.json() as { models: Array<Record<string, unknown>> };
  assert.ok(models.length >= 2);
  const minimax = models.find((m) => m.name === "MiniMax M2.7");
  assert.ok(minimax);
  assert.equal(minimax.providerName, "Dahl");
  assert.equal(minimax.modality, "text");
  assert.equal(minimax.registered, true);

  const diffusion = models.find((m) => m.name === "DiffusionGemma");
  assert.ok(diffusion);
  assert.equal(diffusion.providerName, "NVIDIA");
  assert.equal(diffusion.modality, "vision");
  assert.equal(diffusion.registered, true);

  // Assert NO secrets or keys leaked in model registry API
  const registryText = JSON.stringify(models);
  assert.equal(registryText.includes("dahl_"), false);
  assert.equal(registryText.includes("nvapi-"), false);

  // 3. Register real workspace via pick-directory
  const pickRes = await request(app, "POST", "/api/workspace/pick-directory", JSON.stringify({ path: disposableDir }));
  assert.equal(pickRes.status, 200);
  const pickData = pickRes.json() as { project: { id: string; name: string; path: string }; cancelled: boolean };
  assert.equal(pickData.cancelled, false);
  assert.ok(pickData.project.id);
  assert.equal(pickData.project.name, path.basename(disposableDir));
  const canonicalDir = await (await import("node:fs/promises")).realpath(disposableDir);
  assert.equal(pickData.project.path, canonicalDir);

  const projectId = pickData.project.id;

  // 4. Explorer listing: Explorer shows ONLY the real files from disposable project, NO dummy Vite files
  const filesRes = await request(app, "GET", `/api/projects/${projectId}/files`);
  assert.equal(filesRes.status, 200);
  const { entries } = filesRes.json() as { entries: Array<{ name: string; type: string }> };
  const entryNames = entries.map((e) => e.name);
  assert.ok(entryNames.includes("src"));
  assert.ok(entryNames.includes("package.json"));
  assert.equal(entryNames.includes("index.html"), false);
  assert.equal(entryNames.includes("vite.config.ts"), false);
  assert.equal(entryNames.includes("tsconfig.json"), false);

  // 5. Direct Read from workspace
  const openRes = await request(app, "GET", `/api/projects/${projectId}/file?path=src%2Fmain.ts`);
  assert.equal(openRes.status, 200);
  const version = openRes.json() as { content: string; hash: string };
  assert.equal(version.content, 'console.log("initial version");\n');

  // 6. Direct Write / Save through Mediobot
  const newContent = 'console.log("edited by mediobot");\n';
  const saveRes = await request(
    app,
    "PUT",
    `/api/projects/${projectId}/file`,
    JSON.stringify({ path: "src/main.ts", content: newContent, expectedHash: version.hash })
  );
  assert.equal(saveRes.status, 200);

  // 7. Verify disk directly outside Mediobot
  const diskContent = await readFile(path.join(disposableDir, "src", "main.ts"), "utf8");
  assert.equal(diskContent, newContent);

  // 8. Stale write conflict protection
  const staleRes = await request(
    app,
    "PUT",
    `/api/projects/${projectId}/file`,
    JSON.stringify({ path: "src/main.ts", content: "stale content", expectedHash: version.hash })
  );
  assert.equal(staleRes.status, 409);

  // 9. External modification + Refresh
  const externalContent = 'console.log("externally modified");\n';
  await writeFile(path.join(disposableDir, "src", "main.ts"), externalContent);

  const refreshRes = await request(app, "GET", `/api/projects/${projectId}/file?path=src%2Fmain.ts`);
  assert.equal(refreshRes.status, 200);
  const refreshedVersion = refreshRes.json() as { content: string; hash: string };
  assert.equal(refreshedVersion.content, externalContent);

  // 10. Create new file through Explorer
  const createRes = await request(
    app,
    "POST",
    `/api/projects/${projectId}/files`,
    JSON.stringify({ parentPath: "src", name: "feature.ts", type: "file" })
  );
  assert.equal(createRes.status, 201);
  assert.equal(await readFile(path.join(disposableDir, "src", "feature.ts"), "utf8"), "");

  // 11. Rename entry
  const renameRes = await request(
    app,
    "PATCH",
    `/api/projects/${projectId}/files`,
    JSON.stringify({ path: "src/feature.ts", name: "api.ts" })
  );
  assert.equal(renameRes.status, 200);
  assert.equal(await readFile(path.join(disposableDir, "src", "api.ts"), "utf8"), "");
  await assert.rejects(readFile(path.join(disposableDir, "src", "feature.ts"), "utf8"), { code: "ENOENT" });

  // 12. Delete entry
  const deleteRes = await request(
    app,
    "DELETE",
    `/api/projects/${projectId}/files`,
    JSON.stringify({ path: "src/api.ts" })
  );
  assert.equal(deleteRes.status, 200);
  await assert.rejects(readFile(path.join(disposableDir, "src", "api.ts"), "utf8"), { code: "ENOENT" });

  // 13. Path Containment: attempts to escape project root are strictly rejected
  const escapeRes = await request(app, "GET", `/api/projects/${projectId}/file?path=..%2Foutside.txt`);
  assert.ok(escapeRes.status === 403 || escapeRes.status === 404, `Expected 403 or 404, got ${escapeRes.status}`);

  // 14. Project identity deduplication
  const secondPick = await request(app, "POST", "/api/workspace/pick-directory", JSON.stringify({ path: disposableDir }));
  assert.equal(secondPick.status, 200);
  const secondData = secondPick.json() as { project: { id: string } };
  assert.equal(secondData.project.id, projectId);
});

// Helper for HTTP requests in test
class FakeResponse extends (await import("node:stream")).Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  output = "";
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.output += chunk.toString();
    callback();
  }
  writeHead(status: number, headers: Record<string, string>) {
    this.statusCode = status;
    this.headers = headers;
    return this;
  }
}

async function request(
  app: Awaited<ReturnType<typeof startCommandCenter>>,
  method: string,
  url: string,
  bodyText?: string
) {
  const req = Object.assign(
    (await import("node:stream")).Readable.from(bodyText ? [bodyText] : []),
    new (await import("node:events")).EventEmitter(),
    { method, url, headers: {} }
  );
  const res = new FakeResponse();
  const finished = new Promise<void>((resolve) => res.once("finish", resolve));
  await app.handle(req as never, res as never);
  await finished;
  return {
    status: res.statusCode,
    headers: res.headers,
    text: res.output,
    json: () => JSON.parse(res.output),
  };
}
