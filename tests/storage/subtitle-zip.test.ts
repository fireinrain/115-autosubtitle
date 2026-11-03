import {describe, expect, it} from "vitest";
import {buildSubtitleZip, crc32, readZipEntries} from "../../src/storage/subtitle-zip";
import type {SubtitleRecord} from "../../src/storage/database";

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
        cues: [{id: 0, startMs: 1000, endMs: 2000, text: "Hello", sourceOrder: 0}],
        cueCount: 1,
        checksum: "crc32:abc",
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        parserVersion: 1,
        ...over,
    };
}

describe("crc32", () => {
    it("匹配标准 CRC-32 测试向量", () => {
        expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
        expect(crc32(new Uint8Array())).toBe(0);
    });
});

describe("buildSubtitleZip", () => {
    it("把每条字幕写入 ZIP，并保留原始内容", async () => {
        const one = makeRecord({title: "第一集.srt", rawBlob: new Blob(["first"])});
        const two = makeRecord({title: "第二集.srt", rawBlob: new Blob(["second"])});

        const blob = await buildSubtitleZip([one, two]);
        const entries = await readZipEntries(await blob.arrayBuffer());

        expect(entries.map((entry) => entry.name)).toEqual(["第一集.srt", "第二集.srt"]);
        expect(new TextDecoder().decode(entries[0].data)).toBe("first");
        expect(new TextDecoder().decode(entries[1].data)).toBe("second");
    });

    it("重名文件自动加序号", async () => {
        const blob = await buildSubtitleZip([
            makeRecord({title: "same.srt", rawBlob: new Blob(["a"])}),
            makeRecord({title: "same.srt", rawBlob: new Blob(["b"])}),
        ]);
        const entries = await readZipEntries(await blob.arrayBuffer());

        expect(entries.map((entry) => entry.name)).toEqual(["same.srt", "same (2).srt"]);
        expect(new TextDecoder().decode(entries[1].data)).toBe("b");
    });

    it("标题没有扩展名时按字幕格式补上", async () => {
        const blob = await buildSubtitleZip([
            makeRecord({title: "无扩展名", format: "ass"}),
        ]);
        const entries = await readZipEntries(await blob.arrayBuffer());
        expect(entries[0].name).toBe("无扩展名.ass");
    });

    it("过滤路径分隔符，避免 ZIP 内出现目录穿越", async () => {
        const blob = await buildSubtitleZip([
            makeRecord({title: "../../evil.srt"}),
        ]);
        const entries = await readZipEntries(await blob.arrayBuffer());
        expect(entries[0].name).toBe("evil.srt");
    });

    it("空列表生成合法 ZIP", async () => {
        const blob = await buildSubtitleZip([]);
        const entries = await readZipEntries(await blob.arrayBuffer());
        expect(entries).toEqual([]);
    });

    it("支持 deflate 压缩，并仍能还原原文", async () => {
        if (typeof CompressionStream === "undefined") return;
        const text = "字幕内容".repeat(5000);
        const blob = await buildSubtitleZip([
            makeRecord({title: "big.srt", rawBlob: new Blob([text])}),
        ]);
        const raw = await blob.arrayBuffer();
        const method = new DataView(raw).getUint16(8, true);
        expect(method).toBe(8);
        expect(blob.size).toBeLessThan(text.length);

        const entries = await readZipEntries(raw);
        expect(new TextDecoder().decode(entries[0].data)).toBe(text);
    });
});
