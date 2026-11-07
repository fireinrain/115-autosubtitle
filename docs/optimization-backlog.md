# 优化清单与已知限制

> 基线：2026-11-07，版本 `0.3.2`，生产构建 `dist/115-subtitle-assistant.user.js`。
> 验证基线：`npm run lint`、`npm run typecheck` 通过；`npm test` 22 个文件 / 200 个用例通过；`npm run build` 通过。
> 已完成真实页面验证：旧/新播放页、视频切换、跨播放域名元数据同步与自动恢复、手动番号持久化、同步索引刷新、清理入口、快捷键、ZIP
> 导出与去重。
> 本轮未完成真实浏览器验证：原生桌面全屏、移动端/窄视口手工验收。

## 1. 当前已实现

- 旧播放页 `115vod.com` 与新播放页 `115.com/players/video/*`，CC 入口与 Shadow DOM overlay。
- 番号识别、手动番号持久化、迅雷 / SubtitleCat 并行搜索、评分排序去重、匹配原因提示。
- SRT / VTT 解析；ASS/SSA 默认转换为只含时间轴和纯文本的 VTT，完整渲染不在当前范围。
- 时间轴同步、样式与偏移、字幕拖动定位、预览、单文件下载、缓存 ZIP 导出。
- IndexedDB 缓存、跨视频隔离、同番号自动替换、手动去重、按天/容量清理。
- 无缓存自动搜索，带 15 分钟 TTL 查询缓存；只提示结果，不自动应用。
- GM 跨播放域名缓存元数据同步；事件推送 + 15s 轮询 fallback；远程索引清理；旧缓存来源补齐。
- 视频切换清理、搜索代次隔离、metadata 就绪门控、请求取消。
- 非阻塞 toast / 确认弹层；面板 ARIA、键盘 tab 导航、焦点样式、窄屏 CSS。
- 来源健康检查；网络层并发/同 host 频率限制、网络错误/5xx 一次退避重试。
- IndexedDB v2：`subtitleMeta` 元数据 store、v1 迁移、`parserVersion` 按需重解析。
- ESLint 基线；CI 在 build 前执行 lint + typecheck + test。

## 2. 已完成优化项

| 项目                      | 状态            | 说明                                                                                                                         |
|-------------------------|---------------|----------------------------------------------------------------------------------------------------------------------------|
| 3.1 自动搜索重复请求与 TTL       | ✅ 已完成         | `autoSearchCache.v1`，15 分钟，按番号 + 60s 时长桶/文件名；空结果也缓存；手动搜索绕过并覆盖                                                              |
| 3.2 元数据同步实时性与冲突         | ✅ 已完成         | `subtitleMeta` 专属查询、`GM_addValueChangeListener` 推送、按视频 `updatedAt` 解决选中冲突、远程索引清理、旧记录来源补齐                                   |
| 3.3 未接线设置               | ✅ 已完成         | 删除 `autoSelectHighConfidence`；其余设置均已接线                                                                                     |
| 3.5 字幕拖动定位              | ✅ 已完成         | 样式页「调整位置」；定位模式才启用 pointer events，拖动写入百分比，Esc 退出                                                                            |
| 3.7 未使用播放器适配器           | ✅ 已完成         | 删除 `src/player/generic-video-adapter.ts`                                                                                   |
| 3.8 面板与观察器性能            | ✅ 已完成         | 面板按 tab 条件重绘 + rAF 合并；CC 插入 100ms 节流；播放器 observer 去掉高频属性观察                                                                 |
| 3.9 阻塞式 alert / confirm | ✅ 已完成         | 用户可见错误改 toast；去重/清理/清空/远程清理改异步确认弹层                                                                                         |
| 3.10 Provider 健康/限流/重试  | ✅ 已完成         | 来源检测按钮；全局并发 3、同 host 250ms；网络错误/5xx 一次退避重试；失败来源 60s 冷却，手动搜索可强制重试                                                           |
| 3.11 新版选择器脆弱            | ✅ 已完成         | 保留文本定位，新增 aria-label/title fallback；找不到时只记录一次结构诊断                                                                          |
| 3.12 ASS/SSA 自动转 VTT    | ✅ 已完成         | `ass-parser.ts` 提取 Dialogue 时间轴/文本，`ass-to-vtt.ts` 输出纯文本 VTT；丢弃样式/定位/动画/绘图，缓存格式统一为 vtt                                     |
| 4.2 lint / format       | ✅ 已完成（lint）   | 新增 ESLint 9 + typescript-eslint 与 `npm run lint`，CI 已接入；未做全仓库 Prettier 格式化，避免无关 diff                                       |
| 4.3 缓存数据库演进             | ✅ 已完成         | DB v2 + `subtitleMeta` 迁移；`PARSER_VERSION` + 按需重解析                                                                         |
| 4.5 可访问性与移动端            | 🟡 代码完成，待真机验收 | tablist/tab/tabpanel、aria-selected、方向键、range/color aria-label、toast aria-live、dialog 焦点、`:focus-visible`、窄屏 CSS；尚未做移动端真机验收 |

## 3. 仍需真实浏览器验证

### 3.1 原生桌面全屏

- 现状：「网页全屏」已在新旧播放页验证；「桌面全屏」仍标记 `TODO(REAL-115-VERIFICATION)`。
- 已增加运行时检测：`fullscreenchange` 后若 `document.fullscreenElement` 不包含 overlay 宿主，会 toast 明确提示“当前为
  video 原生全屏，自定义字幕层不会显示”。
- 本次尝试启动 Chrome 远程调试时 DevTools HTTP 端点不可用，未能在真实页面完成全屏元素检查。
- 验证方法：进入桌面全屏后检查 `document.fullscreenElement` 是 `video`、播放器根容器还是页面根节点，并确认
  overlay/提示是否符合预期。
- 若全屏元素是 `<video>`，需要评估原生 `TextTrack` fallback；目前只做明确提示，不宣称支持。

### 3.2 移动端与窄视口

- 已加 `width: min(400px, calc(100vw - 16px))` 和窄屏结果行换行 CSS。
- 仍需在真实 115 页面用窄视口确认面板不遮挡控制栏、确认按钮可点击、键盘焦点顺序合理。

## 4. 已知限制

- ASS/SSA 完整渲染未实现：当前自动转换为只有文字和时间轴的 VTT，样式表、定位、动画、卡拉 OK、绘图和完整排版不保留；转换后的缓存不保留原始
  ASS/SSA 字节。
- 自动搜索缓存 TTL 内不会重新请求；需要最新结果时可手动搜索。
- 旧缓存若无法从在线来源精确匹配 `providerId + sourceId`，仍无法补来源信息。
- 下载地址可能过期或来源下线，跨域恢复失败时回退自动搜索。
- 开发模式没有 `GM_xmlhttpRequest`，在线搜索只能在安装构建产物后验证。
- 桌面全屏与移动端未完成真机验收。

## 5. 文档维护约定

修改播放器选择器、缓存模型、同步协议、支持格式或权限时，同步更新：

- `README.md` 的用户可见能力与限制；
- `115-subtitle-assistant-design.md` 的对应章节；
- `docs/115-player-inspection.md` 的实测记录；
- 本文档的状态与优先级。

未实测的浏览器/全屏/权限行为继续标记 `TODO(REAL-115-VERIFICATION)`，不得写成已完成。
