import type { PlayerAdapter, PlayerContext, PlayerMetadata } from "./player-adapter";
import { throttle } from "../utils/debounce";
import { isFiniteNumber } from "../utils/number";

const VIDEO_SELECTOR = "#js-video";
const TITLE_SELECTOR = "#js-video_title";
const PLAYER_BOX_SELECTOR = "#js-video_box";
const PICKCODE_PARAM = "pickcode";
const MODERN_PLAYER_PATH = /^\/players\/video\/([^/]+)\/?$/;

/** 新版播放页 `https://115.com/players/video/<pickcode>?name=<文件名>&fid=<文件ID>` 的解析结果。 */
export interface ModernPlayerInfo {
    pickcode: string;
    fileId: string;
    fileName?: string;
}

/**
 * 解析新版 115 播放页 URL。
 *
 * 实测：文件 ID 使用路径里的 pickcode（与旧播放页 pickcode 同源），
 * 文件名在 `name` 查询参数里；`fid` 是数字文件 ID，仅作 fallback。
 */
export function parseModernPlayerUrl(rawUrl: string): ModernPlayerInfo | null {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return null;
    }
    if (url.hostname !== "115.com" && !url.hostname.endsWith(".115.com")) return null;

    const match = url.pathname.match(MODERN_PLAYER_PATH);
    if (!match) return null;

    let pickcode = match[1];
    try {
        pickcode = decodeURIComponent(pickcode);
    } catch {
        // keep raw
    }
    const fileName = url.searchParams.get("name") || undefined;
    const fid = url.searchParams.get("fid") || undefined;
    const fileId = pickcode || fid;
    if (!fileId) return null;

    return {pickcode, fileId, fileName};
}

export class M115VideoAdapter implements PlayerAdapter {
  readonly id = "115-video";

  detect(): PlayerContext | null {
      const modern = parseModernPlayerUrl(window.location.href);
      if (modern) return this.detectModern(modern);
      return this.detectLegacy();
  }

    private detectLegacy(): PlayerContext | null {
    const video = document.querySelector<HTMLVideoElement>(VIDEO_SELECTOR);
    if (!video) return null;

    const style = getComputedStyle(video);
    if (style.display === "none" || style.visibility === "hidden") return null;

    const playerRoot =
      document.querySelector<HTMLElement>(PLAYER_BOX_SELECTOR) ??
      video.parentElement ??
      document.body;
        this.ensurePositioned(playerRoot);

        return {
            video,
            playerRoot,
            overlayHost: playerRoot,
            metadata: this.readMetadata(video),
        };
    }

    /**
     * 新版播放页没有 `#js-video`，video 也没有稳定 id；控制栏是 video 同级的
     * 绝对定位层（实测 `div.absolute.inset-x-0.bottom-0...`），因此用 video 的
     * 直接父容器同时作为播放器根节点和 overlay 宿主。
     */
    private detectModern(info: ModernPlayerInfo): PlayerContext | null {
        const video = this.findVisibleVideo();
        if (!video) return null;

        const playerRoot = this.resolveModernPlayerRoot(video);
        this.ensurePositioned(playerRoot);

        return {
            video,
            playerRoot,
            overlayHost: playerRoot,
            metadata: this.readMetadata(video, info),
        };
    }

    private resolveModernPlayerRoot(video: HTMLVideoElement): HTMLElement {
        const parent = video.parentElement;
        if (parent && (parent.querySelector("button") || parent.querySelector('[class*="bottom-0"]'))) {
            return parent;
        }
        return (
            video.closest<HTMLElement>('div[class*="aspect-video"]') ??
            parent ??
            document.body
        );
    }

    private findVisibleVideo(): HTMLVideoElement | null {
        const candidates = [...document.querySelectorAll<HTMLVideoElement>("video")]
            .map((video) => {
                const rect = video.getBoundingClientRect();
                const style = getComputedStyle(video);
                return {video, rect, style};
            })
            .filter(
                ({rect, style}) =>
                    rect.width > 0 &&
                    rect.height > 0 &&
                    style.display !== "none" &&
                    style.visibility !== "hidden",
            );

        if (candidates.length === 0) return null;
        if (candidates.length === 1) return candidates[0].video;

        // 多个 video 时优先正在播放的，其次取可见面积最大的，避免误选预览/广告。
        candidates.sort((a, b) => {
            const playing = Number(!b.video.paused) - Number(!a.video.paused);
            if (playing !== 0) return playing;
            return b.rect.width * b.rect.height - a.rect.width * a.rect.height;
        });
        return candidates[0].video;
    }

    private ensurePositioned(playerRoot: HTMLElement): void {
    if (getComputedStyle(playerRoot).position === "static") {
      playerRoot.style.position = "relative";
    }
  }

    private readMetadata(video: HTMLVideoElement, modern?: ModernPlayerInfo): PlayerMetadata {
    return {
      platform: "115",
        fileName: modern ? modern.fileName : this.findFileName(),
        fileId: modern ? modern.fileId : this.findFileId(),
      duration: isFiniteNumber(video.duration) ? video.duration : undefined,
      width: video.videoWidth || undefined,
      height: video.videoHeight || undefined,
      sourcePageUrl: window.location.href,
    };
  }

  private findFileName(): string | undefined {
    const titleEl = document.querySelector<HTMLElement>(TITLE_SELECTOR);
    const raw = titleEl?.textContent?.trim();
    if (raw) return this.cleanFileName(raw);

    const ogTitle = document.querySelector<HTMLMetaElement>('meta[property="og:title"]');
    if (ogTitle?.content) return this.cleanFileName(ogTitle.content);

    const docTitle = document.title?.trim();
    if (docTitle) return this.cleanFileName(docTitle);

    return undefined;
  }

  private cleanFileName(name: string): string {
    return name
      .replace(/^正在播放[：:]\s*/, "")
      .replace(/\s*-\s*115.*$/, "")
      .trim();
  }

  private findFileId(): string | undefined {
    try {
      const url = new URL(window.location.href);
      const pickcode = url.searchParams.get(PICKCODE_PARAM);
      if (pickcode) return pickcode;
    } catch {
      // ignore
    }

      const activeItem = document.querySelector<HTMLElement>(
          "#js-video_list li.hover[pickcode], #js-video_list li[pickcode]",
      );
    if (activeItem) {
      const pc = activeItem.getAttribute(PICKCODE_PARAM);
      if (pc) return pc;
    }

    return undefined;
  }

  observe(onChange: (context: PlayerContext | null) => void): () => void {
    const scheduleDetect = throttle(() => {
      const ctx = this.detect();
      onChange(ctx);
    }, 300);

    const observer = new MutationObserver(() => {
      scheduleDetect();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "src"],
    });

    const onFullscreenChange = () => scheduleDetect();
    document.addEventListener("fullscreenchange", onFullscreenChange);

      // 用捕获阶段监听文档上的媒体事件：新版播放器可能替换 video 元素，
      // 绑定到单个元素会漏掉替换后的 loadstart/loadedmetadata。
      const onMediaEvent = (event: Event) => {
          if (event.target instanceof HTMLVideoElement) scheduleDetect();
      };
      document.addEventListener("loadstart", onMediaEvent, true);
      document.addEventListener("loadedmetadata", onMediaEvent, true);

    const timers: number[] = [];
    timers.push(window.setTimeout(scheduleDetect, 500));
    timers.push(window.setTimeout(scheduleDetect, 1500));
    timers.push(window.setTimeout(scheduleDetect, 3000));

    return () => {
      observer.disconnect();
      document.removeEventListener("fullscreenchange", onFullscreenChange);
        document.removeEventListener("loadstart", onMediaEvent, true);
        document.removeEventListener("loadedmetadata", onMediaEvent, true);
      for (const t of timers) clearTimeout(t);
    };
  }
}

export const m115VideoAdapter = new M115VideoAdapter();
