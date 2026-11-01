import type { SubtitleProvider, SubtitleSearchResult, SubtitleDownload } from "./provider";
import type { SubtitleSearchQuery } from "./provider";

export class LocalFileProvider implements SubtitleProvider {
  readonly id = "local";
  readonly name = "本地文件";
  readonly enabledByDefault = true;

  async search(_query: SubtitleSearchQuery): Promise<SubtitleSearchResult[]> {
    return [];
  }

  async download(result: SubtitleSearchResult): Promise<SubtitleDownload> {
    throw new Error(`本地 Provider 不支持下载：${result.sourceId}`);
  }

  async fromFile(file: File): Promise<{ bytes: ArrayBuffer; fileName: string }> {
    const bytes = await file.arrayBuffer();
    return { bytes, fileName: file.name };
  }
}

export const localFileProvider = new LocalFileProvider();