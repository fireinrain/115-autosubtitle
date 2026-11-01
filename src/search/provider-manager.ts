import type { SubtitleProvider, SubtitleSearchQuery, SubtitleSearchResult } from "../providers/provider";
import { localFileProvider } from "../providers/local-provider";
import { xunleiProvider } from "../providers/xunlei-provider";
import { subtitleCatProvider } from "../providers/subtitlecat-provider";
import type { GlobalSettings } from "../settings/settings-service";
import { logger } from "../utils/logger";
import { SubtitleError } from "../utils/errors";

export type ProviderStatus = "pending" | "searching" | "success" | "no-results" | "error" | "timeout";

export interface ProviderState {
  providerId: string;
  status: ProviderStatus;
  errorMessage?: string;
  resultCount: number;
}

export interface SearchProgress {
  providerStates: Record<string, ProviderState>;
  results: SubtitleSearchResult[];
  done: boolean;
}

export class ProviderManager {
  private providers: Map<string, SubtitleProvider> = new Map();

  constructor() {
    this.register(localFileProvider);
    this.register(xunleiProvider);
    this.register(subtitleCatProvider);
  }

  register(provider: SubtitleProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): SubtitleProvider | undefined {
    return this.providers.get(id);
  }

  getAll(): SubtitleProvider[] {
    return Array.from(this.providers.values());
  }

  getEnabled(settings: GlobalSettings): SubtitleProvider[] {
    return this.getAll().filter((p) => {
      const ps = settings.providers[p.id];
      if (ps) return ps.enabled;
      return p.enabledByDefault;
    });
  }
}

export const providerManager = new ProviderManager();