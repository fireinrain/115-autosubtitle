import type { SubtitleSearchQuery, SubtitleSearchResult } from "../providers/provider";
import type { GlobalSettings } from "../settings/settings-service";
import type { ProviderState, SearchProgress } from "./provider-manager";
import { providerManager } from "./provider-manager";
import { deduplicateResults, scoreResult, sortResults } from "./result-matcher";
import { logger } from "../utils/logger";
import { isSubtitleError, SubtitleError } from "../utils/errors";

export interface SearchCallbacks {
  onProgress?: (progress: SearchProgress) => void;
}

export class SubtitleSearchEngine {
  async search(
    query: SubtitleSearchQuery,
    settings: GlobalSettings,
    callbacks?: SearchCallbacks,
  ): Promise<SubtitleSearchResult[]> {
    const providers = providerManager.getEnabled(settings).filter((p) => p.id !== "local");

    if (providers.length === 0) {
      return [];
    }

    const providerStates: Record<string, ProviderState> = {};
    for (const p of providers) {
      providerStates[p.id] = { providerId: p.id, status: "pending", resultCount: 0 };
    }

    let allResults: SubtitleSearchResult[] = [];
    const controller = new AbortController();

    const signal = query.signal;
    if (signal) {
      signal.addEventListener("abort", () => controller.abort());
    }

    const promises = providers.map(async (provider) => {
      providerStates[provider.id].status = "searching";
      callbacks?.onProgress?.({ providerStates: { ...providerStates }, results: allResults, done: false });

      try {
        const result = await Promise.race([
          provider.search({ ...query, signal: controller.signal }),
          this.timeout(12000, provider.id),
        ]);

        providerStates[provider.id].status = result.length > 0 ? "success" : "no-results";
        providerStates[provider.id].resultCount = result.length;

        const scored = result.map((r) => {
          const { score, reasons } = scoreResult(r, query);
          return { ...r, matchScore: score, matchReasons: reasons };
        });

        allResults = deduplicateResults([...allResults, ...scored]);
        allResults = sortResults(allResults);
      } catch (e) {
        if (isSubtitleError(e) && e.code === "PROVIDER_TIMEOUT") {
          providerStates[provider.id].status = "timeout";
          providerStates[provider.id].errorMessage = "搜索超时";
        } else if (controller.signal.aborted) {
          providerStates[provider.id].status = "error";
          providerStates[provider.id].errorMessage = "已取消";
        } else {
          providerStates[provider.id].status = "error";
          providerStates[provider.id].errorMessage = e instanceof Error ? e.message : "未知错误";
          logger.warn(`Provider ${provider.id} 搜索失败`, e);
        }
      }

      callbacks?.onProgress?.({ providerStates: { ...providerStates }, results: allResults, done: false });
    });

    await Promise.allSettled(promises);

    callbacks?.onProgress?.({ providerStates, results: allResults, done: true });
    return allResults;
  }

  private timeout(ms: number, providerId: string): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new SubtitleError("PROVIDER_TIMEOUT", `${providerId} 搜索超时`)), ms);
    });
  }
}

export const subtitleSearchEngine = new SubtitleSearchEngine();