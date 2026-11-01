import type { ParsedSubtitle, SubtitleCue, SubtitleFormat, SubtitleSegment } from "./subtitle-model";
import { encodingDetector } from "./encoding-detector";
import { SubtitleError } from "../utils/errors";

export interface SubtitleParser {
  readonly format: SubtitleFormat;
  parse(bytes: ArrayBuffer, encoding?: string): ParsedSubtitle;
}

export class SrtParser implements SubtitleParser {
  readonly format: SubtitleFormat = "srt";

  parse(bytes: ArrayBuffer, encoding?: string): ParsedSubtitle {
    const text = encodingDetector.decode(bytes, encoding);
    const warnings: string[] = [];
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const blocks = normalized.split(/\n\n+/).filter((b) => b.trim().length > 0);

    const cues: SubtitleCue[] = [];
    let sourceOrder = 0;

    for (const block of blocks) {
      const lines = block.split("\n");
      if (lines.length < 2) {
        warnings.push(`跳过不完整字幕块：${block.slice(0, 40)}`);
        continue;
      }

      let timeLineIndex = 0;
      if (!/-->/.test(lines[0])) {
        timeLineIndex = 1;
      }

      const timeMatch = lines[timeLineIndex]?.match(
        /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/,
      );

      if (!timeMatch) {
        warnings.push(`无法解析时间轴：${lines[timeLineIndex] ?? block.slice(0, 40)}`);
        continue;
      }

      const startMs = timeToMs(
        Number(timeMatch[1]),
        Number(timeMatch[2]),
        Number(timeMatch[3]),
        Number(timeMatch[4]),
      );
      const endMs = timeToMs(
        Number(timeMatch[5]),
        Number(timeMatch[6]),
        Number(timeMatch[7]),
        Number(timeMatch[8]),
      );

      if (endMs < startMs) {
        warnings.push(`时间范围反向：${startMs} -> ${endMs}`);
        continue;
      }

      const textLines = lines.slice(timeLineIndex + 1);
      const rawText = textLines.join("\n").trim();
      if (!rawText) {
        warnings.push("空字幕文本已跳过");
        continue;
      }

      const { text, segments } = parseInlineTags(rawText);

      cues.push({
        id: cues.length,
        startMs,
        endMs,
        text,
        segments,
        sourceOrder: sourceOrder++,
      });
    }

    return {
      format: "srt",
      encoding: encoding ?? encodingDetector.detect(bytes),
      cues,
      warnings,
    };
  }
}

function timeToMs(hours: number, minutes: number, seconds: number, millis: number): number {
  return hours * 3600_000 + minutes * 60_000 + seconds * 1000 + millis;
}

const TAG_PATTERN = /<(\/?)([biu])>/gi;

function parseInlineTags(raw: string): { text: string; segments: SubtitleSegment[] } {
  const segments: SubtitleSegment[] = [];
  let text = "";
  let lastIndex = 0;
  let bold = false;
  let italic = false;
  let underline = false;

  const pushSegment = (content: string) => {
    if (!content) return;
    segments.push({ text: content, bold, italic, underline });
    text += content;
  };

  let match: RegExpExecArray | null;
  TAG_PATTERN.lastIndex = 0;
  while ((match = TAG_PATTERN.exec(raw)) !== null) {
    pushSegment(raw.slice(lastIndex, match.index));
    const isClose = match[1] === "/";
    const tag = match[2].toLowerCase();
    if (tag === "b") bold = !isClose;
    else if (tag === "i") italic = !isClose;
    else if (tag === "u") underline = !isClose;
    lastIndex = TAG_PATTERN.lastIndex;
  }
  pushSegment(raw.slice(lastIndex));

  if (segments.length === 0) {
    return { text: raw, segments: [{ text: raw }] };
  }
  return { text, segments };
}

export function parseSubtitle(bytes: ArrayBuffer, format: SubtitleFormat, encoding?: string): ParsedSubtitle {
  switch (format) {
    case "srt":
      return new SrtParser().parse(bytes, encoding);
    case "vtt":
      return new VttParser().parse(bytes, encoding);
    default:
      throw new SubtitleError("UNSUPPORTED_FORMAT", `不支持的字幕格式：${format}`);
  }
}

export class VttParser implements SubtitleParser {
  readonly format: SubtitleFormat = "vtt";

  parse(bytes: ArrayBuffer, encoding?: string): ParsedSubtitle {
    const text = encodingDetector.decode(bytes, encoding);
    const warnings: string[] = [];
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    if (!normalized.startsWith("WEBVTT")) {
      throw new SubtitleError("PARSE_FAILED", "VTT 文件缺少 WEBVTT 文件头");
    }

    const lines = normalized.split("\n");
    const cues: SubtitleCue[] = [];
    let sourceOrder = 0;
    let i = 0;

    while (i < lines.length && lines[i] !== "") i++;
    i++;

    while (i < lines.length) {
      while (i < lines.length && lines[i].trim() === "") i++;
      if (i >= lines.length) break;

      const blockStart = i;
      while (i < lines.length && lines[i].trim() !== "") i++;
      const block = lines.slice(blockStart, i);

      if (block.length === 0) continue;
      if (block[0].trim().toUpperCase().startsWith("NOTE")) continue;

      let timeLineIndex = 0;
      if (!block[0].includes("-->")) {
        timeLineIndex = 1;
      }

      const timeLine = block[timeLineIndex];
      const timeMatch = timeLine?.match(
        /(\d{1,2}:)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{1,2}:)?(\d{2}):(\d{2})\.(\d{3})/,
      );

      if (!timeMatch) {
        warnings.push(`无法解析 VTT 时间轴：${timeLine ?? ""}`);
        continue;
      }

      const startMs = vttTimeToMs(timeMatch[1], timeMatch[2], timeMatch[3], timeMatch[4]);
      const endMs = vttTimeToMs(timeMatch[5], timeMatch[6], timeMatch[7], timeMatch[8]);

      if (endMs < startMs) {
        warnings.push(`时间范围反向：${startMs} -> ${endMs}`);
        continue;
      }

      const textLines = block.slice(timeLineIndex + 1);
      const rawText = textLines.join("\n").trim();
      if (!rawText) {
        warnings.push("空字幕文本已跳过");
        continue;
      }

      const { text, segments } = parseVttTags(rawText);

      cues.push({
        id: cues.length,
        startMs,
        endMs,
        text,
        segments,
        sourceOrder: sourceOrder++,
      });
    }

    return {
      format: "vtt",
      encoding: encoding ?? encodingDetector.detect(bytes),
      cues,
      warnings,
    };
  }
}

function vttTimeToMs(hours: string | undefined, minutes: string, seconds: string, millis: string): number {
  const h = hours ? parseInt(hours, 10) : 0;
  return h * 3600_000 + parseInt(minutes, 10) * 60_000 + parseInt(seconds, 10) * 1000 + parseInt(millis, 10);
}

const VTT_TAG_PATTERN = /<\/?([biu]|c[^>]*)>/gi;

function parseVttTags(raw: string): { text: string; segments: SubtitleSegment[] } {
  const segments: SubtitleSegment[] = [];
  let text = "";
  let lastIndex = 0;
  let bold = false;
  let italic = false;
  let underline = false;

  const pushSegment = (content: string) => {
    if (!content) return;
    segments.push({ text: content, bold, italic, underline });
    text += content;
  };

  let match: RegExpExecArray | null;
  VTT_TAG_PATTERN.lastIndex = 0;
  while ((match = VTT_TAG_PATTERN.exec(raw)) !== null) {
    pushSegment(raw.slice(lastIndex, match.index));
    const tag = match[1].toLowerCase();
    const isClose = match[0].startsWith("</");
    if (tag === "b") bold = !isClose;
    else if (tag === "i") italic = !isClose;
    else if (tag === "u") underline = !isClose;
    lastIndex = VTT_TAG_PATTERN.lastIndex;
  }
  pushSegment(raw.slice(lastIndex));

  if (segments.length === 0) {
    return { text: raw, segments: [{ text: raw }] };
  }
  return { text, segments };
}

export function detectFormat(fileName: string): SubtitleFormat {
  const ext = fileName.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "srt":
      return "srt";
    case "vtt":
      return "vtt";
    case "ass":
      return "ass";
    case "ssa":
      return "ssa";
    default:
      return "unknown";
  }
}