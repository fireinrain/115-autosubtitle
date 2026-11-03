import {encodingDetector} from "./encoding-detector";
import type {SubtitleCue} from "./subtitle-model";

/**
 * 预览展示上限。
 * 字幕文件可能很大（尤其 ASS/SSA），面板弹层不适合一次性渲染几十万行。
 */
export const PREVIEW_MAX_CHARS = 200_000;
export const PREVIEW_MAX_LINES = 4_000;

/**
 * 解码原始字幕字节，返回**未经改写**的文本（保留时间轴、编号与空行）。
 * 解码失败时返回空字符串，由调用方决定回退方式。
 */
export function decodeRawSubtitle(bytes: ArrayBuffer, encoding?: string): string {
    try {
        return encodingDetector.decode(bytes, encoding);
    } catch {
        return "";
    }
}

/**
 * 从 Cue 重建带时间轴的预览文本。
 *
 * 序号与时间轴放在同一行（`1. 00:00:00,000 --> 00:00:10,000`），
 * 字幕正文另起一行。SRT 原格式里序号独占一行，在弹层里很浪费纵向空间。
 */
export function formatCuesWithTimestamps(cues: SubtitleCue[]): string {
    return cues
        .map((cue, index) => {
            return `${index + 1}. ${formatTimestamp(cue.startMs)} --> ${formatTimestamp(cue.endMs)}\n${cue.text}`;
        })
        .join("\n\n");
}

/** 毫秒转 `HH:MM:SS,mmm`，与 SRT 时间轴格式一致。 */
export function formatTimestamp(ms: number): string {
    const total = Math.max(0, Math.round(ms));
    const hours = Math.floor(total / 3_600_000);
    const minutes = Math.floor((total % 3_600_000) / 60_000);
    const seconds = Math.floor((total % 60_000) / 1000);
    const millis = total % 1000;
    return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`;
}

/** 超长字幕截断，并明确标注已被截断。 */
export function limitPreviewText(text: string): string {
    const lines = text.split("\n");
    let truncated = false;

    let result = text;
    if (result.length > PREVIEW_MAX_CHARS) {
        result = result.slice(0, PREVIEW_MAX_CHARS);
        truncated = true;
    }

    const limitedLines = result.split("\n");
    if (limitedLines.length > PREVIEW_MAX_LINES) {
        result = limitedLines.slice(0, PREVIEW_MAX_LINES).join("\n");
        truncated = true;
    }

    if (!truncated) return text;
    return `${result}\n\n…（字幕较长，仅显示前 ${Math.min(lines.length, PREVIEW_MAX_LINES)} 行）`;
}

function pad(value: number, length: number): string {
    return String(value).padStart(length, "0");
}
