export interface PlayerMetadata {
  platform: "115";
  fileId?: string;
  fileName?: string;
  duration?: number;
  width?: number;
  height?: number;
  sourcePageUrl: string;
}

export interface PlayerContext {
  video: HTMLVideoElement;
  playerRoot: HTMLElement;
  overlayHost: HTMLElement;
  metadata: PlayerMetadata;
}

export interface PlayerAdapter {
  readonly id: string;
  detect(): PlayerContext | null;
  observe(onChange: (context: PlayerContext | null) => void): () => void;
}

export type PlayerState =
  | "waiting"
  | "attached"
  | "metadata-ready"
  | "video-changed"
  | "detached"
  | "error";