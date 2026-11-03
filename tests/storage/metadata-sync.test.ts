import {beforeEach, describe, expect, it} from "vitest";
import type {SubtitleRecord, VideoRecord} from "../../src/storage/database";
import {database} from "../../src/storage/database";
import {subtitleRepository} from "../../src/storage/subtitle-repository";
import {buildSyncBucket, METADATA_SYNC_KEY, MetadataSyncService,} from "../../src/storage/metadata-sync";
import type {SubtitleSearchResult} from "../../src/providers/provider";

const ORIGIN_OLD = "115vod.com";
const ORIGIN_NEW = "115.com";
const VIDEO_KEY = "id:file-1|dur:7216";

function makeResult(over: Partial<SubtitleSearchResult> = {}): SubtitleSearchResult {
    return {
        providerId: "subtitlecat",
        sourceId: "source-1",
        title: "ABC-123.zh.srt",
        format: "srt",
        downloadUrl: "https://www.subtitlecat.com/subs/1/ABC-123.srt",
        matchScore: 48,
        matchReasons: ["番号完全匹配", "时长接近"],
        ...over,
    };
}

function makeRecord(over: Partial<SubtitleRecord> = {}): SubtitleRecord {
    return {
        id: "sub-1",
        videoKey: VIDEO_KEY,
        code: "ABC-123",
        providerId: "subtitlecat",
        sourceId: "source-1",
        title: "ABC-123.zh.srt",
        format: "srt",
        // fake-indexeddb 在 jsdom 下会把 Blob 克隆成 size=0 的对象；
        // 这里用带 size 的占位对象测试元数据构造，真实 Blob 的 size 另由 buildSyncBucket 测试覆盖。
        rawBlob: {size: 5} as unknown as Blob,
        encoding: "utf-8",
        cues: [{id: 0, startMs: 1000, endMs: 2000, text: "Hello", sourceOrder: 0}],
        cueCount: 1,
        checksum: "crc32:abc",
        createdAt: 1000,
        lastUsedAt: 2000,
        parserVersion: 1,
        sourceResult: makeResult(),
        ...over,
    };
}

function makeVideo(over: Partial<VideoRecord> = {}): VideoRecord {
    return {
        videoKey: VIDEO_KEY,
        code: "ABC-123",
        codeSource: "auto",
        selectedSubtitleId: "sub-1",
        subtitleEnabled: true,
        offsetMs: 0,
        lastPlayedAt: 1000,
        updatedAt: 1000,
        ...over,
    };
}

describe("MetadataSyncService", () => {
    beforeEach(async () => {
        (globalThis as unknown as { __gmStore: Map<string, unknown> }).__gmStore.clear();
        await database.close();
        await database.open();
        await subtitleRepository.clearAll();
    });

    it("把本地缓存元数据同步到另一个播放域名", async () => {
        await subtitleRepository.save(makeRecord());
        await subtitleRepository.saveVideoRecord(makeVideo());

        await new MetadataSyncService(ORIGIN_OLD).publish();

        const remote = new MetadataSyncService(ORIGIN_NEW).getRemoteForVideo(
            VIDEO_KEY,
            "file-1",
        );
        expect(remote.subtitles).toHaveLength(1);
        expect(remote.subtitles[0].title).toBe("ABC-123.zh.srt");
        expect(remote.subtitles[0].origin).toBe(ORIGIN_OLD);
        expect(remote.subtitles[0].size).toBe(5);
        expect(remote.selected?.id).toBe("sub-1");
        // 只同步重新下载所需字段，匹配说明等大字段不进入 GM 存储。
        expect(remote.subtitles[0].sourceResult?.downloadUrl).toContain("subtitlecat.com");
        expect(remote.subtitles[0].sourceResult?.matchScore).toBeUndefined();
        expect(remote.subtitles[0].sourceResult?.matchReasons).toBeUndefined();
    });

    it("两个域名各自 publish 不会覆盖对方的 bucket", async () => {
        await subtitleRepository.save(makeRecord());
        await subtitleRepository.saveVideoRecord(makeVideo());
        await new MetadataSyncService(ORIGIN_OLD).publish();

        await subtitleRepository.clearAll();
        await subtitleRepository.save(
            makeRecord({
                id: "sub-new",
                videoKey: "id:file-2|dur:100",
                title: "NEW-001.srt",
                sourceId: "source-2",
                sourceResult: makeResult({sourceId: "source-2", title: "NEW-001.srt"}),
            }),
        );
        await subtitleRepository.saveVideoRecord(
            makeVideo({videoKey: "id:file-2|dur:100", selectedSubtitleId: "sub-new"}),
        );
        await new MetadataSyncService(ORIGIN_NEW).publish();

        const oldRemote = new MetadataSyncService(ORIGIN_OLD).getRemoteForVideo(
            "id:file-2|dur:100",
            "file-2",
        );
        expect(oldRemote.selected?.id).toBe("sub-new");

        const newRemote = new MetadataSyncService(ORIGIN_NEW).getRemoteForVideo(
            VIDEO_KEY,
            "file-1",
        );
        expect(newRemote.selected?.id).toBe("sub-1");
    });

    it("videoKey 时长不同但文件 ID 相同时仍能匹配", async () => {
        await subtitleRepository.save(makeRecord({videoKey: "id:file-1|dur:100"}));
        await subtitleRepository.saveVideoRecord(
            makeVideo({videoKey: "id:file-1|dur:100"}),
        );
        await new MetadataSyncService(ORIGIN_OLD).publish();

        const remote = new MetadataSyncService(ORIGIN_NEW).getRemoteForVideo(
            "id:file-1|dur:101",
            "file-1",
        );
        expect(remote.selected?.id).toBe("sub-1");
    });

    it("不同文件 ID 不会误匹配", async () => {
        await subtitleRepository.save(makeRecord());
        await new MetadataSyncService(ORIGIN_OLD).publish();

        const remote = new MetadataSyncService(ORIGIN_NEW).getRemoteForVideo(
            "id:file-9|dur:7216",
            "file-9",
        );
        expect(remote.subtitles).toHaveLength(0);
        expect(remote.selected).toBeNull();
    });

    it("统计其他域名的缓存数量、大小和来源", async () => {
        await subtitleRepository.save(makeRecord());
        await new MetadataSyncService(ORIGIN_OLD).publish();

        expect(new MetadataSyncService(ORIGIN_NEW).getRemoteSummary()).toEqual({
            count: 1,
            bytes: 5,
            origins: [ORIGIN_OLD],
        });
    });

    it("构造同步快照时按最近使用排序并计算真实 Blob 大小", () => {
        const bucket = buildSyncBucket(
            [
                makeRecord({id: "old", lastUsedAt: 100, rawBlob: new Blob(["12"])}),
                makeRecord({id: "new", lastUsedAt: 200, rawBlob: new Blob(["12345"])}),
            ],
            [],
        );
        expect(bucket.subtitles.map((item) => item.id)).toEqual(["new", "old"]);
        expect(bucket.subtitles[0].size).toBe(5);
        expect(bucket.subtitles[1].size).toBe(2);
    });


    it("多个远程来源的选中项以视频记录 updatedAt 为准", async () => {
        await subtitleRepository.save(makeRecord({id: "sub-old"}));
        await subtitleRepository.saveVideoRecord(
            makeVideo({selectedSubtitleId: "sub-old", updatedAt: 1000}),
        );
        await new MetadataSyncService(ORIGIN_OLD).publish();

        await subtitleRepository.clearAll();
        await subtitleRepository.save(
            makeRecord({
                id: "sub-new",
                sourceId: "source-2",
                title: "NEW.srt",
                sourceResult: makeResult({sourceId: "source-2", title: "NEW.srt"}),
            }),
        );
        await subtitleRepository.saveVideoRecord(
            makeVideo({selectedSubtitleId: "sub-new", updatedAt: 5000}),
        );
        await new MetadataSyncService("115.com").publish();

        const remote = new MetadataSyncService("115disk.com").getRemoteForVideo(VIDEO_KEY, "file-1");
        expect(remote.selected?.id).toBe("sub-new");
    });

    it("清理远程索引只删除其他域名，不删除本地 bucket", async () => {
        await subtitleRepository.save(makeRecord());
        await new MetadataSyncService(ORIGIN_OLD).publish();
        await new MetadataSyncService(ORIGIN_NEW).publish();

        const service = new MetadataSyncService(ORIGIN_NEW);
        expect(service.clearRemoteOrigins()).toEqual([ORIGIN_OLD]);
        expect(service.getRemoteSummary()).toEqual({count: 0, bytes: 0, origins: []});

        // 本域名刚发布的 bucket 仍然存在，后续 publish 可继续维护。
        await service.publish();
        expect(new MetadataSyncService(ORIGIN_OLD).getRemoteSummary().count).toBe(1);
    });

    it("GM 数据损坏时忽略坏数据并允许重新 publish", async () => {
        GM_setValue(METADATA_SYNC_KEY, "not-an-object");
        const service = new MetadataSyncService(ORIGIN_NEW);
        expect(service.getRemoteForVideo(VIDEO_KEY, "file-1").subtitles).toHaveLength(0);

        await subtitleRepository.save(makeRecord());
        await service.publish();

        const remote = new MetadataSyncService(ORIGIN_OLD).getRemoteForVideo(
            VIDEO_KEY,
            "file-1",
        );
        expect(remote.subtitles).toHaveLength(1);
    });
});
