import type {SubtitleRecord} from "./database";
import {isFiniteNumber} from "../utils/number";

/**
 * 极简 ZIP 打包（浏览器原生 deflate-raw，环境不支持时退回 store）。
 *
 * 不引入 JSZip 之类依赖可以避免额外包体积和供应链风险。
 * ZIP 结构参考 PKWARE APPNOTE：本地文件头 + 文件数据 + 中央目录 + EOCD。
 */

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let bit = 0; bit < 8; bit++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[i] = c >>> 0;
    }
    return table;
})();

export function crc32(data: Uint8Array): number {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
        crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
    name: string;
    data: Uint8Array;
    payload: Uint8Array;
    crc: number;
    method: 0 | 8;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
    if (typeof CompressionStream === "undefined") return null;
    try {
        return await transformBytes(new CompressionStream("deflate-raw"), data);
    } catch {
        // 部分浏览器不支持 deflate-raw，退回 store 模式，ZIP 仍然合法。
        return null;
    }
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
    if (typeof DecompressionStream === "undefined") {
        throw new Error("DecompressionStream unavailable");
    }
    return transformBytes(new DecompressionStream("deflate-raw"), data);
}

async function transformBytes(
    stream: CompressionStream | DecompressionStream,
    data: Uint8Array,
): Promise<Uint8Array> {
    const reader = stream.readable.getReader();
    const writer = stream.writable.getWriter();

    // 必须先开始读取再写入：字幕文件可能有几百 KB，只写不读会触发背压死锁。
    const readPromise = (async () => {
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (; ;) {
            const {done, value} = await reader.read();
            if (done) break;
            chunks.push(value);
            total += value.length;
        }
        const output = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            output.set(chunk, offset);
            offset += chunk.length;
        }
        return output;
    })();

    await writer.write(data as unknown as BufferSource);
    await writer.close();
    return readPromise;
}

function sanitizeFileName(name: string): string {
    // 只取文件名部分，避免 `../` 之类的路径穿越；再替换 Windows 不允许的字符。
    const base = name.split(/[\\/]/).pop() ?? name;
    const cleaned = base
        // eslint-disable-next-line no-control-regex -- 文件名里的控制字符必须替换
        .replace(/[\u0000-\u001f<>:"|?*]/g, "_")
        .replace(/\s+/g, " ")
        .trim();
    return cleaned || "subtitle";
}

function ensureExtension(name: string, record: SubtitleRecord): string {
    if (/\.[a-z0-9]{1,5}$/i.test(name)) return name;
    const extension = record.format === "unknown" ? "srt" : record.format;
    return `${name}.${extension}`;
}

function makeUniqueName(base: string, used: Set<string>): string {
    if (!used.has(base.toLowerCase())) {
        used.add(base.toLowerCase());
        return base;
    }
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    let index = 2;
    let candidate = `${stem} (${index})${ext}`;
    while (used.has(candidate.toLowerCase())) {
        index++;
        candidate = `${stem} (${index})${ext}`;
    }
    used.add(candidate.toLowerCase());
    return candidate;
}

function dosDateTime(timestamp: number): { time: number; date: number } {
    const date = new Date(isFiniteNumber(timestamp) ? timestamp : Date.now());
    const year = Math.max(1980, date.getFullYear());
    return {
        time:
            (date.getHours() << 11) |
            (date.getMinutes() << 5) |
            Math.floor(date.getSeconds() / 2),
        date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
}

function localHeader(entry: ZipEntry, time: number, date: number): Uint8Array {
    const nameBytes = new TextEncoder().encode(entry.name);
    const buf = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(buf.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true); // version needed
    // bit 11：文件名为 UTF-8，避免中文标题在 Windows 资源管理器中乱码。
    view.setUint16(6, 0x0800, true);
    view.setUint16(8, entry.method, true);
    view.setUint16(10, time, true);
    view.setUint16(12, date, true);
    view.setUint32(14, entry.crc, true);
    view.setUint32(18, entry.payload.length, true);
    view.setUint32(22, entry.data.length, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);
    buf.set(nameBytes, 30);
    return buf;
}

function centralHeader(
    entry: ZipEntry,
    offset: number,
    time: number,
    date: number,
): Uint8Array {
    const nameBytes = new TextEncoder().encode(entry.name);
    const buf = new Uint8Array(46 + nameBytes.length);
    const view = new DataView(buf.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true); // version made by
    view.setUint16(6, 20, true); // version needed
    view.setUint16(8, 0x0800, true);
    view.setUint16(10, entry.method, true);
    view.setUint16(12, time, true);
    view.setUint16(14, date, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.payload.length, true);
    view.setUint32(24, entry.data.length, true);
    view.setUint16(28, nameBytes.length, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, offset, true);
    buf.set(nameBytes, 46);
    return buf;
}

function endOfCentralDirectory(
    count: number,
    cdSize: number,
    cdOffset: number,
): Uint8Array {
    const buf = new Uint8Array(22);
    const view = new DataView(buf.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(4, 0, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, count, true);
    view.setUint16(10, count, true);
    view.setUint32(12, cdSize, true);
    view.setUint32(16, cdOffset, true);
    view.setUint16(20, 0, true);
    return buf;
}

export async function buildSubtitleZip(records: SubtitleRecord[]): Promise<Blob> {
    const usedNames = new Set<string>();
    const entries: ZipEntry[] = [];

    for (const record of records) {
        const name = makeUniqueName(
            ensureExtension(sanitizeFileName(record.title), record),
            usedNames,
        );
        const data = new Uint8Array(await record.rawBlob.arrayBuffer());
        const compressed = await deflateRaw(data);
        entries.push({
            name,
            data,
            payload: compressed ?? data,
            crc: crc32(data),
            method: compressed ? 8 : 0,
        });
    }

    const chunks: BlobPart[] = [];
    const centralChunks: Uint8Array[] = [];
    let offset = 0;

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const source = records[i];
        const {time, date} = dosDateTime(
            source ? Math.max(source.createdAt ?? 0, source.lastUsedAt ?? 0) : Date.now(),
        );
        const local = localHeader(entry, time, date);
        chunks.push(local.buffer as ArrayBuffer, entry.payload.buffer as ArrayBuffer);
        centralChunks.push(centralHeader(entry, offset, time, date));
        offset += local.length + entry.payload.length;
    }

    const cdOffset = offset;
    const cdSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const eocd = endOfCentralDirectory(entries.length, cdSize, cdOffset);

    for (const chunk of centralChunks) chunks.push(chunk.buffer as ArrayBuffer);
    chunks.push(eocd.buffer as ArrayBuffer);

    return new Blob(chunks, {type: "application/zip"});
}

export interface ZipFileEntry {
    name: string;
    data: Uint8Array;
}

/**
 * 仅供测试：读取中央目录，返回文件名和对应数据。
 * 生产环境不需要解压，保留一个最小解析器便于验证生成的 ZIP 结构。
 */
export async function readZipEntries(buffer: ArrayBuffer): Promise<ZipFileEntry[]> {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);

    let eocdOffset = -1;
    for (let i = bytes.length - 22; i >= 0; i--) {
        if (view.getUint32(i, true) === 0x06054b50) {
            eocdOffset = i;
            break;
        }
    }
    if (eocdOffset < 0) throw new Error("ZIP EOCD not found");

    const count = view.getUint16(eocdOffset + 10, true);
    const cdOffset = view.getUint32(eocdOffset + 16, true);
    const entries: ZipFileEntry[] = [];
    let cursor = cdOffset;

    for (let i = 0; i < count; i++) {
        if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error("Bad central header");
        const method = view.getUint16(cursor + 10, true);
        const nameLength = view.getUint16(cursor + 28, true);
        const extraLength = view.getUint16(cursor + 30, true);
        const commentLength = view.getUint16(cursor + 32, true);
        const localOffset = view.getUint32(cursor + 42, true);
        const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));

        const localNameLength = view.getUint16(localOffset + 26, true);
        const localExtraLength = view.getUint16(localOffset + 28, true);
        const storedSize = view.getUint32(localOffset + 18, true);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const stored = bytes.slice(dataStart, dataStart + storedSize);
        const data = method === 8 ? await inflateRaw(stored) : stored;

        entries.push({name, data});
        cursor += 46 + nameLength + extraLength + commentLength;
    }

    return entries;
}
