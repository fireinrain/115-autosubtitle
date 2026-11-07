import { describe, expect, it } from "vitest";
import { parseSubtitle } from "../../src/subtitle/parsers";
import { AssParser } from "../../src/subtitle/ass-parser";

function enc(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

const ASS_HEADER = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

describe("AssParser", () => {
  it("解析标准 ASS 文件并保留文本中的逗号", () => {
    const ass = `${ASS_HEADER}Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hello, world
Dialogue: 0,0:00:05.50,0:00:08.25,Default,,0,0,0,,Second line
`;
    const result = new AssParser("ass").parse(enc(ass));

    expect(result.format).toBe("ass");
    expect(result.cues).toHaveLength(2);
    expect(result.cues[0].startMs).toBe(1000);
    expect(result.cues[0].endMs).toBe(4000);
    expect(result.cues[0].text).toBe("Hello, world");
    expect(result.cues[1].startMs).toBe(5500);
    expect(result.cues[1].endMs).toBe(8250);
    expect(result.cues[0].sourceOrder).toBe(0);
    expect(result.cues[1].sourceOrder).toBe(1);
    expect(result.warnings.some((warning) => warning.includes("样式定义"))).toBe(true);
  });

  it("解析 SSA 的 Marked 字段和默认事件格式", () => {
    const ssa = `[Script Info]
ScriptType: v4.00

[V4 Styles]
Format: Name, Fontname, Fontsize, PrimaryColour
Style: Default,Arial,20,&HFFFFFF

[Events]
Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: Marked=0,0:00:01.00,0:00:02.50,Default,,0,0,0,,SSA text
`;
    const result = new AssParser("ssa").parse(enc(ssa));

    expect(result.format).toBe("ssa");
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0].startMs).toBe(1000);
    expect(result.cues[0].endMs).toBe(2500);
    expect(result.cues[0].text).toBe("SSA text");
  });

  it("支持自定义 Format 字段顺序", () => {
    const ass = `[Events]
Format: Start, End, Text, Layer, Style, Name, MarginL, MarginR, MarginV, Effect
Dialogue: 0:00:01.00,0:00:02.00,Hello,0,Default,,0,0,0,
`;
    const result = new AssParser("ass").parse(enc(ass));

    expect(result.cues).toHaveLength(1);
    expect(result.cues[0].text).toBe("Hello");
    expect(result.cues[0].startMs).toBe(1000);
  });

  it("缺少 Format 行时使用默认字段顺序并记录 warning", () => {
    const ass = `[Script Info]
ScriptType: v4.00+

[Events]
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Default format
`;
    const result = new AssParser("ass").parse(enc(ass));

    expect(result.cues).toHaveLength(1);
    expect(result.cues[0].text).toBe("Default format");
    expect(result.warnings.some((warning) => warning.includes("Format"))).toBe(true);
  });

  it("SSA 缺少 Format 行时使用 Marked 默认字段顺序", () => {
    const ass = `[Events]
Dialogue: Marked=0,0:00:01.00,0:00:02.00,Default,,0,0,0,,SSA default format
`;
    const result = new AssParser("ssa").parse(enc(ass));

    expect(result.cues).toHaveLength(1);
    expect(result.cues[0].text).toBe("SSA default format");
    expect(result.warnings.some((warning) => warning.includes("Format"))).toBe(true);
  });

  it("解析内联粗体、斜体、下划线和主颜色", () => {
    const ass = `${ASS_HEADER}Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1}Italic{\\i0} {\\b1}Bold{\\b0} {\\u1}Under{\\u0} {\\c&H0000FF&}Red{\\c}
`;
    const result = new AssParser("ass").parse(enc(ass));
    const cue = result.cues[0];

    expect(cue.text).toBe("Italic Bold Under Red");
    expect(cue.segments).toBeDefined();

    const segments = cue.segments!;
    expect(segments.find((segment) => segment.text === "Italic")?.italic).toBe(true);
    expect(segments.find((segment) => segment.text === "Bold")?.bold).toBe(true);
    expect(segments.find((segment) => segment.text === "Under")?.underline).toBe(true);
    expect(segments.find((segment) => segment.text === "Red")?.color).toBe("#FF0000");
  });

  it("支持 \\1c 主颜色和 \\r 重置", () => {
    const ass = `${ASS_HEADER}Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\1c&H00FF00&\\b1}Green bold{\\r} plain
`;
    const result = new AssParser("ass").parse(enc(ass));
    const segments = result.cues[0].segments!;

    const colored = segments.find((segment) => segment.text === "Green bold");
    expect(colored?.color).toBe("#00FF00");
    expect(colored?.bold).toBe(true);

    const plain = segments.find((segment) => segment.text === " plain");
    expect(plain?.color).toBeUndefined();
    expect(plain?.bold).toBeUndefined();
  });

  it("支持 \\N / \\n 换行和 \\h 空格", () => {
    const ass = `${ASS_HEADER}Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Line1\\NLine2\\nLine3\\hEnd
`;
    const result = new AssParser("ass").parse(enc(ass));

    expect(result.cues[0].text).toBe("Line1\nLine2\nLine3 End");
  });

  it("支持反斜杠转义的左右花括号", () => {
    const ass = `${ASS_HEADER}Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Literal \\{brace\\} text
`;
    const result = new AssParser("ass").parse(enc(ass));

    expect(result.cues[0].text).toBe("Literal {brace} text");
  });

  it("忽略绘图块，只保留绘图后的普通文本", () => {
    const ass = `${ASS_HEADER}Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0{\\p0}Visible
`;
    const result = new AssParser("ass").parse(enc(ass));

    expect(result.cues).toHaveLength(1);
    expect(result.cues[0].text).toBe("Visible");
    expect(result.warnings.some((warning) => warning.includes("绘图"))).toBe(true);
  });

  it("忽略定位和动画标签但保留文本", () => {
    const ass = `${ASS_HEADER}Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\pos(100,200)\\fad(100,100)}Top text
`;
    const result = new AssParser("ass").parse(enc(ass));

    expect(result.cues[0].text).toBe("Top text");
    expect(result.warnings.some((warning) => warning.includes("覆盖标签"))).toBe(true);
  });

  it("跳过反向时间范围", () => {
    const ass = `${ASS_HEADER}Dialogue: 0,0:00:05.00,0:00:01.00,Default,,0,0,0,,Reversed
`;
    const result = new AssParser("ass").parse(enc(ass));

    expect(result.cues).toHaveLength(0);
    expect(result.warnings.some((warning) => warning.includes("反向"))).toBe(true);
  });

  it("忽略 Comment 事件", () => {
    const ass = `${ASS_HEADER}Comment: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Ignored
Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,Kept
`;
    const result = new AssParser("ass").parse(enc(ass));

    expect(result.cues).toHaveLength(1);
    expect(result.cues[0].text).toBe("Kept");
  });

  it("缺少 [Events] 段时抛出解析错误", () => {
    const ass = `[Script Info]
ScriptType: v4.00+
`;
    expect(() => new AssParser("ass").parse(enc(ass))).toThrow();
  });

  it("支持 UTF-8 BOM 和 CRLF", () => {
    const ass = `\uFEFF${ASS_HEADER.replace(/\n/g, "\r\n")}Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,BOM text\r\n`;
    const result = new AssParser("ass").parse(enc(ass));

    expect(result.cues).toHaveLength(1);
    expect(result.cues[0].text).toBe("BOM text");
  });
});

describe("parseSubtitle ASS/SSA dispatch", () => {
  it("ASS 默认转换为 VTT", () => {
    const ass = `${ASS_HEADER}Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Dispatch
`;
    const result = parseSubtitle(enc(ass), "ass");
    expect(result.format).toBe("vtt");
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0].text).toBe("Dispatch");
  });

  it("SSA 默认转换为 VTT", () => {
    const ssa = `[Events]
Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: Marked=0,0:00:01.00,0:00:02.00,Default,,0,0,0,,SSA dispatch
`;
    const result = parseSubtitle(enc(ssa), "ssa");
    expect(result.format).toBe("vtt");
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0].text).toBe("SSA dispatch");
  });
});
