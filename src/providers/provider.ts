import type { SubtitleFormat } from "../subtitle/subtitle-model";

export interface SubtitleSearchQuery {
  code: string;
  normalizedCode: string;
  fileName?: string;
  duration?: number;
  languagePreferences: string[];
    /** 手动搜索/用户重试时跳过 Provider 失败冷却。 */
    force?: boolean;
  signal?: AbortSignal;
}

export interface SubtitleSearchResult {
  providerId: string;
  sourceId: string;
  title: string;
  code?: string;
  language?: string;
  format: SubtitleFormat;
  fileSize?: number;
  duration?: number;
  releaseInfo?: string;
  downloadUrl?: string;
  detailUrl?: string;
  rating?: number;
  updatedAt?: number;
  checksum?: string;
  matchScore?: number;
  matchReasons?: string[];
}

export interface SubtitleDownload {
  bytes: ArrayBuffer;
  fileName: string;
  contentType?: string;
  checksum?: string;
}

export interface SubtitleProvider {
  readonly id: string;
  readonly name: string;
  readonly enabledByDefault: boolean;
  search(query: SubtitleSearchQuery): Promise<SubtitleSearchResult[]>;
  download(result: SubtitleSearchResult, signal?: AbortSignal): Promise<SubtitleDownload>;
  healthCheck?(): Promise<{ ok: boolean; message?: string }>;
}