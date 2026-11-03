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
    /** 允许的最终响应域名；用于校验重定向目标，避免被跳转到未授权 host。 */
    allowedHosts?: string[];
    /** 失败重试次数（仅网络错误/5xx；默认 0）。 */
    retry?: number;
}

export interface GmResponse<T = string | ArrayBuffer> {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: T;
  finalUrl: string;
}

const MAX_CONCURRENT_REQUESTS = 3;
const MIN_HOST_INTERVAL_MS = 250;

export class GmRequestClient {
    private activeRequests = 0;
    private hostNextAllowedAt = new Map<string, number>();
    private waiters: Array<() => void> = [];

  async request<T = string>(options: GmRequestOptions): Promise<GmResponse<T>> {
      const host = this.hostOf(options.url);
      await this.acquire(host, options.signal);
      try {
          let attempt = 0;
          const retries = Math.max(0, options.retry ?? 0);
          for (; ;) {
              try {
                  return await this.requestOnce<T>(options);
              } catch (error) {
                  if (attempt >= retries || !this.shouldRetry(error) || options.signal?.aborted) {
                      throw error;
                  }
                  attempt++;
                  await this.sleep(400 * 2 ** (attempt - 1), options.signal);
              }
          }
      } finally {
          this.release();
      }
  }

    private async requestOnce<T>(options: GmRequestOptions): Promise<GmResponse<T>> {
    const {
      url,
      method = "GET",
      headers,
      data,
      responseType = "text",
      timeoutMs = 15000,
      signal,
      maxBytes,
        allowedHosts,
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

            const finalUrl = resp.finalUrl ?? url;
            // 来源可能通过 3xx 把下载重定向到其他域名；只允许白名单内的最终 host。
            if (allowedHosts && allowedHosts.length > 0) {
                let finalHost: string;
                try {
                    finalHost = new URL(finalUrl).hostname;
                } catch {
                    reject(new SubtitleError("PROVIDER_BAD_RESPONSE", "响应地址不合法"));
                    return;
                }
                if (!allowedHosts.includes(finalHost)) {
                    reject(
                        new SubtitleError(
                            "PROVIDER_BAD_RESPONSE",
                            `响应重定向到未授权域名：${finalHost}`,
                        ),
                    );
                    return;
                }
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
              finalUrl,
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

    private hostOf(url: string): string {
        try {
            return new URL(url).hostname;
        } catch {
            return "unknown-host";
        }
    }

    /**
     * 轻量限流：全局最多 3 个并发，同一 host 至少间隔 250ms。
     * 不追求精确的令牌桶，只避免 SubtitleCat 详情页并发过高触发来源限流。
     */
    private async acquire(host: string, signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) throw new SubtitleError("PROVIDER_TIMEOUT", "请求已取消");
        while (this.activeRequests >= MAX_CONCURRENT_REQUESTS) {
            await new Promise<void>((resolve) => this.waiters.push(resolve));
            if (signal?.aborted) throw new SubtitleError("PROVIDER_TIMEOUT", "请求已取消");
        }

        const lastStart = this.hostNextAllowedAt.get(host) ?? 0;
        const waitMs = lastStart + MIN_HOST_INTERVAL_MS - Date.now();
        if (waitMs > 0) await this.sleep(waitMs, signal);
        if (signal?.aborted) throw new SubtitleError("PROVIDER_TIMEOUT", "请求已取消");

        this.activeRequests++;
        this.hostNextAllowedAt.set(host, Date.now());
    }

    private release(): void {
        this.activeRequests = Math.max(0, this.activeRequests - 1);
        const next = this.waiters.shift();
        next?.();
    }

    private shouldRetry(error: unknown): boolean {
        if (!(error instanceof SubtitleError)) return false;
        if (error.code === "PROVIDER_NETWORK_ERROR") return true;
        return error.code === "PROVIDER_BAD_RESPONSE" && /^HTTP 5\d\d\b/.test(error.message);
    }

    private sleep(ms: number, signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) return Promise.reject(new SubtitleError("PROVIDER_TIMEOUT", "请求已取消"));
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
            }, ms);
            const onAbort = () => {
                clearTimeout(timer);
                reject(new SubtitleError("PROVIDER_TIMEOUT", "请求已取消"));
            };
            signal?.addEventListener("abort", onAbort, {once: true});
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
