/**
 * 小型键值存储适配层。
 *
 * 生产环境（Tampermonkey 沙箱）优先使用 GM 存储。
 * 开发模式下 vite-plugin-monkey 把入口注入页面上下文，`GM_setValue` /
 * `GM_getValue` 并不存在（实测 ReferenceError），这里退回到 localStorage，
 * 仅用于本地调试；不会改变生产环境的存储位置。
 */
const FALLBACK_PREFIX = "115-subtitle-assistant:";

function gmAvailable(): boolean {
  return typeof GM_getValue === "function" && typeof GM_setValue === "function";
}

export function isGmStorageAvailable(): boolean {
  return gmAvailable();
}

export function readStoredValue<T>(key: string, fallback: T): T {
  if (gmAvailable()) {
    try {
      return GM_getValue(key, fallback) as T;
    } catch {
      return fallback;
    }
  }

  try {
    const raw = localStorage.getItem(FALLBACK_PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeStoredValue(key: string, value: unknown): void {
  if (gmAvailable()) {
    GM_setValue(key, value);
    return;
  }
  localStorage.setItem(FALLBACK_PREFIX + key, JSON.stringify(value));
}
