import { describe, it, expect, vi, afterEach } from "vitest";
import { debounce, throttle } from "../../src/utils/debounce";
import { isFiniteNumber } from "../../src/utils/number";

describe("isFiniteNumber", () => {
  it("识别有限数字", () => {
    expect(isFiniteNumber(0)).toBe(true);
    expect(isFiniteNumber(-1.5)).toBe(true);
  });

  it("拒绝非有限值与非法输入", () => {
    expect(isFiniteNumber(NaN)).toBe(false);
    expect(isFiniteNumber(Infinity)).toBe(false);
    expect(isFiniteNumber(-Infinity)).toBe(false);
    expect(isFiniteNumber("1")).toBe(false);
    expect(isFiniteNumber(undefined)).toBe(false);
  });

  it("不依赖被页面删除的 Number.isFinite", () => {
    const original = Number.isFinite;
    // 115 播放页会删除 Number.isFinite，这里模拟该环境。
    // @ts-expect-error 故意覆写为 undefined
    Number.isFinite = undefined;
    try {
      expect(isFiniteNumber(7200)).toBe(true);
      expect(isFiniteNumber(NaN)).toBe(false);
    } finally {
      Number.isFinite = original;
    }
  });
});

describe("throttle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("高频触发时仍按间隔执行，不会被持续触发饿死", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const throttled = throttle(fn, 400);

    // 首次调用立即执行
    throttled();
    expect(fn).toHaveBeenCalledTimes(1);

    // 模拟每 50ms 一次的高频 DOM 变更
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(50);
      throttled();
    }

    // 1s 内至少执行过 2 次（debounce 在同场景下只会执行 0 次）
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("debounce", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("在静默期后只执行一次", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);
    debounced();
    debounced();
    debounced();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
