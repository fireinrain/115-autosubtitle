import { m115VideoAdapter } from "../player/m115-video-adapter";
import { PlayerController } from "../player/player-controller";
import { SubtitlePanel } from "../ui/panel";
import { settingsService, type GlobalSettings } from "../settings/settings-service";
import { subtitleRepository } from "../storage/subtitle-repository";
import { subtitleSearchEngine } from "../search/search-engine";
import { providerManager } from "../search/provider-manager";
import type { SearchProgress } from "../search/provider-manager";
import {parseSubtitle, detectFormat, PARSER_VERSION} from "../subtitle/parsers";
import {
  decodeRawSubtitle,
  formatCuesWithTimestamps,
  limitPreviewText,
} from "../subtitle/preview";
import { localFileProvider } from "../providers/local-provider";
import { computeChecksum, uuid } from "../utils/hash";
import { logger } from "../utils/logger";
import type { SubtitleSearchResult } from "../providers/provider";
import type { SubtitleCue } from "../subtitle/subtitle-model";
import type { SubtitleRecord } from "../storage/database";
import type {VideoIdentity} from "../identity/video-identity";
import {buildSubtitleZip} from "../storage/subtitle-zip";
import {metadataSync, fileIdFromVideoKey, type RemoteSubtitleMeta} from "../storage/metadata-sync";
import {autoSearchCache, buildAutoSearchCacheKey} from "../search/search-cache";
import { isSubtitleError } from "../utils/errors";

export async function bootstrap(): Promise<void> {
  logger.info("115 Subtitle Assistant 启动中...");

  const settings = await settingsService.load();
  logger.setEnabled(settings.debug);

  if (!settings.enabled) {
    logger.info("字幕助手已在设置中禁用");
    return;
  }

  const adapter = m115VideoAdapter;
  const panel = new SubtitlePanel({
    onImportFile: (file) => handleImportFile(file),
    onSearch: (code) => void handleManualSearch(code),
    onSelectResult: (result) => handleSelectResult(result),
    onPreviewResult: (result) => handlePreviewResult(result),
    onDownloadResult: (result) => handleDownloadResult(result),
    onSelectCachedSubtitle: (record) => handleSelectCachedSubtitle(record),
    onRestoreRemote: (meta) => void handleRestoreRemote(meta),
    onStyleChange: (patch) => handleStyleChange(patch),
    onOffsetChange: (offsetMs) => handleOffsetChange(offsetMs),
    onToggleSubtitle: (enabled) => {
      controller.setSubtitleVisible(enabled);
      panel.setSubtitleVisible(enabled);
    },
    onAutoSearchChange: (enabled) => void handleAutoSearchChange(enabled),
    onShortcutChange: (enabled) => void handleShortcutChange(enabled),
    onClearCache: () => handleClearCache(),
    onDeleteSubtitle: (id) => handleDeleteSubtitle(id),
    onCleanupCache: () => void handleCleanupCache(),
    onDeduplicateCache: () => void handleDeduplicateCache(),
    onExportAll: () => void handleExportAll(),
    onRefreshSync: () => void handleRefreshSync(),
    onClearRemoteSync: () => void handleClearRemoteSync(),
    onPositioningChange: (enabled) => handlePositioningChange(enabled),
    onCheckProviders: () => void handleCheckProviders(),
    onBackfillSources: () => void handleBackfillSources(),
  });

  let lastAutoSearchKey = "";
  let autoSearchGeneration = 0;
  /** 每次真正切换文件都会自增；用于丢弃跨视频的旧搜索响应（即使又切回同一视频）。 */
  let searchEpoch = 0;
  let currentSettings = settings;
  /** 当前面板代表的具体文件；用于区分「同一视频身份补全」与「真的切换了视频」。 */
  let lastVideoToken = "";
  /** 用户为该视频手动修正的番号；切换视频时清空，不继承。 */
  let currentManualCode = "";
  let manualCodeLoadedFor = "";
  /** 当前视频本地缓存 ID，用于过滤远程索引中的重复项。 */
  let localSubtitleIds = new Set<string>();
  /** 已经尝试过跨播放域名恢复的文件，避免身份补全时重复下载。 */
  let lastRemoteRestoreToken = "";
  /** 当前搜索的 AbortController；切换视频/发起新搜索时取消旧请求。 */
  let activeSearchAbort: AbortController | null = null;
  let searchRequestId = 0;
  /** 所有在途下载；切换视频时统一取消，避免下载完成后挂到新视频上。 */
  const activeDownloads = new Set<AbortController>();

  function beginDownload(): AbortController {
    const controller = new AbortController();
    activeDownloads.add(controller);
    return controller;
  }

  function endDownload(controller: AbortController): void {
    activeDownloads.delete(controller);
  }

  function abortActiveRequests(): void {
    activeSearchAbort?.abort();
    activeSearchAbort = null;
    for (const controller of activeDownloads) controller.abort();
    activeDownloads.clear();
  }

  /** 用户可见的错误统一走非阻塞 toast，避免 alert 阻断播放器与键盘操作。 */
  function showWarning(message: string): void {
    panel.showToast(message, "warn");
  }

  /** 视频文件身份 token：优先 115 文件 ID，缺失时退回 videoKey。 */
  function identityToken(identity: VideoIdentity | null): string {
    if (!identity) return "";
    return identity.fileId ? `id:${identity.fileId}` : identity.videoKey;
  }

  /** 把本地缓存索引写入 GM 存储，供另一个 115 播放域名读取。 */
  let publishTimer: number | null = null;
  let lastCacheCheckAt = 0;

  function publishMetadata(): void {
    // 连续操作（保存、选中、替换）合并成一次发布，避免重复扫描缓存和写 GM。
    if (publishTimer !== null) window.clearTimeout(publishTimer);
    publishTimer = window.setTimeout(() => {
      publishTimer = null;
      void metadataSync.publish();
    }, 300);
  }

  async function publishMetadataNow(): Promise<void> {
    if (publishTimer !== null) {
      window.clearTimeout(publishTimer);
      publishTimer = null;
    }
    await metadataSync.publish();
  }

  const controller = new PlayerController(adapter, {
    onVideoChange: (identity) => {
      autoSearchGeneration++;
      const token = identityToken(identity);
      if (token !== lastVideoToken) {
        lastVideoToken = token;
        lastAutoSearchKey = "";
        lastRemoteRestoreToken = "";
        currentManualCode = "";
        manualCodeLoadedFor = "";
        searchEpoch++;
        abortActiveRequests();
        controller.setPositioningMode(false);
        panel.setPositioning(false);
        // 上一个视频的在线结果不能带到新视频；即使旧请求还没结束，
        // handleSearch 的过期检查也会丢弃它后续的进度和结果。
        panel.setProgress(null);
      }
      panel.setIdentity(identity);
      if (currentManualCode) {
        panel.setIdentity({...identity, code: currentManualCode, source: "manual"});
      }
      void refreshCacheList();
      void loadManualCode(identity);
      // 自动搜索不在这里触发：必须等缓存恢复流程结束，
      // 否则「先恢复缓存 → 没有缓存才搜索」会变成每次进视频都先搜一遍。
    },
    onPlayerContextAttached: (ctx) => {
      panel.mountPlayerControls(ctx.playerRoot);
      panel.setSubtitleVisible(controller.getSubtitleVisible());
    },
    onSubtitleLoaded: (title, subtitleId) => {
      panel.setCurrentSubtitle(title, subtitleId);
      void refreshCacheList();
    },
    onSubtitleCleared: () => {
      panel.setCurrentSubtitle(null);
    },
    onCacheRestoreSettled: (identity, restored) => {
      if (!restored) void handleCacheMiss(identity);
    },
    resolveCachedSubtitle: (record) => ensureCurrentParser(record),
    onOverlayUnsupported: (reason) => {
      panel.showToast(`${reason}；请退出全屏或使用网页全屏`, "warn");
    },
    onPositionChange: (xPercent, yPercent) => {
      void handleStyleChange({
        xPercent: Math.round(xPercent * 10) / 10,
        yPercent: Math.round(yPercent * 10) / 10,
      }).then(() => panel.setSettings(currentSettings, true));
    },
  });

  controller.setSettings(settings);
  panel.setSettings(settings);
  panel.setSubtitleVisible(controller.getSubtitleVisible());
  panel.mount();
  controller.start();
  void refreshCacheList();
  publishMetadata();

  // 跨播放域名索引没有实时事件；面板打开时每 15s 轻量读取一次 GM。
  let syncWatchTimer: number | null = null;
  metadataSync.watch(() => {
    if (!panel.isOpen()) return;
    if (syncWatchTimer !== null) window.clearTimeout(syncWatchTimer);
    syncWatchTimer = window.setTimeout(() => {
      syncWatchTimer = null;
      refreshRemoteCache();
    }, 150);
  });
  window.setInterval(() => {
    if (document.visibilityState === "visible" && panel.isOpen()) refreshRemoteCache();
  }, 15000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && panel.isOpen()) refreshRemoteCache();
  });

  /**
   * 统一的「使用字幕」入口。
   *
   * 字幕生效 ≠ 立刻看得见：如果用户正好暂停在两条字幕之间，overlay 会是空的。
   * 这里在应用后检查当前时间点是否命中 Cue，并用 toast 明确告知，
   * 避免用户误以为「点击使用没反应」。
   */
  function applySubtitle(
      title: string,
      subtitleId: string | null,
      cues: SubtitleCue[],
      note?: string,
  ): void {
    controller.selectSubtitle(subtitleId, cues);
    controller.setSubtitleVisible(true);
    panel.setSubtitleVisible(true);
    panel.setCurrentSubtitle(title, subtitleId);
    logger.info(`应用字幕：${title}（${cues.length} 条）`);

    const activeCount = controller.getActiveCueCount();
    const hasCueNow = activeCount > 0;
    const suffix = note ? `（${note}）` : "";
    panel.showToast(
      hasCueNow
          ? `已使用：${title}${suffix}`
          : `已使用：${title}${suffix}（当前时间点没有字幕，拖动进度条查看）`,
      hasCueNow ? "success" : "warn",
    );
  }

  /**
   * 解析器版本升级后，用缓存的原始 Blob 重新解析，避免强制重新下载。
   * 解析失败时保留原记录，下一次使用还会再尝试，不会破坏用户数据。
   */
  async function ensureCurrentParser(record: SubtitleRecord): Promise<SubtitleRecord> {
    if (record.parserVersion >= PARSER_VERSION) return record;
    if (record.format === "ass" || record.format === "ssa") return record;
    try {
      const bytes = await record.rawBlob.arrayBuffer();
      const parsed = parseSubtitle(bytes, record.format, record.encoding);
      const updated: SubtitleRecord = {
        ...record,
        cues: parsed.cues,
        cueCount: parsed.cues.length,
        encoding: parsed.encoding,
        parserVersion: PARSER_VERSION,
      };
      await subtitleRepository.save(updated);
      logger.info(`已按解析器 v${PARSER_VERSION} 重新解析缓存字幕：${record.title}`);
      return updated;
    } catch (e) {
      logger.warn(`重新解析缓存字幕失败，保留原记录：${record.title}`, e);
      return record;
    }
  }

  /**
   * 加载当前视频保存的手动番号。手动值优先于自动识别，但不跨视频继承。
   */
  async function loadManualCode(identity: VideoIdentity): Promise<void> {
    if (!identity.videoKey || manualCodeLoadedFor === identity.videoKey) return;
    manualCodeLoadedFor = identity.videoKey;
    try {
      const record = await subtitleRepository.getVideoRecord(identity.videoKey);
      const current = controller.getCurrentIdentity();
      if (!current || current.videoKey !== identity.videoKey) return;
      if (record?.codeSource === "manual" && record.code) {
        currentManualCode = record.code;
        panel.setIdentity({...current, code: record.code, source: "manual"});
      }
    } catch (e) {
      logger.warn("读取手动番号失败", e);
    }
  }

  /** 等身份补全后把手动番号绑定到强 videoKey，避免写到弱 key 上。 */
  async function persistManualCode(identity: VideoIdentity, code: string): Promise<void> {
    const token = identityToken(identity);
    const stable = await waitForStableIdentity(token, 3000);
    if (!stable || identityToken(controller.getCurrentIdentity()) !== token) return;
    try {
      await subtitleRepository.setManualCode(stable.videoKey, code);
      manualCodeLoadedFor = stable.videoKey;
      publishMetadata();
    } catch (e) {
      logger.warn("保存手动番号失败", e);
    }
  }

  async function handleManualSearch(code: string): Promise<void> {
    const trimmed = code.trim();
    if (!trimmed) {
      showWarning("请输入番号");
      return;
    }
    const identity = controller.getCurrentIdentity();
    const autoCode = identity?.code ?? "";
    // 只是点“搜索”确认自动识别结果时，不把它误标成手动修正。
    const isManualCorrection = !autoCode || trimmed.toUpperCase() !== autoCode.toUpperCase();
    if (identity && isManualCorrection) {
      currentManualCode = trimmed;
      panel.setIdentity({...identity, code: trimmed, source: "manual"});
      void persistManualCode(identity, trimmed);
    }
    lastAutoSearchKey = "";
    // 手动搜索始终重新请求，并跳过来源失败冷却；成功结果会覆盖自动搜索 TTL。
    await handleSearch(trimmed, identity, {cacheResults: true, forceProviders: true});
  }

  /**
   * 使用新字幕后删除同番号旧缓存，保持「一个番号一份字幕」。
   * 替换失败不阻塞新字幕生效，只记录错误。
   */
  async function replaceCachedByCode(code: string, keepId: string): Promise<number> {
    if (!code) return 0;
    try {
      const result = await subtitleRepository.replaceByCode(code, keepId);
      if (result.removed > 0) {
        logger.info(`已替换同番号旧缓存：删除 ${result.removed} 条`);
      }
      return result.removed;
    } catch (e) {
      logger.error("替换同番号旧缓存失败", e);
      return 0;
    }
  }

  async function handleImportFile(file: File): Promise<void> {
    try {
      const { bytes, fileName } = await localFileProvider.fromFile(file);
      const format = detectFormat(fileName);
      if (format === "unknown") {
        showWarning("不支持的字幕格式");
        return;
      }
      if (format === "ass" || format === "ssa") {
        showWarning("暂不支持 ASS/SSA 字幕解析，请导入 SRT/VTT 文件。");
        return;
      }
      const parsed = parseSubtitle(bytes, format);
      const identity = controller.getCurrentIdentity();
      if (!identity) {
        showWarning("未检测到视频");
        return;
      }

      const checksum = await computeChecksum(bytes);
      const duplicate = await subtitleRepository.findByChecksum(identity.videoKey, checksum);
      if (duplicate) {
        const current = await ensureCurrentParser(duplicate);
        await subtitleRepository.setSelectedForVideo(identity.videoKey, current.id);
        applySubtitle(current.title, current.id, current.cues, "缓存命中");
        void refreshCacheList();
        publishMetadata();
        return;
      }
      const record: SubtitleRecord = {
        id: uuid(),
        videoKey: identity.videoKey,
        code: currentManualCode || identity.code || "",
        providerId: "local",
        title: fileName,
        format,
        rawBlob: new Blob([bytes]),
        encoding: parsed.encoding,
        cues: parsed.cues,
        cueCount: parsed.cues.length,
        checksum,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        parserVersion: PARSER_VERSION,
      };

      await subtitleRepository.save(record);
      const replaced = await replaceCachedByCode(record.code, record.id);
      await subtitleRepository.setSelectedForVideo(identity.videoKey, record.id);
      applySubtitle(
          fileName,
          record.id,
          parsed.cues,
          replaced > 0 ? `已替换同番号旧缓存 ${replaced} 条` : undefined,
      );
      void refreshCacheList();
      publishMetadata();
      void enforceCacheLimit();
      logger.info(`已加载本地字幕：${fileName}（${parsed.cues.length} 条）`);
    } catch (e) {
      const msg = isSubtitleError(e) ? e.message : "导入字幕失败";
      showWarning(msg);
      logger.error("导入字幕失败", e);
    }
  }

  async function handleSearch(
      code: string,
      origin: VideoIdentity | null = controller.getCurrentIdentity(),
      options: { cacheResults?: boolean; forceProviders?: boolean } = {},
  ): Promise<SubtitleSearchResult[]> {
    if (!code) {
      showWarning("请输入番号");
      return [];
    }

    // 新搜索会取消旧搜索，避免两个请求同时回填面板。
    activeSearchAbort?.abort();
    const abort = new AbortController();
    activeSearchAbort = abort;
    const requestId = ++searchRequestId;

    const identity = origin;
    // 搜索期间用户可能切换视频。用发起时的文件身份和代次做校验，
    // 避免旧视频的进度或结果渲染到新视频面板上（同一视频的时长补全不影响 token）。
    const originEpoch = searchEpoch;
    const originToken = identityToken(identity);
    const stillCurrent = () =>
        requestId === searchRequestId &&
        originEpoch === searchEpoch &&
        identityToken(controller.getCurrentIdentity()) === originToken;
    // 保留最后一次进度：搜索结束时各 Provider 的失败/无结果状态需要继续展示，
    // 之前这里用空对象覆盖，导致错误信息在界面上瞬间消失。
    let latest: SearchProgress = { providerStates: {}, results: [], done: false };
    try {
      const results = await subtitleSearchEngine.search(
          {
            code,
            normalizedCode: code.toUpperCase(),
            fileName: identity?.originalFileName,
            duration: identity?.duration,
            languagePreferences: currentSettings.preferredLanguages,
            force: options.forceProviders,
            signal: abort.signal,
          },
          currentSettings,
          {
            onProgress: (progress) => {
              latest = progress;
              if (stillCurrent()) panel.setProgress(progress);
            },
          },
      );
      if (stillCurrent()) {
        panel.setProgress({...latest, results, done: true});
        if (options.cacheResults) {
          const key = buildAutoSearchCacheKey({
            code,
            duration: identity?.duration,
            fileName: identity?.originalFileName,
          });
          const hasFailure = Object.values(latest.providerStates).some(
              (state) => state.status === "error" || state.status === "timeout",
          );
          // 部分来源失败时不写入 TTL，避免在 15 分钟内一直看到不完整结果；
          // 全部成功（包括明确无结果）才缓存。
          if (key && !hasFailure) autoSearchCache.write(key, results);
        }
        return results;
      }
      return [];
    } finally {
      if (activeSearchAbort === abort) activeSearchAbort = null;
    }
  }

  /**
   * 缓存恢复失败后才调用。只搜索并提示，不自动下载/应用任何结果，
   * 避免匹配分不可靠时给用户挂上错误字幕。
   */
  async function handleAutoSearch(): Promise<void> {
    if (!currentSettings.autoSearch) return;

    // 115 的时长/标题通常晚于 video 元素就绪。先等一小段时间让 identity 补全，
    // 避免用弱 videoKey 查不到缓存就误发搜索请求；期间任何视频切换都会作废旧任务。
    const generation = ++autoSearchGeneration;
    const epoch = searchEpoch;
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    if (generation !== autoSearchGeneration || epoch !== searchEpoch) return;
    if (!currentSettings.autoSearch) return;

    let currentIdentity = controller.getCurrentIdentity();
    if (!currentIdentity) return;
    // 手动修正的番号优先于自动识别结果。
    const code = currentManualCode || currentIdentity.code;
    if (!code) return;
    if (code === lastAutoSearchKey) return;

    // 115 切换视频时会先改 URL/标题，video.src 和 metadata 随后才就绪。
    // 这段窗口里 videoKey 可能对应旧视频或缺少时长，因此每 250ms 复查一次缓存，
    // 只有元数据就绪后才允许搜索；超时仍未就绪就放弃本次，等 loadedmetadata
    // 补全身份后由恢复流程重新触发，避免对已有缓存的视频误搜。
    const deadline = Date.now() + 3000;
    for (; ;) {
      if (controller.getCurrentSubtitleId()) return;
      const selected = await subtitleRepository.getSelectedForVideo(currentIdentity.videoKey);
      if (selected || controller.getCurrentSubtitleId()) return;
      if (generation !== autoSearchGeneration || epoch !== searchEpoch) return;
      if (controller.isMediaMetadataReady()) break;
      if (Date.now() >= deadline) return;
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      if (generation !== autoSearchGeneration || epoch !== searchEpoch) return;
      currentIdentity = controller.getCurrentIdentity();
      if (!currentIdentity || (currentManualCode || currentIdentity.code) !== code) return;
    }

    const cacheKey = buildAutoSearchCacheKey({
      code,
      duration: currentIdentity.duration,
      fileName: currentIdentity.originalFileName,
    });
    const cachedResults = autoSearchCache.read(cacheKey);
    if (cachedResults) {
      lastAutoSearchKey = code;
      panel.setProgress({providerStates: {}, results: cachedResults, done: true});
      panel.showToast(
          cachedResults.length > 0
              ? `使用 15 分钟内的自动搜索结果（${cachedResults.length} 条），请在列表中手动选择`
              : "最近一次自动搜索没有结果；可手动修改番号后搜索",
          cachedResults.length > 0 ? "success" : "warn",
      );
      return;
    }

    lastAutoSearchKey = code;
    const results = await handleSearch(code, currentIdentity, {cacheResults: true});
    // 用户在等待期间可能已经切到别的视频，此时只保留列表，不再提示。
    if (identityToken(controller.getCurrentIdentity()) !== identityToken(currentIdentity)) return;
    if (results.length > 0) {
      panel.showToast(`已自动搜索到 ${results.length} 条字幕，请在列表中手动选择`);
    }
  }

  /**
   * 本地缓存未命中后：
   * 1. 其他播放域名有可恢复的选中字幕 → 重新下载并恢复；
   * 2. 否则才进入自动搜索。
   */
  async function handleCacheMiss(identity: VideoIdentity): Promise<void> {
    if (!currentSettings.autoLoadCachedSubtitle) return;
    if (controller.getCurrentSubtitleId()) return;

    const token = identityToken(identity);
    if (token && token === lastRemoteRestoreToken) return;

    const remote = metadataSync.getRemoteForVideo(identity.videoKey, identity.fileId);
    if (!remote.selected) {
      void handleAutoSearch();
      return;
    }

    // 同一个文件只在首次恢复时尝试一次，避免身份补全后重复下载。
    lastRemoteRestoreToken = token;
    const restored = await restoreRemoteSubtitle(remote.selected, identity);
    if (restored) return;
    if (identityToken(controller.getCurrentIdentity()) !== token) return;
    if (controller.getCurrentSubtitleId()) return;
    void handleAutoSearch();
  }

  /**
   * 等待当前视频身份补全（拿到时长且媒体 metadata 就绪）。
   * 跨域恢复可能在 115 还没切换完 video.src 时就开始，若直接用当时的弱 videoKey
   * 落库，会导致缓存记录和当前视频对不上。
   */
  async function waitForStableIdentity(
      token: string,
      timeoutMs = 3000,
      signal?: AbortSignal,
  ): Promise<VideoIdentity | null> {
    const deadline = Date.now() + timeoutMs;
    for (; ;) {
      if (signal?.aborted) return null;
      const current = controller.getCurrentIdentity();
      if (!current || identityToken(current) !== token) return null;
      if (current.duration !== undefined && controller.isMediaMetadataReady()) return current;
      if (Date.now() >= deadline) return current;
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
  }

  /**
   * 从另一个播放域名的缓存索引恢复字幕。
   *
   * 只同步了元数据与来源信息，因此必须重新下载；本地导入的字幕没有下载地址，
   * 无法跨域名恢复。
   */
  async function restoreRemoteSubtitle(
      meta: RemoteSubtitleMeta,
      identity: VideoIdentity,
      allowReplace = false,
  ): Promise<boolean> {
    const provider = providerManager.get(meta.providerId);
    const providerEnabled = currentSettings.providers[meta.providerId]?.enabled ?? true;
    if (!provider || !providerEnabled || !meta.sourceResult) return false;
    if (meta.format === "ass" || meta.format === "ssa") return false;

    const token = identityToken(identity);
    const epoch = searchEpoch;
    const abort = beginDownload();
    try {
      panel.showToast(`正在从 ${meta.origin} 恢复缓存字幕…`);
      const download = await provider.download(meta.sourceResult, abort.signal);
      if (abort.signal.aborted || epoch !== searchEpoch || identityToken(controller.getCurrentIdentity()) !== token) {
        return false;
      }

      // 等 metadata 补全后再落库，避免把缓存写到只有 fileId 的弱 videoKey 上。
      const latestIdentity = await waitForStableIdentity(token, 3000, abort.signal);
      if (!latestIdentity) return false;
      if (!allowReplace && controller.getCurrentSubtitleId()) return false;

      const format = detectFormat(download.fileName);
      if (format === "unknown" || format === "ass" || format === "ssa") {
        logger.warn(`跨播放域名恢复失败：不支持的字幕格式 ${download.fileName}`);
        return false;
      }
      const parsed = parseSubtitle(download.bytes, format);

      const duplicate = await subtitleRepository.findByChecksum(
          latestIdentity.videoKey,
          download.checksum,
      );
      if (duplicate) {
        let current = duplicate;
        if (!current.sourceResult && meta.sourceResult) {
          current = {...current, sourceResult: meta.sourceResult};
          await subtitleRepository.save(current);
        }
        current = await ensureCurrentParser(current);
        await subtitleRepository.setSelectedForVideo(latestIdentity.videoKey, current.id);
        applySubtitle(current.title, current.id, current.cues, `已从 ${meta.origin} 恢复`);
        void refreshCacheList();
        publishMetadata();
        return true;
      }

      // 复用另一域名的记录 ID，便于两个域名对同一条字幕保持一致的选中引用。
      // 如果本地已有同 ID 但属于其他视频的记录，则改用新的 ID，避免覆盖。
      const existingById = await subtitleRepository.getById(meta.id);
      const recordId =
          existingById && existingById.videoKey !== latestIdentity.videoKey ? uuid() : meta.id;

      const record: SubtitleRecord = {
        id: recordId,
        videoKey: latestIdentity.videoKey,
        code: currentManualCode || meta.code || latestIdentity.code || "",
        providerId: meta.providerId,
        sourceId: meta.sourceId,
        title: meta.title,
        language: meta.language,
        format,
        rawBlob: new Blob([download.bytes]),
        encoding: parsed.encoding,
        cues: parsed.cues,
        cueCount: parsed.cues.length,
        checksum: download.checksum,
        createdAt: meta.createdAt,
        lastUsedAt: Date.now(),
        parserVersion: PARSER_VERSION,
        sourceResult: meta.sourceResult,
      };

      await subtitleRepository.save(record);
      const replaced = await replaceCachedByCode(record.code, record.id);
      await subtitleRepository.setSelectedForVideo(latestIdentity.videoKey, record.id);
      const note = replaced > 0
          ? `已从 ${meta.origin} 恢复，替换 ${replaced} 条旧缓存`
          : `已从 ${meta.origin} 恢复`;
      applySubtitle(record.title, record.id, parsed.cues, note);
      void refreshCacheList();
      publishMetadata();
      void enforceCacheLimit();
      return true;
    } catch (e) {
      if (!abort.signal.aborted) logger.warn("跨播放域名恢复字幕失败", e);
      return false;
    } finally {
      endDownload(abort);
    }
  }

  /** 面板中手动点击「恢复」。 */
  async function handleRestoreRemote(meta: RemoteSubtitleMeta): Promise<void> {
    const identity = controller.getCurrentIdentity();
    if (!identity) {
      showWarning("未检测到视频");
      return;
    }
    if (!meta.sourceResult) {
      panel.showToast("这条字幕来自本地导入，无法在另一播放域名自动恢复", "warn");
      return;
    }
    const restored = await restoreRemoteSubtitle(meta, identity, true);
    if (!restored && identityToken(controller.getCurrentIdentity()) === identityToken(identity)) {
      panel.showToast("跨播放域名恢复失败，请重试或手动搜索", "warn");
    }
  }

  async function handleSelectResult(result: SubtitleSearchResult): Promise<void> {
    const abort = beginDownload();
    try {
      const provider = providerManager.get(result.providerId);
      if (!provider) {
        showWarning(`未找到字幕来源：${result.providerId}`);
        return;
      }
      if (result.format === "ass" || result.format === "ssa") {
        showWarning("暂不支持 ASS/SSA 字幕解析，请选择 SRT/VTT 结果；如需保留文件可点「下载」。");
        return;
      }
      const identity = controller.getCurrentIdentity();

      // 同一视频、同一来源、同一 sourceId 已经缓存过，就不再重复下载。
      if (identity) {
        const cached = await subtitleRepository.findBySource(
            identity.videoKey,
            result.providerId,
            result.sourceId,
        );
        if (cached) {
          let current = cached;
          try {
            // 旧版本缓存可能没有来源快照，导致跨播放域名无法恢复。这里只补写
            // 当前在线结果的元数据，不改变 Blob/Cues，也不需要重新下载。
            if (!current.sourceResult) {
              current = {...current, sourceResult: result, lastUsedAt: Date.now()};
              await subtitleRepository.save(current);
            }
            current = await ensureCurrentParser(current);
            await subtitleRepository.setSelectedForVideo(identity.videoKey, current.id);
          } catch (e) {
            logger.warn("更新字幕缓存失败，仍使用已解析内容", e);
          }
          applySubtitle(current.title, current.id, current.cues, "缓存命中，无需重复下载");
          void refreshCacheList();
          publishMetadata();
          return;
        }
      }

      logger.info(`开始使用在线字幕：${result.providerId}/${result.title}`);
      panel.showToast("正在下载并解析字幕…");
      const download = await provider.download(result, abort.signal);
      const format = detectFormat(download.fileName);
      if (format === "unknown" || format === "ass" || format === "ssa") {
        showWarning("暂不支持该字幕格式，当前仅支持 SRT/VTT。");
        return;
      }
      const parsed = parseSubtitle(download.bytes, format);

      if (identity) {
        // 不同来源可能提供内容完全相同的字幕，下载后用 checksum 再判一次。
        const duplicate = await subtitleRepository.findByChecksum(
            identity.videoKey,
            download.checksum,
        );
        if (duplicate) {
          let current = duplicate;
          try {
            if (!current.sourceResult) {
              current = {...current, sourceResult: result, lastUsedAt: Date.now()};
              await subtitleRepository.save(current);
            }
            current = await ensureCurrentParser(current);
            await subtitleRepository.setSelectedForVideo(identity.videoKey, current.id);
          } catch (e) {
            logger.warn("更新字幕缓存失败，仍使用已解析内容", e);
          }
          applySubtitle(current.title, current.id, current.cues, "内容相同，已复用缓存");
          void refreshCacheList();
          publishMetadata();
          return;
        }

        const record: SubtitleRecord = {
          id: uuid(),
          videoKey: identity.videoKey,
          code: currentManualCode || result.code || identity.code || "",
          providerId: result.providerId,
          sourceId: result.sourceId,
          title: result.title,
          language: result.language,
          format,
          rawBlob: new Blob([download.bytes]),
          encoding: parsed.encoding,
          cues: parsed.cues,
          cueCount: parsed.cues.length,
          checksum: download.checksum,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          parserVersion: PARSER_VERSION,
          sourceResult: result,
        };

        let replaced = 0;
        let cacheFailed = false;
        try {
          await subtitleRepository.save(record);
          replaced = await replaceCachedByCode(record.code, record.id);
          await subtitleRepository.setSelectedForVideo(identity.videoKey, record.id);
        } catch (e) {
          // 字幕已经下载并解析成功；即使 IndexedDB 暂时不可写，也应先显示字幕，
          // 否则用户点击「使用」会看起来毫无效果。
          cacheFailed = true;
          logger.warn("写入字幕缓存失败，但仍应用字幕", e);
        }
        applySubtitle(
            result.title,
            record.id,
            parsed.cues,
            cacheFailed
                ? "字幕已生效，但缓存写入失败"
                : replaced > 0 ? `已替换同番号旧缓存 ${replaced} 条` : undefined,
        );
        void refreshCacheList();
        if (!cacheFailed) {
          publishMetadata();
          void enforceCacheLimit();
        }
      } else {
        applySubtitle(result.title, null, parsed.cues);
        logger.info("已加载字幕但未检测到视频，无法关联缓存");
      }
    } catch (e) {
      if (abort.signal.aborted) return;
      showWarning(isSubtitleError(e) ? e.message : "下载字幕失败");
      logger.error("下载字幕失败", e);
    } finally {
      endDownload(abort);
    }
  }

  async function handlePreviewResult(result: SubtitleSearchResult): Promise<void> {
    const abort = beginDownload();
    try {
      const provider = providerManager.get(result.providerId);
      if (!provider) {
        showWarning(`未找到字幕来源：${result.providerId}`);
        return;
      }
      if (result.format === "ass" || result.format === "ssa") {
        showWarning("暂不支持 ASS/SSA 字幕预览，当前仅支持 SRT/VTT。");
        return;
      }
      const download = await provider.download(result, abort.signal);
      const format = detectFormat(download.fileName);
      if (format === "unknown" || format === "ass" || format === "ssa") {
        showWarning("暂不支持该字幕格式，当前仅支持 SRT/VTT。");
        return;
      }
      const parsed = parseSubtitle(download.bytes, format);
      // 预览保留时间轴：序号与时间轴同一行，字幕正文另起一行。
      let content = formatCuesWithTimestamps(parsed.cues);
      if (!content.trim()) {
        content = decodeRawSubtitle(download.bytes, parsed.encoding);
      }
      panel.showPreview(result.title, limitPreviewText(content.trim() ? content : "（无字幕内容）"));
    } catch (e) {
      if (abort.signal.aborted) return;
      showWarning(isSubtitleError(e) ? e.message : "预览字幕失败");
      logger.error("预览字幕失败", e);
    } finally {
      endDownload(abort);
    }
  }

  async function handleDownloadResult(result: SubtitleSearchResult): Promise<void> {
    const abort = beginDownload();
    try {
      const provider = providerManager.get(result.providerId);
      if (!provider) {
        showWarning(`未找到字幕来源：${result.providerId}`);
        return;
      }
      const download = await provider.download(result, abort.signal);
      const blob = new Blob([download.bytes], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = download.fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      logger.info(`已下载字幕：${download.fileName}`);
    } catch (e) {
      if (abort.signal.aborted) return;
      showWarning(isSubtitleError(e) ? e.message : "下载字幕失败");
      logger.error("下载字幕失败", e);
    } finally {
      endDownload(abort);
    }
  }

  async function handleStyleChange(patch: Partial<GlobalSettings["style"]>): Promise<void> {
    const newStyle = { ...currentSettings.style, ...patch };
    currentSettings = await settingsService.update({ style: newStyle });
    controller.setSettings(currentSettings);
    // 更新来自面板自身的滑块：不重建面板，避免拖动被中断。
    panel.setSettings(currentSettings, false);
  }

  async function handleOffsetChange(offsetMs: number): Promise<void> {
    currentSettings = await settingsService.update({
      sync: { ...currentSettings.sync, offsetMs },
    });
    controller.setOffset(offsetMs);
    panel.setSettings(currentSettings, false);
  }

  async function handleAutoSearchChange(enabled: boolean): Promise<void> {
    currentSettings = await settingsService.update({autoSearch: enabled});
    panel.setSettings(currentSettings, false);
    if (enabled) {
      // 用户刚打开开关时，如果当前视频还没有字幕，立即补一次自动搜索。
      lastAutoSearchKey = "";
      void handleAutoSearch();
    }
  }

  async function handleShortcutChange(enabled: boolean): Promise<void> {
    currentSettings = await settingsService.update({
      shortcuts: {...currentSettings.shortcuts, enabled},
    });
    panel.setSettings(currentSettings, false);
  }

  /**
   * 选用已缓存的字幕。
   * 与在线结果不同，这里不重新下载，直接复用已解析的 cues。
   */
  async function handleSelectCachedSubtitle(record: SubtitleRecord): Promise<void> {
    try {
      const current = await ensureCurrentParser(record);
      const identity = controller.getCurrentIdentity();
      if (identity) {
        try {
          await subtitleRepository.setSelectedForVideo(identity.videoKey, current.id);
          // 选中的记录如果还是弱 videoKey（历史数据或跨域恢复竞态），顺手归一到当前视频。
          await subtitleRepository.save({
            ...current,
            videoKey: current.videoKey === identity.videoKey ? current.videoKey : identity.videoKey,
            lastUsedAt: Date.now(),
          });
        } catch (e) {
          // 缓存写失败不影响本次播放。
          logger.warn("更新缓存选中状态失败，仍应用字幕", e);
        }
      }
      applySubtitle(current.title, current.id, current.cues);
      void refreshCacheList();
      publishMetadata();
    } catch (e) {
      showWarning(isSubtitleError(e) ? e.message : "加载缓存字幕失败");
      logger.error("加载缓存字幕失败", e);
    }
  }

  async function handleDeduplicateCache(): Promise<void> {
    try {
      const result = await subtitleRepository.deduplicateByCode();

      // 当前播放中的字幕可能正好被合掉。优先切换到去重后保留下来的选中项，
      // 没有可用的保留项时清空，避免 overlay 继续显示已删除的 Cue。
      const currentId = controller.getCurrentSubtitleId();
      if (currentId) {
        const stillExists = await subtitleRepository.getById(currentId);
        if (!stillExists) {
          const identity = controller.getCurrentIdentity();
          const selected = identity
              ? await subtitleRepository.getSelectedForVideo(identity.videoKey)
              : null;
          if (selected) {
            controller.selectSubtitle(selected.id, selected.cues);
            controller.setSubtitleVisible(true);
            panel.setSubtitleVisible(true);
            panel.setCurrentSubtitle(selected.title, selected.id);
          } else {
            controller.clearSubtitle();
            panel.setCurrentSubtitle(null);
          }
        }
      }

      await refreshCacheList();
      publishMetadata();
      panel.showToast(
          result.removed > 0
              ? `去重完成：合并 ${result.groups} 组，删除 ${result.removed} 条重复字幕`
              : "没有需要去重的字幕",
          result.removed > 0 ? "success" : "warn",
      );
      logger.info(`缓存去重完成：删除 ${result.removed} 条`);
    } catch (e) {
      showWarning(isSubtitleError(e) ? e.message : "缓存去重失败");
      logger.error("缓存去重失败", e);
    }
  }

  async function handleExportAll(): Promise<void> {
    try {
      const records = await subtitleRepository.getAll();
      if (records.length === 0) {
        panel.showToast("本地没有可导出的字幕", "warn");
        return;
      }

      const blob = await buildSubtitleZip(records);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "115autosubtitle.zip";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      panel.showToast(`已导出 ${records.length} 条字幕`);
      logger.info(`已导出字幕压缩包（${records.length} 条）`);
    } catch (e) {
      showWarning("导出字幕失败");
      logger.error("导出字幕失败", e);
    }
  }

  function handlePositioningChange(enabled: boolean): void {
    controller.setPositioningMode(enabled);
    panel.setPositioning(enabled);
    if (enabled) {
      panel.showToast("拖动字幕到目标位置；按 Esc 或再次点击「完成定位」退出");
    }
  }

  async function handleCheckProviders(): Promise<void> {
    const providers = providerManager.getAll().filter((provider) => provider.id !== "local");
    const checks = await Promise.allSettled(
        providers.map(async (provider) => {
          if (!provider.healthCheck) return {name: provider.name, ok: true, message: "未提供检测"};
          const result = await provider.healthCheck();
          return {name: provider.name, ...result};
        }),
    );
    const failed: string[] = [];
    const passed: string[] = [];
    checks.forEach((check, index) => {
      const fallbackName = providers[index]?.name ?? "未知来源";
      if (check.status === "fulfilled" && check.value.ok) passed.push(check.value.name);
      else {
        const reason = check.status === "fulfilled"
            ? check.value.message ?? "不可用"
            : check.reason instanceof Error ? check.reason.message : "检测失败";
        failed.push(`${fallbackName}：${reason}`);
      }
    });
    panel.showToast(
        failed.length === 0
            ? `来源检测通过：${passed.join("、")}`
            : `可用：${passed.join("、") || "无"}；失败：${failed.join("；")}`,
        failed.length === 0 ? "success" : "warn",
    );
  }

  /**
   * 给当前视频缺 sourceResult 的在线缓存补来源信息。
   *
   * 只匹配 providerId + sourceId 完全一致的在线结果，不按标题猜测；
   * 本地导入记录（providerId=local）没有下载地址，不参与。
   */
  async function handleBackfillSources(): Promise<void> {
    const identity = controller.getCurrentIdentity();
    if (!identity) {
      panel.showToast("未检测到视频", "warn");
      return;
    }
    const code = currentManualCode || identity.code;
    if (!code) {
      panel.showToast("当前视频没有可搜索的番号", "warn");
      return;
    }
    const records = await subtitleRepository.getByVideoKey(identity.videoKey);
    const missing = records.filter(
        (record) => record.providerId !== "local" && record.sourceId && !record.sourceResult,
    );
    if (missing.length === 0) {
      panel.showToast("当前视频没有需要补齐来源信息的缓存", "warn");
      return;
    }

    const results = await handleSearch(code, identity, {forceProviders: true});
    const bySource = new Map(
        results.map((result) => [`${result.providerId}:${result.sourceId}`, result]),
    );
    let filled = 0;
    for (const record of missing) {
      const result = bySource.get(`${record.providerId}:${record.sourceId}`);
      if (!result) continue;
      await subtitleRepository.save({...record, sourceResult: result, lastUsedAt: Date.now()});
      filled++;
    }
    await refreshCacheList();
    if (filled > 0) publishMetadata();
    panel.showToast(
        filled > 0
            ? `已补齐 ${filled} 条字幕的来源信息，可在其他播放域名恢复`
            : "本次搜索结果中没有匹配的来源条目",
        filled > 0 ? "success" : "warn",
    );
  }

  async function handleClearRemoteSync(): Promise<void> {
    try {
      const origins = metadataSync.clearRemoteOrigins();
      await refreshCacheList();
      panel.showToast(
          origins.length > 0
              ? `已清理 ${origins.length} 个其他播放域名的同步索引`
              : "没有可清理的远程同步索引",
          origins.length > 0 ? "success" : "warn",
      );
    } catch (e) {
      logger.error("清理远程同步索引失败", e);
      panel.showToast("清理远程同步索引失败", "warn");
    }
  }

  async function handleRefreshSync(): Promise<void> {
    try {
      await publishMetadataNow();
      await refreshCacheList();
      panel.showToast("已刷新跨播放域名缓存索引");
    } catch (e) {
      logger.error("刷新同步索引失败", e);
      panel.showToast("刷新同步索引失败", "warn");
    }
  }

  async function handleClearCache(): Promise<void> {
    try {
      await subtitleRepository.clearAll();
      controller.clearSubtitle();
      panel.setCurrentSubtitle(null);
      void refreshCacheList();
      publishMetadata();
      panel.showToast("已清空所有字幕缓存");
    } catch (e) {
      logger.error("清空缓存失败", e);
      panel.showToast("清空缓存失败", "warn");
    }
  }

  async function handleDeleteSubtitle(id: string): Promise<void> {
    await subtitleRepository.delete(id);
    if (controller.getCurrentSubtitleId() === id) {
      controller.clearSubtitle();
      panel.setCurrentSubtitle(null);
    }
    void refreshCacheList();
    publishMetadata();
  }

  function formatByteSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  }

  function protectedSubtitleIds(): string[] {
    const current = controller.getCurrentSubtitleId();
    return current ? [current] : [];
  }

  async function handleCleanupCache(): Promise<void> {
    try {
      const result = await subtitleRepository.cleanup({
        maxBytes: 0,
        olderThanDays: currentSettings.cache.cleanupAfterDays,
        protectIds: protectedSubtitleIds(),
      });
      lastCacheCheckAt = Date.now();
      if (result.removed > 0) {
        await refreshCacheList();
        publishMetadata();
        panel.showToast(`清理完成：删除 ${result.removed} 条，释放 ${formatByteSize(result.freedBytes)}`);
      } else {
        panel.showToast("没有可清理的未使用缓存", "warn");
      }
    } catch (e) {
      logger.error("清理缓存失败", e);
      panel.showToast("清理缓存失败", "warn");
    }
  }

  /** 超出容量上限时按最近使用时间自动清理，当前播放字幕受保护。 */
  async function enforceCacheLimit(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - lastCacheCheckAt < 60_000) return;
    lastCacheCheckAt = now;
    try {
      const result = await subtitleRepository.cleanup({
        maxBytes: currentSettings.cache.maxBytes,
        olderThanDays: 0,
        protectIds: protectedSubtitleIds(),
      });
      if (result.removed > 0) {
        await refreshCacheList();
        publishMetadata();
        panel.showToast(
            `缓存超出上限，已自动清理 ${result.removed} 条旧字幕，释放 ${formatByteSize(result.freedBytes)}`,
            "warn",
        );
      }
    } catch (e) {
      logger.warn("自动清理缓存失败", e);
    }
  }

  async function refreshCacheList(): Promise<void> {
    const all = await subtitleRepository.getAll();
    const bytes = all.reduce((sum, record) => sum + record.rawBlob.size, 0);
    panel.setCacheSummary({count: all.length, bytes});

    const identity = controller.getCurrentIdentity();
    if (!identity) {
      localSubtitleIds = new Set();
      panel.setCachedSubtitles([]);
      refreshRemoteCache();
      return;
    }

    const local = all.filter(
        (record) =>
            record.videoKey === identity.videoKey ||
            (identity.fileId !== undefined &&
                fileIdFromVideoKey(record.videoKey) === identity.fileId),
    );
    panel.setCachedSubtitles(local);

    // 同一条字幕可能在两个域名都缓存过（恢复后会复用 ID），按 ID 去重，
    // 避免本地列表和「其他播放域名」列表重复出现。
    localSubtitleIds = new Set(local.map((record) => record.id));

    refreshRemoteCache();
  }

  /**
   * 只刷新 GM 中的远程索引，不重新读取 IndexedDB。
   * 面板打开时定时调用，作为跨播放域名的轻量“准实时”同步。
   */
  function refreshRemoteCache(): void {
    panel.setRemoteSummary(metadataSync.getRemoteSummary());
    const identity = controller.getCurrentIdentity();
    if (!identity) {
      panel.setRemoteSubtitles([]);
      return;
    }
    const remote = metadataSync.getRemoteForVideo(identity.videoKey, identity.fileId);
    panel.setRemoteSubtitles(remote.subtitles.filter((item) => !localSubtitleIds.has(item.id)));
  }
}