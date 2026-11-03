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
  }

  setCues(cues: SubtitleCue[]): void {
    const same = cues.length === this.currentCues.length &&
      cues.every((c, i) => c.id === this.currentCues[i]?.id);
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
        pointer-events: none;
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

  dispose(): void {
    this.unmount();
  }
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}