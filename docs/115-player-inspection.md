# 115 播放页勘察记录

> 本文件只记录**在真实 115 播放页实测到的**信息。未验证的项目明确标记为 `TODO(REAL-115-VERIFICATION)`，
> 不得据此猜测实现。修改播放器适配代码时，请同步更新对应条目与验证日期。

## 1. 环境

| 项 | 值 |
|---|---|
| 检查日期 | 2026-11-01 |
| 浏览器 | Chrome 150.0.7871.125（macOS） |
| Tampermonkey | 5.5.1 |
| 页面 host | `https://115vod.com/` |
| 页面 path | `/`，查询参数含 `pickcode` 与 `share_id`（分享播放页） |
| 脚本运行方式 | Tampermonkey 开发版加载器（vite-plugin-monkey dev），入口注入页面上下文 |

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

`TODO(REAL-115-VERIFICATION)`

- 未实测「下一条 / 选集」切换时 `#js-video` 节点是否复用。
- 当前实现以 `video` 元素 + `pickcode` 作为同一视频判定依据，切换时会 detach 旧上下文并重建 overlay。

## 7. 已知限制

- 开发版加载器把 dev server 地址写死在脚本里，端口漂移会导致脚本静默不执行；
  `vite.config.ts` 已固定 `server.port = 5173` 且 `strictPort: true`。
- 开发模式运行在页面上下文，`GM_setValue` / `GM_xmlhttpRequest` 不可用：
  - 设置存储退回 `localStorage`（仅开发模式，生产仍走 GM 存储）；
  - 在线字幕搜索在开发模式下会失败，需要安装构建产物验证。
