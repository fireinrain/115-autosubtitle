import {database, toSubtitleMeta, type SubtitleMeta, type SubtitleRecord, type VideoRecord} from "./database";
import { SubtitleError } from "../utils/errors";

export interface DeduplicateResult {
    /** 被删除的重复字幕数量 */
    removed: number;
    /** 去重后保留的字幕总数 */
    kept: number;
    /** 实际发生合并的番号分组数量 */
    groups: number;
}

export interface CleanupOptions {
    /** 容量上限（字节）；<=0 表示不按容量清理。 */
    maxBytes: number;
    /** 清理超过多少天未使用的记录；<=0 表示不按时间清理。 */
    olderThanDays: number;
    /** 额外需要保护的记录 ID（如当前正在播放的字幕）。 */
    protectIds?: Iterable<string>;
    now?: number;
}

export interface CleanupResult {
    removed: number;
    freedBytes: number;
    totalBytes: number;
}

/** 番号归一化：去空白、统一大写，避免 `abc-123` 与 `ABC 123` 被当成两组。 */
function normalizeCode(code: string): string {
    return code.trim().toUpperCase().replace(/\s+/g, "");
}

export class SubtitleRepository {
  async save(record: SubtitleRecord): Promise<void> {
    try {
        const {tx, stores} = await database.transaction(["subtitles", "subtitleMeta"], "readwrite");
      stores.subtitles.put(record);
        stores.subtitleMeta.put(toSubtitleMeta(record));
      await this.waitForTransaction(tx);
    } catch (e) {
      if (e instanceof DOMException && e.name === "QuotaExceededError") {
        throw new SubtitleError("CACHE_QUOTA_EXCEEDED", "缓存空间不足", e);
      }
      throw new SubtitleError("CACHE_WRITE_FAILED", "写入字幕缓存失败", e);
    }
  }

  async getById(id: string): Promise<SubtitleRecord | null> {
    try {
      const { tx, stores } = await database.transaction("subtitles", "readonly");
      const req = stores.subtitles.get(id);
      await this.waitForTransaction(tx);
      return (req.result as SubtitleRecord | undefined) ?? null;
    } catch (e) {
      throw new SubtitleError("CACHE_READ_FAILED", "读取字幕缓存失败", e);
    }
  }

  async getByVideoKey(videoKey: string): Promise<SubtitleRecord[]> {
    const { tx, stores } = await database.transaction("subtitles", "readonly");
    const index = stores.subtitles.index("videoKey");
    const req = index.getAll(videoKey);
    await this.waitForTransaction(tx);
    return (req.result as SubtitleRecord[]) ?? [];
  }

    /**
     * 同一视频下是否已经缓存过同一来源的这条字幕。
     * 用于「使用」在线结果时避免重复下载。
     */
    async findBySource(
        videoKey: string,
        providerId: string,
        sourceId?: string,
    ): Promise<SubtitleRecord | null> {
        if (!sourceId) return null;
        const records = await this.getByVideoKey(videoKey);
        return records.find((r) => r.providerId === providerId && r.sourceId === sourceId) ?? null;
    }

    /**
     * 同一视频下是否已经缓存过内容完全相同的字幕。
     * 用于下载完成后的校验，以及本地导入时的去重。
     */
    async findByChecksum(videoKey: string, checksum?: string): Promise<SubtitleRecord | null> {
        if (!checksum) return null;
        const records = await this.getByVideoKey(videoKey);
        return records.find((r) => r.checksum === checksum) ?? null;
    }

  async delete(id: string): Promise<void> {
      const {tx, stores} = await database.transaction(["subtitles", "subtitleMeta", "videoRecords"], "readwrite");
    stores.subtitles.delete(id);
      stores.subtitleMeta.delete(id);

    const idx = stores.videoRecords.index("lastPlayedAt");
    const allReq = idx.getAll();
    await new Promise<void>((resolve) => {
      allReq.onsuccess = () => {
        const records = (allReq.result as VideoRecord[]) ?? [];
        for (const rec of records) {
          if (rec.selectedSubtitleId === id) {
            rec.selectedSubtitleId = undefined;
            stores.videoRecords.put(rec);
          }
        }
        resolve();
      };
      allReq.onerror = () => resolve();
    });

    await this.waitForTransaction(tx);
  }

  async getAll(): Promise<SubtitleRecord[]> {
    const { tx, stores } = await database.transaction("subtitles", "readonly");
    const req = stores.subtitles.getAll();
    await this.waitForTransaction(tx);
    return (req.result as SubtitleRecord[]) ?? [];
  }

    /** 只读取纯元数据，不加载 Blob/Cues；用于跨播放域名同步和统计。 */
    async getAllMetadata(): Promise<SubtitleMeta[]> {
        const {tx, stores} = await database.transaction("subtitleMeta", "readonly");
        const req = stores.subtitleMeta.getAll();
        await this.waitForTransaction(tx);
        return (req.result as SubtitleMeta[]) ?? [];
    }

    /**
     * 按番号去重：同一番号只保留最新的一份，旧字幕删除。
     *
     * 「最新」以 `createdAt` / `lastUsedAt` 的较大值为准，因此重新使用过的旧字幕
     * 会被视为更新，避免把用户刚用过的字幕删掉。
     *
     * 删除后同步修正 `videoRecords.selectedSubtitleId`：
     * - 保留的字幕属于同一个视频时，选中引用重定向到保留记录；
     * - 属于其他视频时清除引用，绝不把别的视频的字幕挂到当前视频上。
     */
    async deduplicateByCode(): Promise<DeduplicateResult> {
        const all = await this.getAll();
        const groups = new Map<string, SubtitleRecord[]>();

        for (const record of all) {
            const key = normalizeCode(record.code ?? "");
            if (!key) continue;
            const list = groups.get(key);
            if (list) list.push(record);
            else groups.set(key, [record]);
        }

        const removedToKept = new Map<string, SubtitleRecord>();
        let mergedGroups = 0;
        for (const list of groups.values()) {
            if (list.length < 2) continue;
            mergedGroups++;
            const sorted = [...list].sort(
                (a, b) =>
                    Math.max(b.createdAt ?? 0, b.lastUsedAt ?? 0) -
                    Math.max(a.createdAt ?? 0, a.lastUsedAt ?? 0),
            );
            const keep = sorted[0];
            for (const record of sorted.slice(1)) {
                removedToKept.set(record.id, keep);
            }
        }

        if (removedToKept.size === 0) {
            return {removed: 0, kept: all.length, groups: 0};
        }

        const {tx, stores} = await database.transaction(["subtitles", "subtitleMeta", "videoRecords"], "readwrite");
        for (const id of removedToKept.keys()) {
            stores.subtitles.delete(id);
            stores.subtitleMeta.delete(id);
        }

        const videoReq = stores.videoRecords.getAll();
        await new Promise<void>((resolve, reject) => {
            videoReq.onsuccess = () => {
                const records = (videoReq.result as VideoRecord[]) ?? [];
                const now = Date.now();
                for (const rec of records) {
                    if (!rec.selectedSubtitleId) continue;
                    const keep = removedToKept.get(rec.selectedSubtitleId);
                    if (!keep) continue;
                    rec.selectedSubtitleId = keep.videoKey === rec.videoKey ? keep.id : undefined;
                    rec.updatedAt = now;
                    stores.videoRecords.put(rec);
                }
                resolve();
            };
            videoReq.onerror = () => reject(videoReq.error);
        });

        await this.waitForTransaction(tx);
        return {
            removed: removedToKept.size,
            kept: all.length - removedToKept.size,
            groups: mergedGroups,
        };
    }

    /**
     * 使用一条新字幕后，删除同一番号的旧缓存，只保留 `keepId`。
     *
     * 与 `deduplicateByCode()` 不同，这里不按时间判断保留项：
     * 用户刚使用的新字幕就是唯一保留项，确保「新字幕覆盖旧字幕」。
     * 删除后同步修正选中引用；保留项属于其他视频时清除引用，避免串字幕。
     */
    async replaceByCode(code: string, keepId: string): Promise<{ removed: number }> {
        const key = normalizeCode(code);
        if (!key) return {removed: 0};

        const all = await this.getAll();
        const keep = all.find((r) => r.id === keepId);
        if (!keep) return {removed: 0};

        const removed = all.filter(
            (r) => r.id !== keepId && normalizeCode(r.code ?? "") === key,
        );
        if (removed.length === 0) return {removed: 0};

        const removedIds = new Set(removed.map((r) => r.id));
        const {tx, stores} = await database.transaction(["subtitles", "subtitleMeta", "videoRecords"], "readwrite");
        for (const id of removedIds) {
            stores.subtitles.delete(id);
            stores.subtitleMeta.delete(id);
        }

        const videoReq = stores.videoRecords.getAll();
        await new Promise<void>((resolve, reject) => {
            videoReq.onsuccess = () => {
                const records = (videoReq.result as VideoRecord[]) ?? [];
                const now = Date.now();
                for (const rec of records) {
                    if (!rec.selectedSubtitleId || !removedIds.has(rec.selectedSubtitleId)) continue;
                    rec.selectedSubtitleId = rec.videoKey === keep.videoKey ? keep.id : undefined;
                    rec.updatedAt = now;
                    stores.videoRecords.put(rec);
                }
                resolve();
            };
            videoReq.onerror = () => reject(videoReq.error);
        });

        await this.waitForTransaction(tx);
        return {removed: removed.length};
    }

  async getSelectedForVideo(videoKey: string): Promise<SubtitleRecord | null> {
    const { tx, stores } = await database.transaction("videoRecords", "readonly");
    const req = stores.videoRecords.get(videoKey);
    await this.waitForTransaction(tx);
    const record = req.result as VideoRecord | undefined;
    if (!record?.selectedSubtitleId) return null;
    return this.getById(record.selectedSubtitleId);
  }

    /** 保存用户手动修正的番号；后续打开该视频时优先使用。 */
    async setManualCode(videoKey: string, code: string): Promise<void> {
        const now = Date.now();
        const {tx, stores} = await database.transaction("videoRecords", "readwrite");
        const getReq = stores.videoRecords.get(videoKey);
        await new Promise<void>((resolve) => {
            getReq.onsuccess = () => {
                const existing = getReq.result as VideoRecord | undefined;
                const record: VideoRecord = existing
                    ? {...existing, code, codeSource: "manual", updatedAt: now}
                    : {
                        videoKey,
                        code,
                        codeSource: "manual",
                        subtitleEnabled: true,
                        offsetMs: 0,
                        lastPlayedAt: now,
                        updatedAt: now,
                    };
                stores.videoRecords.put(record);
                resolve();
            };
            getReq.onerror = () => resolve();
        });
        await this.waitForTransaction(tx);
    }

  async setSelectedForVideo(videoKey: string, subtitleId: string): Promise<void> {
    const now = Date.now();
    const { tx, stores } = await database.transaction("videoRecords", "readwrite");
    const getReq = stores.videoRecords.get(videoKey);
    await new Promise<void>((resolve) => {
      getReq.onsuccess = () => {
        const existing = getReq.result as VideoRecord | undefined;
        const record: VideoRecord = existing
          ? { ...existing, selectedSubtitleId: subtitleId, updatedAt: now }
          : {
              videoKey,
              codeSource: "auto",
              subtitleEnabled: true,
              offsetMs: 0,
              selectedSubtitleId: subtitleId,
              lastPlayedAt: now,
              updatedAt: now,
            };
        stores.videoRecords.put(record);
        resolve();
      };
      getReq.onerror = () => resolve();
    });
    await this.waitForTransaction(tx);
  }

  async getVideoRecord(videoKey: string): Promise<VideoRecord | null> {
    const { tx, stores } = await database.transaction("videoRecords", "readonly");
    const req = stores.videoRecords.get(videoKey);
    await this.waitForTransaction(tx);
    return (req.result as VideoRecord | undefined) ?? null;
  }

    async getAllVideoRecords(): Promise<VideoRecord[]> {
        const {tx, stores} = await database.transaction("videoRecords", "readonly");
        const req = stores.videoRecords.getAll();
        await this.waitForTransaction(tx);
        return (req.result as VideoRecord[]) ?? [];
    }

  async saveVideoRecord(record: VideoRecord): Promise<void> {
    const { tx, stores } = await database.transaction("videoRecords", "readwrite");
    stores.videoRecords.put(record);
    await this.waitForTransaction(tx);
  }

    /**
     * 清理缓存：按时间和容量删除未受保护的记录。
     *
     * 保护规则：调用方传入的 protectIds（通常是当前播放字幕）。
     * 删除后同步清除 `videoRecords.selectedSubtitleId` 中的引用。
     */
    async cleanup(options: CleanupOptions): Promise<CleanupResult> {
        const all = await this.getAll();
        const now = options.now ?? Date.now();
        const protectIds = new Set(options.protectIds ?? []);
        const sizes = new Map<string, number>();
        for (const record of all) sizes.set(record.id, record.rawBlob?.size ?? 0);

        const isProtected = (record: SubtitleRecord): boolean => protectIds.has(record.id);
        const removedIds = new Set<string>();

        if (options.olderThanDays > 0) {
            const cutoff = now - options.olderThanDays * 24 * 60 * 60 * 1000;
            for (const record of all) {
                if (!isProtected(record) && (record.lastUsedAt ?? 0) < cutoff) {
                    removedIds.add(record.id);
                }
            }
        }

        let totalBytes = all.reduce((sum, record) => sum + (sizes.get(record.id) ?? 0), 0);
        for (const id of removedIds) totalBytes -= sizes.get(id) ?? 0;

        if (options.maxBytes > 0 && totalBytes > options.maxBytes) {
            const candidates = all
                .filter((record) => !removedIds.has(record.id) && !isProtected(record))
                .sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0));
            for (const record of candidates) {
                if (totalBytes <= options.maxBytes) break;
                removedIds.add(record.id);
                totalBytes -= sizes.get(record.id) ?? 0;
            }
        }

        if (removedIds.size === 0) {
            return {removed: 0, freedBytes: 0, totalBytes};
        }

        const freedBytes = [...removedIds].reduce((sum, id) => sum + (sizes.get(id) ?? 0), 0);
        const {tx, stores} = await database.transaction(["subtitles", "subtitleMeta", "videoRecords"], "readwrite");
        for (const id of removedIds) {
            stores.subtitles.delete(id);
            stores.subtitleMeta.delete(id);
        }

        const videoReq = stores.videoRecords.getAll();
        await new Promise<void>((resolve, reject) => {
            videoReq.onsuccess = () => {
                const records = (videoReq.result as VideoRecord[]) ?? [];
                const nowTs = Date.now();
                for (const rec of records) {
                    if (!rec.selectedSubtitleId || !removedIds.has(rec.selectedSubtitleId)) continue;
                    rec.selectedSubtitleId = undefined;
                    rec.updatedAt = nowTs;
                    stores.videoRecords.put(rec);
                }
                resolve();
            };
            videoReq.onerror = () => reject(videoReq.error);
        });

        await this.waitForTransaction(tx);
        return {removed: removedIds.size, freedBytes, totalBytes};
    }

  async estimateSize(): Promise<{ count: number; bytes: number }> {
    const all = await this.getAll();
    let bytes = 0;
    for (const r of all) {
      bytes += r.rawBlob.size;
      bytes += JSON.stringify(r.cues).length;
    }
    return { count: all.length, bytes };
  }

  async clearAll(): Promise<void> {
      const {tx, stores} = await database.transaction(["subtitles", "subtitleMeta", "videoRecords"], "readwrite");
    stores.subtitles.clear();
      stores.subtitleMeta.clear();
    stores.videoRecords.clear();
    await this.waitForTransaction(tx);
  }

  private waitForTransaction(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
}

export const subtitleRepository = new SubtitleRepository();