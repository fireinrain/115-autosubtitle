import type {SubtitleCue, SubtitleFormat} from "../subtitle/subtitle-model";
import type {SubtitleSearchResult} from "../providers/provider";

export interface SubtitleRecord {
  id: string;
  videoKey: string;
  code: string;
  providerId: string;
  sourceId?: string;
  title: string;
  language?: string;
  format: SubtitleFormat;
  rawBlob: Blob;
  encoding: string;
  cues: SubtitleCue[];
  cueCount: number;
  checksum?: string;
  createdAt: number;
  lastUsedAt: number;
  parserVersion: number;
    /**
     * 在线来源的搜索结果快照（含下载地址）。
     * 用于跨播放域名恢复缓存：IndexedDB 按 origin 隔离，但 GM 存储共享，
     * 另一个域名可以凭这份元数据重新下载同一条字幕。
     */
    sourceResult?: SubtitleSearchResult;
}

/**
 * 字幕的纯元数据投影。
 *
 * 与 `SubtitleRecord` 的区别是不含 `rawBlob` 与 `cues`，供跨播放域名同步、
 * 缓存列表统计等只需要元数据的场景使用，避免为了发布索引把大对象全部读进内存。
 */
export interface SubtitleMeta {
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
    /** 原始字幕文件大小（字节）；不依赖 Blob 本身。 */
    size: number;
    createdAt: number;
    lastUsedAt: number;
    parserVersion: number;
    sourceResult?: SubtitleSearchResult;
}

export function toSubtitleMeta(record: SubtitleRecord): SubtitleMeta {
    return {
        id: record.id,
        videoKey: record.videoKey,
        code: record.code,
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
        parserVersion: record.parserVersion,
        sourceResult: record.sourceResult,
    };
}

export interface VideoRecord {
  videoKey: string;
  fileId?: string;
  fileName?: string;
  normalizedFileName?: string;
  code?: string;
  codeSource: "auto" | "manual";
  selectedSubtitleId?: string;
  subtitleEnabled: boolean;
  offsetMs: number;
  lastPlayedAt: number;
  updatedAt: number;
}

export interface SettingsEntry {
  key: string;
  value: unknown;
  updatedAt: number;
}

export const DB_NAME = "115AutoSubtitleDB";
export const DB_VERSION = 2;

export interface IDBCollections {
  subtitles: SubtitleRecord;
    subtitleMeta: SubtitleMeta;
  videoRecords: VideoRecord;
  settings: SettingsEntry;
}

export class Database {
  private dbPromise: Promise<IDBDatabase> | null = null;

  open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("数据库被阻塞"));
      request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (event) => this.upgrade(request.result, event.oldVersion);
    });
    return this.dbPromise;
  }

    private upgrade(db: IDBDatabase, oldVersion: number): void {
    if (!db.objectStoreNames.contains("subtitles")) {
      const store = db.createObjectStore("subtitles", { keyPath: "id" });
      store.createIndex("videoKey", "videoKey", { unique: false });
      store.createIndex("code", "code", { unique: false });
      store.createIndex("providerId", "providerId", { unique: false });
      store.createIndex("lastUsedAt", "lastUsedAt", { unique: false });
      store.createIndex("checksum", "checksum", { unique: false });
    }

    if (!db.objectStoreNames.contains("videoRecords")) {
      const store = db.createObjectStore("videoRecords", { keyPath: "videoKey" });
      store.createIndex("lastPlayedAt", "lastPlayedAt", { unique: false });
    }

    if (!db.objectStoreNames.contains("settings")) {
      db.createObjectStore("settings", { keyPath: "key" });
    }

        // v2：增加不含 Blob/Cues 的元数据 store，供同步与统计使用。
        // 旧记录必须从 subtitles 投影一次，否则升级后远程索引会突然变空。
        if (!db.objectStoreNames.contains("subtitleMeta")) {
            const metaStore = db.createObjectStore("subtitleMeta", {keyPath: "id"});
            metaStore.createIndex("videoKey", "videoKey", {unique: false});
            metaStore.createIndex("code", "code", {unique: false});
            metaStore.createIndex("providerId", "providerId", {unique: false});
            metaStore.createIndex("lastUsedAt", "lastUsedAt", {unique: false});
            metaStore.createIndex("checksum", "checksum", {unique: false});

            if (oldVersion < 2 && db.objectStoreNames.contains("subtitles")) {
                const tx = metaStore.transaction;
                const source = tx.objectStore("subtitles");
                const cursorReq = source.openCursor();
                cursorReq.onsuccess = () => {
                    const cursor = cursorReq.result;
                    if (!cursor) return;
                    const record = cursor.value as SubtitleRecord;
                    if (record && typeof record.id === "string") {
                        metaStore.put(toSubtitleMeta(record));
                    }
                    cursor.continue();
                };
            }
        }
  }

  async transaction<K extends keyof IDBCollections>(
    storeNames: K | K[],
    mode: IDBTransactionMode,
  ): Promise<{ tx: IDBTransaction; stores: { [P in K]: IDBObjectStore } }> {
    const db = await this.open();
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const tx = db.transaction(names as string[], mode);
    const stores = {} as { [P in K]: IDBObjectStore };
    for (const name of names) {
      stores[name] = tx.objectStore(name as string);
    }
    return { tx, stores };
  }

  async close(): Promise<void> {
    if (this.dbPromise) {
      const db = await this.dbPromise;
      db.close();
      this.dbPromise = null;
    }
  }
}

export const database = new Database();