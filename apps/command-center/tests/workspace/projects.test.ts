import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalProjectCatalog } from "../../src/projects.ts";

test("local project catalog exposes only explicit, contained non-secret files", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "mediobot-projects-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "project");
  const outside = path.join(parent, "outside.txt");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, ".env"), "private");
  await writeFile(path.join(root, "src", "app.ts"), "export const ok = true;\n");
  await writeFile(outside, "outside");
  await symlink(outside, path.join(root, "escape.txt"));
  const catalog = new LocalProjectCatalog();
  const project = await catalog.add(root);
  const files = await catalog.listFiles(project.id);
  assert.deepEqual(files.map((file) => file.name), ["src"]);
  assert.deepEqual(files[0]?.children?.map((file) => file.name), ["app.ts"]);
  assert.equal(await catalog.readFile(project.id, "src/app.ts"), "export const ok = true;\n");
  const original = "export const ok = true;\n";
  const version = createHash("sha256").update(original).digest("hex");
  const saved = await catalog.writeFile(project.id, "src/app.ts", "export const ok = false;\n", version);
  assert.equal(await readFile(path.join(root, "src", "app.ts"), "utf8"), "export const ok = false;\n");
  await assert.rejects(catalog.writeFile(project.id, "src/app.ts", "lost update", version), /file-conflict/);
  assert.notEqual(saved.hash, version);
  const concurrentBase = saved.hash;
  const concurrent = await Promise.allSettled([
    catalog.writeFile(project.id, "src/app.ts", "first writer\n", concurrentBase),
    catalog.writeFile(project.id, "src/app.ts", "second writer\n", concurrentBase),
  ]);
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter((result) => result.status === "rejected").length, 1);
  await catalog.createEntry(project.id, "src", "new.ts", "file");
  assert.equal(await readFile(path.join(root, "src", "new.ts"), "utf8"), "");
  await assert.rejects(catalog.createEntry(project.id, "src", "../escape", "file"), /safe file/);
  await assert.rejects(catalog.readFile(project.id, ".env"), /secret files/);
  await assert.rejects(catalog.readFile(project.id, "escape.txt"), /Symbolic links/);
  await assert.rejects(catalog.readFile(project.id, "../outside.txt"), /outside this project/);
});

test("project selection rejects overlapping roots and filesystem roots", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "mediobot-projects-overlap-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const nested = path.join(parent, "nested");
  await mkdir(nested);
  const catalog = new LocalProjectCatalog(parent);
  await assert.rejects(catalog.add(nested), /may not overlap/);
  await assert.rejects(catalog.add(path.parse(parent).root), /filesystem root/);
});

test("project explorer lists deeply nested files and performs contained rename and delete operations", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "mediobot-project-crud-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "project");
  await mkdir(path.join(root, "src", "deep", "nested"), { recursive: true });
  await writeFile(path.join(root, "src", "deep", "nested", "item.ts"), "export const value = 1;\n");
  const catalog = new LocalProjectCatalog();
  const project = await catalog.add(root);
  const tree = await catalog.listFiles(project.id);
  assert.equal(tree[0]?.children?.[0]?.children?.[0]?.children?.[0]?.name, "item.ts");

  await catalog.renameEntry(project.id, "src/deep/nested/item.ts", "renamed.ts");
  assert.equal(await readFile(path.join(root, "src/deep/nested/renamed.ts"), "utf8"), "export const value = 1;\n");
  await assert.rejects(catalog.renameEntry(project.id, "src/deep/nested/renamed.ts", "../escape.ts"), /safe new name/);
  await catalog.deleteEntry(project.id, "src/deep/nested/renamed.ts");
  await assert.rejects(readFile(path.join(root, "src/deep/nested/renamed.ts"), "utf8"), { code: "ENOENT" });
  await catalog.createEntry(project.id, "src/deep", "new-folder", "folder");
  await catalog.createEntry(project.id, "src/deep/new-folder", "child.txt", "file");
  await catalog.deleteEntry(project.id, "src/deep/new-folder");
  await assert.rejects(readFile(path.join(root, "src/deep/new-folder/child.txt"), "utf8"), { code: "ENOENT" });
  await assert.rejects(catalog.deleteEntry(project.id, "../outside"), /cannot be deleted/);
});

test("concurrent create and rename never overwrite the destination", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "mediobot-project-rename-race-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "project");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "source.ts"), "source contents");
  const catalog = new LocalProjectCatalog();
  const project = await catalog.add(root);

  const results = await Promise.allSettled([
    catalog.renameEntry(project.id, "src/source.ts", "destination.ts"),
    catalog.createEntry(project.id, "src", "destination.ts", "file"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const sourceExists = await readFile(path.join(root, "src", "source.ts"), "utf8").then(() => true, () => false);
  const destination = await readFile(path.join(root, "src", "destination.ts"), "utf8");
  if (sourceExists) assert.equal(destination, "");
  else assert.equal(destination, "source contents");
});
