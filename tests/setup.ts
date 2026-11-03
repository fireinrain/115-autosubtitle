import "fake-indexeddb/auto";

const gmStore = new Map<string, unknown>();
// @ts-expect-error - expose for test cleanup
globalThis.__gmStore = gmStore;

// @ts-expect-error - global GM API mocks for tests
globalThis.GM_getValue = (key: string, defaultValue?: unknown) =>
  gmStore.has(key) ? gmStore.get(key) : defaultValue;
// @ts-expect-error - global GM API mock
globalThis.GM_setValue = (key: string, value: unknown) => {
  gmStore.set(key, value);
};
// @ts-expect-error - global GM API mock
globalThis.GM_deleteValue = (key: string) => {
  gmStore.delete(key);
};

// @ts-expect-error - global GM API mock
globalThis.GM_xmlhttpRequest = () => {
  throw new Error("GM_xmlhttpRequest not mocked in tests");
};