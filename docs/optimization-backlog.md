# 优化清单与已知限制

> 基线：2026-11-03，生产构建 `dist/115-subtitle-assistant.user.js`（139.12 kB）。
> 本文档只列**当前代码中真实存在**的优化点和未完成项；完成一项后请同步更新对应设计章节和本表。
>
> 验证基线：`npm run typecheck` 通过；`npm test` 15 个文件 / 151 个用例通过；`npm run build` 通过。
> 已完成真实页面验证：旧播放页、新播放页、视频切换、跨播放域名元数据同步与自动恢复。

## 1. 当前已实现

- 旧播放页 `115vod.com` 与新播放页 `115.com/players/video/*`。
- 播放器控制栏「字幕」按钮后的 CC 入口。
- 番号识别、在线搜索（迅雷 / SubtitleCat）、结果评分排序、去重。
- SRT / VTT 解析、时间轴同步、Shadow DOM overlay、样式与偏移。
- 本地字幕导入（SRT / VTT）、字幕预览、单文件下载、缓存 ZIP 导出。
- IndexedDB 本地缓存、跨视频隔离、同番号自动替换、手动去重。
- 无缓存自动搜索（只提示，不自动应用）。
- GM 跨播放域名缓存元数据同步；可下载来源支持自动恢复。
- 视频切换清理旧字幕、搜索代次隔离、metadata 就绪门控。
- 单元测试覆盖解析、时间轴、身份、评分、缓存、设置、ZIP、GM 同步、播放器 URL。

## 2. P0：正确性与安全

### 2.1 ASS / SSA 支持声明与实际不一致

- 现状：`detectFormat()` 会把 `.ass/.ssa` 识别为 `ass/ssa`，但 `parseSubtitle()` 只实现 `srt/vtt`，会抛
  `UNSUPPORTED_FORMAT`。
- 影响：来源或本地导入 ASS/SSA 时，UI/README 若宣称支持，会在下载后失败；用户无法预期。
- 建议：
    - README、面板提示明确“仅支持 SRT/VTT”；
    - ASS/SSA 在下载/导入前给出可操作错误，不再列入后续功能规划。
- 相关：`src/subtitle/parsers.ts`、`README.md`。

### 2.2 手动番号修正未持久化

- 现状：搜索框输入只作为本次查询参数；`VideoRecord.codeSource` 始终是 `"auto"`，`codeDraft` 不写入缓存。
- 影响：用户手动纠正番号后，下次打开同一视频仍用自动识别结果，不符合“手动值优先于自动提取”的要求。
- 建议：
    - 增加“保存为当前视频番号”动作或搜索时自动保存；
    - `setSelectedForVideo` / 新的 `setManualCode` 写入 `codeSource: "manual"`；
    - 自动恢复时优先使用手动值；切换视频不继承。
- 相关：`src/app/bootstrap.ts`、`src/ui/panel.ts`、`src/storage/subtitle-repository.ts`。

### 2.3 下载重定向的最终域名未校验

- 现状：Provider 只校验初始 `downloadUrl` 的 host；`gm-request` 返回 `finalUrl`，但调用方未检查重定向后的域名。
- 影响：来源若把下载重定向到未授权 host，当前实现会接受响应体，不符合网络层“重定向目标校验”要求。
- 建议：在统一网络层或 Provider 下载后校验 `finalUrl` 必须在允许域名列表；不通过则抛 `DOWNLOAD_FAILED`。
- 相关：`src/network/gm-request.ts`、`src/providers/*.ts`。

### 2.4 视频切换时不取消在途搜索/下载

- 现状：搜索层支持 `AbortSignal`，但 `bootstrap.handleSearch()` 没有创建并传入 signal；`provider.download()` 也没有在视频切换时取消。
- 影响：旧视频的请求继续占用网络，虽然结果会被 `searchEpoch` 丢弃，但会浪费流量、延迟新任务，且无法真正释放 GM 请求。
- 建议：为每次搜索/下载创建 `AbortController`，在 `onVideoChange`、新搜索、面板关闭时 abort；补充取消状态测试。
- 相关：`src/app/bootstrap.ts`、`src/search/search-engine.ts`、`src/network/gm-request.ts`。

## 3. P1：体验与一致性

### 3.1 自动搜索的重复请求与 TTL

- 现状：`lastAutoSearchKey` 只在当前页面会话内按番号去重；每次新开页面、切换视频后无缓存都会重新请求来源。
- 建议：增加短期查询缓存（如 10–30 分钟，按番号 + 文件名/时长），并区分“用户手动刷新”与“自动搜索”。
- 相关：`src/app/bootstrap.ts`、`src/search/search-engine.ts`。

### 3.2 元数据同步的实时性与冲突

- 现状：GM 索引只在启动和本地缓存变更时发布；另一个域名不会收到实时通知，需要刷新/切换视频才看到。
- 其他限制：
    - 旧记录没有 `sourceResult`，只能显示「说明」；
    - 两个域名的选中状态可能不一致，恢复时以另一域名为准；
    - 没有“刷新同步索引 / 清理远程索引”入口；
    - 每次发布都会读取完整记录（含 Blob/Cues）并重写整个 payload。
- 建议：
    - 面板增加“刷新同步索引”按钮；
    - 增加元数据专属查询/存储，避免发布时加载字幕正文；
    - 对 `publish()` 做防抖，减少频繁 GM 写入；
    - 明确冲突策略（按 `lastUsedAt` / 用户最近操作）。
- 相关：`src/storage/metadata-sync.ts`、`src/app/bootstrap.ts`、`src/ui/panel.ts`。

### 3.3 未接线的设置项

以下配置已定义但当前没有实际行为，容易让用户误以为已生效：

- `autoSelectHighConfidence`：没有自动选择逻辑（当前产品选择是“不自动应用”，应删除或明确为预留）。
- `cache.maxBytes` / `cache.cleanupAfterDays`：没有自动清理、LRU 或保留建议。
- `shortcuts.enabled`：没有字幕快捷键实现。
- `isFavorite`：缓存记录有字段，但面板没有收藏入口，清理策略也未保护收藏。

建议实现缓存清理/收藏，或从设置模型和 UI 中移除未实现项。
相关：`src/settings/settings-service.ts`、`src/storage/subtitle-repository.ts`、`src/ui/panel.ts`。

### 3.4 匹配原因未展示

- 现状：`matchReasons` 已计算并存入结果，但面板只显示匹配分数。
- 建议：在结果行或悬停提示中展示主要匹配原因，满足“评分可解释”。
- 相关：`src/search/result-matcher.ts`、`src/ui/panel.ts`。

### 3.5 字幕拖动定位未实现

- 现状：位置只能通过样式面板的百分比滑块调整；没有“调整位置”模式下的拖动。
- 建议：增加可选的拖动模式，正常播放时 overlay 保持 `pointer-events: none`，并做边界/全屏/容器变化处理。
- 相关：`src/renderer/overlay-renderer.ts`、`src/ui/panel.ts`。

### 3.6 旧播放页文件 ID fallback 可能选错文件

- 现状：URL 没有 `pickcode` 时，`#js-video_list li[pickcode]` 会取文档中第一个列表项，而不是当前播放项。
- 建议：只使用 `.hover`/当前项，找不到就返回 `undefined`，不要猜。
- 相关：`src/player/m115-video-adapter.ts`。

### 3.7 未使用的播放器适配器

- 现状：`src/player/generic-video-adapter.ts` 没有被任何入口引用。
- 建议：删除，或明确作为未来站点适配的 fallback 并接入启动流程。
- 相关：`src/player/generic-video-adapter.ts`。

### 3.8 面板与观察器性能

- 现状：
    - 面板状态更新通常整块 `renderBody()`（`replaceChildren`）；
    - `MutationObserver` 观察整个 `body`，每 300ms 触发一次 detect；
    - 播放器根节点上的 `ensureNativeToggle()` 在每次 childList 变化时查询完整按钮列表。
- 建议：按 tab/section 做局部更新；播放器 attach 后把观察范围收缩到 playerRoot；对 CC 插入做节流。
- 相关：`src/ui/panel.ts`、`src/player/m115-video-adapter.ts`。

### 3.9 阻塞式 alert / confirm

- 现状：导入失败、下载失败、清空缓存、去重确认使用 `alert/confirm`。
- 建议：统一为非阻塞 toast/确认弹层，保持可访问性和不中断播放。
- 相关：`src/app/bootstrap.ts`、`src/ui/panel.ts`。

### 3.10 Provider 健康检查、限流与重试

- 现状：接口存在 `healthCheck?()`，但未实现；网络层没有速率限制/退避重试。
- 建议：为来源增加健康状态展示、失败退避、并发/频率限制，避免触发来源限流。
- 相关：`src/providers/provider.ts`、`src/search/provider-manager.ts`、`src/network/gm-request.ts`。

### 3.11 新版播放器选择器的脆弱性

- 现状：新版播放器依赖按钮文本「字幕」和 utility class 定位，115 改版后可能失效。
- 建议：增加结构 fallback（控制栏内第一个文本为「字幕」的 button）、诊断日志和适配记录；选择器变化时给出可读提示而不是静默。
- 相关：`src/ui/panel.ts`、`src/player/m115-video-adapter.ts`、`docs/115-player-inspection.md`。

## 4. P2：工程质量与兼容性

### 4.1 CI 未运行测试与类型检查

- 现状：`.github/workflows/build-and-commit.yml` 只执行 `npm ci` + `npm run build`。
- 建议：在 build 前执行 `npm run typecheck && npm test`；失败不发布。
- 风险：当前 `package.json` 版本固定 `0.1.0`，每次 push 都用同一 tag 创建 release，可能导致 tag 冲突或覆盖；需要版本递增/仅手动发布策略。
- 相关：`.github/workflows/build-and-commit.yml`、`package.json`。

### 4.2 缺少关键集成测试

- 现状：有解析、缓存、同步等单测，但没有自动化覆盖：
    - `bootstrap` 的自动搜索 / 跨域恢复 / 视频切换时序；
    - `PlayerController` 的身份补全与 restore；
    - `SubtitleSearchEngine` 的超时、取消、部分失败；
    - `ProviderManager` 的启用/禁用；
    - 面板 UI 与 CC 插入。
- 建议：优先补 `PlayerController` 和 `bootstrap` 的可测试抽取（把策略提取为纯函数/服务）。
- 相关：`tests/`。

### 4.3 没有 lint / format 脚本

- 现状：只有 typecheck/test/build。
- 建议：按需引入 ESLint/Prettier 或至少 `eslint --max-warnings=0`；避免一次性全仓库格式化。
- 相关：`package.json`。

### 4.4 缓存数据库演进

- 现状：`DB_VERSION = 1`；`sourceResult` 是可选字段，未做版本升级；`parserVersion` 已存储但没有“重新解析”流程。
- 建议：规划 metadata 专属 store / 索引、版本迁移、parserVersion 变化后的按需重解析。
- 相关：`src/storage/database.ts`、`src/storage/subtitle-repository.ts`。

### 4.5 原生桌面全屏与跨浏览器

- 现状：「网页全屏」已在新旧播放页验证；「桌面全屏」仍标记 `TODO(REAL-115-VERIFICATION)`。
- 建议：验证原生全屏元素与 overlay；若全屏的是 `<video>`，评估原生 `TextTrack` 或回退提示。
- 另：Firefox / Violentmonkey 的 GM API 差异未验证。
- 相关：`docs/115-player-inspection.md`。

### 4.6 可访问性与移动端

- 面板控件的键盘焦点、ARIA、移动端布局未系统验证。
- 建议：加焦点样式、键盘操作、窄屏布局测试。

## 5. 建议实施顺序

1. 修正 ASS/SSA 文档与错误提示（低成本，避免误导）。
2. 手动番号持久化（产品要求缺口）。
3. 搜索/下载取消 + 重定向域名校验（安全与资源）。
4. 缓存容量清理、收藏与设置项接线。
5. 元数据同步的刷新入口、元数据专属查询、防抖发布。
6. CI 加 typecheck/test，修版本/发布策略。
7. 补 PlayerController / bootstrap 集成测试。
8. 拖动定位、桌面全屏、跨浏览器。

## 6. 文档维护约定

- 修改播放器选择器、缓存模型、同步协议、支持格式或权限时，同步更新：
    - `README.md` 的用户可见能力与限制；
    - `115-subtitle-assistant-design.md` 的对应章节；
    - `docs/115-player-inspection.md` 的实测记录；
    - 本文档的状态与优先级。
- 未实测的浏览器/全屏/权限行为继续标记 `TODO(REAL-115-VERIFICATION)`，不得写成已完成。
