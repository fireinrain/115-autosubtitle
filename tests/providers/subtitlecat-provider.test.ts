import { describe, it, expect, vi, beforeEach } from "vitest";
import { SubtitleCatProvider } from "../../src/providers/subtitlecat-provider";
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

function searchHtml(items: { href: string; text: string }[]): string {
  const links = items
    .map((i) => `<a href="${i.href}">${i.text}</a>`)
    .join("");
  return `<html><body>${links}</body></html>`;
}

function detailHtml(srtHrefs: string[]): string {
  const links = srtHrefs
    .map((h) => `<a href="${h}">download</a>`)
    .join("");
  return `<html><body>${links}</body></html>`;
}

describe("SubtitleCatProvider", () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it("id 和 name 正确", () => {
    const p = new SubtitleCatProvider();
    expect(p.id).toBe("subtitlecat");
    expect(p.name).toBe("SubtitleCat");
    expect(p.enabledByDefault).toBe(true);
  });

  it("解析搜索页并访问详情页获取下载链接", async () => {
    mockRequest.mockResolvedValueOnce({
      body: searchHtml([{ href: "subs/123.html", text: "IPX-247" }]),
    });
    mockRequest.mockResolvedValueOnce({
      body: detailHtml(["/subs/123-zh-CN.srt", "/subs/123-zh-TW.srt"]),
    });

    const p = new SubtitleCatProvider();
    const results = await p.search(makeQuery());

    expect(results).toHaveLength(1);
    expect(results[0].providerId).toBe("subtitlecat");
    expect(results[0].title).toBe("IPX-247");
    expect(results[0].format).toBe("srt");
    expect(results[0].language).toBe("简体中文");
    expect(results[0].code).toBe("IPX-247");
    expect(results[0].downloadUrl).toBe("https://www.subtitlecat.com/subs/123-zh-CN.srt");
  });

  it("优先选择 zh-CN，其次 zh-TW", async () => {
    mockRequest.mockResolvedValueOnce({
      body: searchHtml([{ href: "subs/123.html", text: "IPX-247" }]),
    });
    mockRequest.mockResolvedValueOnce({
      body: detailHtml(["/subs/123-zh-TW.srt"]),
    });

    const p = new SubtitleCatProvider();
    const results = await p.search(makeQuery());
    expect(results[0].language).toBe("繁体中文");
  });

  it("无 zh-CN/zh-TW 时回退到第一个 srt", async () => {
    mockRequest.mockResolvedValueOnce({
      body: searchHtml([{ href: "subs/123.html", text: "IPX-247" }]),
    });
    mockRequest.mockResolvedValueOnce({
      body: detailHtml(["/subs/123-en.srt"]),
    });

    const p = new SubtitleCatProvider();
    const results = await p.search(makeQuery());
    expect(results).toHaveLength(1);
    expect(results[0].language).toBe("未知");
  });

  it("详情页无 srt 链接时跳过", async () => {
    mockRequest.mockResolvedValueOnce({
      body: searchHtml([{ href: "subs/123.html", text: "IPX-247" }]),
    });
    mockRequest.mockResolvedValueOnce({
      body: detailHtml([]),
    });

    const p = new SubtitleCatProvider();
    const results = await p.search(makeQuery());
    expect(results).toHaveLength(0);
  });

  it("搜索页无候选时不发起详情页请求", async () => {
    mockRequest.mockResolvedValueOnce({ body: searchHtml([]) });

    const p = new SubtitleCatProvider();
    const results = await p.search(makeQuery());
    expect(results).toHaveLength(0);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it("去重相同的候选详情页", async () => {
    mockRequest.mockResolvedValueOnce({
      body: searchHtml([
        { href: "subs/123.html", text: "IPX-247" },
        { href: "subs/123.html", text: "IPX-247 dup" },
      ]),
    });
    mockRequest.mockResolvedValueOnce({
      body: detailHtml(["/subs/123-zh-CN.srt"]),
    });

    const p = new SubtitleCatProvider();
    const results = await p.search(makeQuery());
    expect(results).toHaveLength(1);
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it("download 下载字幕并返回 ArrayBuffer", async () => {
    const bytes = new TextEncoder().encode("1\n00:00:01,000 --> 00:00:02,000\nHello").buffer;
    mockRequest.mockResolvedValueOnce({ body: bytes });

    const p = new SubtitleCatProvider();
    const result = {
      providerId: "subtitlecat",
      sourceId: "subs/123.html",
      title: "test.srt",
      format: "srt" as const,
      downloadUrl: "https://www.subtitlecat.com/subs/123-zh-CN.srt",
    };

    const download = await p.download(result);
    expect(download.bytes).toBe(bytes);
    expect(download.fileName).toBe("test.srt");
    expect(download.checksum).toBeDefined();
  });

  it("标题不带扩展名时使用下载地址中的文件名", async () => {
    const bytes = new TextEncoder().encode("1\n00:00:01,000 --> 00:00:02,000\nHello").buffer;
    mockRequest.mockResolvedValueOnce({body: bytes});

    const p = new SubtitleCatProvider();
    const result = {
      providerId: "subtitlecat",
      sourceId: "subs/1725.html",
      title: "DVAJ-758.zh-cn(by transub)",
      format: "srt" as const,
      downloadUrl:
          "https://www.subtitlecat.com/subs/1725/DVAJ-758.zh-cn(by%20transub)-zh-CN.srt",
    };

    const download = await p.download(result);
    expect(download.fileName).toBe("DVAJ-758.zh-cn(by transub)-zh-CN.srt");
  });

  it("download 拒绝非 subtitlecat 域名", async () => {
    const p = new SubtitleCatProvider();
    const result = {
      providerId: "subtitlecat",
      sourceId: "1",
      title: "test.srt",
      format: "srt" as const,
      downloadUrl: "https://evil.com/1.srt",
    };

    await expect(p.download(result)).rejects.toThrow();
  });
});