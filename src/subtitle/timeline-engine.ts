import type { SubtitleCue } from "./subtitle-model";
import { isFiniteNumber } from "../utils/number";

export class SubtitleTimelineEngine {
  private cues: SubtitleCue[] = [];
  private sortedCues: SubtitleCue[] = [];
  /** prefixMaxEnd[i] = sortedCues[0..i] 中最大的 endMs，用于安全地向前回溯重叠 Cue。 */
  private prefixMaxEnd: number[] = [];
  private offsetMs = 0;

  load(cues: SubtitleCue[]): void {
    this.cues = cues;
    this.sortedCues = [...cues].sort((a, b) => a.startMs - b.startMs);
    this.prefixMaxEnd = [];
    let maxEnd = -Infinity;
    for (const cue of this.sortedCues) {
      if (cue.endMs > maxEnd) maxEnd = cue.endMs;
      this.prefixMaxEnd.push(maxEnd);
    }
  }

  setOffset(offsetMs: number): void {
    this.offsetMs = offsetMs;
  }

  update(videoTimeSeconds: number): SubtitleCue[] {
    if (!isFiniteNumber(videoTimeSeconds) || videoTimeSeconds < 0) {
      return [];
    }
    const t = videoTimeSeconds * 1000 - this.offsetMs;
    return this.findActiveCues(t);
  }

  private findActiveCues(t: number): SubtitleCue[] {
    if (this.sortedCues.length === 0) return [];

    const idx = this.binarySearch(t);
    if (idx < 0) return [];

    const result: SubtitleCue[] = [];
    // 向前回溯：只要前缀最大结束时间还覆盖 t，就可能存在更早开始、但更晚结束的长 Cue。
    // 这里不能用 `endMs <= t` 直接 break，否则“0-2h 的长 Cue + 5-8s 的短 Cue”会漏掉长 Cue。
    for (let i = idx; i >= 0; i--) {
      if (this.prefixMaxEnd[i] <= t) break;
      const cue = this.sortedCues[i];
      if (cue.startMs <= t && cue.endMs > t) result.push(cue);
    }

    for (let i = idx + 1; i < this.sortedCues.length; i++) {
      const cue = this.sortedCues[i];
      if (cue.startMs > t) break;
      if (cue.endMs <= t) continue;
      result.push(cue);
    }

    result.sort((a, b) => a.sourceOrder - b.sourceOrder);
    return result;
  }

  private binarySearch(t: number): number {
    let lo = 0;
    let hi = this.sortedCues.length - 1;
    let result = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.sortedCues[mid].startMs <= t) {
        result = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return result;
  }

  clear(): void {
    this.cues = [];
    this.sortedCues = [];
    this.prefixMaxEnd = [];
    this.offsetMs = 0;
  }

  dispose(): void {
    this.clear();
  }
}