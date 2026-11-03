import {describe, expect, it} from "vitest";
import {
    DEFAULT_SUBTITLE_FONT,
    findFontPreset,
    FONT_PRESETS,
    normalizeFontFamily,
} from "../../src/settings/font-presets";

describe("FONT_PRESETS", () => {
    it("默认字体栈包含中文字体，而不是西文字体兜底", () => {
        expect(DEFAULT_SUBTITLE_FONT).toContain("PingFang SC");
        expect(DEFAULT_SUBTITLE_FONT).toContain("Source Han Sans SC");
    });

    it("每个预设都有唯一 id 和非空字体栈", () => {
        const ids = new Set(FONT_PRESETS.map((p) => p.id));
        expect(ids.size).toBe(FONT_PRESETS.length);
        for (const preset of FONT_PRESETS) {
            expect(preset.label.length).toBeGreaterThan(0);
            expect(preset.fontFamily.length).toBeGreaterThan(0);
        }
    });

    it("能找到已注册的字体栈", () => {
        expect(findFontPreset(FONT_PRESETS[1].fontFamily)?.id).toBe(FONT_PRESETS[1].id);
        expect(findFontPreset("Arial, sans-serif")).toBeUndefined();
    });
});

describe("normalizeFontFamily", () => {
    it("空值回退默认字体", () => {
        expect(normalizeFontFamily("")).toBe(DEFAULT_SUBTITLE_FONT);
        expect(normalizeFontFamily("   ")).toBe(DEFAULT_SUBTITLE_FONT);
        expect(normalizeFontFamily(undefined)).toBe(DEFAULT_SUBTITLE_FONT);
    });

    it("拒绝可能注入 CSS 的字体栈", () => {
        expect(normalizeFontFamily('Arial; } body { display: none')).toBe(DEFAULT_SUBTITLE_FONT);
        expect(normalizeFontFamily("Arial</style>")).toBe(DEFAULT_SUBTITLE_FONT);
    });

    it("保留正常的自定义字体栈", () => {
        expect(normalizeFontFamily('"Custom Font", sans-serif')).toBe('"Custom Font", sans-serif');
    });
});
