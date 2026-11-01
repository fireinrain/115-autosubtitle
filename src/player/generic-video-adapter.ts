import type { PlayerAdapter, PlayerContext, PlayerMetadata } from "./player-adapter";
import { throttle } from "../utils/debounce";
import { isFiniteNumber } from "../utils/number";
import { logger } from "../utils/logger";

export class GenericVideoAdapter implements PlayerAdapter {
  readonly id = "generic-video";

  detect(): PlayerContext | null {
    const videos = document.querySelectorAll("video");
    const candidates: { video: HTMLVideoElement; score: number }[] = [];

    for (const video of videos) {
      if (video.offsetWidth === 0 && video.offsetHeight === 0) continue;
      const rect = video.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      let score = rect.width * rect.height;
      if (!video.paused) score += 1_000_000;
      if (video.duration && isFiniteNumber(video.duration)) score += 100_000;

      candidates.push({ video, score });
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score);

    const video = candidates[0].video;
    const playerRoot = this.findPlayerRoot(video);
    const overlayHost = this.findOverlayHost(video, playerRoot);
    const metadata = this.readMetadata(video);

    return { video, playerRoot, overlayHost, metadata };
  }

  private findPlayerRoot(video: HTMLVideoElement): HTMLElement {
    let el: HTMLElement | null = video.parentElement;
    while (el) {
      const style = getComputedStyle(el);
      if (style.position === "relative" || style.position === "absolute" || style.position === "fixed") {
        return el;
      }
      el = el.parentElement;
    }
    return video.parentElement ?? document.body;
  }

  private findOverlayHost(video: HTMLVideoElement, playerRoot: HTMLElement): HTMLElement {
    return playerRoot;
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
    // TODO(REAL-115-VERIFICATION): 需要在真实 115 播放页确认文件名所在 DOM 节点。
    // 当前实现尝试从常见位置查找，实测后应替换为精确选择器。
    const title = document.querySelector<HTMLElement>("[data-file-name], .file-name, .video-title");
    if (title?.textContent?.trim()) return title.textContent.trim();

    const meta = document.querySelector<HTMLMetaElement>('meta[property="og:title"]');
    if (meta?.content) return meta.content;

    return document.title || undefined;
  }

  private findFileId(): string | undefined {
    // TODO(REAL-115-VERIFICATION): 115 文件 ID 的可访问来源需要实测确认。
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

    const initialTimer = setTimeout(scheduleDetect, 500);

    return () => {
      observer.disconnect();
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      clearTimeout(initialTimer);
    };
  }
}