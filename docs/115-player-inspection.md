# 115 播放页勘察记录

> 本文件只记录**在真实 115 播放页实测到的**信息。未验证的项目明确标记为 `TODO(REAL-115-VERIFICATION)`，
> 不得据此猜测实现。修改播放器适配代码时，请同步更新对应条目与验证日期。

## 1. 环境

| 项            | 值                                                                                                        |
|--------------|----------------------------------------------------------------------------------------------------------|
| 检查日期         | 2026-11-01（初始勘察）；2026-11-03（补充视频切换实测）                                                                    |
| 浏览器          | Chrome 150.0.7871.125（macOS）                                                                             |
| Tampermonkey | 5.5.1                                                                                                    |
| 页面 host      | `https://115vod.com/`（旧播放页）；`https://115.com/`（新版播放页 `/players/video/<pickcode>`）                        |
| 页面 path      | `/`，查询参数含 `pickcode` 与 `share_id`（分享播放页）                                                                 |
| 脚本运行方式       | Tampermonkey；开发期为 vite-plugin-monkey dev 加载器，2026-11-03 切换实测使用构建产物 `dist/115-subtitle-assistant.user.js` |

## 2. 播放器 DOM

实测结构（分享播放页，单视频）：

```html
<div id="js-video_box" class="player-h5">            <!-- position: relative -->
  <div class="play-stage">…</div>
  <div class="player-holder">
    <video id="js-video"></video>                     <!-- display: flex, 1120x630 -->
  </div>
  <div class="operate-bar">                           <!-- 底部控制栏 -->
    <div class="bar-side">
      <ul>
        <li><a class="btn-cle"><s>倍速</s></a>…</li>
        <li><a class="btn-cle"><s>选集</s></a>…</li>
        <li><a class="btn-cle"><s>1080P</s></a>…</li>
        <li><a class="btn-cle"><s>字幕</s></a><div class="tooltip">字幕设置</div></li>
        <li><a class="btn-cle"><s>音量</s></a>…</li>
        …
      </ul>
    </div>
  </div>
</div>
```

关键结论：

- `video` 元素选择器 `#js-video` 稳定可用，`getComputedStyle(video).display === "flex"`，尺寸非零。
- 播放器根节点 `#js-video_box` 的 `position` 为 `relative`，可直接作为 overlay 宿主。
- 原生「字幕」按钮是 `.operate-bar .bar-side > ul > li` 中的第 4 个 `li`，
  结构固定为 `<li><a class="btn-cle"><s>字幕</s></a><div class="tooltip">字幕设置</div></li>`。
  助手的 `CC` 按钮插入在该 `li` 之后（`li.after()`）。
- 原生按钮样式：`a.btn-cle` 为 `40x20`、`opacity .7`、背景 `#666`；助手按钮复用同样的 class，视觉一致。

## 3. 视频元数据

| 字段 | 来源 | 实测值示例 |
|---|---|---|
| 文件名 | `#js-video_title`（`<i>` 元素） | `489155.com@DVAJ-758.mp4` |
| 文件 ID | URL 查询参数 `pickcode` | `biym1swqjygpd8s12` |
| 时长/分辨率 | `video.duration` / `video.videoWidth` / `video.videoHeight` | `7216.3s` / `1920x1080` |
| 视频地址 | `video.src` | `blob:` URL（**不得写入日志或作为身份依据**） |

注意：

- `#js-video_title` 的文本在播放器初始化**之后**才写入。首次 `document-idle` 探测时该节点可能为空，
  因此 `PlayerController` 必须在后续探测中补齐身份信息（见 `refreshIdentity`）。
- 页面会删除 `Number.isFinite` 与 `Number.isInteger`（实测 `typeof Number.isFinite === "undefined"`）。
  开发模式下脚本运行在页面上下文，直接调用会抛 `TypeError`；统一改用 `src/utils/number.ts` 的 `isFiniteNumber`。

## 4. 页面变更频率与探测策略

- 115 播放页会持续修改 DOM 属性（进度条、广告位、弹幕等）。
- 对 `MutationObserver` 使用 `debounce` 会被无限重置，回调**永远不会执行**（实测身份信息一直无法刷新）。
- 现改为 `throttle(400ms)`，保证持续变更时仍按间隔重新探测。

## 5. 全屏

`TODO(REAL-115-VERIFICATION)`

- 尚未实测原生全屏进入的是 `video`、`#js-video_box` 还是页面根节点。
- 若全屏元素是 `video` 本身，当前挂在 `#js-video_box` 下的 overlay 不会显示，需要回退方案。

## 6. 视频切换

实测 2026-11-03（生产构建，Chrome，`https://115vod.com/`，分享播放页播放列表切换）。

切换方式与结果：

- 点击播放列表项后 URL 变为 `/?hls=1&pickcode=<新 pickcode>`，属于同页面切换。
- **`#js-video` 元素被复用**：切换前后 `video === 切换前 video` 为 `true`（在元素上打的临时标记在切换后仍存在）。
- 切换后 `video.duration` 的变化顺序为：短暂保留旧值（实测约 0.25s 内仍为上一个视频的 91s）→ 变为 `NaN` 约 2s → 新视频
  metadata 就绪后恢复（实测 7216.3s）。
- 旧字幕、overlay 内容和「当前视频」缓存列表在切换后立即清理；旧视频的在线搜索结果不会显示在新视频上。
- 切换回有缓存的视频时，字幕恢复发生在新的 `loadedmetadata` 之后（实测约 2.3s），而不是 URL 变化时。

对实现的约束：

- 同一视频判定继续使用 `video` 元素 + `pickcode`；元素复用意味着必须依赖 `pickcode` 变化触发 detach/attach。
- 自动搜索不能在 URL 变化后的固定短延迟内直接用 `videoKey` 查缓存：此时 `duration` 可能是旧值或 `NaN`
  ，会误判“无缓存”并发起多余搜索。必须等待 `loadedmetadata` 就绪，或在搜索前轮询复查缓存。
- 搜索结果需要绑定发起搜索时的文件身份与代次；搜索途中切换视频时，旧结果必须丢弃，不能回填到新视频面板。

## 7. 新版播放页（115.com/players/video/*）

实测 2026-11-03（Chrome，生产构建）：

- 页面 host `https://115.com/`，path `/players/video/<pickcode>`，常用查询参数 `name`、`fid`。
- video 没有 id 和稳定 class（实测为 `w-full h-full object-contain`），位于
  `div.relative.w-full.h-full.bg-black.overflow-hidden.group` 内。
- 控制栏也在该容器内。字幕按钮是 `<button>字幕</button>`，外层为 `<div class="relative">`；
  class 是构建生成的 utility class（如 `p-1 text-sm ... text-blue-400`），不能作为稳定选择器。
- 文件名来源：URL 的 `name` 参数（已 URL 解码）；文件 ID 使用路径中的 pickcode，`fid` 作为 fallback。
- 播放列表切换时 path 里的 pickcode 会变化（示例 `e5exo0rcveo9ozlcb` → `akvrd2apyvdlmhfpm`）。
- overlay 宿主使用 video 的直接父容器（`position: relative`），与 video 显示区域一致。
- CC 按钮插在原生「字幕」按钮的父容器之后，复用「倍速」按钮的样式：
  `p-1 text-sm whitespace-nowrap transition-colors text-white hover:text-blue-400`。
- 播放列表切换会**替换 video 元素**（旧站是复用同一个元素），因此媒体事件监听挂在
  `document` 捕获阶段，不能只绑定首次发现的 video。
- 「网页全屏」时播放器根容器扩展到整个视口，CC 按钮和 overlay 都会保留；退出后恢复。
- 缓存隔离：`115.com` 与 `115vod.com` 是不同 origin，IndexedDB 不共享；
  两个播放域名各自维护字幕缓存，GM 设置共享。缓存索引通过 GM `metadataSync.v1` 同步：
  另一个域名可以按在线来源信息重新下载并恢复字幕；本地导入的字幕只能显示元数据，不能自动恢复。

### 7.1 跨播放域名缓存元数据实测（2026-11-03）

- `115vod.com` 的 3 条缓存索引在 `115.com` 缓存 Tab 中显示为「其他播放域名 3 条 / 214.7KB」。
- 同一 DVAJ 视频在 `115.com` 打开时，远程列表正确显示 `115vod.com` 的记录；本地导入记录标记为不可恢复。
- 在 `115vod.com` 使用一条带 `sourceResult` 的在线字幕后，`115.com` 重新加载同一视频会先提示
  「正在从 115vod.com 恢复缓存字幕…」，约 1.8s 后恢复成功。
- 恢复记录使用强 `videoKey`（`id:biym1swqjygpd8s12|dur:7216`），不会写成只有 fileId 的弱 key。
- 只同步元数据和在线来源快照，不复制 Blob/Cues；两个页面之间没有实时推送，需要刷新或切换视频后重新读取。

## 8. 已知限制

- 开发版加载器把 dev server 地址写死在脚本里，端口漂移会导致脚本静默不执行；
  `vite.config.ts` 已固定 `server.port = 5173` 且 `strictPort: true`。
- 开发模式运行在页面上下文，`GM_setValue` / `GM_xmlhttpRequest` 不可用：
  - 设置存储退回 `localStorage`（仅开发模式，生产仍走 GM 存储）；
  - 在线字幕搜索在开发模式下会失败，需要安装构建产物验证。
- 「桌面全屏」仍未实测；「网页全屏」已在新旧播放页验证。见第 5 节。
- ASS/SSA 当前只按扩展名识别，解析器尚未实现，会返回不支持错误。
- 更多优化项与优先级见 `docs/optimization-backlog.md`。
