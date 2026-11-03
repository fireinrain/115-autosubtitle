import type {SubtitleSearchResult} from "../providers/provider";
import {readStoredValue, writeStoredValue} from "../storage/gm-storage";
import {isFiniteNumber} from "../utils/number";

/**
 * 自动搜索的短期结果缓存。
 *
 * 背景：用户刷新页面或在新标签页打开同一个视频时，自动搜索会对同一个番号
 * 重复请求字幕站。这里按「番号 + 时长桶/文件名」缓存 15 分钟内的结果，
 * 只用于自动搜索；手动搜索会显式绕过缓存，但成功后仍会覆盖缓存。
 *
 * - 空结果也缓存，避免来源明确无结果时反复请求；
 * - 最多保存 20 个查询，按写入时间淘汰；
 * - 存储键与设置、元数据同步分离，损坏时整体丢弃即可恢复。
 */
export const AUTO_SEARCH_CACHE_KEY = "autoSearchCache.v1";
export const AUTO_SEARCH_TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 20;

interface SearchCacheEntry {
    /** 写入时间（毫秒） */
    savedAt: number;
    results: SubtitleSearchResult[];
}

interface SearchCachePayload {
    version: 1;
    entries: Record<string, SearchCacheEntry>;
}

export interface SearchCacheKeyInput {
    code: string;
    duration?: number;
    fileName?: string;
}

function normalizeCode(code: string): string {
    return code.trim().toUpperCase().replace(/\s+/g, "");
}

function normalizeFileName(name?: string): string {
    if (!name) return "";
    return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * 时长统一按 60 秒分桶，避免同一视频因元数据精度差异导致缓存永远不命中。
 * 没有时长时退回文件名；文件名也缺失时只用番号（仍比完全不缓存安全）。
 */
export function buildAutoSearchCacheKey(input: SearchCacheKeyInput): string {
    const code = normalizeCode(input.code);
    if (!code) return "";
    if (input.duration !== undefined && isFiniteNumber(input.duration) && input.duration > 0) {
        return `${code}|dur:${Math.floor(input.duration / 60)}`;
    }
    const fileName = normalizeFileName(input.fileName);
    return fileName ? `${code}|name:${fileName}` : `${code}|name:unknown`;
}

function emptyPayload(): SearchCachePayload {
    return {version: 1, entries: {}};
}

function normalizePayload(raw: unknown): SearchCachePayload {
    if (!raw || typeof raw !== "object") return emptyPayload();
    const value = raw as Partial<SearchCachePayload>;
    if (value.version !== 1 || !value.entries || typeof value.entries !== "object") {
        return emptyPayload();
    }
    const entries: Record<string, SearchCacheEntry> = {};
    for (const [key, entry] of Object.entries(value.entries)) {
        if (!key || !entry || typeof entry !== "object") continue;
        const savedAt = (entry as SearchCacheEntry).savedAt;
        const results = (entry as SearchCacheEntry).results;
        if (typeof savedAt !== "number" || !Array.isArray(results)) continue;
        entries[key] = {savedAt, results: results.filter(isSearchResult)};
    }
    return {version: 1, entries};
}

function isSearchResult(value: unknown): value is SubtitleSearchResult {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<SubtitleSearchResult>;
    return typeof item.providerId === "string" &&
        typeof item.sourceId === "string" &&
        typeof item.title === "string" &&
        typeof item.format === "string";
}

export class AutoSearchCache {
    constructor(private readonly now: () => number = () => Date.now()) {
    }

    read(key: string): SubtitleSearchResult[] | null {
        if (!key) return null;
        try {
            const payload = normalizePayload(readStoredValue<unknown>(AUTO_SEARCH_CACHE_KEY, null));
            const entry = payload.entries[key];
            if (!entry) return null;
            if (this.now() - entry.savedAt > AUTO_SEARCH_TTL_MS) {
                delete payload.entries[key];
                this.writePayload(payload);
                return null;
            }
            return entry.results;
        } catch {
            // 存储不可用/损坏不应该阻断自动搜索。
            return null;
        }
    }

    write(key: string, results: SubtitleSearchResult[]): void {
        if (!key) return;
        try {
            const payload = normalizePayload(readStoredValue<unknown>(AUTO_SEARCH_CACHE_KEY, null));
            payload.entries[key] = {savedAt: this.now(), results};

            const ordered = Object.entries(payload.entries)
                .sort((a, b) => b[1].savedAt - a[1].savedAt)
                .slice(0, MAX_ENTRIES);
            payload.entries = Object.fromEntries(ordered);
            this.writePayload(payload);
        } catch {
            // 缓存写入失败只影响下一次请求，不影响当前搜索。
        }
    }

    clear(): void {
        writeStoredValue(AUTO_SEARCH_CACHE_KEY, emptyPayload());
    }

    private writePayload(payload: SearchCachePayload): void {
        writeStoredValue(AUTO_SEARCH_CACHE_KEY, payload);
    }
}

export const autoSearchCache = new AutoSearchCache();
