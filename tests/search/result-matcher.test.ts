import { describe, it, expect } from "vitest";
import { scoreResult, sortResults, deduplicateResults } from "../../src/search/result-matcher";
import type { SubtitleSearchResult, SubtitleSearchQuery } from "../../src/providers/provider";

function query(over: Partial<SubtitleSearchQuery> = {}): SubtitleSearchQuery {
  return {
    code: "ABC-123",
    normalizedCode: "ABC-123",
    languagePreferences: ["zh-CN", "en"],
    ...over,
  };
}

function result(over: Partial<SubtitleSearchResult> = {}): SubtitleSearchResult {
  return {
    providerId: "test",
    sourceId: "1",
    title: "ABC-123 subtitle",
    format: "srt",
    ...over,
  };
}

describe("scoreResult", () => {
  it("番号完全匹配得高分", () => {
    const { score, reasons } = scoreResult(result({ code: "ABC-123" }), query());
    expect(score).toBeGreaterThanOrEqual(40);
    expect(reasons).toContain("番号完全匹配");
  });

  it("番号不匹配扣分", () => {
    const { score, reasons } = scoreResult(result({ code: "XYZ-999" }), query());
    expect(score).toBeLessThan(40);
    expect(reasons).toContain("番号不匹配");
  });

  it("首选语言加分", () => {
    const { score, reasons } = scoreResult(
      result({ code: "ABC-123", language: "zh-CN" }),
      query(),
    );
    expect(reasons).toContain("首选语言");
    expect(score).toBeGreaterThan(40);
  });

  it("次选语言加分较少", () => {
    const { reasons } = scoreResult(
      result({ code: "ABC-123", language: "en" }),
      query(),
    );
    expect(reasons).toContain("次选语言");
  });

  it("时长接近加分", () => {
    const { score, reasons } = scoreResult(
      result({ code: "ABC-123", duration: 7200 }),
      query({ duration: 7200 }),
    );
    expect(reasons).toContain("时长接近");
    expect(score).toBeGreaterThan(40);
  });

  it("分数限制在 0-100 范围", () => {
    const { score } = scoreResult(
      result({ code: "ABC-123", language: "zh-CN", duration: 7200, rating: 10 }),
      query({ duration: 7200 }),
    );
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("缺失番号字段不扣分也不加分", () => {
    const { reasons } = scoreResult(result({ code: undefined }), query());
    expect(reasons).not.toContain("番号不匹配");
  });
});

describe("sortResults", () => {
  it("按 matchScore 降序排序", () => {
    const results = [
      result({ sourceId: "1", matchScore: 30 }),
      result({ sourceId: "2", matchScore: 90 }),
      result({ sourceId: "3", matchScore: 60 }),
    ];
    const sorted = sortResults(results);
    expect(sorted.map((r) => r.sourceId)).toEqual(["2", "3", "1"]);
  });

  it("不修改原数组", () => {
    const results = [result({ sourceId: "1", matchScore: 30 })];
    const sorted = sortResults(results);
    expect(sorted).not.toBe(results);
  });
});

describe("deduplicateResults", () => {
  it("按 providerId+sourceId 去重", () => {
    const results = [
      result({ providerId: "a", sourceId: "1", title: "first" }),
      result({ providerId: "a", sourceId: "1", title: "duplicate" }),
      result({ providerId: "b", sourceId: "1", title: "different provider" }),
    ];
    const deduped = deduplicateResults(results);
    expect(deduped).toHaveLength(2);
    expect(deduped[0].title).toBe("first");
    expect(deduped[1].title).toBe("different provider");
  });

  it("保留首次出现的结果", () => {
    const results = [
      result({ providerId: "a", sourceId: "1", title: "keep" }),
      result({ providerId: "a", sourceId: "1", title: "drop" }),
    ];
    const deduped = deduplicateResults(results);
    expect(deduped[0].title).toBe("keep");
  });
});