import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isSensitiveName } from "@mediobot-v2/contracts";
import {
  createProjectIntelligenceEngine,
  retrieveProjectContext,
  formatProjectContextForMaestro,
} from "../src/index.ts";

test("PIE Security: isSensitiveName classification policy covers all mandated targets and protects safe files", () => {
  // Required sensitive targets
  assert.equal(isSensitiveName(".env"), true, ".env must be sensitive");
  assert.equal(isSensitiveName(".env.local"), true, ".env.local must be sensitive");
  assert.equal(isSensitiveName(".env.production"), true, ".env.production must be sensitive");
  assert.equal(isSensitiveName("credentials.json"), true, "credentials.json must be sensitive");
  assert.equal(isSensitiveName("secrets.json"), true, "secrets.json must be sensitive");
  assert.equal(isSensitiveName("token.json"), true, "token.json must be sensitive");
  assert.equal(isSensitiveName(".npmrc"), true, ".npmrc must be sensitive");
  assert.equal(isSensitiveName(".aws"), true, ".aws must be sensitive");
  assert.equal(isSensitiveName(".aws/credentials"), true, ".aws/credentials must be sensitive");
  assert.equal(isSensitiveName(".ssh"), true, ".ssh must be sensitive");
  assert.equal(isSensitiveName(".ssh/id_rsa"), true, ".ssh/id_rsa must be sensitive");
  assert.equal(isSensitiveName("server.key"), true, "server.key must be sensitive");
  assert.equal(isSensitiveName("cert.pem"), true, "cert.pem must be sensitive");
  assert.equal(isSensitiveName("id_rsa"), true, "id_rsa must be sensitive");
  assert.equal(isSensitiveName("id_ed25519"), true, "id_ed25519 must be sensitive");

  // Safe files that must NOT be flagged
  assert.equal(isSensitiveName("package.json"), false, "package.json must be safe");
  assert.equal(isSensitiveName("tsconfig.json"), false, "tsconfig.json must be safe");
  assert.equal(isSensitiveName("README.md"), false, "README.md must be safe");
  assert.equal(isSensitiveName("AGENTS.md"), false, "AGENTS.md must be safe");
  assert.equal(isSensitiveName("src/index.ts"), false, "src/index.ts must be safe");
  assert.equal(isSensitiveName("src/auth/service.ts"), false, "src/auth/service.ts must be safe");
});

test("PIE Security: Excludes sensitive files, paths, and synthetic secret contents from PIE indexing, retrieval, RepoMap, and context formatting", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-sensitive-regression-"));
  try {
    // 1. Setup workspace with safe files
    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({
        name: "safe-demo-app",
        type: "module",
        dependencies: { express: "^4.19.0" },
      })
    );
    await writeFile(
      path.join(tempDir, "src", "index.ts"),
      `export function bootstrapApp(): string {
  return "App Initialized";
}
export const APP_VERSION = "1.0.0";
`
    );

    // 2. Setup synthetic secrets and sensitive files mandated by security policy
    const syntheticSecrets = {
      envSecret: "ENV_SECRET_KEY_98765",
      envLocalSecret: "LOCAL_SECRET_KEY_43210",
      credentialsSecret: "CREDENTIALS_JSON_BEARER_TOKEN_XYZ",
      secretsJsonSecret: "SECRETS_JSON_API_KEY_ABCDEF",
      tokenJsonSecret: "TOKEN_JSON_AUTH_TOKEN_QWERTY",
      npmrcSecret: "//registry.npmjs.org/:_authToken=NPMRC_SECRET_AUTH_999",
      awsSecret: "AWS_SECRET_ACCESS_KEY_SAMPLE_123456",
      sshSecret: "-----BEGIN OPENSSH PRIVATE KEY-----SYNTHETIC_SSH_KEY_DATA",
      serverKeySecret: "-----BEGIN PRIVATE KEY-----SERVER_KEY_SECRET_CONTENT",
    };

    await writeFile(path.join(tempDir, ".env"), `SECRET_VAL=${syntheticSecrets.envSecret}\n`);
    await writeFile(path.join(tempDir, ".env.local"), `LOCAL_VAL=${syntheticSecrets.envLocalSecret}\n`);
    await writeFile(
      path.join(tempDir, "credentials.json"),
      JSON.stringify({ client_secret: syntheticSecrets.credentialsSecret })
    );
    await writeFile(
      path.join(tempDir, "secrets.json"),
      JSON.stringify({ apiKey: syntheticSecrets.secretsJsonSecret })
    );
    await writeFile(
      path.join(tempDir, "token.json"),
      JSON.stringify({ token: syntheticSecrets.tokenJsonSecret })
    );
    await writeFile(path.join(tempDir, ".npmrc"), `${syntheticSecrets.npmrcSecret}\n`);

    await mkdir(path.join(tempDir, ".aws"), { recursive: true });
    await writeFile(path.join(tempDir, ".aws", "credentials"), `aws_secret_access_key=${syntheticSecrets.awsSecret}\n`);

    await mkdir(path.join(tempDir, ".ssh"), { recursive: true });
    await writeFile(path.join(tempDir, ".ssh", "id_rsa"), `${syntheticSecrets.sshSecret}\n`);

    await writeFile(path.join(tempDir, "server.key"), `${syntheticSecrets.serverKeySecret}\n`);

    // 3. Initialize and index with PIE
    const engine = createProjectIntelligenceEngine({ workspaceRoot: tempDir });
    await engine.initialize();
    const indexReport = await engine.fullIndex();

    // Verify index report
    assert.ok(indexReport.filesIndexed > 0, "Safe files should be indexed");

    // 4. Test broad and focused retrieval
    const retrieved = await retrieveProjectContext(engine, tempDir, "token credentials secret key bootstrapApp", {
      focusFiles: [
        ".env",
        ".env.local",
        "credentials.json",
        "secrets.json",
        "token.json",
        ".npmrc",
        ".aws/credentials",
        ".ssh/id_rsa",
        "server.key",
        "src/index.ts",
      ],
    });

    // 5. Verify file list in context
    const filePaths = retrieved.files.map((f) => f.path);
    assert.ok(filePaths.includes("src/index.ts"), "Safe file src/index.ts must be present");
    assert.ok(!filePaths.some((p) => p.includes(".env")), "No .env in retrieved files");
    assert.ok(!filePaths.some((p) => p.includes(".env.local")), "No .env.local in retrieved files");
    assert.ok(!filePaths.some((p) => p.includes("credentials.json")), "No credentials.json in retrieved files");
    assert.ok(!filePaths.some((p) => p.includes("secrets.json")), "No secrets.json in retrieved files");
    assert.ok(!filePaths.some((p) => p.includes("token.json")), "No token.json in retrieved files");
    assert.ok(!filePaths.some((p) => p.includes(".npmrc")), "No .npmrc in retrieved files");
    assert.ok(!filePaths.some((p) => p.includes(".aws")), "No .aws in retrieved files");
    assert.ok(!filePaths.some((p) => p.includes(".ssh")), "No .ssh in retrieved files");
    assert.ok(!filePaths.some((p) => p.includes("server.key")), "No server.key in retrieved files");

    // 6. Verify symbols
    assert.ok(retrieved.symbols.some((s) => s.name === "bootstrapApp"), "bootstrapApp symbol must be present");
    for (const sym of retrieved.symbols) {
      assert.equal(isSensitiveName(sym.filePath), false, `Symbol filePath ${sym.filePath} must not be sensitive`);
      assert.equal(isSensitiveName(sym.name), false, `Symbol name ${sym.name} must not be sensitive`);
    }

    // 7. Verify RepoMap
    assert.ok(retrieved.repoMap, "RepoMap should be generated");
    assert.ok(retrieved.repoMap.content.includes("src/index.ts"), "RepoMap should include src/index.ts");
    assert.ok(!retrieved.repoMap.content.includes("credentials.json"), "RepoMap must not contain credentials.json");
    assert.ok(!retrieved.repoMap.content.includes(".env"), "RepoMap must not contain .env");
    assert.ok(!retrieved.repoMap.content.includes("secrets.json"), "RepoMap must not contain secrets.json");
    assert.ok(!retrieved.repoMap.content.includes("token.json"), "RepoMap must not contain token.json");
    assert.ok(!retrieved.repoMap.content.includes("server.key"), "RepoMap must not contain server.key");
    assert.ok(!retrieved.repoMap.content.includes(".npmrc"), "RepoMap must not contain .npmrc");
    assert.ok(!retrieved.repoMap.content.includes(".aws"), "RepoMap must not contain .aws");
    assert.ok(!retrieved.repoMap.content.includes(".ssh"), "RepoMap must not contain .ssh");

    // 8. Format records for Maestro and verify complete absence of filenames and secret contents
    const formattedRecords = formatProjectContextForMaestro(retrieved);
    const serializedContext = JSON.stringify(formattedRecords);

    // Filename exclusions
    assert.equal(serializedContext.includes(".env"), false, "Serialized context must not include .env");
    assert.equal(serializedContext.includes(".env.local"), false, "Serialized context must not include .env.local");
    assert.equal(serializedContext.includes("credentials.json"), false, "Serialized context must not include credentials.json");
    assert.equal(serializedContext.includes("secrets.json"), false, "Serialized context must not include secrets.json");
    assert.equal(serializedContext.includes("token.json"), false, "Serialized context must not include token.json");
    assert.equal(serializedContext.includes(".npmrc"), false, "Serialized context must not include .npmrc");
    assert.equal(serializedContext.includes(".aws"), false, "Serialized context must not include .aws");
    assert.equal(serializedContext.includes(".ssh"), false, "Serialized context must not include .ssh");
    assert.equal(serializedContext.includes("server.key"), false, "Serialized context must not include server.key");

    // Secret content exclusions
    for (const [keyName, secretValue] of Object.entries(syntheticSecrets)) {
      assert.equal(
        serializedContext.includes(secretValue),
        false,
        `Synthetic secret content for ${keyName} (${secretValue}) must NOT appear in serialized context`
      );
    }

    await engine.dispose();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
