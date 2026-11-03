import type {SubtitleFormat} from "../subtitle/subtitle-model";
import type {SubtitleSearchResult} from "../providers/provider";
import type {SubtitleRecord, VideoRecord} from "./database";
import {subtitleRepository} from "./subtitle-repository";
import {readStoredValue, writeStoredValue} from "./gm-storage";
import {isFiniteNumber} from "../utils/number";
import {logger} from "../utils/logger";

/**
 * 跨播放域名的缓存元数据同步。
 *
 * 背景：`115vod.com` 与 `115.com` 是不同 origin，IndexedDB 相互隔离；
 * 但 Tampermonkey 的 GM 存储在同一个脚本内跨 origin 共享。
 *
 * 这里只同步「可重建缓存」所需的元数据：字幕标识、视频关联、选中状态和在线来源的
 * 下载信息；不同步 Blob 与 Cues（体积大，且 GM 存储容量有限）。
 * 另一个域名恢复时按 `sourceResult` 重新下载，而不是伪造本地缓存。
 */
const SYNC_KEY = "metadataSync.v1";
/** 共享 GM 存储键；导出以便测试和后续迁移。 */
export const METADATA_SYNC_KEY = SYNC_KEY;
const SYNC_VERSION = 1;
const MAX_SUBTITLES_PER_ORIGIN = 500;
const MAX_VIDEOS_PER_ORIGIN = 500;

export interface SyncedSubtitleMeta {
    id: string;
    videoKey: string;
    code: string;
    providerId: string;
    sourceId?: string;
    title: string;
    language?: string;
    format: SubtitleFormat;
    cueCount: number;
    checksum?: string;
    size: number;
    createdAt: number;
    lastUsedAt: number;
    isFavorite: boolean;
    /** 在线来源的搜索结果快照，用于在另一个播放域名重新下载。 */
    sourceResult?: SubtitleSearchResult;
}

export interface SyncedVideoMeta {
    videoKey: string;
    code?: string;
    selectedSubtitleId?: string;
    offsetMs: number;
    subtitleEnabled: boolean;
    updatedAt: number;
}

export interface RemoteSubtitleMeta extends SyncedSubtitleMeta {
    origin: string;
}

export interface RemoteCacheSummary {
    count: number;
    bytes: number;
    origins: string[];
}

interface SyncBucket {
    updatedAt: number;
    subtitles: SyncedSubtitleMeta[];
    videos: SyncedVideoMeta[];
}

interface SyncPayload {
    version: number;
    buckets: Record<string, SyncBucket>;
}

export function getCurrentOrigin(): string {
    return window.location.host || "unknown-origin";
}

/** 从 `id:<pickcode>|dur:...` 中提取 115 文件 ID，用于跨域名匹配同一个视频。 */
export function fileIdFromVideoKey(videoKey: string): string | undefined {
    const match = /^id:([^|]+)/.exec(videoKey);
    return match?.[1];
}

function matchesVideo(metaVideoKey: string, videoKey: string, fileId?: string): boolean {
    if (metaVideoKey === videoKey) return true;
    if (!fileId) return false;
    return fileIdFromVideoKey(metaVideoKey) === fileId;
}

function sanitizeSourceResult(result?: SubtitleSearchResult): SubtitleSearchResult | undefined {
    if (!result) return undefined;
    // 只保留重新下载需要的字段，避免把大体积的匹配说明写进 GM 存储。
    return {
        providerId: result.providerId,
        sourceId: result.sourceId,
        title: result.title,
        code: result.code,
        language: result.language,
        format: result.format,
        fileSize: result.fileSize,
        duration: result.duration,
        releaseInfo: result.releaseInfo,
        downloadUrl: result.downloadUrl,
        detailUrl: result.detailUrl,
        rating: result.rating,
        updatedAt: result.updatedAt,
        checksum: result.checksum,
    };
}

function toSyncedSubtitle(record: SubtitleRecord): SyncedSubtitleMeta {
    return {
        id: record.id,
        videoKey: record.videoKey,
        code: record.code ?? "",
        providerId: record.providerId,
        sourceId: record.sourceId,
        title: record.title,
        language: record.language,
        format: record.format,
        cueCount: record.cueCount,
        checksum: record.checksum,
        size: record.rawBlob?.size ?? 0,
        createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt,
        isFavorite: record.isFavorite,
        sourceResult: sanitizeSourceResult(record.sourceResult),
    };
}

function toSyncedVideo(record: VideoRecord): SyncedVideoMeta {
    return {
        videoKey: record.videoKey,
        code: record.code,
        selectedSubtitleId: record.selectedSubtitleId,
        offsetMs: record.offsetMs,
        subtitleEnabled: record.subtitleEnabled,
        updatedAt: record.updatedAt,
    };
}

/** 构造单个播放域名的同步快照（导出以便单测）。 */
export function buildSyncBucket(
    subtitles: SubtitleRecord[],
    videos: VideoRecord[],
): SyncBucket {
    return {
        updatedAt: Date.now(),
        subtitles: [...subtitles]
            .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
            .slice(0, MAX_SUBTITLES_PER_ORIGIN)
            .map(toSyncedSubtitle),
        videos: [...videos]
            .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
            .slice(0, MAX_VIDEOS_PER_ORIGIN)
            .map(toSyncedVideo),
    };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown, fallback = 0): number {
    return isFiniteNumber(value) ? value : fallback;
}

function normalizeSourceResult(value: unknown): SubtitleSearchResult | undefined {
    if (!isObject(value)) return undefined;
    const providerId = asString(value.providerId);
    const sourceId = asString(value.sourceId);
    const title = asString(value.title);
    const format = asString(value.format) as SubtitleFormat | undefined;
    if (!providerId || !sourceId || !title || !format) return undefined;
    return {
        providerId,
        sourceId,
        title,
        code: asString(value.code),
        language: asString(value.language),
        format,
        fileSize: isFiniteNumber(value.fileSize) ? value.fileSize : undefined,
        duration: isFiniteNumber(value.duration) ? value.duration : undefined,
        releaseInfo: asString(value.releaseInfo),
        downloadUrl: asString(value.downloadUrl),
        detailUrl: asString(value.detailUrl),
        rating: isFiniteNumber(value.rating) ? value.rating : undefined,
        updatedAt: isFiniteNumber(value.updatedAt) ? value.updatedAt : undefined,
        checksum: asString(value.checksum),
    };
}

function normalizeSubtitle(value: unknown): SyncedSubtitleMeta | null {
    if (!isObject(value)) return null;
    const id = asString(value.id);
    const videoKey = asString(value.videoKey);
    const providerId = asString(value.providerId);
    const title = asString(value.title);
    const format = asString(value.format) as SubtitleFormat | undefined;
    if (!id || !videoKey || !providerId || !title || !format) return null;
    return {
        id,
        videoKey,
        code: asString(value.code) ?? "",
        providerId,
        sourceId: asString(value.sourceId),
        title,
        language: asString(value.language),
        format,
        cueCount: asNumber(value.cueCount),
        checksum: asString(value.checksum),
        size: asNumber(value.size),
        createdAt: asNumber(value.createdAt),
        lastUsedAt: asNumber(value.lastUsedAt),
        isFavorite: value.isFavorite === true,
        sourceResult: normalizeSourceResult(value.sourceResult),
    };
}

function normalizeVideo(value: unknown): SyncedVideoMeta | null {
    if (!isObject(value)) return null;
    const videoKey = asString(value.videoKey);
    if (!videoKey) return null;
    return {
        videoKey,
        code: asString(value.code),
        selectedSubtitleId: asString(value.selectedSubtitleId),
        offsetMs: asNumber(value.offsetMs),
        subtitleEnabled: value.subtitleEnabled !== false,
        updatedAt: asNumber(value.updatedAt),
    };
}

/**
 * GM 存储可能被旧版本或外部修改，读取时按字段逐项校验，
 * 坏数据只丢弃对应条目，不让整个同步功能失效。
 */
function normalizePayload(raw: unknown): SyncPayload {
    const empty: SyncPayload = {version: SYNC_VERSION, buckets: {}};
    if (!isObject(raw) || raw.version !== SYNC_VERSION || !isObject(raw.buckets)) return empty;

    const buckets: Record<string, SyncBucket> = {};
    for (const [origin, value] of Object.entries(raw.buckets)) {
        if (!origin || !isObject(value)) continue;
        const subtitles = Array.isArray(value.subtitles)
            ? value.subtitles.map(normalizeSubtitle).filter((s): s is SyncedSubtitleMeta => s !== null)
            : [];
        const videos = Array.isArray(value.videos)
            ? value.videos.map(normalizeVideo).filter((v): v is SyncedVideoMeta => v !== null)
            : [];
        buckets[origin] = {
            updatedAt: asNumber(value.updatedAt),
            subtitles,
            videos,
        };
    }
    return {version: SYNC_VERSION, buckets};
}

export class MetadataSyncService {
    constructor(private readonly origin: string = getCurrentOrigin()) {
    }

    getOrigin(): string {
        return this.origin;
    }

    /**
     * 把当前 origin 的 IndexedDB 元数据写入共享 GM 存储。
     * 只覆盖自己的 bucket，保留其他播放域名的数据。
     */
    async publish(): Promise<void> {
        try {
            const [subtitles, videos] = await Promise.all([
                subtitleRepository.getAll(),
                subtitleRepository.getAllVideoRecords(),
            ]);
            const payload = this.readPayload();
            payload.buckets[this.origin] = buildSyncBucket(subtitles, videos);
            writeStoredValue(SYNC_KEY, payload);
        } catch (e) {
            logger.warn("同步缓存元数据失败", e);
        }
    }

    /** 获取其他播放域名中与当前视频关联的字幕元数据和选中项。 */
    getRemoteForVideo(
        videoKey: string,
        fileId?: string,
    ): { subtitles: RemoteSubtitleMeta[]; selected: RemoteSubtitleMeta | null } {
        const payload = this.readPayload();
        const byId = new Map<string, RemoteSubtitleMeta>();
        let selected: RemoteSubtitleMeta | null = null;

        for (const [origin, bucket] of Object.entries(payload.buckets)) {
            if (origin === this.origin) continue;

            const subtitles = bucket.subtitles.filter((sub) =>
                matchesVideo(sub.videoKey, videoKey, fileId),
            );
            for (const sub of subtitles) {
                const existing = byId.get(sub.id);
                if (!existing || sub.lastUsedAt > existing.lastUsedAt) {
                    byId.set(sub.id, {...sub, origin});
                }
            }

            for (const video of bucket.videos) {
                if (!video.selectedSubtitleId) continue;
                if (!matchesVideo(video.videoKey, videoKey, fileId)) continue;
                const sub = subtitles.find((item) => item.id === video.selectedSubtitleId);
                if (!sub) continue;
                if (!selected || sub.lastUsedAt > selected.lastUsedAt) {
                    selected = {...sub, origin};
                }
            }
        }

        return {
            subtitles: [...byId.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt),
            selected,
        };
    }

    /** 其他播放域名的缓存总量，用于面板提示。 */
    getRemoteSummary(): RemoteCacheSummary {
        const payload = this.readPayload();
        const seen = new Set<string>();
        let count = 0;
        let bytes = 0;
        const origins: string[] = [];

        for (const [origin, bucket] of Object.entries(payload.buckets)) {
            if (origin === this.origin || bucket.subtitles.length === 0) continue;
            origins.push(origin);
            for (const sub of bucket.subtitles) {
                if (seen.has(sub.id)) continue;
                seen.add(sub.id);
                count++;
                bytes += sub.size > 0 ? sub.size : 0;
            }
        }

        return {count, bytes, origins};
    }

    private readPayload(): SyncPayload {
        return normalizePayload(readStoredValue<unknown>(SYNC_KEY, null));
    }
}

export const metadataSync = new MetadataSyncService();
