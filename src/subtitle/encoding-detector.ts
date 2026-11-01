const BOM_UTF8 = [0xef, 0xbb, 0xbf];
const BOM_UTF16_LE = [0xff, 0xfe];
const BOM_UTF16_BE = [0xfe, 0xff];

export interface EncodingDetector {
  detect(bytes: ArrayBuffer): string;
  decode(bytes: ArrayBuffer, encoding?: string): string;
}

class DefaultEncodingDetector implements EncodingDetector {
  detect(bytes: ArrayBuffer): string {
    const view = new Uint8Array(bytes);
    if (view.length >= 3 && view[0] === BOM_UTF8[0] && view[1] === BOM_UTF8[1] && view[2] === BOM_UTF8[2]) {
      return "utf-8";
    }
    if (view.length >= 2 && view[0] === BOM_UTF16_LE[0] && view[1] === BOM_UTF16_LE[1]) {
      return "utf-16le";
    }
    if (view.length >= 2 && view[0] === BOM_UTF16_BE[0] && view[1] === BOM_UTF16_BE[1]) {
      return "utf-16be";
    }
    if (looksLikeUtf8(view)) {
      return "utf-8";
    }
    return "gb18030";
  }

  decode(bytes: ArrayBuffer, encoding?: string): string {
    const enc = encoding ?? this.detect(bytes);
    if (enc === "utf-8") {
      const view = new Uint8Array(bytes);
      const hasBom = view.length >= 3 && view[0] === BOM_UTF8[0] && view[1] === BOM_UTF8[1] && view[2] === BOM_UTF8[2];
      const slice = hasBom ? bytes.slice(3) : bytes;
      return new TextDecoder("utf-8").decode(slice);
    }
    if (enc === "utf-16le" || enc === "utf-16be") {
      return new TextDecoder(enc).decode(bytes.slice(2));
    }
    if (enc === "gb18030" || enc === "gbk") {
      try {
        return new TextDecoder("gb18030").decode(bytes);
      } catch {
        return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      }
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

function looksLikeUtf8(view: Uint8Array): boolean {
  let i = 0;
  const len = Math.min(view.length, 8192);
  while (i < len) {
    const b = view[i];
    if (b < 0x80) {
      i++;
      continue;
    }
    let extra: number;
    if ((b & 0xe0) === 0xc0) extra = 1;
    else if ((b & 0xf0) === 0xe0) extra = 2;
    else if ((b & 0xf8) === 0xf0) extra = 3;
    else return false;
    if (i + extra >= len) break;
    for (let j = 1; j <= extra; j++) {
      if ((view[i + j] & 0xc0) !== 0x80) return false;
    }
    i += extra + 1;
  }
  return true;
}

export const encodingDetector: EncodingDetector = new DefaultEncodingDetector();