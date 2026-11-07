import type { SubtitleCue } from "./subtitle-model";
import { AssParser } from "./ass-parser";

/**
 * ASS/SSA → VTT 转换结果。
 *
 * 只保留时间轴与纯文本：样式表、定位、动画、卡拉 OK、绘图等高级特性
 * 在转换阶段全部丢弃，输出可直接交给 `VttParser` 解析。
 */
export interface AssToVttResult {
  bytes: ArrayBuffer;
  text: string;
  warnings: string[];
}

/**
 * 把 ASS/SSA 字节转换为 UTF-8 VTT。
 *
 * 这里不保留原始字节：调用方应把返回的 VTT 作为新的 `rawBlob` 保存，
 * 后续解析、缓存和导出都按 VTT 处理，避免同一条记录同时存在两种格式。
 */
export function convertAssToVtt(
  bytes: ArrayBuffer,
  format: "ass" | "ssa",
  encoding?: string,
): AssToVttResult {
  const parsed = new AssParser(format).parse(bytes, encoding);
  const text = serializeCuesToVtt(parsed.cues);

  return {
    bytes: new TextEncoder().encode(text).buffer,
    text,
    warnings: parsed.warnings,
  };
}

/**
 * 将统一 Cue 模型序列化为 WebVTT 文本。
 *
 * 只写纯文本，不输出粗体/斜体/颜色等标签；ASS 的内联样式在这里被有意丢弃。
 */
export function serializeCuesToVtt(cues: SubtitleCue[]): string {
  const blocks: string[] = [];

  for (const cue of cues) {
    const body = normalizeCueText(cue.text);
    if (!body) continue;

    blocks.push(`${formatVttTime(cue.startMs)} --> ${formatVttTime(cue.endMs)}\n${body}`);
  }

  return blocks.length > 0 ? `WEBVTT\n\n${blocks.join("\n\n")}\n` : "WEBVTT\n\n";
}

/**
 * VTT 以空行分隔 cue，因此字幕内部的连续空行必须折叠；
 * 否则 ASS 里的多段空行会把一条字幕拆成多个块并导致后半段丢失。
 */
function normalizeCueText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function formatVttTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;

  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}`;
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, "0");
}
