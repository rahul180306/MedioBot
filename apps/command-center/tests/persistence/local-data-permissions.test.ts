import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { LocalDatabase } from "../../src/storage/db.ts";
import { assertNonProductionDatabase, getAppDataDirectory, getProductionDatabasePath } from "../../src/storage/appPaths.ts";

test("application data and SQLite files are private on POSIX systems", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-private-data-"));
  const appData = path.join(root, "data");
  mkdirSync(appData);
  const previousDataDir = process.env.MEDIOBOT_DATA_DIR;
  process.env.MEDIOBOT_DATA_DIR = appData;
  try {
    if (process.platform !== "win32") chmodSync(appData, 0o755);
    const resolved = getAppDataDirectory();
    assert.equal(resolved, appData);
    if (process.platform !== "win32") assert.equal(statSync(appData).mode & 0o777, 0o700);

    const database = new LocalDatabase(path.join(appData, "mediobot.db"));
    try {
      database.raw.exec("CREATE TABLE permission_probe (value TEXT); INSERT INTO permission_probe VALUES ('local data');");
      if (process.platform !== "win32") {
        assert.equal(statSync(database.path).mode & 0o777, 0o600);
        // WAL sidecars can inherit broader file modes, so their app-owned
        // parent must remain inaccessible to other local users.
        assert.equal(statSync(path.dirname(database.path)).mode & 0o777, 0o700);
      }
    } finally { database.close(); }
  } finally {
    if (previousDataDir === undefined) delete process.env.MEDIOBOT_DATA_DIR;
    else process.env.MEDIOBOT_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("test database guard rejects a symlink to the production database", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-prod-db-link-"));
  const link = path.join(root, "linked.db");
  symlinkSync(getProductionDatabasePath(), link);
  try {
    assert.throws(
      () => new LocalDatabase(link),
      /Tests are strictly prohibited from accessing or mutating the production database\./,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("test database guard rejects a hard link to the production database", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-prod-db-hardlink-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousAppData = process.env.APPDATA;
  const previousXdgDataHome = process.env.XDG_DATA_HOME;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.APPDATA = path.join(root, "roaming");
  process.env.XDG_DATA_HOME = path.join(root, "xdg-data");
  try {
    const productionPath = getProductionDatabasePath();
    mkdirSync(path.dirname(productionPath), { recursive: true });
    writeFileSync(productionPath, "disposable test database sentinel");
    const alias = path.join(root, "database-hardlink.db");
    linkSync(productionPath, alias);
    assert.throws(
      () => assertNonProductionDatabase(alias),
      /Tests are strictly prohibited from accessing or mutating the production database\./,
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
    if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdgDataHome;
    rmSync(root, { recursive: true, force: true });
  }
});
