import type { VideoIdentity } from "../identity/video-identity";
import type { SubtitleSearchResult } from "../providers/provider";
import { providerManager, type ProviderState, type SearchProgress } from "../search/provider-manager";
import type { GlobalSettings, SubtitleStyleSettings } from "../settings/settings-service";
import {FONT_PRESETS, findFontPreset, normalizeFontFamily} from "../settings/font-presets";
import type { SubtitleRecord } from "../storage/database";
import type {RemoteCacheSummary, RemoteSubtitleMeta} from "../storage/metadata-sync";
import {
  decodeRawSubtitle,
  formatCuesWithTimestamps,
  limitPreviewText,
} from "../subtitle/preview";

export interface PanelCallbacks {
  onImportFile: (file: File) => void;
  onSearch: (code: string) => void;
  onSelectResult: (result: SubtitleSearchResult) => void;
  onPreviewResult: (result: SubtitleSearchResult) => void;
  onDownloadResult: (result: SubtitleSearchResult) => void;
  onSelectCachedSubtitle: (record: SubtitleRecord) => void;
  onRestoreRemote: (meta: RemoteSubtitleMeta) => void;
  onStyleChange: (style: Partial<SubtitleStyleSettings>) => void;
  onOffsetChange: (offsetMs: number) => void;
  onToggleSubtitle: (enabled: boolean) => void;
  onAutoSearchChange: (enabled: boolean) => void;
  onClearCache: () => void;
  onDeleteSubtitle: (id: string) => void;
  onDeduplicateCache: () => void;
  onExportAll: () => void;
}

type PanelTab = "subs" | "style" | "sync" | "cache";

const TABS: Array<{ id: PanelTab; label: string }> = [
  { id: "subs", label: "字幕" },
  { id: "style", label: "样式" },
  { id: "sync", label: "同步" },
  { id: "cache", label: "缓存" },
];

const PANEL_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .panel {
    position: fixed; display: none; flex-direction: column;
    width: 400px; max-height: min(62vh, 620px);
    background: #1e1e2e; color: #cdd6f4;
    border: 1px solid #45475a; border-radius: 10px;
    box-shadow: 0 12px 40px rgba(0,0,0,.55);
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color-scheme: dark;
    overflow: hidden;
  }
  .panel.open { display: flex; }
  .header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #181825; border-bottom: 1px solid #313244; }
  .title { flex: 1; font-size: 13px; font-weight: 600; }
  .pill { border: 1px solid #45475a; background: #313244; color: #cdd6f4; border-radius: 999px; padding: 2px 10px; font-size: 11px; cursor: pointer; }
  .pill.on { background: #a6e3a1; border-color: #a6e3a1; color: #1e1e2e; }
  .pill.off { color: #a6adc8; }
  .close { background: none; border: none; color: #a6adc8; font-size: 18px; line-height: 1; cursor: pointer; padding: 0 2px; }
  .close:hover { color: #f38ba8; }
  .tabs { display: flex; gap: 2px; padding: 8px 8px 0; background: #181825; }
  .tab { flex: 1; padding: 6px 0; background: none; border: none; border-bottom: 2px solid transparent; color: #a6adc8; font-size: 12px; cursor: pointer; }
  .tab:hover { color: #cdd6f4; }
  .tab.active { color: #89b4fa; border-bottom-color: #89b4fa; }
  .body { flex: 1; padding: 12px; overflow-y: auto; }
  .section { margin-bottom: 14px; }
  .section-title { font-size: 11px; color: #a6adc8; margin-bottom: 6px; display: flex; justify-content: space-between; }
  .info { padding: 8px 10px; background: #313244; border-radius: 6px; font-size: 12px; color: #a6adc8; margin-bottom: 8px; word-break: break-all; }
  .info b { color: #cdd6f4; font-weight: 500; }
  .row { display: flex; gap: 8px; align-items: center; }
  .row + .row { margin-top: 8px; }
  .slider { flex: 1; min-width: 0; accent-color: #89b4fa; }
  .value { min-width: 58px; text-align: right; font-size: 12px; color: #a6adc8; font-variant-numeric: tabular-nums; }
  .field-label { min-width: 62px; font-size: 12px; color: #a6adc8; }
  .input { flex: 1; min-width: 0; padding: 6px 10px; background: #313244; border: 1px solid #45475a; border-radius: 6px; color: #cdd6f4; font-size: 13px; }
  .input:focus { outline: none; border-color: #89b4fa; }
  select.input { cursor: pointer; }
  .btn { padding: 6px 12px; background: #89b4fa; color: #1e1e2e; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500; white-space: nowrap; }
  .btn:hover { background: #74c7ec; }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn-ghost { background: #313244; color: #cdd6f4; border: 1px solid #45475a; }
  .btn-ghost:hover { background: #45475a; }
  .btn-sm { padding: 3px 9px; font-size: 11px; }
  .btn-danger { background: #f38ba8; }
  .btn-danger:hover { background: #eba0ac; }
  .result { padding: 9px 10px; background: #313244; border: 1px solid transparent; border-radius: 6px; margin-bottom: 6px; }
  .result.active { border-color: #a6e3a1; background: rgba(166,227,161,.10); box-shadow: inset 3px 0 0 #a6e3a1; }
  .result.active .result-title { color: #a6e3a1; }
  .result-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .result-title-wrap { display: flex; align-items: center; gap: 4px; min-width: 0; max-width: 50%; }
  .badge-active { display: inline-block; flex-shrink: 0; padding: 1px 7px; border-radius: 999px; background: #a6e3a1; color: #1e1e2e; font-size: 10px; font-weight: 600; vertical-align: 1px; }
  .btn-active { background: rgba(166,227,161,.18) !important; color: #a6e3a1 !important; border: 1px solid #a6e3a1 !important; opacity: 1 !important; cursor: default; }
  .toast { position: fixed; left: 50%; bottom: 96px; transform: translate(-50%, 8px); z-index: 2147483001; max-width: 380px; padding: 9px 14px; border-radius: 8px; background: rgba(166,227,161,.97); color: #1e1e2e; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.45); opacity: 0; transition: opacity .16s ease, transform .16s ease; pointer-events: none; word-break: break-all; }
  .toast.show { opacity: 1; transform: translate(-50%, 0); }
  .toast.warn { background: rgba(249,226,175,.97); }
  .result-title { min-width: 0; font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .result-meta { font-size: 11px; color: #a6adc8; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .result-actions { display: flex; gap: 6px; margin-left: auto; flex-shrink: 0; }
  .empty { padding: 14px 10px; text-align: center; font-size: 12px; color: #6c7086; background: #181825; border-radius: 6px; }
  .chip { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 10px; margin-right: 4px; }
  .chip-success { background: rgba(166,227,161,.16); color: #a6e3a1; }
  .chip-error { background: rgba(243,139,168,.16); color: #f38ba8; }
  .chip-busy { background: rgba(137,180,250,.16); color: #89b4fa; }
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.72); display: flex; align-items: center; justify-content: center; padding: 24px; }
  .modal { display: flex; flex-direction: column; width: 640px; max-width: 92vw; max-height: 78vh; background: #1e1e2e; border: 1px solid #45475a; border-radius: 10px; overflow: hidden; }
  .modal-header { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: #181825; border-bottom: 1px solid #313244; }
  .modal-title { flex: 1; font-size: 13px; font-weight: 600; word-break: break-all; }
  .modal-body { flex: 1; overflow-y: auto; padding: 12px 14px; }
  .preview-line { padding: 3px 0; border-bottom: 1px solid #313244; font-size: 12px; line-height: 1.6; color: #cdd6f4; }
  .preview-line:last-child { border-bottom: none; }
  .preview-line:empty { border-bottom: none; padding: 0; height: 8px; }
  .preview-time { color: #89b4fa; font-variant-numeric: tabular-nums; }
  .preview-text { color: #cdd6f4; }
`;

function div(className: string, text?: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function btn(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  el.textContent = text;
  el.addEventListener("click", onClick);
  return el;
}

export class SubtitlePanel {
  private host: HTMLElement | null = null;
  private container: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private callbacks: PanelCallbacks;

  private panelEl: HTMLDivElement | null = null;
  private bodyEl: HTMLDivElement | null = null;
  private tabEls = new Map<PanelTab, HTMLButtonElement>();
  private statusPill: HTMLButtonElement | null = null;
  private modalEl: HTMLElement | null = null;

  private visible = false;
  private activeTab: PanelTab = "subs";

  private identity: VideoIdentity | null = null;
  private progress: SearchProgress | null = null;
  private currentSubtitle: string | null = null;
  private currentSubtitleId: string | null = null;
  private cachedSubtitles: SubtitleRecord[] = [];
  private remoteSubtitles: RemoteSubtitleMeta[] = [];
  private remoteSummary: RemoteCacheSummary = {count: 0, bytes: 0, origins: []};
  private cacheSummary = {count: 0, bytes: 0};
  private settings: GlobalSettings | null = null;
  private codeDraft: string | null = null;
  private toastEl: HTMLElement | null = null;
  private toastTimer: number | null = null;

  private playerRoot: HTMLElement | null = null;
  private playerBarObserver: MutationObserver | null = null;
  private nativeToggle: { container: HTMLElement; anchor: HTMLElement } | null = null;
  private subtitleVisible = true;
  /** 控制栏自动隐藏时锚点 rect 会退化为 0，用最近一次有效位置兜底。 */
  private lastAnchorRect: { right: number; top: number; bottom: number } | null = null;

  constructor(callbacks: PanelCallbacks) {
    this.callbacks = callbacks;
  }

  mount(): void {
    if (this.root) return;
    this.host = document.body;
    const container = document.createElement("div");
    container.className = "userscript-panel-host";
    container.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483000;";
    this.root = container.attachShadow({ mode: "open" });
    this.host.appendChild(container);
    this.container = container;

    this.buildShell();

    document.addEventListener("pointerdown", this.handleDocumentPointerDown, true);
    document.addEventListener("keydown", this.handleDocumentKeyDown, true);
    window.addEventListener("resize", this.handleViewportChange);
    window.addEventListener("scroll", this.handleViewportChange, true);
  }

  setIdentity(identity: VideoIdentity | null): void {
    if (this.identity?.videoKey !== identity?.videoKey) this.codeDraft = null;
    this.identity = identity;
    this.renderBody();
  }

  setProgress(progress: SearchProgress | null): void {
    this.progress = progress;
    this.renderBody();
  }

  setCurrentSubtitle(title: string | null, subtitleId: string | null = null): void {
    this.currentSubtitle = title;
    this.currentSubtitleId = subtitleId;
    this.renderBody();
  }

  setCachedSubtitles(subtitles: SubtitleRecord[]): void {
    this.cachedSubtitles = subtitles;
    this.renderBody();
  }

  setRemoteSubtitles(subtitles: RemoteSubtitleMeta[]): void {
    this.remoteSubtitles = subtitles;
    this.renderBody();
  }

  setRemoteSummary(summary: RemoteCacheSummary): void {
    this.remoteSummary = summary;
    if (this.visible && this.activeTab === "cache") this.renderBody();
  }

  setCacheSummary(summary: { count: number; bytes: number }): void {
    const changed =
        this.cacheSummary.count !== summary.count || this.cacheSummary.bytes !== summary.bytes;
    this.cacheSummary = summary;
    // 缓存数量和列表通常一起更新；这里只在摘要真的变化时重绘，避免重复重建 DOM。
    if (changed && this.visible && this.activeTab === "cache") this.renderBody();
  }

  /**
   * 更新设置。
   * @param updateView 为 false 时只记录新值、不重建界面——用于由面板自身滑块触发的更新，
   *                   避免拖动过程中 DOM 被替换导致滑块中断。
   */
  setSettings(settings: GlobalSettings, updateView = true): void {
    this.settings = settings;
    if (updateView) this.renderBody();
  }

  show(tab: PanelTab = this.activeTab): void {
    this.visible = true;
    this.setActiveTab(tab);
    this.panelEl?.classList.add("open");
    this.positionPanel();
  }

  hide(): void {
    this.visible = false;
    this.panelEl?.classList.remove("open");
  }

  isOpen(): boolean {
    return this.visible;
  }

  showPreview(title: string, content: string): void {
    this.modalEl?.remove();
    this.modalEl = null;
    if (!this.root) return;

    const overlay = div("modal-overlay");
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.closePreview();
    });

    const modal = div("modal");
    const header = div("modal-header");
    header.appendChild(div("modal-title", title));
    header.appendChild(btn("close", "×", () => this.closePreview()));

    const body = div("modal-body");
    const lines = content.split("\n");
    for (const line of lines) {
      // 时间轴行（`1. 00:00:00,000 --> 00:00:10,000`）单独着色，方便快速定位。
      const className = line.includes("-->") ? "preview-line preview-time" : "preview-line preview-text";
      body.appendChild(div(className, line));
    }

    modal.appendChild(header);
    modal.appendChild(body);
    overlay.appendChild(modal);
    this.root.appendChild(overlay);
    this.modalEl = overlay;
  }

  private closePreview(): void {
    this.modalEl?.remove();
    this.modalEl = null;
  }

  /**
   * 把助手开关插入 115 原生播放器底栏。
   *
   * 实测依据：docs/115-player-inspection.md
   * - 旧播放页（115vod.com）：原生字幕按钮位于
   *   `#js-video_box .operate-bar .bar-side > ul` 的第 4 个 `li`，
   *   结构为 `<li><a class="btn-cle"><s>字幕</s></a><div class="tooltip">…</div></li>`。
   * - 新播放页（115.com/players/video/*）：控制栏里是
   *   `<div class="relative"><button>字幕</button></div>`，按钮没有 id/class 语义，
   *   只能按文本与结构定位。
   * 这里把 CC 插到原生字幕控件后面，并观察播放器根节点，防止 SPA 重绘后按钮丢失。
   */
  mountPlayerControls(playerRoot: HTMLElement): void {
    if (this.playerRoot === playerRoot) {
      this.ensureNativeToggle();
      return;
    }
    this.teardownPlayerControls();
    this.playerRoot = playerRoot;
    this.ensureNativeToggle();
    this.playerBarObserver = new MutationObserver(() => this.ensureNativeToggle());
    this.playerBarObserver.observe(playerRoot, { childList: true, subtree: true });
  }

  setSubtitleVisible(visible: boolean): void {
    this.subtitleVisible = visible;
    this.updateStatusPill();
    if (this.visible && this.activeTab === "subs") this.renderBody();
  }

  private findNativeSubtitleControl(
      root: HTMLElement,
  ): { container: HTMLElement; button: HTMLElement; mode: "legacy" | "modern" } | null {
    // 旧播放器：li > a.btn-cle > s:字幕
    const items = root.querySelectorAll<HTMLLIElement>(".operate-bar .bar-side > ul > li");
    for (const li of items) {
      const anchor = li.firstElementChild;
      if (!(anchor instanceof HTMLAnchorElement)) continue;
      if (!anchor.classList.contains("btn-cle")) continue;
      if (anchor.textContent?.trim() !== "字幕") continue;
      return {container: li, button: anchor, mode: "legacy"};
    }

    // 新播放器：控制栏里的 <button>字幕</button>，外层是 <div class="relative">。
    // 按钮类名是构建时生成的 utility class，不能作为长期选择器，只按文本定位。
    const buttons = root.querySelectorAll<HTMLButtonElement>("button");
    for (const button of buttons) {
      if (button.closest('[data-userscript="subtitle-toggle"]')) continue;
      if (button.textContent?.trim() !== "字幕") continue;
      const container = button.parentElement;
      if (!container) continue;
      if (button.getBoundingClientRect().width <= 0) continue;
      return {container, button, mode: "modern"};
    }

    return null;
  }

  private ensureNativeToggle(): void {
    if (!this.playerRoot) return;
    const native = this.findNativeSubtitleControl(this.playerRoot);
    if (!native) return;

    if (
        this.nativeToggle &&
        this.nativeToggle.container.isConnected &&
        this.nativeToggle.container.previousElementSibling === native.container
    ) {
      return;
    }

    this.nativeToggle?.container.remove();
    this.nativeToggle = null;

    if (native.mode === "legacy") {
      const li = document.createElement("li");
      li.className = "userscript-subtitle-toggle";
      li.dataset.userscript = "subtitle-toggle";

      const anchor = document.createElement("a");
      anchor.href = "javascript:;";
      anchor.className = "btn-cle";
      anchor.setAttribute("role", "button");
      anchor.setAttribute("aria-label", "打开字幕助手列表");
      anchor.title = "字幕助手";

      const label = document.createElement("s");
      label.textContent = "CC";
      anchor.appendChild(label);

      const tooltip = div("tooltip");
      tooltip.textContent = "字幕助手";

      li.appendChild(anchor);
      li.appendChild(tooltip);
      anchor.addEventListener("click", this.handleNativeToggleClick);
      native.container.after(li);

      this.nativeToggle = {container: li, anchor};
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.className = native.container.className || "relative";
    wrapper.dataset.userscript = "subtitle-toggle";

    const button = document.createElement("button");
    button.type = "button";
    // 与新版控制栏「倍速」等按钮保持一致；「字幕」的 text-blue-400 表示开启态，
    // 这里使用普通的白色/悬停蓝色。
    button.className = "p-1 text-sm whitespace-nowrap transition-colors text-white hover:text-blue-400";
    button.dataset.userscript = "subtitle-toggle";
    button.setAttribute("role", "button");
    button.setAttribute("aria-label", "打开字幕助手列表");
    button.title = "字幕助手";
    button.textContent = "CC";
    button.addEventListener("click", this.handleNativeToggleClick);

    wrapper.appendChild(button);
    native.container.after(wrapper);
    this.nativeToggle = {container: wrapper, anchor: button};
  }

  private handleNativeToggleClick = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    if (this.visible && this.activeTab === "subs") {
      this.hide();
    } else {
      this.show("subs");
    }
  };

  private handleDocumentPointerDown = (event: PointerEvent): void => {
    if (!this.visible) return;
    const path = event.composedPath();
    if (this.container && path.includes(this.container)) return;
    if (this.nativeToggle && path.includes(this.nativeToggle.container)) return;
    this.hide();
  };

  private handleDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    if (this.modalEl) {
      this.closePreview();
      return;
    }
    if (this.visible) this.hide();
  };

  private handleViewportChange = (): void => {
    if (this.visible) this.positionPanel();
  };

  private buildShell(): void {
    if (!this.root) return;

    const style = document.createElement("style");
    style.textContent = PANEL_CSS;
    this.root.appendChild(style);

    const panel = div("panel");

    const header = div("header");
    header.appendChild(div("title", "115 字幕助手"));

    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "pill on";
    pill.addEventListener("click", () => {
      this.subtitleVisible = !this.subtitleVisible;
      this.updateStatusPill();
      this.callbacks.onToggleSubtitle(this.subtitleVisible);
      if (this.visible && this.activeTab === "subs") this.renderBody();
    });
    header.appendChild(pill);
    this.statusPill = pill;

    header.appendChild(btn("close", "×", () => this.hide()));
    panel.appendChild(header);

    const tabs = div("tabs");
    for (const tab of TABS) {
      const el = btn("tab", tab.label, () => this.setActiveTab(tab.id));
      tabs.appendChild(el);
      this.tabEls.set(tab.id, el);
    }
    panel.appendChild(tabs);

    const body = div("body");
    panel.appendChild(body);

    this.root.appendChild(panel);
    this.panelEl = panel;
    this.bodyEl = body;

    this.updateStatusPill();
    this.setActiveTab(this.activeTab);
  }

  private setActiveTab(tab: PanelTab): void {
    this.activeTab = tab;
    for (const [id, el] of this.tabEls) {
      el.classList.toggle("active", id === tab);
    }
    this.renderBody();
  }

  private updateStatusPill(): void {
    if (!this.statusPill) return;
    this.statusPill.textContent = this.subtitleVisible ? "字幕：开" : "字幕：关";
    this.statusPill.classList.toggle("on", this.subtitleVisible);
    this.statusPill.classList.toggle("off", !this.subtitleVisible);
    this.statusPill.setAttribute("aria-pressed", String(this.subtitleVisible));
    this.statusPill.title = this.subtitleVisible ? "点击隐藏字幕" : "点击显示字幕";
  }

  private renderBody(): void {
    if (!this.bodyEl) return;
    this.bodyEl.replaceChildren();

    switch (this.activeTab) {
      case "subs":
        this.bodyEl.appendChild(this.renderSubsTab());
        break;
      case "style":
        this.bodyEl.appendChild(this.renderStyleTab());
        break;
      case "sync":
        this.bodyEl.appendChild(this.renderSyncTab());
        break;
      case "cache":
        this.bodyEl.appendChild(this.renderCacheTab());
        break;
    }

    // 内容高度变化会影响上弹位置，重算一次锚点，避免面板超出视口。
    if (this.visible) this.positionPanel();
  }

  private renderSubsTab(): HTMLElement {
    const pane = div("tab-pane");

    const infoSection = div("section");
    const info = div("info");
    if (this.identity) {
      const fileRow = div("info-row");
      fileRow.append("文件：");
      fileRow.appendChild(this.strong(this.identity.originalFileName ?? "未知"));
      const codeRow = div("info-row");
      codeRow.append("番号：");
      codeRow.appendChild(this.strong(this.identity.code ?? "未识别"));
      codeRow.append(`（${sourceLabel(this.identity.source)}）`);
      info.appendChild(fileRow);
      info.appendChild(codeRow);
    } else {
      info.textContent = "尚未检测到播放器";
    }
    infoSection.appendChild(info);
    pane.appendChild(infoSection);

    if (this.currentSubtitle) {
      const current = div("info");
      current.append("当前字幕：");
      current.appendChild(this.strong(this.currentSubtitle));
      pane.appendChild(current);
    }

    const searchSection = div("section");
    const searchRow = div("row");
    const codeInput = document.createElement("input");
    codeInput.type = "text";
    codeInput.className = "input";
    codeInput.placeholder = "输入番号后搜索";
    codeInput.value = this.codeDraft ?? this.identity?.code ?? "";
    codeInput.addEventListener("input", () => {
      this.codeDraft = codeInput.value;
    });
    codeInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.callbacks.onSearch(codeInput.value.trim());
    });

    const searching = this.progress !== null && !this.progress.done;
    const searchBtn = btn("btn", searching ? "搜索中…" : "搜索", () => {
      this.callbacks.onSearch(codeInput.value.trim());
    });
    searchBtn.disabled = searching;

    searchRow.appendChild(codeInput);
    searchRow.appendChild(searchBtn);
    searchSection.appendChild(searchRow);

    const autoRow = div("row");
    autoRow.appendChild(div("field-label", "无缓存自动搜"));
    const autoOn = this.settings?.autoSearch ?? true;
    const autoBtn = btn("btn btn-ghost btn-sm", autoOn ? "已开启" : "已关闭", () => {
      const next = !(this.settings?.autoSearch ?? true);
      autoBtn.textContent = next ? "已开启" : "已关闭";
      this.callbacks.onAutoSearchChange(next);
    });
    autoBtn.title = "先恢复该视频的缓存；没有缓存时才自动搜索，但不会自动使用搜索结果";
    const autoHint = div("value", "仅搜索，不自动使用");
    autoHint.style.minWidth = "0";
    autoHint.style.flex = "1";
    autoHint.style.textAlign = "left";
    autoRow.appendChild(autoBtn);
    autoRow.appendChild(autoHint);
    searchSection.appendChild(autoRow);

    const actionRow = div("row");
    const importBtn = btn("btn btn-ghost", "导入本地字幕", () => fileInput.click());
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".srt,.vtt";
    fileInput.style.display = "none";
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (file) this.callbacks.onImportFile(file);
      fileInput.value = "";
    });
    actionRow.appendChild(importBtn);
    actionRow.appendChild(fileInput);
    if (this.currentSubtitle) {
      actionRow.appendChild(
        btn("btn btn-ghost", "关闭字幕", () => this.callbacks.onToggleSubtitle(false)),
      );
    }
    searchSection.appendChild(actionRow);
    pane.appendChild(searchSection);

    const online = this.renderOnlineResults();
    if (online) pane.appendChild(online);

    const cached = this.renderCachedList();
    if (cached) pane.appendChild(cached);

    return pane;
  }

  private renderOnlineResults(): HTMLElement | null {
    if (!this.progress) return null;

    const section = div("section");
    const title = div("section-title");
    title.appendChild(document.createTextNode(
      this.progress.done ? `在线结果（${this.progress.results.length}）` : "在线搜索结果…",
    ));
    section.appendChild(title);

    const states = Object.values(this.progress.providerStates);
    const stateRow = div("row");
    stateRow.style.flexWrap = "wrap";
    stateRow.style.gap = "4px";
    for (const state of states) {
      stateRow.appendChild(this.providerChip(state));
    }
    if (stateRow.childElementCount > 0) section.appendChild(stateRow);

    const allFailed =
      this.progress.done &&
      states.length > 0 &&
      states.every((s) => s.status === "error" || s.status === "timeout");
    // 全部失败且都是「环境发不出请求」时，普通用户看到的「搜索失败」没有可操作性。
    const networkUnavailable =
        allFailed && states.every((s) => s.errorCode === "NETWORK_UNAVAILABLE");

    if (this.progress.results.length === 0) {
      const message = !this.progress.done
        ? "正在搜索，请稍候…"
        : allFailed
          ? "所有字幕来源都搜索失败"
          : "没有搜索到字幕";
      const empty = div("empty", message);
      empty.style.marginTop = "8px";
      section.appendChild(empty);
      if (networkUnavailable) {
        const hint = div(
            "empty",
            "当前环境无法发起跨域请求（缺少 GM_xmlhttpRequest），通常是开发模式加载器导致。请安装构建产物 dist/115-subtitle-assistant.user.js 后重试。",
        );
        hint.style.marginTop = "4px";
        hint.style.fontSize = "11px";
        hint.style.lineHeight = "1.5";
        section.appendChild(hint);
      }
      return section;
    }

    for (const result of this.progress.results) {
      const meta = [
        providerManager.get(result.providerId)?.name ?? result.providerId,
        result.format.toUpperCase(),
        result.language,
        result.matchScore !== undefined ? `匹配 ${Math.round(result.matchScore)}` : undefined,
      ].filter(Boolean).join(" · ");

      section.appendChild(
        this.createSubtitleRow({
          title: result.title,
          meta,
          actions: [
            { label: "使用", primary: true, onClick: () => this.callbacks.onSelectResult(result) },
            { label: "查看", onClick: () => this.callbacks.onPreviewResult(result) },
            { label: "下载", onClick: () => this.callbacks.onDownloadResult(result) },
          ],
        }),
      );
    }

    return section;
  }

  private renderCachedList(): HTMLElement | null {
    if (this.cachedSubtitles.length === 0 && this.remoteSubtitles.length === 0) return null;

    const section = div("section");

    if (this.cachedSubtitles.length > 0) {
      section.appendChild(div("section-title", `已缓存（${this.cachedSubtitles.length}）`));
      for (const sub of this.cachedSubtitles) {
        const meta = `${sub.format.toUpperCase()} · ${sub.cueCount} 条 · ${formatSize(sub.rawBlob.size)} · ${providerManager.get(sub.providerId)?.name ?? sub.providerId}`;
        section.appendChild(
            this.createSubtitleRow({
              title: sub.title,
              meta,
              active: sub.id === this.currentSubtitleId,
              actions: [
                {label: "使用", primary: true, onClick: () => this.callbacks.onSelectCachedSubtitle(sub)},
                {
                  label: "查看", onClick: () => {
                    void this.previewCached(sub);
                  }
                },
                {label: "删除", danger: true, onClick: () => this.callbacks.onDeleteSubtitle(sub.id)},
              ],
            }),
        );
      }
    }

    if (this.remoteSubtitles.length > 0) {
      section.appendChild(div("section-title", `其他播放域名缓存（${this.remoteSubtitles.length}）`));
      section.appendChild(
          div("info", "来自其他 115 播放域名的索引；恢复时会重新下载字幕文件，不会复制本地 Blob。"),
      );
      for (const sub of this.remoteSubtitles) {
        const provider = providerManager.get(sub.providerId);
        const providerEnabled = this.settings?.providers[sub.providerId]?.enabled ?? true;
        const restorable = Boolean(sub.sourceResult && provider && providerEnabled);
        const providerName = provider?.name ?? sub.providerId;
        const meta = `${providerName} · ${sub.format.toUpperCase()} · ${sub.cueCount} 条 · ${formatSize(sub.size)} · ${sub.origin}`;
        section.appendChild(
            this.createSubtitleRow({
              title: sub.title,
              meta,
              actions: restorable
                  ? [{label: "恢复", primary: true, onClick: () => this.callbacks.onRestoreRemote(sub)}]
                  : [
                    {
                      label: "说明",
                      onClick: () =>
                          this.showToast(
                              !sub.sourceResult
                                  ? "这条字幕来自本地导入，无法在另一播放域名自动恢复；请在原域名使用或重新导入文件。"
                                  : "这条字幕的来源已禁用或不可用，启用对应字幕来源后才能恢复。",
                              "warn",
                          ),
                    },
                  ],
            }),
        );
      }
    }

    return section;
  }

  private async previewCached(record: SubtitleRecord): Promise<void> {
    // 预览用解析后的 Cue 重建：序号与时间轴合并在一行，字幕正文另起一行。
    // 只有解析结果为空时才回退到原始文件文本，避免出现空白弹层。
    let content = formatCuesWithTimestamps(record.cues);
    if (!content.trim()) {
      try {
        content = decodeRawSubtitle(await record.rawBlob.arrayBuffer(), record.encoding);
      } catch {
        content = "";
      }
    }
    this.showPreview(record.title, limitPreviewText(content.trim() ? content : "（无字幕内容）"));
  }

  private renderStyleTab(): HTMLElement {
    const pane = div("tab-pane");
    const style = this.settings?.style;

    if (!style) {
      pane.appendChild(div("empty", "设置尚未加载"));
      return pane;
    }

    const section = div("section");
    section.appendChild(div("section-title", "字幕样式"));

    section.appendChild(this.fontRow(normalizeFontFamily(style.fontFamily)));
    section.appendChild(this.sliderRow("字号", style.fontSize, 16, 72, 1, (v) => ({ fontSize: v })));
    section.appendChild(this.sliderRow("描边", style.outlineWidth, 0, 6, 1, (v) => ({ outlineWidth: v })));
    section.appendChild(this.sliderRow("垂直位置", style.yPercent, 20, 98, 1, (v) => ({ yPercent: v })));
    section.appendChild(this.sliderRow("水平位置", style.xPercent, 5, 95, 1, (v) => ({ xPercent: v })));
    section.appendChild(this.sliderRow("最大宽度", style.maxWidthPercent, 30, 100, 1, (v) => ({ maxWidthPercent: v })));
    section.appendChild(this.sliderRow("行间距", style.lineHeight, 1, 2.4, 0.1, (v) => ({ lineHeight: v })));
    section.appendChild(this.sliderRow("背景透明", style.backgroundOpacity, 0, 100, 1, (v) => ({ backgroundOpacity: v })));

    pane.appendChild(section);

    const colorSection = div("section");
    colorSection.appendChild(div("section-title", "颜色"));
    colorSection.appendChild(this.colorRow("字体颜色", style.color, (v) => ({ color: v })));
    colorSection.appendChild(this.colorRow("描边颜色", style.outlineColor, (v) => ({ outlineColor: v })));
    colorSection.appendChild(this.colorRow("背景颜色", style.backgroundColor, (v) => ({ backgroundColor: v })));
    pane.appendChild(colorSection);

    const toggleSection = div("section");
    const shadowRow = div("row");
    const shadowLabel = div("field-label", "文字阴影");
    const shadowToggle = btn("btn btn-ghost btn-sm", style.shadow ? "已开启" : "已关闭", () => {
      const next = !(this.settings?.style.shadow ?? true);
      shadowToggle.textContent = next ? "已开启" : "已关闭";
      this.callbacks.onStyleChange({ shadow: next });
    });
    shadowRow.appendChild(shadowLabel);
    shadowRow.appendChild(shadowToggle);
    toggleSection.appendChild(shadowRow);
    pane.appendChild(toggleSection);

    return pane;
  }

  private renderSyncTab(): HTMLElement {
    const pane = div("tab-pane");
    const sync = this.settings?.sync;
    const offset = sync?.offsetMs ?? 0;
    const step = sync?.stepMs ?? 500;

    const section = div("section");
    section.appendChild(div("section-title", "字幕时间偏移"));
    section.appendChild(div("info", "正值表示字幕延后，负值表示字幕提前。"));

    const row = div("row");
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "-10000";
    slider.max = "10000";
    slider.step = "100";
    slider.value = String(offset);
    slider.className = "slider";
    const value = div("value", formatOffset(offset));
    slider.addEventListener("input", () => {
      value.textContent = formatOffset(Number(slider.value));
      this.callbacks.onOffsetChange(Number(slider.value));
    });
    row.appendChild(slider);
    row.appendChild(value);
    section.appendChild(row);

    const stepRow = div("row");
    stepRow.appendChild(btn("btn btn-ghost btn-sm", `-${step}ms`, () => {
      this.callbacks.onOffsetChange((this.settings?.sync.offsetMs ?? 0) - step);
    }));
    stepRow.appendChild(btn("btn btn-ghost btn-sm", `+${step}ms`, () => {
      this.callbacks.onOffsetChange((this.settings?.sync.offsetMs ?? 0) + step);
    }));
    stepRow.appendChild(btn("btn btn-ghost btn-sm", "重置", () => this.callbacks.onOffsetChange(0)));
    section.appendChild(stepRow);

    pane.appendChild(section);
    return pane;
  }

  private renderCacheTab(): HTMLElement {
    const pane = div("tab-pane");
    const section = div("section");
    section.appendChild(div("section-title", "缓存管理"));

    const total = this.cacheSummary;
    const currentCount = this.cachedSubtitles.length;
    const remoteText =
        this.remoteSummary.count > 0
            ? `；其他播放域名 ${this.remoteSummary.count} 条 / ${formatSize(this.remoteSummary.bytes)}`
            : "";
    const summaryText =
        (total.count === currentCount
            ? `本地缓存共 ${total.count} 条字幕，共 ${formatSize(total.bytes)}`
            : `本地缓存共 ${total.count} 条字幕，共 ${formatSize(total.bytes)}；当前视频 ${currentCount} 条`) +
        remoteText;
    section.appendChild(div("info", summaryText));
    if (this.remoteSummary.count > 0) {
      section.appendChild(
          div("info", `已通过 GM 同步索引：${this.remoteSummary.origins.join("、")}`),
      );
    }

    if (currentCount > 0) {
      section.appendChild(div("section-title", "当前视频字幕"));
      for (const sub of this.cachedSubtitles) {
        section.appendChild(
            this.createSubtitleRow({
              title: sub.title,
              meta: `${sub.format.toUpperCase()} · ${sub.cueCount} 条 · ${formatSize(sub.rawBlob.size)}`,
              active: sub.id === this.currentSubtitleId,
              actions: [
                {label: "使用", primary: true, onClick: () => this.callbacks.onSelectCachedSubtitle(sub)},
                {label: "删除", danger: true, onClick: () => this.callbacks.onDeleteSubtitle(sub.id)},
              ],
            }),
        );
      }
    } else {
      section.appendChild(div("empty", "当前视频还没有缓存字幕"));
    }

    const dedupeRow = div("row");
    dedupeRow.appendChild(btn("btn btn-ghost btn-sm", "缓存字幕去重", () => {
      if (
          confirm(
              "将按番号合并缓存：同一番号只保留最新的一份字幕，较旧的记录会被删除。\n该操作不可撤销，确定继续？",
          )
      ) {
        this.callbacks.onDeduplicateCache();
      }
    }));
    const dedupeHint = div("value", "同一番号只保留最新");
    dedupeHint.style.minWidth = "0";
    dedupeHint.style.flex = "1";
    dedupeHint.style.textAlign = "left";
    dedupeRow.appendChild(dedupeHint);
    section.appendChild(dedupeRow);

    const clearRow = div("row");
    clearRow.appendChild(btn("btn btn-danger btn-sm", "清空全部缓存", () => {
      if (confirm("确定清空所有字幕缓存？该操作不可撤销。")) this.callbacks.onClearCache();
    }));
    const exportBtn = btn("btn btn-ghost btn-sm", "导出所有字幕", () => this.callbacks.onExportAll());
    exportBtn.disabled = total.count === 0;
    exportBtn.title = "将所有字幕打包为 115autosubtitle.zip";
    clearRow.appendChild(exportBtn);
    section.appendChild(clearRow);

    pane.appendChild(section);
    return pane;
  }

  private fontRow(current: string): HTMLElement {
    const row = div("row");
    row.appendChild(div("field-label", "字体"));

    const select = document.createElement("select");
    select.className = "input";
    select.setAttribute("aria-label", "字幕字体");

    for (const preset of FONT_PRESETS) {
      const option = document.createElement("option");
      option.value = preset.fontFamily;
      option.textContent = preset.label;
      select.appendChild(option);
    }

    // 旧配置里保存的可能是自定义/已下线的字体栈，保留为一项避免选择被静默改掉。
    if (!findFontPreset(current)) {
      const custom = document.createElement("option");
      custom.value = current;
      custom.textContent = `自定义（${current.split(",")[0].replace(/["']/g, "")}）`;
      select.appendChild(custom);
    }

    select.value = current;
    select.addEventListener("change", () => {
      this.callbacks.onStyleChange({fontFamily: select.value});
    });

    row.appendChild(select);
    return row;
  }

  private sliderRow(
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    toPatch: (value: number) => Partial<SubtitleStyleSettings>,
  ): HTMLElement {
    const row = div("row");
    row.appendChild(div("field-label", label));

    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "slider";
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);
    slider.value = String(value);

    const valueEl = div("value", String(value));
    slider.addEventListener("input", () => {
      const next = Number(slider.value);
      valueEl.textContent = String(next);
      this.callbacks.onStyleChange(toPatch(next));
    });

    row.appendChild(slider);
    row.appendChild(valueEl);
    return row;
  }

  private colorRow(
    label: string,
    value: string,
    toPatch: (value: string) => Partial<SubtitleStyleSettings>,
  ): HTMLElement {
    const row = div("row");
    row.appendChild(div("field-label", label));

    const input = document.createElement("input");
    input.type = "color";
    input.value = value;
    input.style.width = "44px";
    input.style.height = "26px";
    input.style.padding = "0";
    input.style.border = "1px solid #45475a";
    input.style.borderRadius = "6px";
    input.style.background = "#313244";
    input.addEventListener("change", () => this.callbacks.onStyleChange(toPatch(input.value)));

    const text = div("value", value.toUpperCase());
    text.style.minWidth = "70px";
    input.addEventListener("input", () => {
      text.textContent = input.value.toUpperCase();
    });

    row.appendChild(input);
    row.appendChild(text);
    return row;
  }

  private providerChip(state: ProviderState): HTMLElement {
    const name = providerManager.get(state.providerId)?.name ?? state.providerId;
    const { label, tone } = describeProviderState(state);
    const chip = document.createElement("span");
    chip.className = `chip chip-${tone}`;
    chip.textContent = `${name} ${label}`;
    if (state.errorMessage) chip.title = state.errorMessage;
    return chip;
  }

  private createSubtitleRow(opts: {
    title: string;
    meta: string;
    active?: boolean;
    actions: Array<{ label: string; primary?: boolean; danger?: boolean; onClick: () => void }>;
  }): HTMLElement {
    const active = opts.active === true;
    const row = div(`result${active ? " active" : ""}`);

    const head = div("result-head");
    const titleWrap = div("result-title-wrap");
    const titleEl = div("result-title", opts.title);
    // 超长文件名被省略后，悬停仍能看到完整名称。
    titleEl.title = opts.title;
    titleWrap.appendChild(titleEl);
    if (active) {
      const badge = document.createElement("span");
      badge.className = "badge-active";
      badge.textContent = "使用中";
      titleWrap.appendChild(badge);
    }
    head.appendChild(titleWrap);

    const actions = div("result-actions");
    for (const action of opts.actions) {
      const classes = ["btn", "btn-sm"];
      if (action.primary) classes.push("btn-ghost");
      if (action.danger) classes.push("btn-danger");
      // 当前字幕的「使用」按钮改成不可点的「已使用」，
      // 避免用户重复点击后仍不确定到底有没有生效。
      const alreadyActive = active && action.primary;
      if (alreadyActive) classes.push("btn-active");
      const button = btn(classes.join(" "), alreadyActive ? "已使用" : action.label, action.onClick);
      if (alreadyActive) button.disabled = true;
      actions.appendChild(button);
    }
    head.appendChild(actions);
    row.appendChild(head);
    row.appendChild(div("result-meta", opts.meta));
    return row;
  }

  /**
   * 底部浮层提示。用于「使用」之后给出明确反馈：
   * 字幕已生效，但当前暂停点可能正好落在两条字幕的间隙里。
   */
  showToast(message: string, tone: "success" | "warn" = "success"): void {
    if (!this.root) return;
    this.clearToast();

    const el = div(tone === "warn" ? "toast warn" : "toast", message);
    this.root.appendChild(el);
    this.toastEl = el;
    // 强制一次重排，让 opacity/transform 过渡真正生效。
    void el.offsetWidth;
    el.classList.add("show");

    this.toastTimer = window.setTimeout(() => {
      el.classList.remove("show");
      this.toastTimer = window.setTimeout(() => {
        el.remove();
        if (this.toastEl === el) this.toastEl = null;
        this.toastTimer = null;
      }, 200);
    }, 2600);
  }

  private clearToast(): void {
    if (this.toastTimer !== null) {
      window.clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    this.toastEl?.remove();
    this.toastEl = null;
  }

  private strong(text: string): HTMLElement {
    const el = document.createElement("b");
    el.textContent = text;
    return el;
  }

  /**
   * 面板锚定在 `CC` 按钮上方。
   *
   * 不能只用 `bottom` 定位：115 的控制栏会自动隐藏，隐藏时按钮的
   * `getBoundingClientRect()` 会退化（top/height 接近 0），按 `bottom` 计算会把
   * 整个面板推到视口上方（实测 y = -429）。这里统一用 `top/left` 计算并做视口钳制，
   * 上方放不下时改为向按钮下方展开。
   */
  private positionPanel(): void {
    const panel = this.panelEl;
    if (!panel) return;

    const margin = 8;
    const width = panel.offsetWidth || 400;
    const height = panel.offsetHeight || 420;
    const anchor = this.nativeToggle?.anchor;
    const anchorRect = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
    const hasAnchor = !!anchorRect && anchorRect.width > 0 && anchorRect.height > 0;

    if (hasAnchor && anchorRect) {
      this.lastAnchorRect = {
        right: anchorRect.right,
        top: anchorRect.top,
        bottom: anchorRect.bottom,
      };
    }

    // 控制栏隐藏时按钮 rect 不可用，退回最近一次有效锚点，避免面板跳到角落。
    const usable = hasAnchor && anchorRect
        ? {right: anchorRect.right, top: anchorRect.top, bottom: anchorRect.bottom}
        : this.lastAnchorRect;

    let left: number;
    let top: number;

    if (usable) {
      left = usable.right - width;
      top = usable.top - height - 10;
      // 上方空间不足时改为向下展开。
      if (top < margin) top = usable.bottom + 10;
    } else {
      left = window.innerWidth - width - 16;
      top = window.innerHeight - height - 16;
    }

    left = Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - width - margin));
    top = Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - height - margin));

    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }

  private teardownPlayerControls(): void {
    this.playerBarObserver?.disconnect();
    this.playerBarObserver = null;
    this.nativeToggle?.container.remove();
    this.nativeToggle = null;
    this.lastAnchorRect = null;
    this.playerRoot = null;
  }

  dispose(): void {
    this.teardownPlayerControls();
    document.removeEventListener("pointerdown", this.handleDocumentPointerDown, true);
    document.removeEventListener("keydown", this.handleDocumentKeyDown, true);
    window.removeEventListener("resize", this.handleViewportChange);
    window.removeEventListener("scroll", this.handleViewportChange, true);
    this.closePreview();
    this.clearToast();
    this.container?.remove();
    this.container = null;
    this.host = null;
    this.root = null;
    this.panelEl = null;
    this.bodyEl = null;
    this.tabEls.clear();
    this.statusPill = null;
  }
}

function describeProviderState(state: ProviderState): { label: string; tone: "success" | "error" | "busy" } {
  switch (state.status) {
    case "success":
      return { label: `✓ ${state.resultCount}`, tone: "success" };
    case "no-results":
      return { label: "无结果", tone: "success" };
    case "error":
      return { label: "失败", tone: "error" };
    case "timeout":
      return { label: "超时", tone: "error" };
    case "pending":
      return { label: "等待", tone: "busy" };
    case "searching":
    default:
      return { label: "搜索中", tone: "busy" };
  }
}

function formatOffset(offsetMs: number): string {
  const sign = offsetMs > 0 ? "+" : "";
  return `${sign}${(offsetMs / 1000).toFixed(1)}s`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function sourceLabel(source: VideoIdentity["source"]): string {
  switch (source) {
    case "115-dom":
      return "115 页面";
    case "media-element":
      return "播放器";
    case "manual":
      return "手动";
    default:
      return source;
  }
}
