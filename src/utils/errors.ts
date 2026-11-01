export type SubtitleErrorCode =
  | "PLAYER_NOT_FOUND"
  | "VIDEO_METADATA_UNAVAILABLE"
  | "CODE_NOT_FOUND"
  | "PROVIDER_DISABLED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_NETWORK_ERROR"
  | "PROVIDER_BAD_RESPONSE"
  | "NO_RESULTS"
  | "DOWNLOAD_FAILED"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_FORMAT"
  | "DECODE_FAILED"
  | "PARSE_FAILED"
  | "CACHE_QUOTA_EXCEEDED"
  | "CACHE_READ_FAILED"
  | "CACHE_WRITE_FAILED"
  | "FULLSCREEN_OVERLAY_UNSUPPORTED";

export class SubtitleError extends Error {
  readonly code: SubtitleErrorCode;
  readonly cause?: unknown;

  constructor(code: SubtitleErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "SubtitleError";
    this.code = code;
    this.cause = cause;
  }
}

export function isSubtitleError(error: unknown): error is SubtitleError {
  return error instanceof SubtitleError;
}