import { describe, expect, it } from "vitest";
import { convertAssToVtt, serializeCuesToVtt } from "../../src/subtitle/ass-to-vtt";
import { parseSubtitle } from "../../src/subtitle/parsers";

function enc(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

const ASS_HEADER = `[Script Info]
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

describe("convertAssToVtt", () => {
  it("输出可被 VTT 解析器读取的时间轴和纯文本", () => {
    const ass = `${ASS_HEADER}Dialogue: 0,0:00:01.20,0:00:04.50,Default,,0,0,0,,Hello\\NWorld
`;
    const converted = convertAssToVtt(enc(ass), "ass");
    const parsed = parseSubtitle(converted.bytes, "vtt");

    expect(converted.text.startsWith("WEBVTT")).toBe(true);
    expect(converted.text).toContain("00:00:01.200 --> 00:00:04.500");
    expect(parsed.format).toBe("vtt");
    expect(parsed.cues).toHaveLength(1);
    expect(parsed.cues[0].startMs).toBe(1200);
    expect(parsed.cues[0].endMs).toBe(4500);
    expect(parsed.cues[0].text).toBe("Hello\nWorld");
  });

  it("丢弃内联样式、定位和动画标签", () => {
    const ass = `${ASS_HEADER}Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\pos(100,200)\\i1}Italic{\\i0} {\\b1}Bold{\\b0}
`;
    const converted = convertAssToVtt(enc(ass), "ass");
    const parsed = parseSubtitle(converted.bytes, "vtt");
    const cue = parsed.cues[0];

    expect(cue.text).toBe("Italic Bold");
    expect(cue.segments?.some((segment) => segment.bold || segment.italic)).toBe(false);
  });

  it("把连续空行折叠为单行，避免 VTT 块被拆开", () => {
    const ass = `${ASS_HEADER}Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,A\\N\\NB
`;
    const converted = convertAssToVtt(enc(ass), "ass");
    const parsed = parseSubtitle(converted.bytes, "vtt");

    expect(parsed.cues).toHaveLength(1);
    expect(parsed.cues[0].text).toBe("A\nB");
  });

  it("支持 SSA 输入", () => {
    const ssa = `[Script Info]
ScriptType: v4.00

[Events]
Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: Marked=0,0:00:02.00,0:00:03.00,Default,,0,0,0,,SSA line
`;
    const converted = convertAssToVtt(enc(ssa), "ssa");
    const parsed = parseSubtitle(converted.bytes, "vtt");

    expect(parsed.format).toBe("vtt");
    expect(parsed.cues).toHaveLength(1);
    expect(parsed.cues[0].text).toBe("SSA line");
  });

  it("空字幕也输出合法 WEBVTT 头", () => {
    expect(serializeCuesToVtt([])).toBe("WEBVTT\n\n");
  });
});
