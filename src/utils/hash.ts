export async function computeChecksum(bytes: ArrayBuffer): Promise<string> {
  const data = new Uint8Array(bytes);
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    hash = (hash * 31 + data[i]) | 0;
  }
  return `crc32:${hash.toString(16)}`;
}

export function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}