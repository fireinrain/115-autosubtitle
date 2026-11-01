import { describe, it, expect, beforeEach } from "vitest";
import { SubtitleTimelineEngine } from "../../src/subtitle/timeline-engine";
import type { SubtitleCue } from "../../src/subtitle/subtitle-model";

function makeCue(id: number, startMs: number, endMs: number, text = `cue-${id}`): SubtitleCue {
  return { id, startMs, endMs, text, sourceOrder: id };
}

describe("SubtitleTimelineEngine", () => {
  let engine: SubtitleTimelineEngine;

  beforeEach(() => {
    engine = new SubtitleTimelineEngine();
  });

  it("空字幕列表返回空", () => {
    engine.load([]);
    expect(engine.update(1.0)).toEqual([]);
  });

  it("返回开始边界和结束边界内的活动 Cue", () => {
    engine.load([makeCue(0, 1000, 4000)]);
    expect(engine.update(1.0)).toHaveLength(1);
    expect(engine.update(3.999)).toHaveLength(1);
    expect(engine.update(0.999)).toHaveLength(0);
    expect(engine.update(4.0)).toHaveLength(0);
  });

  it("支持多个 Cue，返回当前时间活动的所有 Cue", () => {
    engine.load([
      makeCue(0, 0, 2000),
      makeCue(1, 1500, 3000),
      makeCue(2, 4000, 5000),
    ]);
    expect(engine.update(1.0)).toHaveLength(1);
    expect(engine.update(1.6)).toHaveLength(2);
    expect(engine.update(2.5)).toHaveLength(1);
    expect(engine.update(4.5)).toHaveLength(1);
  });

  it("按 sourceOrder 排序返回结果", () => {
    engine.load([
      makeCue(2, 1000, 5000, "second"),
      makeCue(0, 1000, 5000, "first"),
      makeCue(1, 1000, 5000, "middle"),
    ]);
    const cues = engine.update(2.0);
    expect(cues.map((c) => c.text)).toEqual(["first", "middle", "second"]);
  });

  it("offset 正值使字幕延后显示", () => {
    engine.load([makeCue(0, 5000, 8000)]);
    engine.setOffset(2000);
    expect(engine.update(5.0)).toHaveLength(0);
    expect(engine.update(7.0)).toHaveLength(1);
    expect(engine.update(10.0)).toHaveLength(0);
  });

  it("offset 负值使字幕提前显示", () => {
    engine.load([makeCue(0, 5000, 8000)]);
    engine.setOffset(-2000);
    expect(engine.update(3.0)).toHaveLength(1);
    expect(engine.update(5.9)).toHaveLength(1);
    expect(engine.update(6.0)).toHaveLength(0);
  });

  it("非法时间返回空", () => {
    engine.load([makeCue(0, 0, 5000)]);
    expect(engine.update(-1)).toEqual([]);
    expect(engine.update(NaN)).toEqual([]);
    expect(engine.update(Infinity)).toEqual([]);
  });

  it("clear 后返回空", () => {
    engine.load([makeCue(0, 0, 5000)]);
    engine.clear();
    expect(engine.update(1.0)).toEqual([]);
  });

  it("dispose 后返回空", () => {
    engine.load([makeCue(0, 0, 5000)]);
    engine.dispose();
    expect(engine.update(1.0)).toEqual([]);
  });

  it("重叠 Cue 正确处理", () => {
    engine.load([
      makeCue(0, 0, 10000),
      makeCue(1, 5000, 15000),
      makeCue(2, 8000, 12000),
    ]);
    expect(engine.update(6.0)).toHaveLength(2);
    expect(engine.update(9.0)).toHaveLength(3);
    expect(engine.update(11.0)).toHaveLength(2);
  });

  it("前面的长 Cue 不会被后面的短 Cue 截断", () => {
    // 实测场景：整段 0-2h 的说明字幕 + 中间几秒的短字幕，
    // 旧实现用 endMs <= t 直接 break，会漏掉长 Cue。
    engine.load([
      makeCue(0, 0, 7_200_000, "long"),
      makeCue(1, 5_000, 8_000, "short"),
    ]);
    expect(engine.update(6.0).map((c) => c.text)).toEqual(["long", "short"]);
    expect(engine.update(7_000).map((c) => c.text)).toEqual(["long"]);
  });

  it("大量已结束 Cue 之后仍能命中跨度的长 Cue", () => {
    const cues: SubtitleCue[] = [makeCue(0, 0, 600_000, "long")];
    for (let i = 0; i < 500; i++) {
      const start = i * 1000;
      cues.push(makeCue(i + 1, start, start + 500));
    }
    engine.load(cues);
    expect(engine.update(599).map((c) => c.text)).toContain("long");
  });
});