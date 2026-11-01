import type { PlayerAdapter, PlayerContext, PlayerMetadata } from "./player-adapter";
import { throttle } from "../utils/debounce";
import { isFiniteNumber } from "../utils/number";
import { logger } from "../utils/logger";

const VIDEO_SELECTOR = "#js-video";
const TITLE_SELECTOR = "#js-video_title";
const PLAYER_BOX_SELECTOR = "#js-video_box";
const PICKCODE_PARAM = "pickcode";

export class M115VideoAdapter implements PlayerAdapter {
  readonly id = "115-video";

  detect(): PlayerContext | null {
    const video = document.querySelector<HTMLVideoElement>(VIDEO_SELECTOR);
    if (!video) return null;

    const style = getComputedStyle(video);
    if (style.display === "none" || style.visibility === "hidden") return null;

    const playerRoot =
      document.querySelector<HTMLElement>(PLAYER_BOX_SELECTOR) ??
      video.parentElement ??
      document.body;

    if (getComputedStyle(playerRoot).position === "static") {
      playerRoot.style.position = "relative";
    }

    const overlayHost = playerRoot;

    const metadata = this.readMetadata(video);

    return { video, playerRoot, overlayHost, metadata };
  }

  private readMetadata(video: HTMLVideoElement): PlayerMetadata {
    return {
      platform: "115",
      fileName: this.findFileName(),
      fileId: this.findFileId(),
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

    const activeItem = document.querySelector<HTMLElement>("#js-video_list li.hover[pickcode], #js-video_list li[pickcode]");
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

    const videoEl = document.querySelector<HTMLVideoElement>(VIDEO_SELECTOR);
    const onSrcChange = () => scheduleDetect();
    if (videoEl) {
      videoEl.addEventListener("loadstart", onSrcChange);
      videoEl.addEventListener("loadedmetadata", onSrcChange);
    }

    const timers: number[] = [];
    timers.push(window.setTimeout(scheduleDetect, 500));
    timers.push(window.setTimeout(scheduleDetect, 1500));
    timers.push(window.setTimeout(scheduleDetect, 3000));

    return () => {
      observer.disconnect();
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      if (videoEl) {
        videoEl.removeEventListener("loadstart", onSrcChange);
        videoEl.removeEventListener("loadedmetadata", onSrcChange);
      }
      for (const t of timers) clearTimeout(t);
    };
  }
}

export const m115VideoAdapter = new M115VideoAdapter();