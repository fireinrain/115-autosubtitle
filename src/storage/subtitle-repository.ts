import { database, type SubtitleRecord, type VideoRecord } from "./database";
import { SubtitleError } from "../utils/errors";

export class SubtitleRepository {
  async save(record: SubtitleRecord): Promise<void> {
    try {
      const { tx, stores } = await database.transaction("subtitles", "readwrite");
      stores.subtitles.put(record);
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

  async delete(id: string): Promise<void> {
    const { tx, stores } = await database.transaction(["subtitles", "videoRecords"], "readwrite");
    stores.subtitles.delete(id);

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

  async getSelectedForVideo(videoKey: string): Promise<SubtitleRecord | null> {
    const { tx, stores } = await database.transaction("videoRecords", "readonly");
    const req = stores.videoRecords.get(videoKey);
    await this.waitForTransaction(tx);
    const record = req.result as VideoRecord | undefined;
    if (!record?.selectedSubtitleId) return null;
    return this.getById(record.selectedSubtitleId);
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

  async saveVideoRecord(record: VideoRecord): Promise<void> {
    const { tx, stores } = await database.transaction("videoRecords", "readwrite");
    stores.videoRecords.put(record);
    await this.waitForTransaction(tx);
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
    const { tx, stores } = await database.transaction(["subtitles", "videoRecords"], "readwrite");
    stores.subtitles.clear();
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