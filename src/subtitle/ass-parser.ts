import type { ParsedSubtitle, SubtitleCue, SubtitleFormat, SubtitleSegment } from "./subtitle-model";
import { encodingDetector } from "./encoding-detector";
import { SubtitleError } from "../utils/errors";
import { isFiniteNumber } from "../utils/number";

/**
 * ASS/SSA 文本提取器。
 *
 * 当前产品只保留字幕文字与时间轴，因此这里负责从 [Events] 中提取
 * Dialogue 的 Start/End/Text，并处理 `\N` / `\n` / `\h` 等文本转义。
 * 内联标签会被解析为 Segment，但 `ass-to-vtt.ts` 只取纯文本，不把样式写入 VTT。
 * 样式表、定位、动画、卡拉 OK 和绘图指令不会渲染，只会记录 warnings。
 */
export class AssParser {
  readonly format: SubtitleFormat;

  constructor(format: SubtitleFormat = "ass") {
    this.format = format === "ssa" ? "ssa" : "ass";
  }

  parse(bytes: ArrayBuffer, encoding?: string): ParsedSubtitle {
    const text = encodingDetector.decode(bytes, encoding);
    const warnings: string[] = [];
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n");

    let section = "";
    let scriptType = "";
    let eventFormat: string[] | null = null;
    let hasEventsSection = false;
    let hasStyleDefinitions = false;
    let missingFormat = false;
    let sawUnsupportedTag = false;
    let sawDrawing = false;

    const cues: SubtitleCue[] = [];
    let sourceOrder = 0;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.startsWith("[") && line.endsWith("]")) {
        section = line.slice(1, -1).trim().toLowerCase();
        if (section === "events") hasEventsSection = true;
        continue;
      }

      if (section === "script info") {
        const match = line.match(/^scripttype\s*:\s*(.+)$/i);
        if (match) scriptType = match[1].trim().toLowerCase();
        continue;
      }

      if (section === "v4+ styles" || section === "v4 styles") {
        if (/^style\s*:/i.test(line)) hasStyleDefinitions = true;
        continue;
      }

      if (section !== "events") continue;

      if (/^format\s*:/i.test(line)) {
        const value = line.slice(line.indexOf(":") + 1);
        const fields = value
          .split(",")
          .map((field) => field.trim().toLowerCase())
          .filter(Boolean);
        if (fields.length > 0) eventFormat = fields;
        continue;
      }

      if (!/^dialogue\s*:/i.test(line)) continue;

      const format = eventFormat ?? defaultEventFormat(scriptType, this.format);
      if (!eventFormat) missingFormat = true;

      const payload = line.slice(line.indexOf(":") + 1).trimStart();
      const fields = splitEventFields(payload, format.length);
      if (fields.length < format.length) {
        warnings.push(`Dialogue 字段不足，已跳过：${payload.slice(0, 40)}`);
        continue;
      }

      const startIndex = format.indexOf("start");
      const endIndex = format.indexOf("end");
      const textIndex = format.indexOf("text");
      if (startIndex < 0 || endIndex < 0 || textIndex < 0) {
        warnings.push(`Dialogue Format 缺少 Start/End/Text 字段，已跳过：${payload.slice(0, 40)}`);
        continue;
      }

      const startMs = parseAssTime(fields[startIndex]);
      const endMs = parseAssTime(fields[endIndex]);
      if (startMs === null || endMs === null) {
        warnings.push(`无法解析 ASS 时间轴：${fields[startIndex]} -> ${fields[endIndex]}`);
        continue;
      }
      if (endMs < startMs) {
        warnings.push(`时间范围反向：${startMs} -> ${endMs}`);
        continue;
      }

      const rawText = fields[textIndex] ?? "";
      if (!rawText.trim()) {
        warnings.push("空字幕文本已跳过");
        continue;
      }

      const parsedText = parseAssText(rawText);
      if (parsedText.sawUnsupportedTag) sawUnsupportedTag = true;
      if (parsedText.sawDrawing) sawDrawing = true;

      if (!parsedText.text.trim()) {
        warnings.push(`仅包含绘图或空文本的 Dialogue 已跳过：${rawText.slice(0, 40)}`);
        continue;
      }

      cues.push({
        id: cues.length,
        startMs,
        endMs,
        text: parsedText.text,
        segments: parsedText.segments,
        sourceOrder: sourceOrder++,
      });
    }

    if (!hasEventsSection) {
      throw new SubtitleError("PARSE_FAILED", "ASS/SSA 文件缺少 [Events] 段");
    }
    if (missingFormat) {
      warnings.push("Event 段缺少 Format 行，已使用默认字段顺序");
    }
    if (hasStyleDefinitions) {
      warnings.push("ASS/SSA 转换：已忽略样式定义");
    }
    if (sawUnsupportedTag) {
      warnings.push("ASS/SSA 转换：已忽略定位、动画、字体、描边等覆盖标签");
    }
    if (sawDrawing) {
      warnings.push("ASS/SSA 转换：已忽略 \\p 绘图指令");
    }
    if (cues.length === 0) {
      warnings.push("未找到可显示的 Dialogue 字幕");
    }

    return {
      format: this.format,
      encoding: encoding ?? encodingDetector.detect(bytes),
      cues,
      warnings,
    };
  }
}

function defaultEventFormat(scriptType: string, fallback: SubtitleFormat): string[] {
  // ASS（v4.00+）用 Layer，SSA（v4.00）用 Marked。没有 ScriptType 时按扩展名回退。
  const isSsa = scriptType.includes("v4.00") && !scriptType.includes("v4.00+")
    ? true
    : scriptType.includes("v4.00+")
      ? false
      : fallback === "ssa";
  return isSsa
    ? ["marked", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"]
    : ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
}

/**
 * Dialogue 的 Text 是最后一个字段，内部允许出现逗号，因此只切前 n-1 个逗号。
 */
function splitEventFields(payload: string, count: number): string[] {
  const fields: string[] = [];
  let rest = payload;

  for (let i = 0; i < count - 1; i++) {
    const comma = rest.indexOf(",");
    if (comma < 0) {
      fields.push(rest);
      return fields;
    }
    fields.push(rest.slice(0, comma));
    rest = rest.slice(comma + 1);
  }
  fields.push(rest);
  return fields;
}

function parseAssTime(value: string): number | null {
  // ASS 标准是 h:mm:ss.cc；同时兼容 1/3 位小数和逗号分隔，避免来源差异导致整段丢失。
  const match = value.trim().match(/^(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const fraction = match[4] ?? "0";

  let millis: number;
  if (fraction.length === 1) millis = Number(fraction) * 100;
  else if (fraction.length === 2) millis = Number(fraction) * 10;
  else millis = Number(fraction);

  if (![hours, minutes, seconds, millis].every(isFiniteNumber)) return null;

  return hours * 3_600_000 + minutes * 60_000 + seconds * 1000 + millis;
}

interface AssTextState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color?: string;
  drawing: boolean;
}

interface AssTextParseResult {
  text: string;
  segments: SubtitleSegment[];
  sawUnsupportedTag: boolean;
  sawDrawing: boolean;
}

function parseAssText(raw: string): AssTextParseResult {
  const segments: SubtitleSegment[] = [];
  const state: AssTextState = {
    bold: false,
    italic: false,
    underline: false,
    drawing: false,
  };

  let text = "";
  let buffer = "";
  let sawUnsupportedTag = false;
  let sawDrawing = false;

  const flush = () => {
    if (!buffer) return;
    if (!state.drawing) {
      const segment: SubtitleSegment = { text: buffer };
      if (state.bold) segment.bold = true;
      if (state.italic) segment.italic = true;
      if (state.underline) segment.underline = true;
      if (state.color) segment.color = state.color;
      segments.push(segment);
      text += buffer;
    }
    buffer = "";
  };

  let i = 0;
  while (i < raw.length) {
    const char = raw[i];

    if (char === "{") {
      flush();
      const end = raw.indexOf("}", i + 1);
      if (end === -1) {
        // 未闭合的覆盖块按普通文本保留，避免吞掉整条字幕。
        buffer += raw.slice(i);
        break;
      }
      const result = applyOverrideBlock(raw.slice(i + 1, end), state);
      if (result.sawUnsupportedTag) sawUnsupportedTag = true;
      if (result.sawDrawing) sawDrawing = true;
      i = end + 1;
      continue;
    }

    if (char === "\\") {
      const next = raw[i + 1];
      if (next === "N" || next === "n") {
        buffer += "\n";
        i += 2;
        continue;
      }
      if (next === "h") {
        buffer += " ";
        i += 2;
        continue;
      }
      if (next === "{" || next === "}") {
        // 少量来源会用反斜杠转义花括号，避免被当成覆盖块。
        buffer += next;
        i += 2;
        continue;
      }
      // 非标准转义：保留原文，最终由 textContent 安全显示。
      buffer += char;
      i++;
      continue;
    }

    buffer += char;
    i++;
  }

  flush();

  return { text, segments, sawUnsupportedTag, sawDrawing };
}

function applyOverrideBlock(
  block: string,
  state: AssTextState,
): { sawUnsupportedTag: boolean; sawDrawing: boolean } {
  let sawUnsupportedTag = false;
  let sawDrawing = false;
  let i = 0;

  while (i < block.length) {
    if (block[i] !== "\\") {
      i++;
      continue;
    }
    i++;

    const nameStart = i;
    while (i < block.length && isAsciiDigit(block[i])) i++;
    while (i < block.length && isAsciiLetter(block[i])) i++;
    const name = block.slice(nameStart, i).toLowerCase();
    if (!name) continue;

    let args: string;
    if (block[i] === "(") {
      const end = findClosingParen(block, i);
      args = block.slice(i + 1, end);
      i = end < block.length ? end + 1 : block.length;
    } else if (block[i] === "&") {
      const end = block.indexOf("&", i + 1);
      if (end === -1) {
        args = block.slice(i);
        i = block.length;
      } else {
        args = block.slice(i, end + 1);
        i = end + 1;
      }
    } else {
      const next = block.indexOf("\\", i);
      const end = next === -1 ? block.length : next;
      args = block.slice(i, end);
      i = end;
    }

    switch (name) {
      case "b":
        state.bold = parseToggle(args);
        break;
      case "i":
        state.italic = parseToggle(args);
        break;
      case "u":
        state.underline = parseToggle(args);
        break;
      case "c":
      case "1c": {
        const value = args.trim();
        if (!value) {
          state.color = undefined;
          break;
        }
        const color = parseAssColor(value);
        if (color) state.color = color;
        else sawUnsupportedTag = true;
        break;
      }
      case "r":
        // \r 重置为默认样式；\rStyleName 需要样式表，转换为 VTT 时不应用。
        state.bold = false;
        state.italic = false;
        state.underline = false;
        state.color = undefined;
        if (args.trim()) sawUnsupportedTag = true;
        break;
      case "p": {
        const drawing = args.trim() !== "" && Number(args) > 0;
        state.drawing = drawing;
        if (drawing) sawDrawing = true;
        break;
      }
      default:
        sawUnsupportedTag = true;
        break;
    }
  }

  return { sawUnsupportedTag, sawDrawing };
}

function findClosingParen(value: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < value.length; i++) {
    if (value[i] === "(") depth++;
    else if (value[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return value.length;
}

function parseToggle(args: string): boolean {
  const value = args.trim();
  if (!value) return false;
  const numeric = Number(value);
  return isFiniteNumber(numeric) ? numeric !== 0 : true;
}

/**
 * ASS 颜色是 &HBBGGRR&，可带 8 位 alpha：&HAABBGGRR&。
 * 只读取 RGB 部分；转换到 VTT 时不会输出颜色。
 */
function parseAssColor(raw: string): string | null {
  const match = raw.trim().match(/^&H([0-9a-f]{1,8})&?$/i);
  if (!match) return null;

  const value = match[1].toUpperCase();
  const bgr = value.length > 6 ? value.slice(-6) : value.padStart(6, "0");
  const blue = bgr.slice(0, 2);
  const green = bgr.slice(2, 4);
  const red = bgr.slice(4, 6);
  return `#${red}${green}${blue}`;
}

function isAsciiDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function isAsciiLetter(char: string): boolean {
  return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z");
}
