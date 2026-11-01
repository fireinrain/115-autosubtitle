import { describe, it, expect } from "vitest";
import { parseCode, normalizeFileName, VideoIdentityService } from "../../src/identity/video-identity";
import type { PlayerMetadata } from "../../src/player/player-adapter";

describe("normalizeFileName", () => {
  it("去除视频扩展名", () => {
    expect(normalizeFileName("movie.mp4")).toBe("MOVIE");
    expect(normalizeFileName("video.mkv")).toBe("VIDEO");
  });

  it("归一化空白、点号、下划线", () => {
    expect(normalizeFileName("my.video_file.2024.mp4")).toBe("MY VIDEO FILE 2024");
  });

  it("去除常见括号", () => {
    expect(normalizeFileName("movie[1080p].mp4")).toBe("MOVIE 1080P");
    expect(normalizeFileName("movie【蓝光】.mkv")).toBe("MOVIE 蓝光");
  });

  it("保留番号连字符", () => {
    expect(normalizeFileName("ABC-123.mp4")).toBe("ABC-123");
  });

  it("统一全角半角", () => {
    expect(normalizeFileName("ＡＢＣ-１２３.mp4")).toBe("ABC-123");
  });
});

describe("parseCode", () => {
  it("识别标准字母-数字番号", () => {
    const result = parseCode("ABC-12345");
    expect(result?.normalized).toBe("ABC-12345");
    expect(result?.family).toBe("standard");
    expect(result?.confidence).toBe(0.9);
  });

  it("识别无连字符番号", () => {
    const result = parseCode("ABC12345");
    expect(result?.normalized).toBe("ABC-12345");
    expect(result?.family).toBe("nohyphen");
    expect(result?.confidence).toBe(0.6);
  });

  it("识别 FC2-PPV 番号", () => {
    const result = parseCode("FC2-PPV-1234567");
    expect(result?.normalized).toBe("FC2-PPV-1234567");
    expect(result?.family).toBe("fc2-ppv");
    expect(result?.confidence).toBe(0.95);
  });

  it("大小写不敏感", () => {
    const result = parseCode("abc-123");
    expect(result?.normalized).toBe("ABC-123");
  });

  it("无番号时返回 null", () => {
    expect(parseCode("just a video name")).toBeNull();
    expect(parseCode("")).toBeNull();
  });

  it("从复杂文件名中提取番号", () => {
    const result = parseCode("[SOME_TAG] ABC-12345 1080p.mp4");
    expect(result?.normalized).toBe("ABC-12345");
  });
});

describe("VideoIdentityService", () => {
  const service = new VideoIdentityService();

  function meta(over: Partial<PlayerMetadata> = {}): PlayerMetadata {
    return {
      platform: "115",
      sourcePageUrl: "https://115.com/play",
      ...over,
    };
  }

  it("有 fileId 时生成强身份", () => {
    const id = service.resolve(meta({ fileId: "file-123", fileName: "test.mp4" }));
    expect(id.confidence).toBe("strong");
    expect(id.videoKey).toContain("id:file-123");
  });

  it("无 fileId 时使用文件名生成中等身份", () => {
    const id = service.resolve(meta({ fileName: "ABC-123.mp4" }));
    expect(id.confidence).toBe("medium");
    expect(id.videoKey).toContain("name:");
    expect(id.code).toBe("ABC-123");
  });

  it("无文件名和 fileId 时使用 URL 生成弱身份", () => {
    const id = service.resolve(meta({}));
    expect(id.confidence).toBe("weak");
    expect(id.videoKey).toContain("url:");
  });

  it("同一番号不同文件名生成不同 videoKey", () => {
    const a = service.resolve(meta({ fileName: "ABC-123-part1.mp4" }));
    const b = service.resolve(meta({ fileName: "ABC-123-part2.mp4" }));
    expect(a.videoKey).not.toBe(b.videoKey);
  });

  it("fileId 优先于文件名作为身份依据", () => {
    const a = service.resolve(meta({ fileId: "id-1", fileName: "a.mp4" }));
    const b = service.resolve(meta({ fileId: "id-1", fileName: "b.mp4" }));
    expect(a.videoKey).toBe(b.videoKey);
  });

  it("不将 currentSrc 或临时 URL 作为 key", () => {
    const id = service.resolve(meta({ fileId: "id-1" }));
    expect(id.videoKey).not.toContain("currentSrc");
    expect(id.videoKey).not.toContain("token");
  });
});