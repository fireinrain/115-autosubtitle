import type { SubtitleFormat } from "../subtitle/subtitle-model";
import type { SubtitleCue } from "../subtitle/subtitle-model";

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
  isFavorite: boolean;
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

export const DB_NAME = "115SubtitleAssistantDB";
export const DB_VERSION = 1;

export interface IDBCollections {
  subtitles: SubtitleRecord;
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
      request.onupgradeneeded = () => this.upgrade(request.result);
    });
    return this.dbPromise;
  }

  private upgrade(db: IDBDatabase): void {
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