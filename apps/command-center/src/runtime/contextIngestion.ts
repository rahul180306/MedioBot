import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ModelCapabilities } from "./modelRegistry.ts";
import type { ModelResolver } from "./modelRegistry.ts";
import type { StoredAttachment } from "../storage/attachmentStore.ts";
import { extractPdfText } from "../storage/pdfExtractor.ts";
import { sanitizeReasoningAndSecrets } from "@mediobot-v2/models";

export interface ResolvedTurnContext {
  readonly textPrompt: string;
  readonly promptWithContext: string;
  readonly imageInputs: Array<{
    readonly id: string;
    readonly name: string;
    readonly mimeType: string;
    readonly dataUrl: string;
  }>;
  readonly documentSummaries: Array<{
    readonly name: string;
    readonly kind: "pdf" | "code" | "document";
    readonly size: number;
    readonly pageCount?: number;
  }>;
  readonly visualPerception?: {
    readonly provider: string;
    readonly modelId: string;
    readonly findings: string;
  };
  readonly unsupportedError?: string;
}

const SENSITIVE_PATTERNS = [
  /(?:^|[\\/])\.env(?:\.|$)/i,
  /(?:^|[\\/])\.git[\\/]/i,
  /(?:^|[\\/])id_rsa/i,
  /(?:^|[\\/])id_ed25519/i,
  /\.pem$/i,
  /\.key$/i,
  /(?:^|[\\/])credentials\.json$/i,
];

function isSafeWorkspacePath(targetPath: string, workspaceRoot: string): boolean {
  const resolved = path.resolve(workspaceRoot, targetPath);
  const normalizedRoot = path.resolve(workspaceRoot);
  if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
    return false; // Traversal attempt outside workspace
  }
  return !SENSITIVE_PATTERNS.some((pattern) => pattern.test(resolved));
}

export class MultimodalContextIngestion {
  private readonly modelResolver?: ModelResolver;

  constructor(modelResolver?: ModelResolver) {
    this.modelResolver = modelResolver;
  }

  /**
   * Resolves attachments, documents, project file references, and multimodal visual perception.
   */
  async resolve(params: {
    readonly prompt: string;
    readonly attachments: ReadonlyArray<StoredAttachment>;
    readonly workspaceRoot?: string;
    readonly selectedModelCapabilities?: ModelCapabilities;
    readonly signal?: AbortSignal;
  }): Promise<ResolvedTurnContext> {
    const { prompt, attachments, workspaceRoot, selectedModelCapabilities, signal } = params;

    const imageAttachments = attachments.filter((att) => att.mimeType.startsWith("image/"));
    const nonImageAttachments = attachments.filter((att) => !att.mimeType.startsWith("image/"));

    const imageInputs = imageAttachments.map((att) => ({
      id: att.id,
      name: att.name,
      mimeType: att.mimeType,
      dataUrl: `data:${att.mimeType};base64,${att.bytes.toString("base64")}`,
    }));

    const textChunks: string[] = [];
    const documentSummaries: ResolvedTurnContext["documentSummaries"] = [];

    // 1. Process Non-Image Attachments (PDFs, Code, Documents)
    for (const attachment of nonImageAttachments) {
      if (attachment.kind === "pdf" || attachment.mimeType === "application/pdf" || attachment.name.toLowerCase().endsWith(".pdf")) {
        const extracted = extractPdfText(attachment.bytes);
        documentSummaries.push({
          name: attachment.name,
          kind: "pdf",
          size: attachment.size,
          pageCount: extracted.pageCount,
        });

        if (extracted.warning && !extracted.text) {
          textChunks.push(`[Attached PDF: ${attachment.name}] Notice: ${extracted.warning}`);
        } else {
          const boundedText = extracted.text.slice(0, 300_000);
          textChunks.push(
            `[Attached PDF Specification: ${attachment.name} (${extracted.pageCount} page${extracted.pageCount === 1 ? "" : "s"})]\n${boundedText}`
          );
        }
        continue;
      }

      // Plain text, code, logs
      try {
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(attachment.bytes);
        const bounded = decoded.slice(0, 250_000);
        documentSummaries.push({
          name: attachment.name,
          kind: attachment.kind === "code" ? "code" : "document",
          size: attachment.size,
        });
        textChunks.push(`[Attached File: ${attachment.name}]\n${bounded}`);
      } catch {
        textChunks.push(`[Attachment ${attachment.name} could not be safely decoded as bounded UTF-8 text.]`);
      }
    }

    // 2. Scan and resolve @path/to/file references within prompt
    if (workspaceRoot) {
      const fileRefRegex = /(?:^|\s)@([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9_]+)/g;
      let match: RegExpExecArray | null;
      while ((match = fileRefRegex.exec(prompt)) !== null) {
        const refPath = match[1]!;
        if (isSafeWorkspacePath(refPath, workspaceRoot)) {
          const fullPath = path.resolve(workspaceRoot, refPath);
          try {
            const st = await stat(fullPath);
            if (st.isFile() && st.size <= 250_000) {
              const fileContent = await readFile(fullPath, "utf-8");
              textChunks.push(`[Project File Reference @${refPath}]:\n${fileContent}`);
            }
          } catch {
            // File does not exist or unreadable, ignore silently
          }
        }
      }
    }

    // 3. Multimodal Capability Routing
    let visualPerception: ResolvedTurnContext["visualPerception"];
    let unsupportedError: string | undefined;

    if (imageInputs.length > 0) {
      const primarySupportsVision = selectedModelCapabilities?.vision === true;

      if (!primarySupportsVision) {
        // Primary model is text-only (e.g. Dahl MiniMax).
        // Check if an enabled vision specialist is available in the model registry.
        let visionClientResolved = false;
        if (this.modelResolver) {
          try {
            const resolvedVision = this.modelResolver.resolveForOperation("image-perception");
            if (resolvedVision?.client && resolvedVision.descriptor) {
              visionClientResolved = true;

              // Request visual perception from the vision specialist
              const perceptionPrompt = imageInputs.length === 1
                ? `Carefully analyze this image. Describe the visual layout, user interface components, buttons, typography, colors, text content, error messages, and technical details visible in the screenshot so that a software engineer can accurately implement or debug the component. Answer thoroughly with clear technical structure.`
                : `Carefully compare the provided screenshots. Detail the differences, layout changes, component states, and visual elements between the images. Answer thoroughly with clear technical structure.`;

              const perceptionResponse = await resolvedVision.client.complete({
                system: "You are an expert multimodal visual perception specialist for an AI coding platform. Ground your answer strictly in the pixels and visible elements of the image.",
                input: perceptionPrompt,
                images: imageInputs.map((img) => ({ mimeType: img.mimeType, dataUrl: img.dataUrl })),
                signal: signal ?? AbortSignal.timeout(60_000),
                rawText: true,
              });

              const cleanedFindings = sanitizeReasoningAndSecrets(perceptionResponse).trim();
              if (cleanedFindings) {
                visualPerception = {
                  provider: resolvedVision.descriptor.providerId,
                  modelId: resolvedVision.descriptor.modelId,
                  findings: cleanedFindings,
                };
                textChunks.push(
                  `[Visual Perception Analysis from Vision Specialist (${resolvedVision.descriptor.modelId})]:\n${cleanedFindings}`
                );
              }
            }
          } catch {
            // Vision inference failure or timeout
          }
        }

        if (!visionClientResolved && !visualPerception) {
          unsupportedError = "The selected model does not support image input, and no vision specialist model is currently connected. Please connect a vision model (such as NVIDIA DiffusionGemma) in Settings to process images.";
        }
      }
    }

    const fullPrompt = [prompt, ...textChunks].filter(Boolean).join("\n\n");

    return {
      textPrompt: prompt,
      promptWithContext: fullPrompt,
      imageInputs,
      documentSummaries,
      ...(visualPerception ? { visualPerception } : {}),
      ...(unsupportedError ? { unsupportedError } : {}),
    };
  }
}
