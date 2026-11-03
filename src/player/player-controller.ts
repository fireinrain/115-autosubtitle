import type { PlayerAdapter, PlayerContext } from "./player-adapter";
import type { VideoIdentity } from "../identity/video-identity";
import { VideoIdentityService } from "../identity/video-identity";
import { SubtitleTimelineEngine } from "../subtitle/timeline-engine";
import { OverlayRenderer } from "../renderer/overlay-renderer";
import { subtitleRepository } from "../storage/subtitle-repository";
import type { SubtitleCue } from "../subtitle/subtitle-model";
import type { GlobalSettings } from "../settings/settings-service";
import { isFiniteNumber } from "../utils/number";
import { logger } from "../utils/logger";

export interface PlayerControllerEvents {
  onVideoChange?: (identity: VideoIdentity) => void;
  onPlayerContextAttached?: (context: PlayerContext) => void;
  onSubtitleLoaded?: (title: string, subtitleId: string | null) => void;
  onSubtitleCleared?: () => void;
    /** 缓存恢复流程结束（无论是否命中），供上层决定是否自动搜索。 */
    onCacheRestoreSettled?: (identity: VideoIdentity, restored: boolean) => void;
}

export class PlayerController {
  private adapter: PlayerAdapter;
  private identityService = new VideoIdentityService();
  private timeline = new SubtitleTimelineEngine();
  private renderer = new OverlayRenderer();
  private events: PlayerControllerEvents;

  private currentContext: PlayerContext | null = null;
  private currentIdentity: VideoIdentity | null = null;
  private generation = 0;
  private rafId: number | null = null;
  private videoListeners: Array<{ event: string; handler: EventListener }> = [];
  private stopObserving: (() => void) | null = null;
  private currentSubtitleId: string | null = null;
  private settings: GlobalSettings | null = null;
  private subtitleVisible = true;
    /** 当前 video 的元数据是否已就绪（切换视频时 115 会先改 URL 再替换 src）。 */
    private mediaMetadataReady = false;

  constructor(adapter: PlayerAdapter, events: PlayerControllerEvents = {}) {
    this.adapter = adapter;
    this.events = events;
  }

  setSettings(settings: GlobalSettings): void {
    this.settings = settings;
    this.renderer.setStyle(settings.style);
  }

  start(): void {
    this.stopObserving = this.adapter.observe((ctx) => this.handleContext(ctx));
    const initial = this.adapter.detect();
    if (initial) this.handleContext(initial);
  }

  private handleContext(ctx: PlayerContext | null): void {
    if (!ctx) {
      this.detach();
      return;
    }
    if (this.currentContext && this.isSameVideo(this.currentContext, ctx)) {
      this.refreshIdentity(ctx);
      return;
    }
    void this.attach(ctx);
  }

  /**
   * 同一 video 元素下元数据可能后到（115 的标题节点在播放器初始化后才写入文本）。
   * 首次 detect 时 fileName/code 可能为空，这里在后续探测中补齐身份信息，
   * 否则面板会一直停留在“文件未知 / 番号未识别”。
   */
  private refreshIdentity(ctx: PlayerContext): void {
    this.currentContext = ctx;
    const next = this.identityService.resolve(ctx.metadata);
    const prev = this.currentIdentity;
    if (
      prev &&
      prev.videoKey === next.videoKey &&
      prev.code === next.code &&
      prev.originalFileName === next.originalFileName
    ) {
      return;
    }
    this.currentIdentity = next;
    this.events.onVideoChange?.(next);

    // 115 的时长/标题在播放器初始化后才就绪，首次 attach 时 videoKey 可能缺少
    // `|dur:` 段，导致缓存查不到。身份补全后 videoKey 变强，这里补一次恢复。
    if (
      prev &&
      prev.videoKey !== next.videoKey &&
      !this.currentSubtitleId &&
      this.settings?.autoLoadCachedSubtitle
    ) {
        void this.restoreCachedSubtitle(next);
    }
  }

  /** 按 videoKey 恢复上次选中的字幕（仅在当前没有选中字幕时生效）。 */
  private async restoreCachedSubtitle(identity: VideoIdentity): Promise<void> {
    const gen = this.generation;
      const cached = await subtitleRepository.getSelectedForVideo(identity.videoKey);
      if (gen !== this.generation) return;
      if (!cached || this.currentSubtitleId) {
          this.events.onCacheRestoreSettled?.(identity, Boolean(cached));
          return;
      }
    this.currentSubtitleId = cached.id;
    this.loadCues(cached.cues);
    this.events.onSubtitleLoaded?.(cached.title, cached.id);
      this.events.onCacheRestoreSettled?.(identity, true);
  }

  private isSameVideo(a: PlayerContext, b: PlayerContext): boolean {
    if (a.video !== b.video) return false;
    const aId = a.metadata.fileId;
    const bId = b.metadata.fileId;
    if (aId && bId) return aId === bId;
    return a.metadata.fileName === b.metadata.fileName;
  }

  private async attach(ctx: PlayerContext): Promise<void> {
    await this.detach();
    // detach() 会推进 generation；必须在它完成后捕获本次 attach 的代次，
    // 否则当前实现会把自己误判为过期上下文，导致 overlay 永远不挂载。
    const myGen = ++this.generation;
    if (myGen !== this.generation) return;

    this.currentContext = ctx;
    this.renderer.mount(ctx.overlayHost);
    this.renderer.setVisible(this.subtitleVisible);
    if (this.settings) this.renderer.setStyle(this.settings.style);
      // 115 切换视频时 URL/标题会先变，src 和 metadata 随后才就绪。
      // 记录当前是否已有可用元数据，供自动搜索判断“现在搜索是否已经安全”。
      this.mediaMetadataReady = ctx.video.readyState >= 1;

    const identity = this.identityService.resolve(ctx.metadata);
    this.currentIdentity = identity;
    this.events.onVideoChange?.(identity);
    this.events.onPlayerContextAttached?.(ctx);

    this.bindVideoEvents(ctx.video);
    this.startRenderLoop(ctx.video);

      if (this.settings?.autoLoadCachedSubtitle) {
          await this.restoreCachedSubtitle(identity);
      }
  }

  private async detach(): Promise<void> {
    this.generation++;
    this.stopRenderLoop();
    this.unbindVideoEvents();
    this.timeline.clear();
    this.renderer.setCues([]);
    this.renderer.unmount();
    this.currentSubtitleId = null;
    this.currentContext = null;
    this.currentIdentity = null;
      this.mediaMetadataReady = false;
    this.events.onSubtitleCleared?.();
  }

  private bindVideoEvents(video: HTMLVideoElement): void {
    const handlers: Array<[string, EventListener]> = [
        // 新视频开始加载时先标记元数据未就绪，避免自动搜索在切换窗口里用旧视频的时长查缓存。
        ["loadstart", () => {
            this.mediaMetadataReady = false;
        }],
        ["emptied", () => {
            this.mediaMetadataReady = false;
        }],
      ["loadedmetadata", () => this.onMetadata(video)],
      // 实测：115 播放器在暂停状态下拖动进度条只会触发 `seeking`，
      // `seeked` 可能延迟到恢复播放才触发，导致字幕停在旧内容上。
      // 因此两个事件都刷新，保证拖动时字幕立即跟随。
      ["seeking", () => this.refresh()],
      ["seeked", () => this.refresh()],
      ["playing", () => this.startRenderLoop(video)],
      ["pause", () => { this.refresh(); this.stopRenderLoop(); }],
      ["ended", () => { this.renderer.setCues([]); this.stopRenderLoop(); }],
      ["ratechange", () => this.refresh()],
    ];
    for (const [event, handler] of handlers) {
      video.addEventListener(event, handler);
      this.videoListeners.push({ event, handler });
    }
  }

  private unbindVideoEvents(): void {
    if (this.currentContext) {
      for (const { event, handler } of this.videoListeners) {
        this.currentContext.video.removeEventListener(event, handler);
      }
    }
    this.videoListeners = [];
  }

  private onMetadata(video: HTMLVideoElement): void {
      this.mediaMetadataReady = true;
    if (this.currentContext) {
      this.currentContext.metadata.duration = isFiniteNumber(video.duration) ? video.duration : undefined;
      this.currentContext.metadata.width = video.videoWidth || undefined;
      this.currentContext.metadata.height = video.videoHeight || undefined;
        // 切换视频时 videoKey 可能先只有 id，loadedmetadata 后才补上时长。
        // 若这里不立即刷新身份，缓存恢复会用弱 key 查不到记录，从而误触发自动搜索。
        this.refreshIdentity(this.currentContext);
    }
    this.refresh();
  }

  loadCues(cues: SubtitleCue[]): void {
    this.timeline.load(cues);
    if (this.currentContext) this.startRenderLoop(this.currentContext.video);
    this.refresh();
  }

  /**
   * 选用一条字幕。
   *
   * 之前各处分别调用 `loadCues()` + 手工设置 `currentSubtitleId`，
   * 容易出现“字幕生效了但面板不知道哪条被选中”的状态不一致。
   * 现在统一下沉到这里：id、Cue、立即刷新一次渲染。
   */
  selectSubtitle(subtitleId: string | null, cues: SubtitleCue[]): void {
    this.currentSubtitleId = subtitleId;
    this.loadCues(cues);
  }

  /**
   * 当前播放时间点命中的 Cue 数量。
   * 用于在用户点击「使用」后区分「已生效」与「已生效但此刻没有字幕」。
   */
  getActiveCueCount(): number {
    if (!this.currentContext) return 0;
    return this.timeline.update(this.currentContext.video.currentTime).length;
  }

  setOffset(offsetMs: number): void {
    this.timeline.setOffset(offsetMs);
    this.refresh();
  }

  clearSubtitle(): void {
    this.timeline.clear();
    this.renderer.setCues([]);
    this.currentSubtitleId = null;
  }

  setSubtitleVisible(visible: boolean): void {
    this.subtitleVisible = visible;
    this.renderer.setVisible(visible);
  }

  getSubtitleVisible(): boolean {
    return this.subtitleVisible;
  }

  getCurrentIdentity(): VideoIdentity | null {
    return this.currentIdentity;
  }

  getCurrentSubtitleId(): string | null {
    return this.currentSubtitleId;
  }

    /** 当前 video 的元数据是否已就绪；115 切换视频期间会短暂为 false。 */
    isMediaMetadataReady(): boolean {
        return this.mediaMetadataReady;
    }

  private startRenderLoop(video: HTMLVideoElement): void {
    if (this.rafId !== null) return;
    const tick = () => {
      if (video.paused) {
        this.rafId = null;
        return;
      }
      const cues = this.timeline.update(video.currentTime);
      this.renderer.setCues(cues);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopRenderLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private refresh(): void {
    if (!this.currentContext) return;
    const cues = this.timeline.update(this.currentContext.video.currentTime);
    this.renderer.setCues(cues);
  }

  dispose(): void {
    this.stopObserving?.();
    void this.detach();
  }
}