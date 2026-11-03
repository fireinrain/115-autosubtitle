import { m115VideoAdapter } from "../player/m115-video-adapter";
import { PlayerController } from "../player/player-controller";
import { SubtitlePanel } from "../ui/panel";
import { settingsService, type GlobalSettings } from "../settings/settings-service";
import { subtitleRepository } from "../storage/subtitle-repository";
import { subtitleSearchEngine } from "../search/search-engine";
import { providerManager } from "../search/provider-manager";
import type { SearchProgress } from "../search/provider-manager";
import { parseSubtitle, detectFormat } from "../subtitle/parsers";
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
    onSearch: (code) => handleSearch(code),
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
    onClearCache: () => handleClearCache(),
    onDeleteSubtitle: (id) => handleDeleteSubtitle(id),
    onDeduplicateCache: () => void handleDeduplicateCache(),
    onExportAll: () => void handleExportAll(),
  });

  let lastAutoSearchKey = "";
  let autoSearchGeneration = 0;
  /** 每次真正切换文件都会自增；用于丢弃跨视频的旧搜索响应（即使又切回同一视频）。 */
  let searchEpoch = 0;
  let currentSettings = settings;
  /** 当前面板代表的具体文件；用于区分「同一视频身份补全」与「真的切换了视频」。 */
  let lastVideoToken = "";
  /** 已经尝试过跨播放域名恢复的文件，避免身份补全时重复下载。 */
  let lastRemoteRestoreToken = "";

  /** 视频文件身份 token：优先 115 文件 ID，缺失时退回 videoKey。 */
  function identityToken(identity: VideoIdentity | null): string {
    if (!identity) return "";
    return identity.fileId ? `id:${identity.fileId}` : identity.videoKey;
  }

  /** 把本地缓存索引写入 GM 存储，供另一个 115 播放域名读取。 */
  function publishMetadata(): void {
    void metadataSync.publish();
  }

  const controller = new PlayerController(adapter, {
    onVideoChange: (identity) => {
      autoSearchGeneration++;
      const token = identityToken(identity);
      if (token !== lastVideoToken) {
        lastVideoToken = token;
        lastAutoSearchKey = "";
        lastRemoteRestoreToken = "";
        searchEpoch++;
        // 上一个视频的在线结果不能带到新视频；即使旧请求还没结束，
        // handleSearch 的过期检查也会丢弃它后续的进度和结果。
        panel.setProgress(null);
      }
      panel.setIdentity(identity);
      void refreshCacheList();
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
  });

  controller.setSettings(settings);
  panel.setSettings(settings);
  panel.setSubtitleVisible(controller.getSubtitleVisible());
  panel.mount();
  controller.start();
  void refreshCacheList();
  publishMetadata();

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
        alert("不支持的字幕格式");
        return;
      }
      const parsed = parseSubtitle(bytes, format);
      const identity = controller.getCurrentIdentity();
      if (!identity) {
        alert("未检测到视频");
        return;
      }

      const checksum = await computeChecksum(bytes);
      const duplicate = await subtitleRepository.findByChecksum(identity.videoKey, checksum);
      if (duplicate) {
        await subtitleRepository.setSelectedForVideo(identity.videoKey, duplicate.id);
        applySubtitle(duplicate.title, duplicate.id, duplicate.cues, "缓存命中");
        void refreshCacheList();
        publishMetadata();
        return;
      }
      const record: SubtitleRecord = {
        id: uuid(),
        videoKey: identity.videoKey,
        code: identity.code ?? "",
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
        parserVersion: 1,
        isFavorite: false,
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
      logger.info(`已加载本地字幕：${fileName}（${parsed.cues.length} 条）`);
    } catch (e) {
      const msg = isSubtitleError(e) ? e.message : "导入字幕失败";
      alert(msg);
      logger.error("导入字幕失败", e);
    }
  }

  async function handleSearch(
      code: string,
      origin: VideoIdentity | null = controller.getCurrentIdentity(),
  ): Promise<SubtitleSearchResult[]> {
    if (!code) {
      alert("请输入番号");
      return [];
    }
    const identity = origin;
    // 搜索期间用户可能切换视频。用发起时的文件身份和代次做校验，
    // 避免旧视频的进度或结果渲染到新视频面板上（同一视频的时长补全不影响 token）。
    const originEpoch = searchEpoch;
    const originToken = identityToken(identity);
    const stillCurrent = () =>
        originEpoch === searchEpoch && identityToken(controller.getCurrentIdentity()) === originToken;
    // 保留最后一次进度：搜索结束时各 Provider 的失败/无结果状态需要继续展示，
    // 之前这里用空对象覆盖，导致错误信息在界面上瞬间消失。
    let latest: SearchProgress = { providerStates: {}, results: [], done: false };
    const results = await subtitleSearchEngine.search(
      {
        code,
        normalizedCode: code.toUpperCase(),
        fileName: identity?.originalFileName,
        duration: identity?.duration,
        languagePreferences: currentSettings.preferredLanguages,
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
    }
    return results;
  }

  /**
   * 缓存恢复失败后才调用。只搜索并提示，不自动下载/应用任何结果，
   * 避免匹配分不可靠时给用户挂上错误字幕。
   */
  async function handleAutoSearch(identity: VideoIdentity): Promise<void> {
    if (!currentSettings.autoSearch) return;
    const code = identity.code;
    if (!code) return;

    // 115 的时长/标题通常晚于 video 元素就绪。先等一小段时间让 identity 补全，
    // 避免用弱 videoKey 查不到缓存就误发搜索请求；期间任何视频切换都会作废旧任务。
    const generation = ++autoSearchGeneration;
    const epoch = searchEpoch;
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    if (generation !== autoSearchGeneration || epoch !== searchEpoch) return;
    if (code === lastAutoSearchKey) return;
    if (!currentSettings.autoSearch) return;

    let currentIdentity = controller.getCurrentIdentity();
    if (!currentIdentity || currentIdentity.code !== code) return;

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
      if (!currentIdentity || currentIdentity.code !== code) return;
    }

    lastAutoSearchKey = code;
    const results = await handleSearch(code, currentIdentity);
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
      void handleAutoSearch(identity);
      return;
    }

    // 同一个文件只在首次恢复时尝试一次，避免身份补全后重复下载。
    lastRemoteRestoreToken = token;
    const restored = await restoreRemoteSubtitle(remote.selected, identity);
    if (restored) return;
    if (identityToken(controller.getCurrentIdentity()) !== token) return;
    if (controller.getCurrentSubtitleId()) return;
    void handleAutoSearch(identity);
  }

  /**
   * 等待当前视频身份补全（拿到时长且媒体 metadata 就绪）。
   * 跨域恢复可能在 115 还没切换完 video.src 时就开始，若直接用当时的弱 videoKey
   * 落库，会导致缓存记录和当前视频对不上。
   */
  async function waitForStableIdentity(
      token: string,
      timeoutMs = 3000,
  ): Promise<VideoIdentity | null> {
    const deadline = Date.now() + timeoutMs;
    for (; ;) {
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

    const token = identityToken(identity);
    const epoch = searchEpoch;
    try {
      panel.showToast(`正在从 ${meta.origin} 恢复缓存字幕…`);
      const download = await provider.download(meta.sourceResult);
      if (epoch !== searchEpoch || identityToken(controller.getCurrentIdentity()) !== token) {
        return false;
      }

      // 等 metadata 补全后再落库，避免把缓存写到只有 fileId 的弱 videoKey 上。
      const latestIdentity = await waitForStableIdentity(token);
      if (!latestIdentity) return false;
      if (!allowReplace && controller.getCurrentSubtitleId()) return false;

      const format = detectFormat(download.fileName);
      if (format === "unknown") {
        logger.warn(`跨播放域名恢复失败：不支持的字幕格式 ${download.fileName}`);
        return false;
      }
      const parsed = parseSubtitle(download.bytes, format);

      const duplicate = await subtitleRepository.findByChecksum(
          latestIdentity.videoKey,
          download.checksum,
      );
      if (duplicate) {
        await subtitleRepository.setSelectedForVideo(latestIdentity.videoKey, duplicate.id);
        applySubtitle(duplicate.title, duplicate.id, duplicate.cues, `已从 ${meta.origin} 恢复`);
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
        code: meta.code || latestIdentity.code || "",
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
        parserVersion: 1,
        isFavorite: meta.isFavorite,
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
      return true;
    } catch (e) {
      logger.warn("跨播放域名恢复字幕失败", e);
      return false;
    }
  }

  /** 面板中手动点击「恢复」。 */
  async function handleRestoreRemote(meta: RemoteSubtitleMeta): Promise<void> {
    const identity = controller.getCurrentIdentity();
    if (!identity) {
      alert("未检测到视频");
      return;
    }
    if (!meta.sourceResult) {
      panel.showToast("这条字幕来自本地导入，无法在另一播放域名自动恢复", "warn");
      return;
    }
    const restored = await restoreRemoteSubtitle(meta, identity, true);
    if (!restored) {
      panel.showToast("跨播放域名恢复失败，请重试或手动搜索", "warn");
    }
  }

  async function handleSelectResult(result: SubtitleSearchResult): Promise<void> {
    try {
      const provider = providerManager.get(result.providerId);
      if (!provider) {
        alert(`未找到字幕来源：${result.providerId}`);
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
          await subtitleRepository.setSelectedForVideo(identity.videoKey, cached.id);
          applySubtitle(cached.title, cached.id, cached.cues, "缓存命中，无需重复下载");
          void refreshCacheList();
          publishMetadata();
          return;
        }
      }

      const download = await provider.download(result);
      const format = detectFormat(download.fileName);
      if (format === "unknown") {
        alert("不支持的字幕格式");
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
          await subtitleRepository.setSelectedForVideo(identity.videoKey, duplicate.id);
          applySubtitle(duplicate.title, duplicate.id, duplicate.cues, "内容相同，已复用缓存");
          void refreshCacheList();
          publishMetadata();
          return;
        }

        const record: SubtitleRecord = {
          id: uuid(),
          videoKey: identity.videoKey,
          code: result.code ?? identity.code ?? "",
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
          parserVersion: 1,
          isFavorite: false,
          sourceResult: result,
        };

        await subtitleRepository.save(record);
        const replaced = await replaceCachedByCode(record.code, record.id);
        await subtitleRepository.setSelectedForVideo(identity.videoKey, record.id);
        applySubtitle(
            result.title,
            record.id,
            parsed.cues,
            replaced > 0 ? `已替换同番号旧缓存 ${replaced} 条` : undefined,
        );
        void refreshCacheList();
        publishMetadata();
      } else {
        applySubtitle(result.title, null, parsed.cues);
        logger.info("已加载字幕但未检测到视频，无法关联缓存");
      }
    } catch (e) {
      alert(isSubtitleError(e) ? e.message : "下载字幕失败");
      logger.error("下载字幕失败", e);
    }
  }

  async function handlePreviewResult(result: SubtitleSearchResult): Promise<void> {
    try {
      const provider = providerManager.get(result.providerId);
      if (!provider) {
        alert(`未找到字幕来源：${result.providerId}`);
        return;
      }
      const download = await provider.download(result);
      const format = detectFormat(download.fileName);
      if (format === "unknown") {
        alert("不支持的字幕格式");
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
      alert(isSubtitleError(e) ? e.message : "预览字幕失败");
      logger.error("预览字幕失败", e);
    }
  }

  async function handleDownloadResult(result: SubtitleSearchResult): Promise<void> {
    try {
      const provider = providerManager.get(result.providerId);
      if (!provider) {
        alert(`未找到字幕来源：${result.providerId}`);
        return;
      }
      const download = await provider.download(result);
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
      alert(isSubtitleError(e) ? e.message : "下载字幕失败");
      logger.error("下载字幕失败", e);
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
      const identity = controller.getCurrentIdentity();
      if (identity) void handleAutoSearch(identity);
    }
  }

  /**
   * 选用已缓存的字幕。
   * 与在线结果不同，这里不重新下载，直接复用已解析的 cues。
   */
  async function handleSelectCachedSubtitle(record: SubtitleRecord): Promise<void> {
    try {
      const identity = controller.getCurrentIdentity();
      if (identity) {
        await subtitleRepository.setSelectedForVideo(identity.videoKey, record.id);
        // 选中的记录如果还是弱 videoKey（历史数据或跨域恢复竞态），顺手归一到当前视频。
        await subtitleRepository.save({
          ...record,
          videoKey: record.videoKey === identity.videoKey ? record.videoKey : identity.videoKey,
          lastUsedAt: Date.now(),
        });
      }
      applySubtitle(record.title, record.id, record.cues);
      void refreshCacheList();
      publishMetadata();
    } catch (e) {
      alert(isSubtitleError(e) ? e.message : "加载缓存字幕失败");
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
      alert(isSubtitleError(e) ? e.message : "缓存去重失败");
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
      alert("导出字幕失败");
      logger.error("导出字幕失败", e);
    }
  }

  async function handleClearCache(): Promise<void> {
    await subtitleRepository.clearAll();
    controller.clearSubtitle();
    panel.setCurrentSubtitle(null);
    void refreshCacheList();
    publishMetadata();
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

  async function refreshCacheList(): Promise<void> {
    const all = await subtitleRepository.getAll();
    const bytes = all.reduce((sum, record) => sum + record.rawBlob.size, 0);
    panel.setCacheSummary({count: all.length, bytes});
    panel.setRemoteSummary(metadataSync.getRemoteSummary());

    const identity = controller.getCurrentIdentity();
    if (!identity) {
      panel.setCachedSubtitles([]);
      panel.setRemoteSubtitles([]);
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
    const localIds = new Set(local.map((record) => record.id));
    const remote = metadataSync.getRemoteForVideo(identity.videoKey, identity.fileId);
    panel.setRemoteSubtitles(remote.subtitles.filter((item) => !localIds.has(item.id)));
  }
}