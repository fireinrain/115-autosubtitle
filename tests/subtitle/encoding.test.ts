import { describe, it, expect } from "vitest";
import { encodingDetector } from "../../src/subtitle/encoding-detector";

describe("encodingDetector", () => {
  it("检测 UTF-8 BOM", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x48, 0x69]);
    expect(encodingDetector.detect(bytes.buffer)).toBe("utf-8");
  });

  it("检测 UTF-16 LE BOM", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x48, 0x00]);
    expect(encodingDetector.detect(bytes.buffer)).toBe("utf-16le");
  });

  it("检测 UTF-16 BE BOM", () => {
    const bytes = new Uint8Array([0xfe, 0xff, 0x00, 0x48]);
    expect(encodingDetector.detect(bytes.buffer)).toBe("utf-16be");
  });

  it("纯 ASCII 识别为 utf-8", () => {
    const bytes = new TextEncoder().encode("Hello world");
    expect(encodingDetector.detect(bytes.buffer)).toBe("utf-8");
  });

  it("解码 UTF-8 BOM 时跳过 BOM", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x48, 0x69]);
    expect(encodingDetector.decode(bytes.buffer)).toBe("Hi");
  });

  it("解码 UTF-16 LE", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00]);
    expect(encodingDetector.decode(bytes.buffer)).toBe("Hi");
  });

  it("显式指定 encoding 时使用该编码", () => {
    const bytes = new TextEncoder().encode("Hello");
    expect(encodingDetector.decode(bytes.buffer, "utf-8")).toBe("Hello");
  });

  it("中文 UTF-8 编码正确识别", () => {
    const text = "你好世界";
    const bytes = new TextEncoder().encode(text);
    expect(encodingDetector.detect(bytes.buffer)).toBe("utf-8");
    expect(encodingDetector.decode(bytes.buffer)).toBe(text);
  });

  it("空字节数组不崩溃", () => {
    const bytes = new Uint8Array([]);
    expect(encodingDetector.decode(bytes.buffer)).toBe("");
  });
});