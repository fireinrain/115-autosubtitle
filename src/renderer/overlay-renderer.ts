import type { SubtitleCue } from "../subtitle/subtitle-model";
import type { SubtitleStyleSettings } from "../settings/settings-service";
import {normalizeFontFamily} from "../settings/font-presets";
import { logger } from "../utils/logger";

export class OverlayRenderer {
  private host: HTMLElement | null = null;
  private container: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private stage: HTMLElement | null = null;
  private styleEl: HTMLStyleElement | null = null;
  private currentCues: SubtitleCue[] = [];
  private currentStyle: SubtitleStyleSettings | null = null;
  private visible = true;
    private positioning = false;
    private onPositionCommit: ((xPercent: number, yPercent: number) => void) | null = null;
    private pointerDrag: {
        pointerId: number;
        offsetX: number;
        offsetY: number;
        xPercent: number;
        yPercent: number;
    } | null = null;

  mount(host: HTMLElement): void {
    if (this.host === host && this.container?.isConnected) return;
    this.unmount();

    this.host = host;
    const container = document.createElement("div");
    container.className = "userscript-subtitle-root";
    container.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:9999;overflow:hidden;";
    container.style.display = this.visible ? "block" : "none";

    this.root = container.attachShadow({ mode: "open" });
    this.styleEl = document.createElement("style");
    this.root.appendChild(this.styleEl);

    this.stage = document.createElement("div");
    this.stage.className = "subtitle-stage";
      this.stage.addEventListener("pointerdown", this.handlePointerDown);
      this.stage.addEventListener("pointermove", this.handlePointerMove);
      this.stage.addEventListener("pointerup", this.handlePointerUp);
      this.stage.addEventListener("pointercancel", this.handlePointerUp);
    this.root.appendChild(this.stage);

    host.appendChild(container);
    this.container = container;
    logger.debug("Overlay mounted");
  }

  unmount(): void {
    this.container?.remove();
    this.container = null;
    this.host = null;
    this.root = null;
    this.stage = null;
    this.styleEl = null;
    this.currentCues = [];
      this.pointerDrag = null;
      this.positioning = false;
      this.onPositionCommit = null;
  }

  setCues(cues: SubtitleCue[]): void {
      // Cue 的 id 是按文件内顺序生成的，两个不同字幕文件很容易出现相同的
      // 0..N-1。这里必须比较对象身份，否则切换字幕时会被误判为“没有变化”，
      // overlay 继续显示上一条字幕。
    const same = cues.length === this.currentCues.length &&
        cues.every((cue, index) => cue === this.currentCues[index]);
    if (same) return;
    this.currentCues = cues;
    if (this.visible) this.render();
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (this.container) {
      this.container.style.display = visible ? "block" : "none";
    }
    if (visible) this.render();
  }

  isVisible(): boolean {
    return this.visible;
  }

    /**
     * 进入拖动定位模式。
     *
     * 正常播放时 overlay 必须保持 pointer-events:none，不能拦截播放器点击；
     * 只有用户显式开启定位模式后，字幕舞台才接收指针事件。
     */
    setPositioningMode(
        enabled: boolean,
        onCommit?: (xPercent: number, yPercent: number) => void,
    ): void {
        this.positioning = enabled;
        this.onPositionCommit = onCommit ?? null;
        if (!enabled) this.pointerDrag = null;
        if (this.stage) {
            this.stage.style.cursor = enabled ? "move" : "";
            this.stage.style.pointerEvents = enabled ? "auto" : "none";
        }
        this.applyStyle();
        this.render();
    }

    isPositioningMode(): boolean {
        return this.positioning;
    }

  setStyle(style: SubtitleStyleSettings): void {
    this.currentStyle = style;
    this.applyStyle();
    this.render();
  }

  private applyStyle(): void {
    if (!this.styleEl || !this.currentStyle || !this.stage) return;
    const s = this.currentStyle;
    this.styleEl.textContent = `
      .subtitle-stage {
        position: absolute;
        left: ${s.xPercent}%;
        top: ${s.yPercent}%;
        transform: translate(-50%, -50%);
        max-width: ${s.maxWidthPercent}%;
        width: max-content;
        text-align: center;
        pointer-events: ${this.positioning ? "auto" : "none"};
        cursor: ${this.positioning ? "move" : "default"};
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
      }
      .subtitle-line {
        /* 字幕用中文字幕字体栈，避免中文回退到西文字体后字形发虚、字重不统一。 */
        font-family: ${normalizeFontFamily(s.fontFamily)};
        font-size: ${s.fontSize}px;
        font-weight: ${s.fontWeight};
        color: ${s.color};
        line-height: ${s.lineHeight};
        letter-spacing: 0.02em;
        white-space: pre-wrap;
        text-shadow: ${s.shadow ? `0 2px 4px rgba(0,0,0,0.85), 0 0 8px rgba(0,0,0,0.55)` : "none"};
        -webkit-text-stroke: ${s.outlineWidth}px ${s.outlineColor};
        paint-order: stroke fill;
        background-color: ${s.backgroundOpacity > 0 ? hexToRgba(s.backgroundColor, s.backgroundOpacity / 100) : "transparent"};
        padding: ${s.backgroundOpacity > 0 ? "4px 8px" : "0"};
        border-radius: 4px;
      }
      .seg-bold { font-weight: 700; }
      .seg-italic { font-style: italic; }
      .seg-underline { text-decoration: underline; }
    `;
  }

  private render(): void {
    if (!this.stage || !this.visible) return;
    this.stage.replaceChildren();

      // 当前时间点没有字幕时，定位模式仍需要一个可见的拖动手柄。
      if (this.positioning && this.currentCues.length === 0) {
          const placeholder = document.createElement("div");
          placeholder.className = "subtitle-line";
          placeholder.textContent = "拖动字幕调整位置";
          this.stage.appendChild(placeholder);
          return;
      }

    for (const cue of this.currentCues) {
      const line = document.createElement("div");
      line.className = "subtitle-line";

      if (cue.segments && cue.segments.length > 0) {
        for (const seg of cue.segments) {
          const span = document.createElement("span");
          const classes: string[] = [];
          if (seg.bold) classes.push("seg-bold");
          if (seg.italic) classes.push("seg-italic");
          if (seg.underline) classes.push("seg-underline");
          if (classes.length) span.className = classes.join(" ");
          if (seg.color) span.style.color = seg.color;
          span.textContent = seg.text;
          line.appendChild(span);
        }
      } else {
        line.textContent = cue.text;
      }

      this.stage.appendChild(line);
    }
  }

    private handlePointerDown = (event: PointerEvent): void => {
        if (!this.positioning || !this.stage || !this.host) return;
        if (event.button !== 0) return;
        const hostRect = this.host.getBoundingClientRect();
        const stageRect = this.stage.getBoundingClientRect();
        if (hostRect.width <= 0 || hostRect.height <= 0) return;

        event.preventDefault();
        event.stopPropagation();
        this.stage.setPointerCapture(event.pointerId);
        this.pointerDrag = {
            pointerId: event.pointerId,
            offsetX: event.clientX - (stageRect.left + stageRect.width / 2),
            offsetY: event.clientY - (stageRect.top + stageRect.height / 2),
            xPercent: this.currentStyle?.xPercent ?? 50,
            yPercent: this.currentStyle?.yPercent ?? 88,
        };
    };

    private handlePointerMove = (event: PointerEvent): void => {
        const drag = this.pointerDrag;
        if (!drag || drag.pointerId !== event.pointerId || !this.stage || !this.host) return;
        const hostRect = this.host.getBoundingClientRect();
        if (hostRect.width <= 0 || hostRect.height <= 0) return;

        event.preventDefault();
        event.stopPropagation();
        const xPercent = clampPercent(
            ((event.clientX - drag.offsetX - hostRect.left) / hostRect.width) * 100,
            5,
            95,
        );
        const yPercent = clampPercent(
            ((event.clientY - drag.offsetY - hostRect.top) / hostRect.height) * 100,
            20,
            98,
        );
        drag.xPercent = xPercent;
        drag.yPercent = yPercent;
        this.stage.style.left = `${xPercent}%`;
        this.stage.style.top = `${yPercent}%`;
    };

    private handlePointerUp = (event: PointerEvent): void => {
        const drag = this.pointerDrag;
        if (!drag || drag.pointerId !== event.pointerId) return;
        this.pointerDrag = null;
        if (this.stage?.hasPointerCapture(event.pointerId)) {
            this.stage.releasePointerCapture(event.pointerId);
        }
        event.preventDefault();
        event.stopPropagation();
        this.onPositionCommit?.(drag.xPercent, drag.yPercent);
    };

  dispose(): void {
    this.unmount();
  }
}

function clampPercent(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}