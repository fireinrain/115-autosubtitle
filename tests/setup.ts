import "fake-indexeddb/auto";

const gmStore = new Map<string, unknown>();
// @ts-ignore - expose for test cleanup
globalThis.__gmStore = gmStore;

// @ts-ignore - global GM API mocks for tests
globalThis.GM_getValue = (key: string, defaultValue?: unknown) =>
  gmStore.has(key) ? gmStore.get(key) : defaultValue;
// @ts-ignore
globalThis.GM_setValue = (key: string, value: unknown) => {
  gmStore.set(key, value);
};
// @ts-ignore
globalThis.GM_deleteValue = (key: string) => {
  gmStore.delete(key);
};

// @ts-ignore
globalThis.GM_xmlhttpRequest = () => {
  throw new Error("GM_xmlhttpRequest not mocked in tests");
};