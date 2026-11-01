import { describe, it, expect, beforeEach } from "vitest";
import { SettingsService, DEFAULT_SETTINGS } from "../../src/settings/settings-service";

describe("DEFAULT_SETTINGS", () => {
  it("包含所有必需字段", () => {
    expect(DEFAULT_SETTINGS.enabled).toBe(true);
    expect(Array.isArray(DEFAULT_SETTINGS.preferredLanguages)).toBe(true);
    expect(DEFAULT_SETTINGS.style).toBeDefined();
    expect(DEFAULT_SETTINGS.style.fontSize).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.sync.offsetMs).toBe(0);
    expect(DEFAULT_SETTINGS.cache.maxBytes).toBeGreaterThan(0);
  });
});

describe("SettingsService", () => {
  beforeEach(() => {
    // clear GM storage between tests
    const store = (globalThis as any).__gmStore;
    if (store) store.clear();
  });

  it("load 在无持久化时返回默认设置", async () => {
    const service = new SettingsService();
    const settings = await service.load();
    expect(settings.enabled).toBe(DEFAULT_SETTINGS.enabled);
    expect(settings.style.fontSize).toBe(DEFAULT_SETTINGS.style.fontSize);
  });

  it("save 后 load 返回保存的值", async () => {
    const service = new SettingsService();
    await service.save({ ...DEFAULT_SETTINGS, enabled: false });
    const loaded = await service.load();
    expect(loaded.enabled).toBe(false);
  });

  it("update 合并 patch 到当前设置", async () => {
    const service = new SettingsService();
    const result = await service.update({ enabled: false });
    expect(result.enabled).toBe(false);
    expect(result.style.fontSize).toBe(DEFAULT_SETTINGS.style.fontSize);
  });

  it("mergeDefaults 合并嵌套字段", async () => {
    const service = new SettingsService();
    const result = await service.update({ style: { ...DEFAULT_SETTINGS.style, fontSize: 48 } });
    expect(result.style.fontSize).toBe(48);
    expect(result.style.color).toBe(DEFAULT_SETTINGS.style.color);
  });

  it("新实例读取已保存的设置", async () => {
    const s1 = new SettingsService();
    await s1.save({ ...DEFAULT_SETTINGS, debug: true });

    const s2 = new SettingsService();
    const loaded = await s2.load();
    expect(loaded.debug).toBe(true);
  });

  it("缓存避免重复读取", async () => {
    const service = new SettingsService();
    const a = await service.load();
    const b = await service.load();
    expect(a).toBe(b);
  });
});
