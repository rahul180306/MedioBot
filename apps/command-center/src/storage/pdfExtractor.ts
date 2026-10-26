import { inflateSync, inflateRawSync } from "node:zlib";

export interface ExtractedPdfDocument {
  readonly text: string;
  readonly pageCount: number;
  readonly metadata?: {
    readonly title?: string;
    readonly author?: string;
    readonly subject?: string;
    readonly creator?: string;
  };
  readonly warning?: string;
}

const MAX_DECOMPRESSED_BYTES = 20 * 1024 * 1024; // 20 MB max decompression to prevent zip-bomb / DOS

/**
 * Decodes PDF string escapes: \n, \r, \t, \b, \f, \(, \), \\, \ddd (octal)
 */
function decodePdfLiteralString(str: string): string {
  // Check for UTF-16BE BOM: \xfe\xff
  if (str.startsWith("\xfe\xff") || (str.length >= 2 && str.charCodeAt(0) === 0xfe && str.charCodeAt(1) === 0xff)) {
    try {
      const buf = Buffer.from(str.slice(2), "binary");
      const utf16 = new TextDecoder("utf-16be", { fatal: false }).decode(buf);
      return utf16;
    } catch {
      // fallback
    }
  }

  let result = "";
  let i = 0;
  while (i < str.length) {
    if (str[i] === "\\" && i + 1 < str.length) {
      const next = str[i + 1]!;
      if (next === "n") { result += "\n"; i += 2; }
      else if (next === "r") { result += "\r"; i += 2; }
      else if (next === "t") { result += "\t"; i += 2; }
      else if (next === "b") { result += "\b"; i += 2; }
      else if (next === "f") { result += "\f"; i += 2; }
      else if (next === "(") { result += "("; i += 2; }
      else if (next === ")") { result += ")"; i += 2; }
      else if (next === "\\") { result += "\\"; i += 2; }
      else if (/[0-7]/.test(next)) {
        // Octal escape up to 3 digits
        let octal = next;
        let j = i + 2;
        while (j < str.length && j < i + 4 && /[0-7]/.test(str[j]!)) {
          octal += str[j]!;
          j++;
        }
        result += String.fromCharCode(parseInt(octal, 8));
        i = j;
      } else {
        result += next;
        i += 2;
      }
    } else {
      result += str[i]!;
      i++;
    }
  }
  return result;
}

/**
 * Decodes PDF hex string `<48656c6c6f>`
 */
function decodePdfHexString(hex: string): string {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  // If odd length, PDF spec says append trailing 0
  const padded = clean.length % 2 === 1 ? clean + "0" : clean;
  const buf = Buffer.from(padded, "hex");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder("utf-16be", { fatal: false }).decode(buf.subarray(2));
  }
  return buf.toString("latin1");
}

/**
 * Extracts text commands from uncompressed PDF content stream
 */
function extractTextFromContentStream(streamText: string): string[] {
  const lines: string[] = [];
  // Match text blocks: BT ... ET
  const btEtRegex = /BT[\s\S]*?ET/g;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = btEtRegex.exec(streamText)) !== null) {
    const block = blockMatch[0];
    let currentLine = "";

    // Parse tokens inside the BT...ET block
    // We look for:
    // (literal string) Tj or ' or "
    // <hex string> Tj or ' or "
    // [ ... ] TJ
    // T* or TD or Td (line break)
    let idx = 0;
    while (idx < block.length) {
      const char = block[idx];

      // Line breaking operators in text object
      if (block.startsWith("T*", idx) || block.startsWith("T\r", idx) || block.startsWith("T\n", idx)) {
        if (currentLine.trim()) lines.push(currentLine.trim());
        currentLine = "";
      }

      // Check for array TJ: [ (text) -120 (more text) ] TJ
      if (char === "[") {
        const closeIdx = block.indexOf("]", idx);
        if (closeIdx !== -1) {
          const sub = block.slice(idx + 1, closeIdx);
          const afterClose = block.slice(closeIdx + 1, closeIdx + 10).trimStart();
          if (afterClose.startsWith("TJ")) {
            // Extract all strings in array
            const strRegex = /\((?:\\.|[^\\)])*\)|<[0-9a-fA-F\s]+>/g;
            let sm: RegExpExecArray | null;
            while ((sm = strRegex.exec(sub)) !== null) {
              const matched = sm[0];
              if (matched.startsWith("(")) {
                currentLine += decodePdfLiteralString(matched.slice(1, -1));
              } else if (matched.startsWith("<")) {
                currentLine += decodePdfHexString(matched.slice(1, -1));
              }
            }
            idx = closeIdx + 1;
            continue;
          }
        }
      }

      // Check for literal string ( ... )
      if (char === "(") {
        let depth = 1;
        let strContent = "";
        let j = idx + 1;
        while (j < block.length && depth > 0) {
          if (block[j] === "\\" && j + 1 < block.length) {
            strContent += block[j]! + block[j + 1]!;
            j += 2;
          } else if (block[j] === "(") {
            depth++;
            strContent += "(";
            j++;
          } else if (block[j] === ")") {
            depth--;
            if (depth > 0) strContent += ")";
            j++;
          } else {
            strContent += block[j]!;
            j++;
          }
        }
        const afterStr = block.slice(j, j + 10).trimStart();
        if (afterStr.startsWith("Tj") || afterStr.startsWith("'") || afterStr.startsWith('"')) {
          const decoded = decodePdfLiteralString(strContent);
          currentLine += decoded;
          if (afterStr.startsWith("'") || afterStr.startsWith('"')) {
            if (currentLine.trim()) lines.push(currentLine.trim());
            currentLine = "";
          }
        }
        idx = j;
        continue;
      }

      // Check for hex string < ... >
      if (char === "<" && idx + 1 < block.length && block[idx + 1] !== "<") {
        const closeIdx = block.indexOf(">", idx);
        if (closeIdx !== -1) {
          const hexContent = block.slice(idx + 1, closeIdx);
          const afterHex = block.slice(closeIdx + 1, closeIdx + 10).trimStart();
          if (afterHex.startsWith("Tj") || afterHex.startsWith("'") || afterHex.startsWith('"')) {
            const decoded = decodePdfHexString(hexContent);
            currentLine += decoded;
            if (afterHex.startsWith("'") || afterHex.startsWith('"')) {
              if (currentLine.trim()) lines.push(currentLine.trim());
              currentLine = "";
            }
          }
          idx = closeIdx + 1;
          continue;
        }
      }

      // Standard new line positioning: Td or TD with non-zero y translation
      if ((char === "T" || char === "t") && idx + 1 < block.length && (block[idx + 1] === "d" || block[idx + 1] === "D")) {
        // e.g. 0 -14.4 Td
        if (currentLine.trim()) {
          lines.push(currentLine.trim());
          currentLine = "";
        }
      }

      idx++;
    }

    if (currentLine.trim()) {
      lines.push(currentLine.trim());
    }
  }

  return lines;
}

/**
 * Safely extracts text and metadata from a PDF buffer without native dependencies.
 */
export function extractPdfText(buffer: Buffer): ExtractedPdfDocument {
  if (buffer.length < 8) {
    return { text: "", pageCount: 0, warning: "Empty or truncated PDF." };
  }

  // Verify PDF magic bytes
  const header = buffer.toString("ascii", 0, Math.min(buffer.length, 1024));
  if (!header.includes("%PDF-")) {
    return { text: "", pageCount: 0, warning: "File does not contain valid PDF magic bytes." };
  }

  try {
    const rawContent = buffer.toString("binary");

    // Count pages by searching for /Type /Page (and not /Pages)
    const pageMatches = rawContent.match(/\/Type\s*\/Page\b/g);
    const pageCount = pageMatches ? pageMatches.length : 1;

    // Check for encryption /Encrypt
    if (rawContent.includes("/Encrypt")) {
      return { text: "", pageCount, warning: "PDF document is encrypted or password-protected." };
    }

    // Extract Info dictionary metadata if present
    let title: string | undefined;
    let author: string | undefined;
    let subject: string | undefined;
    let creator: string | undefined;

    const titleMatch = rawContent.match(/\/Title\s*\(([^)]+)\)/);
    if (titleMatch?.[1]) title = decodePdfLiteralString(titleMatch[1]);
    const authorMatch = rawContent.match(/\/Author\s*\(([^)]+)\)/);
    if (authorMatch?.[1]) author = decodePdfLiteralString(authorMatch[1]);
    const subjectMatch = rawContent.match(/\/Subject\s*\(([^)]+)\)/);
    if (subjectMatch?.[1]) subject = decodePdfLiteralString(subjectMatch[1]);
    const creatorMatch = rawContent.match(/\/Creator\s*\(([^)]+)\)/);
    if (creatorMatch?.[1]) creator = decodePdfLiteralString(creatorMatch[1]);

    const extractedTextParts: string[] = [];

    // Find all stream ... endstream blocks in the buffer
    // Binary safe stream slicing
    const streamStartMarker = Buffer.from("stream");
    const endstreamMarker = Buffer.from("endstream");

    let searchOffset = 0;
    while (searchOffset < buffer.length) {
      const streamIdx = buffer.indexOf(streamStartMarker, searchOffset);
      if (streamIdx === -1) break;

      // Find the start of stream bytes (after \r\n or \n)
      let dataStart = streamIdx + streamStartMarker.length;
      if (buffer[dataStart] === 0x0d && buffer[dataStart + 1] === 0x0a) {
        dataStart += 2;
      } else if (buffer[dataStart] === 0x0a || buffer[dataStart] === 0x0d) {
        dataStart += 1;
      }

      const endstreamIdx = buffer.indexOf(endstreamMarker, dataStart);
      if (endstreamIdx === -1) break;

      // Check preceding dictionary for /Filter
      const dictPrefix = buffer.subarray(Math.max(0, streamIdx - 1000), streamIdx).toString("binary");
      const isFlate = dictPrefix.includes("/FlateDecode") || dictPrefix.includes("/Fl");

      const streamBytes = buffer.subarray(dataStart, endstreamIdx);

      if (streamBytes.length > 0) {
        let decompressed: Buffer | undefined;
        if (isFlate) {
          try {
            decompressed = inflateSync(streamBytes, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
          } catch {
            try {
              decompressed = inflateRawSync(streamBytes, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
            } catch {
              // Ignore corrupt or non-zlib streams safely
            }
          }
        } else {
          decompressed = streamBytes;
        }

        if (decompressed && decompressed.length > 0) {
          const streamText = decompressed.toString("latin1");
          if (streamText.includes("BT")) {
            const lines = extractTextFromContentStream(streamText);
            if (lines.length > 0) {
              extractedTextParts.push(...lines);
            }
          }
        }
      }

      searchOffset = endstreamIdx + endstreamMarker.length;
    }

    // Also check for uncompressed text outside streams if any
    let fullText = extractedTextParts.join("\n").trim();

    // Deduplicate consecutive identical lines (e.g. from overlapping text drops)
    if (fullText) {
      const cleanLines = fullText.split("\n").filter((line, i, arr) => line.trim() && (i === 0 || line !== arr[i - 1]));
      fullText = cleanLines.join("\n");
    }

    return {
      text: fullText,
      pageCount: Math.max(1, pageCount),
      metadata: {
        ...(title ? { title } : {}),
        ...(author ? { author } : {}),
        ...(subject ? { subject } : {}),
        ...(creator ? { creator } : {}),
      },
    };
  } catch (err) {
    return {
      text: "",
      pageCount: 1,
      warning: `PDF parsing encountered an error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
