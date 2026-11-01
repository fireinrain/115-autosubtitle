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

const SEARCH_ENDPOINT = "https://api-shoulei-ssl.xunlei.com/oracle/subtitle";
const DOWNLOAD_HOST = "subtitle.v.geilijiasu.com";
const SUPPORTED_FORMATS: SubtitleFormat[] = ["srt", "ass", "ssa"];

interface XunleiSubtitleItem {
  gcid?: string;
  cid?: string;
  url: string;
  ext: string;
  name: string;
  duration?: number;
  languages?: string[];
  langs?: string;
  score?: number;
  fingerprintf_score?: number;
  extra_name?: string;
}

interface XunleiResponse {
  code: number;
  result: string;
  data?: XunleiSubtitleItem[];
}

export class XunleiProvider implements SubtitleProvider {
  readonly id = "xunlei";
  readonly name = "迅雷字幕";
  readonly enabledByDefault = true;

  async search(query: SubtitleSearchQuery): Promise<SubtitleSearchResult[]> {
    const keyword = query.normalizedCode || query.code;
    if (!keyword) return [];

    const url = new URL(SEARCH_ENDPOINT);
    url.searchParams.set("gcid", "");
    url.searchParams.set("cid", "");
    url.searchParams.set("name", keyword);

    logger.debug(`[xunlei] 搜索：${keyword}`);

    try {
      const resp = await gmRequestClient.request<string>({
        url: url.toString(),
        method: "GET",
        responseType: "text",
        timeoutMs: 15000,
        signal: query.signal,
      });

      const data = JSON.parse(resp.body) as XunleiResponse;
      if (data.code !== 0 || !Array.isArray(data.data)) {
        logger.debug(`[xunlei] 响应异常：code=${data.code}, result=${data.result}`);
        return [];
      }

      const results: SubtitleSearchResult[] = [];
      for (let i = 0; i < data.data.length; i++) {
        const item = data.data[i];
        const format = (item.ext?.toLowerCase() ?? "") as SubtitleFormat;
        if (!SUPPORTED_FORMATS.includes(format)) continue;

        let downloadUrl: URL;
        try {
          downloadUrl = new URL(item.url);
        } catch {
          continue;
        }

        if (downloadUrl.protocol !== "https:" || downloadUrl.hostname !== DOWNLOAD_HOST) {
          logger.debug(`[xunlei] 跳过非法下载地址：${item.url}`);
          continue;
        }

        const language = this.resolveLanguage(item);
        results.push({
          providerId: this.id,
          sourceId: item.cid || `xunlei-${i}`,
          title: item.name || `${keyword}.${format}`,
          code: this.extractCode(item.name, keyword),
          language,
          format,
          duration: item.duration ? item.duration / 1000 : undefined,
          releaseInfo: item.extra_name,
          downloadUrl: downloadUrl.toString(),
          rating: item.score && item.score > 0 ? Math.min(10, item.score) : undefined,
        });
      }

      logger.debug(`[xunlei] 搜索完成，共 ${results.length} 条结果`);
      return results;
    } catch (e) {
      if (e instanceof SubtitleError) throw e;
      throw new SubtitleError("PROVIDER_NETWORK_ERROR", "迅雷字幕搜索失败", e);
    }
  }

  async download(result: SubtitleSearchResult, signal?: AbortSignal): Promise<SubtitleDownload> {
    if (!result.downloadUrl) {
      throw new SubtitleError("DOWNLOAD_FAILED", "缺少下载地址");
    }

    const url = new URL(result.downloadUrl);
    if (url.hostname !== DOWNLOAD_HOST) {
      throw new SubtitleError("DOWNLOAD_FAILED", "下载地址域名不合法");
    }

    logger.debug(`[xunlei] 下载字幕：${result.title}`);

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
      throw new SubtitleError("DOWNLOAD_FAILED", "迅雷字幕下载失败", e);
    }
  }

  private resolveLanguage(item: XunleiSubtitleItem): string | undefined {
    if (item.langs) return item.langs;
    if (item.languages && item.languages.length > 0) {
      return item.languages.join(",");
    }
    return undefined;
  }

  private extractCode(name: string, keyword: string): string | undefined {
    const upper = name.toUpperCase();
    const match = upper.match(/[A-Z]{2,6}-\d{2,6}/);
    if (match) return match[0];
    const kwUpper = keyword.toUpperCase();
    if (upper.includes(kwUpper)) return kwUpper;
    return undefined;
  }
}

export const xunleiProvider = new XunleiProvider();