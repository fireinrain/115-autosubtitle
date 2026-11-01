import type { SubtitleFormat } from "../subtitle/subtitle-model";
import { readStoredValue, writeStoredValue } from "../storage/gm-storage";

export interface SubtitleStyleSettings {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  outlineColor: string;
  outlineWidth: number;
  shadow: boolean;
  backgroundColor: string;
  backgroundOpacity: number;
  horizontal: "left" | "center" | "right";
  xPercent: number;
  yPercent: number;
  maxWidthPercent: number;
  lineHeight: number;
}

export interface SubtitleSyncSettings {
  offsetMs: number;
  stepMs: number;
}

export interface CacheSettings {
  maxBytes: number;
  cleanupAfterDays: number;
}

export interface ProviderSettings {
  enabled: boolean;
}

export interface ShortcutSettings {
  enabled: boolean;
}

export interface GlobalSettings {
  enabled: boolean;
  autoSearch: boolean;
  autoLoadCachedSubtitle: boolean;
  autoSelectHighConfidence: boolean;
  preferredLanguages: string[];
  defaultFormatOrder: SubtitleFormat[];
  style: SubtitleStyleSettings;
  sync: SubtitleSyncSettings;
  cache: CacheSettings;
  providers: Record<string, ProviderSettings>;
  shortcuts: ShortcutSettings;
  debug: boolean;
}

export const DEFAULT_SETTINGS: GlobalSettings = {
  enabled: true,
  autoSearch: false,
  autoLoadCachedSubtitle: true,
  autoSelectHighConfidence: false,
  preferredLanguages: ["zh-CN", "zh-TW", "en"],
  defaultFormatOrder: ["srt", "vtt", "ass", "ssa"],
  style: {
    fontFamily: "Arial, sans-serif",
    fontSize: 32,
    fontWeight: 600,
    color: "#FFFFFF",
    outlineColor: "#000000",
    outlineWidth: 2,
    shadow: true,
    backgroundColor: "#000000",
    backgroundOpacity: 0,
    horizontal: "center",
    xPercent: 50,
    yPercent: 88,
    maxWidthPercent: 90,
    lineHeight: 1.2,
  },
  sync: { offsetMs: 0, stepMs: 500 },
  cache: { maxBytes: 200 * 1024 * 1024, cleanupAfterDays: 90 },
  providers: {},
  shortcuts: { enabled: true },
  debug: false,
};

const STORAGE_KEY = "115-subtitle-assistant-settings";

export class SettingsService {
  private cache: GlobalSettings | null = null;

  async load(): Promise<GlobalSettings> {
    if (this.cache) return this.cache;
    try {
      const raw = await this.readValue<Partial<GlobalSettings>>(STORAGE_KEY);
      const merged = this.mergeDefaults(raw);
      this.cache = merged;
      return merged;
    } catch {
      this.cache = { ...DEFAULT_SETTINGS };
      return this.cache;
    }
  }

  async save(settings: GlobalSettings): Promise<void> {
    this.cache = settings;
    await this.writeValue(STORAGE_KEY, settings);
  }

  async update(patch: Partial<GlobalSettings>): Promise<GlobalSettings> {
    const current = await this.load();
    const merged = { ...current, ...patch };
    await this.save(merged);
    return merged;
  }

  private mergeDefaults(raw?: Partial<GlobalSettings>): GlobalSettings {
    if (!raw) return { ...DEFAULT_SETTINGS };
    return {
      ...DEFAULT_SETTINGS,
      ...raw,
      style: { ...DEFAULT_SETTINGS.style, ...raw.style },
      sync: { ...DEFAULT_SETTINGS.sync, ...raw.sync },
      cache: { ...DEFAULT_SETTINGS.cache, ...raw.cache },
      shortcuts: { ...DEFAULT_SETTINGS.shortcuts, ...raw.shortcuts },
      providers: raw.providers ?? {},
    };
  }

  private readValue<T>(key: string): Promise<T | undefined> {
    return new Promise((resolve) => {
      try {
        resolve(readStoredValue<T | undefined>(key, undefined));
      } catch {
        resolve(undefined);
      }
    });
  }

  private writeValue(key: string, value: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        writeStoredValue(key, value);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  }
}

export const settingsService = new SettingsService();