import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type AttachmentKind = "image" | "pdf" | "document" | "code";

export interface AttachmentMetadata {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly kind: AttachmentKind;
  readonly createdAt: number;
  readonly hash: string;
  readonly workspaceId?: string;
  readonly threadId?: string;
}

export interface StoredAttachment extends AttachmentMetadata {
  readonly bytes: Buffer;
}

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5 MB per attachment
export const MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB per turn
export const SAFE_ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeFilename(value: string): string {
  const base = path.basename(value.replaceAll("\\", "/")).replace(/[\0-\x1f]/g, "").trim();
  return (base || "attachment").slice(0, 160);
}

export function sniffMimeType(bytes: Buffer, declaredName: string, declaredMimeType: string): { mimeType: string; kind: AttachmentKind } {
  // 1. Check Image signatures
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mimeType: "image/png", kind: "image" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: "image/jpeg", kind: "image" };
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return { mimeType: "image/webp", kind: "image" };
  }
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))) {
    return { mimeType: "image/gif", kind: "image" };
  }

  // 2. Check PDF signature (%PDF-)
  const headerCheck = bytes.toString("ascii", 0, Math.min(bytes.length, 1024));
  if (headerCheck.includes("%PDF-")) {
    return { mimeType: "application/pdf", kind: "pdf" };
  }

  // 3. Check code and document extensions
  const ext = path.extname(declaredName).toLowerCase();
  const codeExts = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".c", ".h", ".cpp", ".hpp",
    ".java", ".rb", ".php", ".sh", ".bash", ".sql", ".html", ".htm", ".css", ".scss", ".json",
    ".yaml", ".yml", ".toml", ".xml", ".env", ".ini", ".conf",
  ]);
  const docExts = new Set([".md", ".markdown", ".txt", ".csv", ".tsv", ".log", ".rtf"]);

  if (codeExts.has(ext)) {
    return { mimeType: declaredMimeType.includes("/") ? declaredMimeType : "text/plain", kind: "code" };
  }
  if (docExts.has(ext)) {
    return { mimeType: declaredMimeType.includes("/") ? declaredMimeType : "text/plain", kind: "document" };
  }

  // Default fallback if clean UTF-8 text without NUL bytes
  if (!bytes.includes(0)) {
    return { mimeType: "text/plain", kind: "document" };
  }

  return { mimeType: "application/octet-stream", kind: "document" };
}

export class AttachmentStore {
  private readonly directory: string;
  constructor(appDataDirectory: string) {
    this.directory = path.join(path.resolve(appDataDirectory), "attachments");
  }

  async save(
    name: string,
    declaredMimeType: string,
    bytes: Buffer,
    options?: { workspaceId?: string; threadId?: string },
  ): Promise<AttachmentMetadata> {
    if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new Error("Attachment must be between 1 byte and 5 MB.");
    }
    const filename = safeFilename(name);
    const normalizedDeclaredMime = declaredMimeType.toLowerCase().split(";")[0] || "application/octet-stream";
    const detected = sniffMimeType(bytes, filename, normalizedDeclaredMime);

    // If client declared an image format, verify the sniffed format matches image
    if (normalizedDeclaredMime.startsWith("image/") && detected.kind !== "image") {
      throw new Error("The image format could not be validated.");
    }

    const id = randomUUID();
    const hash = createHash("sha256").update(bytes).digest("hex");
    const createdAt = Date.now();

    const metadata: AttachmentMetadata = {
      id,
      name: filename,
      mimeType: detected.mimeType,
      size: bytes.length,
      kind: detected.kind,
      createdAt,
      hash,
      ...(options?.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(options?.threadId ? { threadId: options.threadId } : {}),
    };

    await mkdir(this.directory, { recursive: true });
    await writeFile(path.join(this.directory, id), bytes, { flag: "wx", mode: 0o600 });
    await writeFile(path.join(this.directory, `${id}.json`), JSON.stringify(metadata, null, 2), { flag: "wx", mode: 0o600 });
    return metadata;
  }

  async get(id: string, options?: { workspaceId?: string }): Promise<StoredAttachment | undefined> {
    if (!SAFE_ATTACHMENT_ID.test(id)) return undefined;
    try {
      const meta = JSON.parse(await readFile(path.join(this.directory, `${id}.json`), "utf8")) as AttachmentMetadata;
      if (meta.id !== id || meta.size > MAX_ATTACHMENT_BYTES) return undefined;
      // If workspaceId is specified and metadata has workspaceId, verify isolation
      if (options?.workspaceId && meta.workspaceId && meta.workspaceId !== options.workspaceId) {
        return undefined; // Workspace isolation barrier
      }
      const bytes = await readFile(path.join(this.directory, id));
      if (bytes.length !== meta.size) return undefined;
      return { ...meta, bytes };
    } catch {
      return undefined;
    }
  }

  async remove(id: string): Promise<void> {
    if (!SAFE_ATTACHMENT_ID.test(id)) return;
    await Promise.all([
      rm(path.join(this.directory, id), { force: true }),
      rm(path.join(this.directory, `${id}.json`), { force: true }),
    ]);
  }
}
