import { describe, it, expect, beforeEach } from "vitest";
import { subtitleRepository } from "../../src/storage/subtitle-repository";
import { database } from "../../src/storage/database";
import type { SubtitleRecord } from "../../src/storage/database";

function makeRecord(over: Partial<SubtitleRecord> = {}): SubtitleRecord {
  return {
    id: "sub-" + Math.random().toString(36).slice(2, 9),
    videoKey: "video-key-1",
    code: "ABC-123",
    providerId: "local",
    title: "test.srt",
    format: "srt",
    rawBlob: new Blob(["1\n00:00:01,000 --> 00:00:02,000\nHello"]),
    encoding: "utf-8",
    cues: [{ id: 0, startMs: 1000, endMs: 2000, text: "Hello", sourceOrder: 0 }],
    cueCount: 1,
    checksum: "crc32:abc",
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    parserVersion: 1,
    isFavorite: false,
    ...over,
  };
}

describe("SubtitleRepository", () => {
  beforeEach(async () => {
    await database.close();
    await database.open();
  });

  it("保存和读取字幕记录", async () => {
    const record = makeRecord();
    await subtitleRepository.save(record);
    const got = await subtitleRepository.getById(record.id);
    expect(got).not.toBeNull();
    expect(got?.title).toBe("test.srt");
    expect(got?.cues).toHaveLength(1);
  });

  it("按 videoKey 查询", async () => {
    await subtitleRepository.save(makeRecord({ videoKey: "v1", id: "a" }));
    await subtitleRepository.save(makeRecord({ videoKey: "v1", id: "b" }));
    await subtitleRepository.save(makeRecord({ videoKey: "v2", id: "c" }));

    const v1 = await subtitleRepository.getByVideoKey("v1");
    expect(v1).toHaveLength(2);
    const v2 = await subtitleRepository.getByVideoKey("v2");
    expect(v2).toHaveLength(1);
  });

  it("设置和读取视频选中字幕", async () => {
    const record = makeRecord({ videoKey: "v-sel", id: "sel-1" });
    await subtitleRepository.save(record);
    await subtitleRepository.setSelectedForVideo("v-sel", "sel-1");

    const selected = await subtitleRepository.getSelectedForVideo("v-sel");
    expect(selected).not.toBeNull();
    expect(selected?.id).toBe("sel-1");
  });

  it("删除字幕记录", async () => {
    const record = makeRecord({ id: "del-1" });
    await subtitleRepository.save(record);
    await subtitleRepository.delete("del-1");
    const got = await subtitleRepository.getById("del-1");
    expect(got).toBeNull();
  });

  it("删除被选中字幕时清除选中引用", async () => {
    const record = makeRecord({ videoKey: "v-del", id: "del-sel" });
    await subtitleRepository.save(record);
    await subtitleRepository.setSelectedForVideo("v-del", "del-sel");
    await subtitleRepository.delete("del-sel");

    const selected = await subtitleRepository.getSelectedForVideo("v-del");
    expect(selected).toBeNull();
  });

  it("未找到选中字幕时返回 null", async () => {
    const selected = await subtitleRepository.getSelectedForVideo("nonexistent");
    expect(selected).toBeNull();
  });
});