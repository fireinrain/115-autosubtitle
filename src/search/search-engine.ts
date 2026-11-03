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

const PROVIDER_COOLDOWN_MS = 60_000;

export class SubtitleSearchEngine {
    /** 最近失败的网络来源，短时间内自动搜索不再重复打满请求。 */
    private providerCooldownUntil = new Map<string, number>();

  async search(
    query: SubtitleSearchQuery,
    settings: GlobalSettings,
    callbacks?: SearchCallbacks,
  ): Promise<SubtitleSearchResult[]> {
      const allProviders = providerManager.getEnabled(settings).filter((p) => p.id !== "local");
      const now = Date.now();
      const providers = allProviders.filter(
          (provider) => query.force || (this.providerCooldownUntil.get(provider.id) ?? 0) <= now,
      );

      if (allProviders.length === 0) {
      return [];
    }

    const providerStates: Record<string, ProviderState> = {};
      for (const provider of allProviders) {
          const coolingDown = !providers.includes(provider);
          providerStates[provider.id] = coolingDown
              ? {
                  providerId: provider.id,
                  status: "error",
                  errorMessage: "最近请求失败，自动搜索暂缓 60 秒；可手动搜索重试",
                  errorCode: "PROVIDER_NETWORK_ERROR",
                  resultCount: 0,
              }
              : {providerId: provider.id, status: "pending", resultCount: 0};
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

          this.providerCooldownUntil.delete(provider.id);
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
            if (isSubtitleError(e)) {
                providerStates[provider.id].errorCode = e.code;
                if (e.code === "PROVIDER_NETWORK_ERROR" || e.code === "PROVIDER_TIMEOUT") {
                    this.providerCooldownUntil.set(provider.id, Date.now() + PROVIDER_COOLDOWN_MS);
                }
            }
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