import { m115VideoAdapter } from "../player/m115-video-adapter";
import { PlayerController } from "../player/player-controller";
import { SubtitlePanel } from "../ui/panel";
import { settingsService, type GlobalSettings } from "../settings/settings-service";
import { subtitleRepository } from "../storage/subtitle-repository";
import { subtitleSearchEngine } from "../search/search-engine";
import { providerManager } from "../search/provider-manager";
import type { SearchProgress } from "../search/provider-manager";
import { parseSubtitle, detectFormat } from "../subtitle/parsers";
import { localFileProvider } from "../providers/local-provider";
import { computeChecksum, uuid } from "../utils/hash";
import { logger } from "../utils/logger";
import type { SubtitleSearchResult } from "../providers/provider";
import type { SubtitleCue } from "../subtitle/subtitle-model";
import type { SubtitleRecord } from "../storage/database";
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
    onStyleChange: (patch) => handleStyleChange(patch),
    onOffsetChange: (offsetMs) => handleOffsetChange(offsetMs),
    onToggleSubtitle: (enabled) => {
      controller.setSubtitleVisible(enabled);
      panel.setSubtitleVisible(enabled);
    },
    onClearCache: () => handleClearCache(),
    onDeleteSubtitle: (id) => handleDeleteSubtitle(id),
  });

  let lastAutoSearchKey = "";
  let currentSettings = settings;

  const controller = new PlayerController(adapter, {
    onVideoChange: (identity) => {
      panel.setIdentity(identity);
      void refreshCacheList();
      if (currentSettings.autoSearch && identity.code && identity.code !== lastAutoSearchKey) {
        lastAutoSearchKey = identity.code;
        void handleSearch(identity.code);
      }
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
  });

  controller.setSettings(settings);
  panel.setSettings(settings);
  panel.setSubtitleVisible(controller.getSubtitleVisible());
  panel.mount();
  controller.start();

  /**
   * 统一的「使用字幕」入口。
   *
   * 字幕生效 ≠ 立刻看得见：如果用户正好暂停在两条字幕之间，overlay 会是空的。
   * 这里在应用后检查当前时间点是否命中 Cue，并用 toast 明确告知，
   * 避免用户误以为「点击使用没反应」。
   */
  function applySubtitle(title: string, subtitleId: string | null, cues: SubtitleCue[]): void {
    controller.selectSubtitle(subtitleId, cues);
    controller.setSubtitleVisible(true);
    panel.setSubtitleVisible(true);
    panel.setCurrentSubtitle(title, subtitleId);

    const activeCount = controller.getActiveCueCount();
    const hasCueNow = activeCount > 0;
    panel.showToast(
      hasCueNow
        ? `已使用：${title}`
        : `已使用：${title}（当前时间点没有字幕，拖动进度条查看）`,
      hasCueNow ? "success" : "warn",
    );
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
      await subtitleRepository.setSelectedForVideo(identity.videoKey, record.id);
      applySubtitle(fileName, record.id, parsed.cues);
      void refreshCacheList();
      logger.info(`已加载本地字幕：${fileName}（${parsed.cues.length} 条）`);
    } catch (e) {
      const msg = isSubtitleError(e) ? e.message : "导入字幕失败";
      alert(msg);
      logger.error("导入字幕失败", e);
    }
  }

  async function handleSearch(code: string): Promise<void> {
    if (!code) {
      alert("请输入番号");
      return;
    }
    const identity = controller.getCurrentIdentity();
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
          panel.setProgress(progress);
        },
      },
    );
    panel.setProgress({ ...latest, results, done: true });
  }

  async function handleSelectResult(result: SubtitleSearchResult): Promise<void> {
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
      const identity = controller.getCurrentIdentity();

      if (identity) {
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
        };

        await subtitleRepository.save(record);
        await subtitleRepository.setSelectedForVideo(identity.videoKey, record.id);
        applySubtitle(result.title, record.id, parsed.cues);
        void refreshCacheList();
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
      const previewLines = parsed.cues.slice(0, 30).map((cue, i) => `${i + 1}. ${cue.text}`);
      const content = previewLines.length > 0
        ? previewLines.join("\n")
        : "（无字幕内容）";
      panel.showPreview(result.title, content);
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

  /**
   * 选用已缓存的字幕。
   * 与在线结果不同，这里不重新下载，直接复用已解析的 cues。
   */
  async function handleSelectCachedSubtitle(record: SubtitleRecord): Promise<void> {
    try {
      const identity = controller.getCurrentIdentity();
      if (identity) {
        await subtitleRepository.setSelectedForVideo(identity.videoKey, record.id);
        await subtitleRepository.save({ ...record, lastUsedAt: Date.now() });
      }
      applySubtitle(record.title, record.id, record.cues);
      void refreshCacheList();
    } catch (e) {
      alert(isSubtitleError(e) ? e.message : "加载缓存字幕失败");
      logger.error("加载缓存字幕失败", e);
    }
  }

  async function handleClearCache(): Promise<void> {
    await subtitleRepository.clearAll();
    controller.clearSubtitle();
    panel.setCurrentSubtitle(null);
    void refreshCacheList();
  }

  async function handleDeleteSubtitle(id: string): Promise<void> {
    await subtitleRepository.delete(id);
    if (controller.getCurrentSubtitleId() === id) {
      controller.clearSubtitle();
      panel.setCurrentSubtitle(null);
    }
    void refreshCacheList();
  }

  async function refreshCacheList(): Promise<void> {
    const identity = controller.getCurrentIdentity();
    if (!identity) return;
    const subs = await subtitleRepository.getByVideoKey(identity.videoKey);
    panel.setCachedSubtitles(subs);
  }
}