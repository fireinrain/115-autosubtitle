import type { PlayerMetadata } from "../player/player-adapter";
import { isFiniteNumber } from "../utils/number";

export interface ParsedCode {
  raw: string;
  normalized: string;
  family?: string;
  confidence: number;
}

export interface VideoIdentity {
  videoKey: string;
  fileId?: string;
  originalFileName?: string;
  normalizedFileName?: string;
  code?: string;
  duration?: number;
  fileSize?: number;
  confidence: "strong" | "medium" | "weak";
  source: "115-dom" | "media-element" | "manual";
}

export function normalizeFileName(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[\s_.]+/g, " ")
      .replace(/[\u005B\u005D【】（）()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

export interface CodeParser {
  readonly id: string;
  readonly priority: number;
  match(input: string): boolean;
  parse(input: string): ParsedCode | null;
}

class StandardCodeParser implements CodeParser {
  readonly id = "standard-code";
  readonly priority = 10;

  match(input: string): boolean {
    return /[A-Z]{2,8}-\d{2,6}/i.test(input);
  }

  parse(input: string): ParsedCode | null {
    const match = input.match(/([A-Z]{2,8})-(\d{2,6})/i);
    if (!match) return null;
    const raw = match[0];
    const normalized = `${match[1].toUpperCase()}-${match[2]}`;
    return { raw, normalized, family: "standard", confidence: 0.9 };
  }
}

class NoHyphenCodeParser implements CodeParser {
  readonly id = "nohyphen-code";
  readonly priority = 20;

  match(input: string): boolean {
    return /(?:^|[^A-Z])([A-Z]{2,6})(\d{3,6})(?:[^0-9]|$)/i.test(input);
  }

  parse(input: string): ParsedCode | null {
    const match = input.match(/(?:^|[^A-Z])([A-Z]{2,6})(\d{3,6})(?:[^0-9]|$)/i);
    if (!match) return null;
    const raw = `${match[1]}${match[2]}`;
    const normalized = `${match[1].toUpperCase()}-${match[2]}`;
    return { raw, normalized, family: "nohyphen", confidence: 0.6 };
  }
}

class Fc2PpvCodeParser implements CodeParser {
  readonly id = "fc2-ppv-code";
  readonly priority = 5;

  match(input: string): boolean {
    return /FC2[-_]?PPV[-_]?(\d+)/i.test(input);
  }

  parse(input: string): ParsedCode | null {
    const match = input.match(/FC2[-_]?PPV[-_]?(\d+)/i);
    if (!match) return null;
    const raw = match[0];
    const normalized = `FC2-PPV-${match[1]}`;
    return { raw, normalized, family: "fc2-ppv", confidence: 0.95 };
  }
}

const PARSERS: CodeParser[] = [
  new Fc2PpvCodeParser(),
  new StandardCodeParser(),
  new NoHyphenCodeParser(),
].sort((a, b) => a.priority - b.priority);

export function parseCode(fileName: string): ParsedCode | null {
  const upper = fileName.toUpperCase();
  for (const parser of PARSERS) {
    if (parser.match(upper)) {
      return parser.parse(upper);
    }
  }
  return null;
}

export class VideoIdentityService {
  resolve(metadata: PlayerMetadata): VideoIdentity {
    const originalFileName = metadata.fileName;
    const normalizedFileName = originalFileName ? normalizeFileName(originalFileName) : undefined;
    const parsedCode = normalizedFileName ? parseCode(normalizedFileName) : null;

    const parts: string[] = [];
    let confidence: "strong" | "medium" | "weak" = "weak";

    if (metadata.fileId) {
      parts.push(`id:${metadata.fileId}`);
      confidence = "strong";
    } else if (normalizedFileName) {
      parts.push(`name:${normalizedFileName}`);
      confidence = "medium";
    }

    if (metadata.duration && isFiniteNumber(metadata.duration)) {
      parts.push(`dur:${Math.round(metadata.duration)}`);
    }

    if (parts.length === 0) {
      parts.push(`url:${metadata.sourcePageUrl}`);
    }

    const videoKey = parts.join("|");

    return {
      videoKey,
      fileId: metadata.fileId,
      originalFileName,
      normalizedFileName,
      code: parsedCode?.normalized,
      duration: metadata.duration,
      confidence,
      source: metadata.fileId ? "115-dom" : "media-element",
    };
  }
}