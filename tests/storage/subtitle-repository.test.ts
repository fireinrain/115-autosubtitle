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
      await subtitleRepository.clearAll();
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

    it("按来源查找已缓存字幕", async () => {
        await subtitleRepository.save(
            makeRecord({videoKey: "v-src", id: "src-1", providerId: "xunlei", sourceId: "cid-1"}),
        );
        await subtitleRepository.save(
            makeRecord({videoKey: "v-src", id: "src-2", providerId: "xunlei", sourceId: "cid-2"}),
        );

        const found = await subtitleRepository.findBySource("v-src", "xunlei", "cid-2");
        expect(found?.id).toBe("src-2");
        expect(await subtitleRepository.findBySource("v-src", "xunlei", "missing")).toBeNull();
        expect(await subtitleRepository.findBySource("v-src", "xunlei")).toBeNull();
    });

    it("按 checksum 查找同一视频的相同字幕", async () => {
        await subtitleRepository.save(
            makeRecord({videoKey: "v-sum", id: "sum-1", checksum: "crc32:111"}),
        );
        await subtitleRepository.save(
            makeRecord({videoKey: "v-sum", id: "sum-2", checksum: "crc32:222"}),
        );

        const found = await subtitleRepository.findByChecksum("v-sum", "crc32:222");
        expect(found?.id).toBe("sum-2");
        // 不同视频即使 checksum 相同也不能复用，避免串字幕。
        expect(await subtitleRepository.findByChecksum("v-other", "crc32:222")).toBeNull();
    });

    it("按番号去重时只保留最新的一份", async () => {
        await subtitleRepository.save(
            makeRecord({
                videoKey: "v-dup",
                id: "old",
                code: "abc-123",
                createdAt: 1000,
                lastUsedAt: 1000,
            }),
        );
        await subtitleRepository.save(
            makeRecord({
                videoKey: "v-dup",
                id: "new",
                code: " ABC-123 ",
                createdAt: 2000,
                lastUsedAt: 2000,
            }),
        );
        await subtitleRepository.save(
            makeRecord({videoKey: "v-dup", id: "other", code: "XYZ-999"}),
        );

        const result = await subtitleRepository.deduplicateByCode();
        expect(result).toEqual({removed: 1, kept: 2, groups: 1});
        expect(await subtitleRepository.getById("old")).toBeNull();
        expect(await subtitleRepository.getById("new")).not.toBeNull();
        expect(await subtitleRepository.getById("other")).not.toBeNull();
    });

    it("去重后把同一视频的选中引用重定向到保留记录", async () => {
        await subtitleRepository.save(
            makeRecord({
                videoKey: "v-remap",
                id: "old-sel",
                code: "ABC-123",
                createdAt: 1000,
                lastUsedAt: 1000,
            }),
        );
        await subtitleRepository.save(
            makeRecord({
                videoKey: "v-remap",
                id: "new-sel",
                code: "ABC-123",
                createdAt: 2000,
                lastUsedAt: 2000,
            }),
        );
        await subtitleRepository.setSelectedForVideo("v-remap", "old-sel");

        await subtitleRepository.deduplicateByCode();

        const selected = await subtitleRepository.getSelectedForVideo("v-remap");
        expect(selected?.id).toBe("new-sel");
    });

    it("保留记录属于其他视频时清除选中引用", async () => {
        await subtitleRepository.save(
            makeRecord({
                videoKey: "v-a",
                id: "sel-a",
                code: "ABC-123",
                createdAt: 1000,
                lastUsedAt: 1000,
            }),
        );
        await subtitleRepository.save(
            makeRecord({
                videoKey: "v-b",
                id: "sel-b",
                code: "ABC-123",
                createdAt: 2000,
                lastUsedAt: 2000,
            }),
        );
        await subtitleRepository.setSelectedForVideo("v-a", "sel-a");

        await subtitleRepository.deduplicateByCode();

        // 不能把 v-b 的字幕挂到 v-a 上，否则播放 v-a 会串字幕。
        expect(await subtitleRepository.getSelectedForVideo("v-a")).toBeNull();
        expect(await subtitleRepository.getById("sel-b")).not.toBeNull();
    });

    it("没有番号的记录不参与去重", async () => {
        await subtitleRepository.save(makeRecord({id: "empty-1", code: ""}));
        await subtitleRepository.save(makeRecord({id: "empty-2", code: ""}));

        const result = await subtitleRepository.deduplicateByCode();
        expect(result.removed).toBe(0);
        expect(await subtitleRepository.getById("empty-1")).not.toBeNull();
        expect(await subtitleRepository.getById("empty-2")).not.toBeNull();
    });

    it("使用新字幕后替换同番号的旧缓存", async () => {
        await subtitleRepository.save(
            makeRecord({videoKey: "v-a", id: "old-a", code: "abc-123", createdAt: 1000}),
        );
        await subtitleRepository.save(
            makeRecord({videoKey: "v-a", id: "new-a", code: " ABC-123 ", createdAt: 2000}),
        );
        await subtitleRepository.save(
            makeRecord({videoKey: "v-b", id: "old-b", code: "ABC-123", createdAt: 1500}),
        );
        await subtitleRepository.save(makeRecord({videoKey: "v-c", id: "other", code: "XYZ-999"}));
        await subtitleRepository.setSelectedForVideo("v-a", "old-a");
        await subtitleRepository.setSelectedForVideo("v-b", "old-b");

        const result = await subtitleRepository.replaceByCode("abc-123", "new-a");

        expect(result.removed).toBe(2);
        expect(await subtitleRepository.getById("old-a")).toBeNull();
        expect(await subtitleRepository.getById("old-b")).toBeNull();
        expect(await subtitleRepository.getById("new-a")).not.toBeNull();
        expect(await subtitleRepository.getById("other")).not.toBeNull();
        // 同一视频的选中引用重定向到新字幕；其他视频不能挂载不属于它的字幕。
        expect((await subtitleRepository.getSelectedForVideo("v-a"))?.id).toBe("new-a");
        expect(await subtitleRepository.getSelectedForVideo("v-b")).toBeNull();
    });

    it("替换时保留项不存在或无番号则不删除任何记录", async () => {
        await subtitleRepository.save(makeRecord({id: "keep-test", code: "ABC-123"}));
        await subtitleRepository.save(makeRecord({id: "no-code", code: ""}));

        expect((await subtitleRepository.replaceByCode("ABC-123", "missing")).removed).toBe(0);
        expect((await subtitleRepository.replaceByCode("", "keep-test")).removed).toBe(0);
        expect(await subtitleRepository.getById("keep-test")).not.toBeNull();
        expect(await subtitleRepository.getById("no-code")).not.toBeNull();
    });
});