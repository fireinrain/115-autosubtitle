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

      // 开发模式（vite-plugin-monkey 的 dev 加载器）把脚本注入页面上下文，
      // 此时没有 GM_xmlhttpRequest，所有跨域请求都会在调用处直接抛 ReferenceError。
      // 两个 Provider 的目标站点都不返回 CORS 头，fetch 兜底不可行，只能明确报错。
      if (typeof GM_xmlhttpRequest !== "function") {
          return Promise.reject(
              new SubtitleError(
                  "NETWORK_UNAVAILABLE",
                  "当前环境没有 GM_xmlhttpRequest，无法跨域请求字幕来源",
              ),
          );
      }

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