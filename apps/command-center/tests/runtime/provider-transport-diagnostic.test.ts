import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { OpenAICompatibleStructuredClient } from '@mediobot-v2/models';
import { ModelResolver, ModelProviderError, getEnabledModels } from '../../src/runtime/modelRegistry.ts';
import { ProviderRepository } from '../../src/storage/providerRepository.ts';
import { assertNonProductionDatabase, getProductionDatabasePath } from '../../src/storage/appPaths.ts';
import { createComposition } from '../../src/composition.ts';

// Native transport, unchanged requests. Only fixed error codes and safe metadata leave this test.
const codes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EPERM', 'EACCES', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID']);
function errorCodes(error: unknown): string[] {
  const found: string[] = [];
  let current = error;
  for (let i = 0; i < 4 && current && typeof current === 'object'; i++) {
    const item = current as { code?: unknown; cause?: unknown };
    if (typeof item.code === 'string' && codes.has(item.code)) found.push(item.code);
    current = item.cause;
  }
  return found;
}
function safeId(value: string): string {
  return /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$/.test(value) && !/(?:sk-|key|token|secret)/i.test(value) ? value : 'redacted';
}
function safeScheme(value: string | undefined): 'http' | 'https' | 'other' {
  try {
    const protocol = new URL(value ?? '').protocol;
    return protocol === 'http:' ? 'http' : protocol === 'https:' ? 'https' : 'other';
  } catch { return 'other'; }
}
const diagnosticTimeoutMs = Math.min(180_000, Math.max(5_000, Number(process.env.MEDIOBOT_DIAGNOSTIC_TIMEOUT_MS) || 70_000));
test('registry-backed native transport diagnostic', { skip: process.env.MEDIOBOT_DIAGNOSE_TRANSPORT !== '1', timeout: diagnosticTimeoutMs + 10_000 }, async t => {
  const custom = process.env.MEDIOBOT_DATA_DIR?.trim();
  const databasePath = custom ? path.join(path.resolve(custom), 'mediobot.db') : getProductionDatabasePath();
  assertNonProductionDatabase(databasePath);
  if (!existsSync(databasePath)) { t.skip('application-store-missing'); return; }
  const db = new DatabaseSync(databasePath, { readOnly: true }); t.after(() => db.close());
  const repo = new ProviderRepository(db);
  const models = getEnabledModels(repo).filter(m => m.capabilities.text);
  const providerId = process.env.MEDIOBOT_DIAGNOSTIC_PROVIDER;
  const modelId = process.env.MEDIOBOT_DIAGNOSTIC_MODEL;
  const selected = models.find(m => m.providerId === providerId && m.id === modelId);
  if (!selected) { t.skip('explicit-connected-text-pair-unavailable'); return; }
  let transportFailed = false;
  const resolver = new ModelResolver(repo, { createClient: options => {
    t.diagnostic(JSON.stringify({ stage: 'resolved-client', configSource: custom ? 'explicit-application-data-directory' : 'default-production-application-store',
      providerConnectionId: safeId(selected.providerId), modelId: safeId(options.modelId), endpointScheme: safeScheme(options.baseUrl),
      connected: true, enabled: true, textCapability: true, credentialResolution: 'passed-normal-resolver',
      jsonMode: options.jsonMode, supportsSystemRole: options.supportsSystemRole }));
    return new OpenAICompatibleStructuredClient({ ...options, fetch: async (input, init) => {
      const started = performance.now();
      try {
        const response = await fetch(input, init);
        t.diagnostic(JSON.stringify({ stage: 'http-response', status: response.status,
          contentType: response.headers.get('content-type')?.split(';', 1)[0]?.slice(0, 80) ?? 'unknown', elapsedMs: performance.now() - started }));
        return response;
      } catch (error) {
        transportFailed = true;
        t.diagnostic(JSON.stringify({ stage: 'native-fetch-before-response', codes: errorCodes(error), elapsedMs: performance.now() - started }));
        throw error;
      }
    } });
  } });
  const selection = { providerConnectionId: selected.providerId, modelId: selected.id };
  // Exercise the exact UI Maestro entry point. No execution or browser identities are allocated.
  const composition = createComposition({ modelResolver: resolver }); t.after(() => composition.shutdown?.());
  const requestSignal = AbortSignal.timeout(diagnosticTimeoutMs);
  try {
    const result = await composition.decideMaestroTurn!('Reply with a brief greeting.', { modelSelection: selection }, requestSignal);
    t.diagnostic(JSON.stringify({ stage: 'maestro-decision', status: 'passed', intent: result.type }));
  } catch (error) {
    t.diagnostic(JSON.stringify({ stage: 'maestro-decision', status: 'failed', category: transportFailed && requestSignal.aborted ? 'request-deadline-timeout'
      : error instanceof ModelProviderError ? error.code : 'decision-failure', transportFailed }));
    if (transportFailed) { t.skip('native-transport-unavailable'); return; }
    throw new Error('Provider/decision diagnostic failed after transport; see safe stage diagnostics');
  }
});
