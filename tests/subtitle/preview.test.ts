import {describe, expect, it} from "vitest";
import {
    decodeRawSubtitle,
    formatCuesWithTimestamps,
    formatTimestamp,
    limitPreviewText,
    PREVIEW_MAX_LINES,
} from "../../src/subtitle/preview";
import type {SubtitleCue} from "../../src/subtitle/subtitle-model";

function cue(id: number, startMs: number, endMs: number, text: string): SubtitleCue {
    return {id, startMs, endMs, text, sourceOrder: id};
}

describe("formatTimestamp", () => {
    it("输出 SRT 风格的 HH:MM:SS,mmm", () => {
        expect(formatTimestamp(0)).toBe("00:00:00,000");
        expect(formatTimestamp(1_234)).toBe("00:00:01,234");
        expect(formatTimestamp(3_661_005)).toBe("01:01:01,005");
        expect(formatTimestamp(7_200_000)).toBe("02:00:00,000");
    });

    it("负数按 0 处理", () => {
        expect(formatTimestamp(-500)).toBe("00:00:00,000");
    });
});

describe("formatCuesWithTimestamps", () => {
    it("序号与时间轴同一行，正文另起一行", () => {
        const text = formatCuesWithTimestamps([
            cue(0, 0, 2000, "第一行\n第二行"),
            cue(1, 2500, 4000, "第三条"),
        ]);
        expect(text).toBe(
            [
                "1. 00:00:00,000 --> 00:00:02,000",
                "第一行",
                "第二行",
                "",
                "2. 00:00:02,500 --> 00:00:04,000",
                "第三条",
            ].join("\n"),
        );
    });

    it("空列表返回空字符串", () => {
        expect(formatCuesWithTimestamps([])).toBe("");
    });
});

describe("decodeRawSubtitle", () => {
    it("解码 UTF-8 并保留原始时间轴文本", () => {
        const original = "1\n00:00:01,000 --> 00:00:02,000\n你好\n";
        const bytes = new TextEncoder().encode(original).buffer as ArrayBuffer;
        expect(decodeRawSubtitle(bytes, "utf-8")).toBe(original);
    });

    it("解码 GB18030", () => {
        // 「字幕」的 GB18030 编码
        const bytes = new Uint8Array([0xd7, 0xd6, 0xc4, 0xbb]).buffer;
        expect(decodeRawSubtitle(bytes, "gb18030")).toBe("字幕");
    });

    it("解码失败时返回空字符串而不是抛错", () => {
        const bytes = new Uint8Array([0x00]).buffer;
        const original = TextDecoder;
        // 模拟环境不支持该编码
        // @ts-expect-error 故意替换构造器
        globalThis.TextDecoder = function () {
            throw new Error("unsupported");
        };
        try {
            expect(decodeRawSubtitle(bytes, "gb18030")).toBe("");
        } finally {
            globalThis.TextDecoder = original;
        }
    });
});

describe("limitPreviewText", () => {
    it("未超限时原样返回", () => {
        const text = "1\n00:00:00,000 --> 00:00:01,000\nhi";
        expect(limitPreviewText(text)).toBe(text);
    });

    it("超过行数上限时截断并提示", () => {
        const text = Array.from({length: PREVIEW_MAX_LINES + 10}, (_, i) => `line-${i}`).join("\n");
        const result = limitPreviewText(text);
        expect(result.split("\n").length).toBeLessThanOrEqual(PREVIEW_MAX_LINES + 3);
        expect(result).toContain("仅显示前");
    });
});
