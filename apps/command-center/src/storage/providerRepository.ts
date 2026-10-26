import type { DatabaseSync } from "node:sqlite";
import type { ModelCapabilities } from "@mediobot-v2/models";
import { Entry } from "@napi-rs/keyring";

export type { ModelCapabilities };

export interface ConfiguredModel {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly capabilities?: ModelCapabilities;
  readonly context?: string;
  readonly tag?: string;
  readonly description?: string;
  readonly isCustom?: boolean;
}

export interface CustomHeader {
  readonly id: string;
  readonly name: string;
  readonly value: string;
}

export interface ProviderConnection {
  readonly id: string;
  readonly providerType: string;
  readonly displayName: string;
  readonly baseUrl?: string;
  readonly credentialStatus: "configured" | "missing";
  readonly credentialRef?: string;
  readonly models: ReadonlyArray<ConfiguredModel>;
  readonly customHeaders?: ReadonlyArray<CustomHeader>;
  readonly connected: boolean;
  readonly enabled: boolean;
  readonly badge?: string;
  readonly iconType?: string;
  readonly description?: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

export interface CredentialStore {
  get(reference: string): { readonly apiKey?: string; readonly customHeaders?: ReadonlyArray<CustomHeader> } | null;
  put(reference: string, credentials: { readonly apiKey?: string; readonly customHeaders?: ReadonlyArray<CustomHeader> }): void;
  delete(reference: string): void;
}

/** Test-only credential store. Production credentials use the operating system credential vault. */
export class SqliteCredentialStore implements CredentialStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) { this.db = db; }
  get(reference: string): { readonly apiKey?: string; readonly customHeaders?: ReadonlyArray<CustomHeader> } | null {
    const row = this.db.prepare("SELECT api_key FROM provider_secrets WHERE provider_id = ?").get(reference) as { api_key: string } | undefined;
    if (!row?.api_key) return null;
    try {
      const parsed = JSON.parse(row.api_key) as { apiKey?: unknown; customHeaders?: unknown };
      return { ...(typeof parsed.apiKey === "string" ? { apiKey: parsed.apiKey } : {}),
        ...(Array.isArray(parsed.customHeaders) ? { customHeaders: parsed.customHeaders as CustomHeader[] } : {}) };
    } catch {
      // Legacy installations stored the API key directly; migrate on next save.
      return { apiKey: row.api_key };
    }
  }
  put(reference: string, credentials: { readonly apiKey?: string; readonly customHeaders?: ReadonlyArray<CustomHeader> }): void {
    this.db.prepare(`INSERT INTO provider_secrets (provider_id, api_key, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET api_key = excluded.api_key, updated_at = excluded.updated_at`)
      .run(reference, JSON.stringify(credentials), Date.now());
  }
  delete(reference: string): void {
    this.db.prepare("DELETE FROM provider_secrets WHERE provider_id = ?").run(reference);
  }
}

/** Stores provider secrets in macOS Keychain, Windows Credential Vault, or the platform keyring. */
export class SystemCredentialStore implements CredentialStore {
  private readonly service = "MedioBot V2 Provider Credentials";
  private readonly db: DatabaseSync;
  private readonly entry: (reference: string) => Entry;

  constructor(db: DatabaseSync, entryForReference: (reference: string) => Entry = reference => new Entry(this.service, reference)) {
    this.db = db;
    this.entry = entryForReference;
    this.migratePlaintextCredentials();
  }

  get(reference: string): { readonly apiKey?: string; readonly customHeaders?: ReadonlyArray<CustomHeader> } | null {
    const secret = this.entry(reference).getPassword();
    if (secret === null) return null;
    try {
      const parsed = JSON.parse(secret) as { apiKey?: unknown; customHeaders?: unknown };
      return { ...(typeof parsed.apiKey === "string" ? { apiKey: parsed.apiKey } : {}),
        ...(Array.isArray(parsed.customHeaders) ? { customHeaders: parsed.customHeaders as CustomHeader[] } : {}) };
    } catch {
      // Preserve values written by an earlier single-key credential format.
      return { apiKey: secret };
    }
  }

  put(reference: string, credentials: { readonly apiKey?: string; readonly customHeaders?: ReadonlyArray<CustomHeader> }): void {
    const entry = this.entry(reference);
    const serialized = JSON.stringify(credentials);
    entry.setPassword(serialized);
    if (entry.getPassword() !== serialized) {
      throw new Error("The operating system credential store did not confirm the saved provider credentials.");
    }
  }

  delete(reference: string): void {
    this.entry(reference).deletePassword();
  }

  private migratePlaintextCredentials(): void {
    const rows = this.db.prepare("SELECT provider_id, api_key FROM provider_secrets").all() as Array<{ provider_id: string; api_key: string }>;
    const remove = this.db.prepare("DELETE FROM provider_secrets WHERE provider_id = ?");
    for (const row of rows) {
      let bundle: { readonly apiKey?: string; readonly customHeaders?: ReadonlyArray<CustomHeader> };
      try {
        const parsed = JSON.parse(row.api_key) as { apiKey?: unknown; customHeaders?: unknown };
        bundle = { ...(typeof parsed.apiKey === "string" ? { apiKey: parsed.apiKey } : {}),
          ...(Array.isArray(parsed.customHeaders) ? { customHeaders: parsed.customHeaders as CustomHeader[] } : {}) };
      } catch { bundle = { apiKey: row.api_key }; }
      const existing = this.get(row.provider_id);
      this.put(row.provider_id, {
        ...(existing?.apiKey || bundle.apiKey ? { apiKey: existing?.apiKey || bundle.apiKey } : {}),
        ...(existing?.customHeaders || bundle.customHeaders ? { customHeaders: existing?.customHeaders || bundle.customHeaders } : {}),
      });
      // Erase legacy plaintext only after the platform store confirms persistence.
      remove.run(row.provider_id);
    }

    const headerRows = this.db.prepare("SELECT id, custom_headers_json FROM provider_connections").all() as Array<{ id: string; custom_headers_json: string }>;
    const saveRedactedHeaders = this.db.prepare("UPDATE provider_connections SET custom_headers_json = ? WHERE id = ?");
    for (const row of headerRows) {
      let headers: CustomHeader[] = [];
      try { headers = JSON.parse(row.custom_headers_json) as CustomHeader[]; } catch { continue; }
      if (!Array.isArray(headers) || !headers.some(header => typeof header?.value === "string" && header.value.length > 0)) continue;
      const existing = this.get(row.id);
      const migratedHeaders = existing?.customHeaders ?? headers;
      this.put(row.id, { ...(existing?.apiKey ? { apiKey: existing.apiKey } : {}), customHeaders: migratedHeaders });
      saveRedactedHeaders.run(JSON.stringify(headers.map(({ id, name }) => ({ id, name, value: "" }))), row.id);
    }
  }
}

export class ProviderRepository {
  private readonly db: DatabaseSync;
  private readonly credentials: CredentialStore;

  constructor(db: DatabaseSync, credentials: CredentialStore = new SqliteCredentialStore(db)) {
    this.db = db;
    this.credentials = credentials;
  }

  list(): ProviderConnection[] {
    const rows = this.db.prepare(
      "SELECT * FROM provider_connections WHERE connected = 1 ORDER BY created_at ASC"
    ).all() as Array<{
      id: string;
      provider_type: string;
      display_name: string;
      base_url: string | null;
      credential_status: string;
      models_json: string;
      custom_headers_json: string;
      connected: number;
      enabled: number;
      badge: string | null;
      icon_type: string | null;
      description: string | null;
      created_at: number;
      updated_at: number;
    }>;

    return rows.map((r) => {
      let models: ConfiguredModel[] = [];
      try {
        models = JSON.parse(r.models_json);
      } catch {
        models = [];
      }

      let customHeaders: CustomHeader[] = [];
      try {
        customHeaders = JSON.parse(r.custom_headers_json);
      } catch {
        customHeaders = [];
      }

      const storedCredentials = this.credentials.get(r.id);
      if (storedCredentials?.customHeaders) customHeaders = [...storedCredentials.customHeaders];
      const hasCredential = Boolean(storedCredentials?.apiKey || customHeaders.some((header) => header.value));
      const credentialStatus: "configured" | "missing" = hasCredential || r.provider_type === "custom" ? "configured" : "missing";

      return {
        id: r.id,
        providerType: r.provider_type,
        displayName: r.display_name,
        baseUrl: r.base_url || undefined,
        credentialStatus,
        credentialRef: hasCredential ? r.id : undefined,
        models,
        customHeaders: customHeaders.length > 0 ? customHeaders : undefined,
        connected: Boolean(r.connected) && (credentialStatus === "configured"),
        enabled: Boolean(r.enabled),
        badge: r.badge || undefined,
        iconType: r.icon_type || undefined,
        description: r.description || undefined,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
  }

  get(id: string): ProviderConnection | null {
    if (!id || typeof id !== "string") return null;
    const row = this.db.prepare(
      "SELECT * FROM provider_connections WHERE id = ? AND connected = 1"
    ).get(id) as {
      id: string;
      provider_type: string;
      display_name: string;
      base_url: string | null;
      credential_status: string;
      models_json: string;
      custom_headers_json: string;
      connected: number;
      enabled: number;
      badge: string | null;
      icon_type: string | null;
      description: string | null;
      created_at: number;
      updated_at: number;
    } | undefined;

    if (!row) return null;

    let models: ConfiguredModel[] = [];
    try {
      models = JSON.parse(row.models_json);
    } catch {
      models = [];
    }

    let customHeaders: CustomHeader[] = [];
    try {
      customHeaders = JSON.parse(row.custom_headers_json);
    } catch {
      customHeaders = [];
    }

    const storedCredentials = this.credentials.get(row.id);
    if (storedCredentials?.customHeaders) customHeaders = [...storedCredentials.customHeaders];
    const hasCredential = Boolean(storedCredentials?.apiKey || customHeaders.some((header) => header.value));
    const credentialStatus: "configured" | "missing" = hasCredential || row.provider_type === "custom" ? "configured" : "missing";

    return {
      id: row.id,
      providerType: row.provider_type,
      displayName: row.display_name,
      baseUrl: row.base_url || undefined,
      credentialStatus,
      credentialRef: hasCredential ? row.id : undefined,
      models,
      customHeaders: customHeaders.length > 0 ? customHeaders : undefined,
      connected: Boolean(row.connected) && credentialStatus === "configured",
      enabled: Boolean(row.enabled),
      badge: row.badge || undefined,
      iconType: row.icon_type || undefined,
      description: row.description || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  save(connection: Omit<ProviderConnection, "credentialStatus">, apiKey?: string): ProviderConnection {
    const now = Date.now();
    const cleanApiKey = apiKey?.trim();

    const previousCredentials = this.credentials.get(connection.id);
    const credentialBundle = {
      ...(cleanApiKey || previousCredentials?.apiKey ? { apiKey: cleanApiKey || previousCredentials?.apiKey } : {}),
      ...((connection.customHeaders?.length ?? 0) > 0 ? { customHeaders: connection.customHeaders } : previousCredentials?.customHeaders ? { customHeaders: previousCredentials.customHeaders } : {}),
    };
    const hasCredential = Boolean(credentialBundle.apiKey || credentialBundle.customHeaders?.some((header) => header.value));
    const credentialStatus: "configured" | "missing" = hasCredential || connection.providerType === "custom" ? "configured" : "missing";

    this.db.prepare(`
      INSERT INTO provider_connections (
        id, provider_type, display_name, base_url, credential_status, models_json,
        custom_headers_json, connected, enabled, badge, icon_type, description, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        provider_type = excluded.provider_type,
        display_name = excluded.display_name,
        base_url = excluded.base_url,
        credential_status = excluded.credential_status,
        models_json = excluded.models_json,
        custom_headers_json = excluded.custom_headers_json,
        connected = excluded.connected,
        enabled = excluded.enabled,
        badge = excluded.badge,
        icon_type = excluded.icon_type,
        description = excluded.description,
        updated_at = excluded.updated_at
    `).run(
      connection.id,
      connection.providerType,
      connection.displayName,
      connection.baseUrl || null,
      credentialStatus,
      JSON.stringify(connection.models || []),
      JSON.stringify((connection.customHeaders || []).map(({ id, name }) => ({ id, name, value: "" }))),
      connection.connected ? 1 : 0,
      connection.enabled ? 1 : 0,
      connection.badge || null,
      connection.iconType || null,
      connection.description || null,
      connection.createdAt || now,
      now
    );

    if (Object.keys(credentialBundle).length > 0) this.credentials.put(connection.id, credentialBundle);

    return {
      ...connection,
      credentialStatus,
      createdAt: connection.createdAt || now,
      updatedAt: now,
    };
  }

  delete(id: string): boolean {
    const res = this.db.prepare("DELETE FROM provider_connections WHERE id = ?").run(id);
    this.credentials.delete(id);
    return res.changes > 0;
  }

  updateEnabled(id: string, enabled: boolean): boolean {
    const res = this.db.prepare(
      "UPDATE provider_connections SET enabled = ?, updated_at = ? WHERE id = ?"
    ).run(enabled ? 1 : 0, Date.now(), id);
    return res.changes > 0;
  }

  updateModelEnabled(providerId: string, modelId: string, enabled: boolean): boolean {
    const prov = this.get(providerId);
    if (!prov) return false;

    const updatedModels = prov.models.map((m) =>
      m.id === modelId ? { ...m, enabled } : m
    );

    const res = this.db.prepare(
      "UPDATE provider_connections SET models_json = ?, updated_at = ? WHERE id = ?"
    ).run(JSON.stringify(updatedModels), Date.now(), providerId);

    return res.changes > 0;
  }

  /**
   * Environment variable fallback during development/testing phase.
   * In production, this returns null so the system relies solely on UI settings.
   */
  getEnvApiKey(providerId: string): string | null {
    if (typeof process === "undefined" || !process.env) return null;
    if (process.env.NODE_ENV === "test") return null;
    const key = providerId.toLowerCase().replace(/^provider-/, "");
    if (key === "nvidia") {
      return process.env.NVIDIA_API_KEY?.trim() || null;
    }
    if (key === "dahl") {
      return process.env.DAHL_API_KEY?.trim() || null;
    }
    if (key === "anthropic") {
      return process.env.ANTHROPIC_API_KEY?.trim() || null;
    }
    if (key === "openai") {
      return process.env.OPENAI_API_KEY?.trim() || null;
    }
    return null;
  }

  /**
   * Internal secret lookup for runtime execution.
   * Prefers SQLite stored credentials, falling back to environment variables during dev/testing.
   * NEVER exposed over GET APIs, SSE, or logs.
   */
  getSecret(providerId: string): string | null {
    return this.credentials.get(providerId)?.apiKey ?? this.getEnvApiKey(providerId);
  }

  getCustomHeaders(providerId: string): ReadonlyArray<CustomHeader> {
    return this.credentials.get(providerId)?.customHeaders ?? [];
  }

  /**
   * Synchronize catalog models and environment credentials into SQLite.
   * Ensures new and improved models appear in the UI and active keys are ready.
   */
  syncFromCatalog(catalog: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly defaultBaseUrl?: string;
    readonly defaultModels: ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly capabilities?: any;
      readonly context?: string;
      readonly tag?: string;
      readonly description?: string;
      readonly enabled?: boolean;
    }>;
    readonly badge?: string;
    readonly iconType?: string;
    readonly description?: string;
  }>): void {
    for (const entry of catalog) {
      if (entry.id === "custom") continue;
      const existing = this.get(entry.id);
      const envKey = this.getEnvApiKey(entry.id);

      if (!existing) {
        if (envKey) {
          this.save({
            id: entry.id,
            providerType: entry.id,
            displayName: entry.name,
            baseUrl: entry.defaultBaseUrl,
            models: entry.defaultModels.map((m) => ({ ...m, enabled: true })),
            connected: true,
            enabled: true,
            badge: entry.badge,
            iconType: entry.iconType,
            description: entry.description,
          }, envKey);
        }
      } else {
        const currentModels = [...existing.models];
        let changed = false;
        for (const defaultModel of entry.defaultModels) {
          const idx = currentModels.findIndex((m) => m.id === defaultModel.id);
          if (idx === -1) {
            currentModels.push({ ...defaultModel, enabled: true });
            changed = true;
          } else {
            if (JSON.stringify(currentModels[idx].capabilities) !== JSON.stringify(defaultModel.capabilities)
              || currentModels[idx].name !== defaultModel.name) {
              currentModels[idx] = {
                ...currentModels[idx],
                name: defaultModel.name,
                capabilities: defaultModel.capabilities,
                context: defaultModel.context,
                tag: defaultModel.tag,
                description: defaultModel.description,
              };
              changed = true;
            }
          }
        }
        if (changed) {
          this.db.prepare("UPDATE provider_connections SET models_json = ?, updated_at = ? WHERE id = ?")
            .run(JSON.stringify(currentModels), Date.now(), entry.id);
        }
        if (envKey) {
          const storedKey = this.credentials.get(entry.id)?.apiKey;
          if (!storedKey) {
            this.credentials.put(entry.id, { apiKey: envKey });
          }
        }
      }
    }
  }
}
