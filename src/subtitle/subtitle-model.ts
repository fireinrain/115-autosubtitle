export type SubtitleFormat = "srt" | "vtt" | "ass" | "ssa" | "unknown";

export interface SubtitleSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
}

export interface CueRegion {
  vertical?: "top" | "middle" | "bottom";
  horizontal?: "left" | "center" | "right";
  line?: number | string;
}

export interface SubtitleCue {
  id: number;
  startMs: number;
  endMs: number;
  text: string;
  segments?: SubtitleSegment[];
  region?: CueRegion;
  sourceOrder: number;
}

export interface ParsedSubtitle {
  format: SubtitleFormat;
  encoding: string;
  cues: SubtitleCue[];
  warnings: string[];
}