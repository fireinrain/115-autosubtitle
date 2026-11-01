import { SubtitleError } from "../utils/errors";
import { logger } from "../utils/logger";

export interface GmRequestOptions {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  data?: string | ArrayBuffer;
  responseType?: "text" | "arraybuffer" | "json";
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBytes?: number;
}

export interface GmResponse<T = string | ArrayBuffer> {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: T;
  finalUrl: string;
}

export class GmRequestClient {
  async request<T = string>(options: GmRequestOptions): Promise<GmResponse<T>> {
    const {
      url,
      method = "GET",
      headers,
      data,
      responseType = "text",
      timeoutMs = 15000,
      signal,
      maxBytes,
    } = options;

    return new Promise<GmResponse<T>>((resolve, reject) => {
      const handle = GM_xmlhttpRequest({
        method,
        url,
        headers,
        data,
        responseType,
        timeout: timeoutMs,
        onload: (resp) => {
          if (resp.status < 200 || resp.status >= 300) {
            reject(
              new SubtitleError(
                "PROVIDER_BAD_RESPONSE",
                `HTTP ${resp.status} ${resp.statusText}`,
              ),
            );
            return;
          }
          const body = resp.response as T;
          if (maxBytes && typeof body === "string" && body.length > maxBytes) {
            reject(new SubtitleError("FILE_TOO_LARGE", "响应体超过最大限制"));
            return;
          }
          if (maxBytes && body instanceof ArrayBuffer && body.byteLength > maxBytes) {
            reject(new SubtitleError("FILE_TOO_LARGE", "响应体超过最大限制"));
            return;
          }
          resolve({
            status: resp.status,
            statusText: resp.statusText,
            headers: resp.responseHeaders ? this.parseHeaders(resp.responseHeaders) : {},
            body,
            finalUrl: resp.finalUrl ?? url,
          });
        },
        onerror: () => {
          reject(new SubtitleError("PROVIDER_NETWORK_ERROR", "网络请求失败"));
        },
        ontimeout: () => {
          reject(new SubtitleError("PROVIDER_TIMEOUT", "请求超时"));
        },
      });

      if (signal) {
        if (signal.aborted) {
          handle.abort();
          reject(new SubtitleError("PROVIDER_TIMEOUT", "请求已取消"));
          return;
        }
        signal.addEventListener("abort", () => {
          try {
            handle.abort();
          } catch (e) {
            logger.debug("abort failed", e);
          }
          reject(new SubtitleError("PROVIDER_TIMEOUT", "请求已取消"));
        });
      }
    });
  }

  private parseHeaders(raw: string): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx > 0) {
        headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
    }
    return headers;
  }
}

export const gmRequestClient = new GmRequestClient();