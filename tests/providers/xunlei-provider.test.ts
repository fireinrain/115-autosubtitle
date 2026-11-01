import { describe, it, expect, vi, beforeEach } from "vitest";
import { XunleiProvider } from "../../src/providers/xunlei-provider";
import type { SubtitleSearchQuery } from "../../src/providers/provider";

vi.mock("../../src/network/gm-request", () => ({
  gmRequestClient: {
    request: vi.fn(),
  },
}));

import { gmRequestClient } from "../../src/network/gm-request";

const mockRequest = gmRequestClient.request as unknown as ReturnType<typeof vi.fn>;

function makeQuery(over: Partial<SubtitleSearchQuery> = {}): SubtitleSearchQuery {
  return {
    code: "IPX-247",
    normalizedCode: "IPX-247",
    languagePreferences: ["zh-CN", "en"],
    ...over,
  };
}

describe("XunleiProvider", () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it("id 和 name 正确", () => {
    const p = new XunleiProvider();
    expect(p.id).toBe("xunlei");
    expect(p.name).toBe("迅雷字幕");
    expect(p.enabledByDefault).toBe(true);
  });

  it("解析标准迅雷响应并返回结果", async () => {
    mockRequest.mockResolvedValueOnce({
      body: JSON.stringify({
        code: 0,
        result: "ok",
        data: [
          {
            gcid: "GCID1",
            cid: "CID1",
            url: "https://subtitle.v.geilijiasu.com/CID/1.srt",
            ext: "srt",
            name: "IPX-247.srt",
            duration: 6920520,
            languages: ["默认"],
            score: 0,
          },
        ],
      }),
    });

    const p = new XunleiProvider();
    const results = await p.search(makeQuery());

    expect(results).toHaveLength(1);
    expect(results[0].providerId).toBe("xunlei");
    expect(results[0].sourceId).toBe("CID1");
    expect(results[0].title).toBe("IPX-247.srt");
    expect(results[0].format).toBe("srt");
    expect(results[0].code).toBe("IPX-247");
    expect(results[0].duration).toBeCloseTo(6920.52);
    expect(results[0].language).toBe("默认");
    expect(results[0].downloadUrl).toBe("https://subtitle.v.geilijiasu.com/CID/1.srt");
  });

  it("支持 langs 字段作为语言", async () => {
    mockRequest.mockResolvedValueOnce({
      body: JSON.stringify({
        code: 0,
        result: "ok",
        data: [
          {
            cid: "CID1",
            url: "https://subtitle.v.geilijiasu.com/CID/1.srt",
            ext: "srt",
            name: "IPX-247.srt",
            langs: "简体中文",
          },
        ],
      }),
    });

    const p = new XunleiProvider();
    const results = await p.search(makeQuery());
    expect(results[0].language).toBe("简体中文");
  });

  it("跳过不支持的格式", async () => {
    mockRequest.mockResolvedValueOnce({
      body: JSON.stringify({
        code: 0,
        result: "ok",
        data: [
          { cid: "1", url: "https://subtitle.v.geilijiasu.com/1.txt", ext: "txt", name: "a.txt" },
          { cid: "2", url: "https://subtitle.v.geilijiasu.com/2.srt", ext: "srt", name: "a.srt" },
        ],
      }),
    });

    const p = new XunleiProvider();
    const results = await p.search(makeQuery());
    expect(results).toHaveLength(1);
    expect(results[0].format).toBe("srt");
  });

  it("跳过非 geilijiasu 域名的下载地址", async () => {
    mockRequest.mockResolvedValueOnce({
      body: JSON.stringify({
        code: 0,
        result: "ok",
        data: [
          { cid: "1", url: "https://evil.com/1.srt", ext: "srt", name: "a.srt" },
          { cid: "2", url: "https://subtitle.v.geilijiasu.com/2.srt", ext: "srt", name: "b.srt" },
        ],
      }),
    });

    const p = new XunleiProvider();
    const results = await p.search(makeQuery());
    expect(results).toHaveLength(1);
    expect(results[0].sourceId).toBe("2");
  });

  it("code 非 0 时返回空", async () => {
    mockRequest.mockResolvedValueOnce({
      body: JSON.stringify({ code: 1, result: "error", data: [] }),
    });

    const p = new XunleiProvider();
    const results = await p.search(makeQuery());
    expect(results).toHaveLength(0);
  });

  it("无 normalizedCode 时返回空", async () => {
    const p = new XunleiProvider();
    const results = await p.search(makeQuery({ normalizedCode: "", code: "" }));
    expect(results).toHaveLength(0);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("download 下载字幕并返回 ArrayBuffer", async () => {
    const bytes = new TextEncoder().encode("1\n00:00:01,000 --> 00:00:02,000\nHello").buffer;
    mockRequest.mockResolvedValueOnce({ body: bytes });

    const p = new XunleiProvider();
    const result = {
      providerId: "xunlei",
      sourceId: "1",
      title: "test.srt",
      format: "srt" as const,
      downloadUrl: "https://subtitle.v.geilijiasu.com/1.srt",
    };

    const download = await p.download(result);
    expect(download.bytes).toBe(bytes);
    expect(download.fileName).toBe("test.srt");
    expect(download.checksum).toBeDefined();
  });

  it("download 拒绝非法域名", async () => {
    const p = new XunleiProvider();
    const result = {
      providerId: "xunlei",
      sourceId: "1",
      title: "test.srt",
      format: "srt" as const,
      downloadUrl: "https://evil.com/1.srt",
    };

    await expect(p.download(result)).rejects.toThrow();
  });
});