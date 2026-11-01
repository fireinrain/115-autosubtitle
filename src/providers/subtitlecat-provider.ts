import type {
  SubtitleProvider,
  SubtitleSearchQuery,
  SubtitleSearchResult,
  SubtitleDownload,
} from "./provider";
import type { SubtitleFormat } from "../subtitle/subtitle-model";
import { gmRequestClient } from "../network/gm-request";
import { logger } from "../utils/logger";
import { SubtitleError } from "../utils/errors";
import { computeChecksum } from "../utils/hash";

const BASE_URL = "https://www.subtitlecat.com";
const MAX_CANDIDATES = 20;
const MAX_CONCURRENT_DETAIL = 5;

interface DetailCandidate {
  title: string;
  url: URL;
}

export class SubtitleCatProvider implements SubtitleProvider {
  readonly id = "subtitlecat";
  readonly name = "SubtitleCat";
  readonly enabledByDefault = true;

  async search(query: SubtitleSearchQuery): Promise<SubtitleSearchResult[]> {
    const keyword = query.normalizedCode || query.code;
    if (!keyword) return [];

    const searchUrl = new URL("/index.php", BASE_URL);
    searchUrl.searchParams.set("search", keyword);

    logger.debug(`[subtitlecat] 搜索：${keyword}`);

    try {
      const resp = await gmRequestClient.request<string>({
        url: searchUrl.toString(),
        method: "GET",
        responseType: "text",
        timeoutMs: 15000,
        signal: query.signal,
      });

      const candidates = this.parseSearchHtml(resp.body, keyword);
      if (candidates.length === 0) {
        logger.debug("[subtitlecat] 搜索页未找到候选字幕");
        return [];
      }

      const limited = candidates.slice(0, MAX_CANDIDATES);
      const results = await this.fetchDetails(limited, keyword, query.signal);

      logger.debug(`[subtitlecat] 搜索完成，共 ${results.length} 条结果`);
      return results;
    } catch (e) {
      if (e instanceof SubtitleError) throw e;
      throw new SubtitleError("PROVIDER_NETWORK_ERROR", "SubtitleCat 搜索失败", e);
    }
  }

  async download(result: SubtitleSearchResult, signal?: AbortSignal): Promise<SubtitleDownload> {
    if (!result.downloadUrl) {
      throw new SubtitleError("DOWNLOAD_FAILED", "缺少下载地址");
    }

    const url = new URL(result.downloadUrl);
    if (url.hostname !== "www.subtitlecat.com") {
      throw new SubtitleError("DOWNLOAD_FAILED", "下载地址域名不合法");
    }

    logger.debug(`[subtitlecat] 下载字幕：${result.title}`);

    try {
      const resp = await gmRequestClient.request<ArrayBuffer>({
        url: result.downloadUrl,
        method: "GET",
        responseType: "arraybuffer",
        timeoutMs: 30000,
        signal,
        maxBytes: 5 * 1024 * 1024,
      });

      const fileName = result.title || `subtitle.${result.format}`;
      const checksum = await computeChecksum(resp.body);

      return {
        bytes: resp.body,
        fileName,
        checksum,
      };
    } catch (e) {
      if (e instanceof SubtitleError) throw e;
      throw new SubtitleError("DOWNLOAD_FAILED", "SubtitleCat 字幕下载失败", e);
    }
  }

  private parseSearchHtml(html: string, keyword: string): DetailCandidate[] {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const links = Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href^="subs/"]'));

    const candidates: DetailCandidate[] = [];
    const seen = new Set<string>();

    for (const link of links) {
      const href = link.getAttribute("href");
      if (!href) continue;
      try {
        const detailUrl = new URL(href, BASE_URL);
        if (seen.has(detailUrl.href)) continue;
        seen.add(detailUrl.href);

        const title = (link.textContent || "").trim() || keyword;
        candidates.push({ title, url: detailUrl });
      } catch {
        continue;
      }
    }

    return candidates;
  }

  private async fetchDetails(
    candidates: DetailCandidate[],
    keyword: string,
    signal?: AbortSignal,
  ): Promise<SubtitleSearchResult[]> {
    const results: SubtitleSearchResult[] = [];
    const queue = [...candidates];

    const workers = Array.from({ length: Math.min(MAX_CONCURRENT_DETAIL, queue.length) }, async () => {
      while (queue.length > 0) {
        const candidate = queue.shift();
        if (!candidate) break;

        try {
          const result = await this.fetchDetail(candidate, keyword, signal);
          if (result) results.push(result);
        } catch (e) {
          logger.debug(`[subtitlecat] 详情页解析失败：${candidate.url.href}`, e);
        }
      }
    });

    await Promise.all(workers);
    return results;
  }

  private async fetchDetail(
    candidate: DetailCandidate,
    keyword: string,
    signal?: AbortSignal,
  ): Promise<SubtitleSearchResult | null> {
    const resp = await gmRequestClient.request<string>({
      url: candidate.url.href,
      method: "GET",
      responseType: "text",
      timeoutMs: 15000,
      signal,
    });

    const doc = new DOMParser().parseFromString(resp.body, "text/html");
    const srtLinks = Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href*=".srt"]'));

    if (srtLinks.length === 0) return null;

    const matched =
      srtLinks.find((a) => /-zh-CN\.srt$/i.test(new URL(a.href, BASE_URL).pathname)) ||
      srtLinks.find((a) => /-zh-TW\.srt$/i.test(new URL(a.href, BASE_URL).pathname)) ||
      srtLinks[0];

    const href = matched.getAttribute("href");
    if (!href) return null;

    let downloadUrl: URL;
    try {
      downloadUrl = new URL(href, BASE_URL);
    } catch {
      return null;
    }

    if (downloadUrl.protocol !== "https:" || downloadUrl.hostname !== "www.subtitlecat.com") {
      return null;
    }

    const isZhCN = /-zh-CN\.srt$/i.test(downloadUrl.pathname);
    const isZhTW = /-zh-TW\.srt$/i.test(downloadUrl.pathname);
    const language = isZhCN ? "简体中文" : isZhTW ? "繁体中文" : "未知";

    const format: SubtitleFormat = "srt";

    return {
      providerId: this.id,
      sourceId: candidate.url.pathname,
      title: candidate.title,
      code: this.extractCode(candidate.title, keyword),
      language,
      format,
      downloadUrl: downloadUrl.href,
      detailUrl: candidate.url.href,
    };
  }

  private extractCode(title: string, keyword: string): string | undefined {
    const upper = title.toUpperCase();
    const match = upper.match(/[A-Z]{2,6}-\d{2,6}/);
    if (match) return match[0];
    const kwUpper = keyword.toUpperCase();
    if (upper.includes(kwUpper)) return kwUpper;
    return undefined;
  }
}

export const subtitleCatProvider = new SubtitleCatProvider();