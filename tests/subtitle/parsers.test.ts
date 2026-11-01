import { describe, it, expect } from "vitest";
import { SrtParser, VttParser, parseSubtitle, detectFormat } from "../../src/subtitle/parsers";

function enc(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

describe("SrtParser", () => {
  it("解析标准 SRT 文件", () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Hello world

2
00:00:05,000 --> 00:00:08,500
Second line
`;
    const parser = new SrtParser();
    const result = parser.parse(enc(srt));

    expect(result.format).toBe("srt");
    expect(result.cues).toHaveLength(2);
    expect(result.cues[0].startMs).toBe(1000);
    expect(result.cues[0].endMs).toBe(4000);
    expect(result.cues[0].text).toBe("Hello world");
    expect(result.cues[1].startMs).toBe(5000);
    expect(result.cues[1].endMs).toBe(8500);
    expect(result.cues[1].text).toBe("Second line");
    expect(result.cues[0].sourceOrder).toBe(0);
    expect(result.cues[1].sourceOrder).toBe(1);
  });

  it("支持多行字幕文本", () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Line one
Line two
`;
    const result = new SrtParser().parse(enc(srt));
    expect(result.cues[0].text).toBe("Line one\nLine two");
  });

  it("支持 CRLF 换行", () => {
    const srt = "1\r\n00:00:01,000 --> 00:00:04,000\r\nCRLF text\r\n";
    const result = new SrtParser().parse(enc(srt));
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0].text).toBe("CRLF text");
  });

  it("支持文件末尾缺少空行", () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
No trailing newline`;
    const result = new SrtParser().parse(enc(srt));
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0].text).toBe("No trailing newline");
  });

  it("跳过非法时间轴块并记录 warning", () => {
    const srt = `1
not a timeline
bad block

2
00:00:01,000 --> 00:00:04,000
Good cue
`;
    const result = new SrtParser().parse(enc(srt));
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0].text).toBe("Good cue");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("跳过空文本字幕块", () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000

2
00:00:05,000 --> 00:00:08,000
Has text
`;
    const result = new SrtParser().parse(enc(srt));
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0].text).toBe("Has text");
  });

  it("跳过反向时间范围", () => {
    const srt = `1
00:00:05,000 --> 00:00:01,000
Reversed
`;
    const result = new SrtParser().parse(enc(srt));
    expect(result.cues).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("反向"))).toBe(true);
  });

  it("解析常见内联标签为分段", () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
<b>Bold</b> and <i>italic</i> text
`;
    const result = new SrtParser().parse(enc(srt));
    expect(result.cues[0].text).toBe("Bold and italic text");
    expect(result.cues[0].segments).toBeDefined();
    const segs = result.cues[0].segments!;
    expect(segs[0].text).toBe("Bold");
    expect(segs[0].bold).toBe(true);
    expect(segs[1].text).toBe(" and ");
    expect(segs[1].bold).toBe(false);
    expect(segs[2].text).toBe("italic");
    expect(segs[2].italic).toBe(true);
  });

  it("不执行 HTML 脚本，只作为文本处理", () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
<script>alert(1)</script> and <a href="x">link</a>
`;
    const result = new SrtParser().parse(enc(srt));
    expect(result.cues[0].text).toContain("<script>alert(1)</script>");
    expect(result.cues[0].text).toContain("<a href=\"x\">link</a>");
  });

  it("支持带编号和不带编号的块", () => {
    const srt = `00:00:01,000 --> 00:00:04,000
No number block

2
00:00:05,000 --> 00:00:08,000
Numbered block
`;
    const result = new SrtParser().parse(enc(srt));
    expect(result.cues).toHaveLength(2);
    expect(result.cues[0].text).toBe("No number block");
    expect(result.cues[1].text).toBe("Numbered block");
  });
});

describe("VttParser", () => {
  it("解析标准 VTT 文件", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
Hello world

00:00:05.000 --> 00:00:08.500
Second line
`;
    const result = new VttParser().parse(enc(vtt));
    expect(result.format).toBe("vtt");
    expect(result.cues).toHaveLength(2);
    expect(result.cues[0].startMs).toBe(1000);
    expect(result.cues[0].endMs).toBe(4000);
    expect(result.cues[1].startMs).toBe(5000);
    expect(result.cues[1].endMs).toBe(8500);
  });

  it("支持带小时的时间格式", () => {
    const vtt = `WEBVTT

01:00:01.000 --> 01:00:04.000
One hour in
`;
    const result = new VttParser().parse(enc(vtt));
    expect(result.cues[0].startMs).toBe(3601000);
    expect(result.cues[0].endMs).toBe(3604000);
  });

  it("跳过 NOTE 块", () => {
    const vtt = `WEBVTT

NOTE This is a note

00:00:01.000 --> 00:00:04.000
Real cue
`;
    const result = new VttParser().parse(enc(vtt));
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0].text).toBe("Real cue");
  });

  it("缺少 WEBVTT 头时抛出错误", () => {
    const vtt = `00:00:01.000 --> 00:00:04.000
No header
`;
    expect(() => new VttParser().parse(enc(vtt))).toThrow();
  });

  it("支持 cue ID", () => {
    const vtt = `WEBVTT

cue-id-1
00:00:01.000 --> 00:00:04.000
With id
`;
    const result = new VttParser().parse(enc(vtt));
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0].text).toBe("With id");
  });
});

describe("parseSubtitle dispatch", () => {
  it("按格式分派到对应解析器", () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Test
`;
    const result = parseSubtitle(enc(srt), "srt");
    expect(result.format).toBe("srt");
    expect(result.cues).toHaveLength(1);
  });

  it("未知格式抛出错误", () => {
    expect(() => parseSubtitle(enc("x"), "unknown")).toThrow();
  });
});

describe("detectFormat", () => {
  it("根据扩展名识别格式", () => {
    expect(detectFormat("movie.srt")).toBe("srt");
    expect(detectFormat("movie.vtt")).toBe("vtt");
    expect(detectFormat("movie.ass")).toBe("ass");
    expect(detectFormat("movie.ssa")).toBe("ssa");
    expect(detectFormat("movie.txt")).toBe("unknown");
    expect(detectFormat("noextension")).toBe("unknown");
  });

  it("大小写不敏感", () => {
    expect(detectFormat("MOVIE.SRT")).toBe("srt");
    expect(detectFormat("Movie.Srt")).toBe("srt");
  });
});