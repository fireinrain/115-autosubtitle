// ==UserScript==
// @name         115 Subtitle Assistant
// @namespace    https://example.invalid/115-subtitle-assistant
// @version      0.3.0
// @description  115 网页播放器字幕搜索、显示与本地缓存
// @match        https://115vod.com/*
// @match        https://115.com/players/*
// @connect      api-shoulei-ssl.xunlei.com
// @connect      subtitle.v.geilijiasu.com
// @connect      www.subtitlecat.com
// @grant        GM_addStyle
// @grant        GM_addValueChangeListener
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_removeValueChangeListener
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(function() {
	"use strict";
	function throttle(fn, intervalMs) {
		let lastRun = 0;
		let timer = null;
		let pendingArgs = null;
		const run = (args) => {
			lastRun = Date.now();
			fn(...args);
		};
		return (...args) => {
			pendingArgs = args;
			const elapsed = Date.now() - lastRun;
			if (elapsed >= intervalMs && timer === null) {
				pendingArgs = null;
				run(args);
				return;
			}
			if (timer !== null) return;
			timer = setTimeout(() => {
				timer = null;
				const next = pendingArgs;
				pendingArgs = null;
				if (next) run(next);
			}, Math.max(0, intervalMs - elapsed));
		};
	}
	function isFiniteNumber(value) {
		return typeof value === "number" && value === value && value !== Infinity && value !== -Infinity;
	}
	var VIDEO_SELECTOR = "#js-video";
	var TITLE_SELECTOR = "#js-video_title";
	var PLAYER_BOX_SELECTOR = "#js-video_box";
	var PICKCODE_PARAM = "pickcode";
    var MODERN_PLAYER_PATH = /^\/players\/video\/([^/]+)\/?$/;

    function parseModernPlayerUrl(rawUrl) {
        let url;
        try {
            url = new URL(rawUrl);
        } catch {
            return null;
        }
        if (url.hostname !== "115.com" && !url.hostname.endsWith(".115.com")) return null;
        const match = url.pathname.match(MODERN_PLAYER_PATH);
        if (!match) return null;
        let pickcode = match[1];
        try {
            pickcode = decodeURIComponent(pickcode);
        } catch {
        }
        const fileName = url.searchParams.get("name") || void 0;
        const fid = url.searchParams.get("fid") || void 0;
        const fileId = pickcode || fid;
        if (!fileId) return null;
        return {
            pickcode,
            fileId,
            fileName
        };
    }
	var M115VideoAdapter = class {
		id = "115-video";
		detect() {
            const modern = parseModernPlayerUrl(window.location.href);
            if (modern) return this.detectModern(modern);
            return this.detectLegacy();
        }

        detectLegacy() {
			const video = document.querySelector(VIDEO_SELECTOR);
			if (!video) return null;
			const style = getComputedStyle(video);
			if (style.display === "none" || style.visibility === "hidden") return null;
			const playerRoot = document.querySelector(PLAYER_BOX_SELECTOR) ?? video.parentElement ?? document.body;
            this.ensurePositioned(playerRoot);
			return {
				video,
				playerRoot,
				overlayHost: playerRoot,
				metadata: this.readMetadata(video)
			};
		}

        detectModern(info) {
            const video = this.findVisibleVideo();
            if (!video) return null;
            const playerRoot = this.resolveModernPlayerRoot(video);
            this.ensurePositioned(playerRoot);
            return {
                video,
                playerRoot,
                overlayHost: playerRoot,
                metadata: this.readMetadata(video, info)
            };
        }

        resolveModernPlayerRoot(video) {
            const parent = video.parentElement;
            if (parent && (parent.querySelector("button") || parent.querySelector("[class*=\"bottom-0\"]"))) return parent;
            return video.closest("div[class*=\"aspect-video\"]") ?? parent ?? document.body;
        }

        findVisibleVideo() {
            const candidates = [...document.querySelectorAll("video")].map((video) => {
                return {
                    video,
                    rect: video.getBoundingClientRect(),
                    style: getComputedStyle(video)
                };
            }).filter(({
                           rect,
                           style
                       }) => rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden");
            if (candidates.length === 0) return null;
            if (candidates.length === 1) return candidates[0].video;
            candidates.sort((a, b) => {
                const playing = Number(!b.video.paused) - Number(!a.video.paused);
                if (playing !== 0) return playing;
                return b.rect.width * b.rect.height - a.rect.width * a.rect.height;
            });
            return candidates[0].video;
        }

        ensurePositioned(playerRoot) {
            if (getComputedStyle(playerRoot).position === "static") playerRoot.style.position = "relative";
        }

        readMetadata(video, modern) {
			return {
				platform: "115",
                fileName: modern ? modern.fileName : this.findFileName(),
                fileId: modern ? modern.fileId : this.findFileId(),
				duration: isFiniteNumber(video.duration) ? video.duration : void 0,
				width: video.videoWidth || void 0,
				height: video.videoHeight || void 0,
				sourcePageUrl: window.location.href
			};
		}
		findFileName() {
			const raw = document.querySelector(TITLE_SELECTOR)?.textContent?.trim();
			if (raw) return this.cleanFileName(raw);
			const ogTitle = document.querySelector("meta[property=\"og:title\"]");
			if (ogTitle?.content) return this.cleanFileName(ogTitle.content);
			const docTitle = document.title?.trim();
			if (docTitle) return this.cleanFileName(docTitle);
		}
		cleanFileName(name) {
			return name.replace(/^正在播放[：:]\s*/, "").replace(/\s*-\s*115.*$/, "").trim();
		}
		findFileId() {
			try {
				const pickcode = new URL(window.location.href).searchParams.get(PICKCODE_PARAM);
				if (pickcode) return pickcode;
			} catch {}
            const activeItem = document.querySelector("#js-video_list li.hover[pickcode]");
			if (activeItem) {
				const pc = activeItem.getAttribute(PICKCODE_PARAM);
				if (pc) return pc;
			}
            const items = document.querySelectorAll("#js-video_list li[pickcode]");
            if (items.length === 1) return items[0].getAttribute(PICKCODE_PARAM) ?? void 0;
		}
		observe(onChange) {
			const scheduleDetect = throttle(() => {
				onChange(this.detect());
			}, 300);
			const observer = new MutationObserver(() => {
				scheduleDetect();
			});
			observer.observe(document.body, {
				childList: true,
                subtree: true
			});
			const onFullscreenChange = () => scheduleDetect();
			document.addEventListener("fullscreenchange", onFullscreenChange);
            const onMediaEvent = (event) => {
                if (event.target instanceof HTMLVideoElement) scheduleDetect();
            };
            document.addEventListener("loadstart", onMediaEvent, true);
            document.addEventListener("loadedmetadata", onMediaEvent, true);
			const timers = [];
			timers.push(window.setTimeout(scheduleDetect, 500));
			timers.push(window.setTimeout(scheduleDetect, 1500));
			timers.push(window.setTimeout(scheduleDetect, 3e3));
			return () => {
				observer.disconnect();
				document.removeEventListener("fullscreenchange", onFullscreenChange);
                document.removeEventListener("loadstart", onMediaEvent, true);
                document.removeEventListener("loadedmetadata", onMediaEvent, true);
				for (const t of timers) clearTimeout(t);
			};
		}
	};
	var m115VideoAdapter = new M115VideoAdapter();

    function normalizeFileName$1(input) {
        return input.normalize("NFKC").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[\s_.]+/g, " ").replace(/[\u005B\u005D【】（）()]/g, " ").replace(/\s+/g, " ").trim().toUpperCase();
	}
	var StandardCodeParser = class {
		id = "standard-code";
		priority = 10;
		match(input) {
			return /[A-Z]{2,8}-\d{2,6}/i.test(input);
		}
		parse(input) {
			const match = input.match(/([A-Z]{2,8})-(\d{2,6})/i);
			if (!match) return null;
			return {
				raw: match[0],
				normalized: `${match[1].toUpperCase()}-${match[2]}`,
				family: "standard",
				confidence: .9
			};
		}
	};
	var NoHyphenCodeParser = class {
		id = "nohyphen-code";
		priority = 20;
		match(input) {
			return /(?:^|[^A-Z])([A-Z]{2,6})(\d{3,6})(?:[^0-9]|$)/i.test(input);
		}
		parse(input) {
			const match = input.match(/(?:^|[^A-Z])([A-Z]{2,6})(\d{3,6})(?:[^0-9]|$)/i);
			if (!match) return null;
			return {
				raw: `${match[1]}${match[2]}`,
				normalized: `${match[1].toUpperCase()}-${match[2]}`,
				family: "nohyphen",
				confidence: .6
			};
		}
	};
	var Fc2PpvCodeParser = class {
		id = "fc2-ppv-code";
		priority = 5;
		match(input) {
			return /FC2[-_]?PPV[-_]?(\d+)/i.test(input);
		}
		parse(input) {
			const match = input.match(/FC2[-_]?PPV[-_]?(\d+)/i);
			if (!match) return null;
			return {
				raw: match[0],
				normalized: `FC2-PPV-${match[1]}`,
				family: "fc2-ppv",
				confidence: .95
			};
		}
	};
	var PARSERS = [
		new Fc2PpvCodeParser(),
		new StandardCodeParser(),
		new NoHyphenCodeParser()
	].sort((a, b) => a.priority - b.priority);
	function parseCode(fileName) {
		const upper = fileName.toUpperCase();
		for (const parser of PARSERS) if (parser.match(upper)) return parser.parse(upper);
		return null;
	}
	var VideoIdentityService = class {
		resolve(metadata) {
			const originalFileName = metadata.fileName;
            const normalizedFileName = originalFileName ? normalizeFileName$1(originalFileName) : void 0;
			const parsedCode = normalizedFileName ? parseCode(normalizedFileName) : null;
			const parts = [];
			let confidence = "weak";
			if (metadata.fileId) {
				parts.push(`id:${metadata.fileId}`);
				confidence = "strong";
			} else if (normalizedFileName) {
				parts.push(`name:${normalizedFileName}`);
				confidence = "medium";
			}
			if (metadata.duration && isFiniteNumber(metadata.duration)) parts.push(`dur:${Math.round(metadata.duration)}`);
			if (parts.length === 0) parts.push(`url:${metadata.sourcePageUrl}`);
			return {
				videoKey: parts.join("|"),
				fileId: metadata.fileId,
				originalFileName,
				normalizedFileName,
				code: parsedCode?.normalized,
				duration: metadata.duration,
				confidence,
				source: metadata.fileId ? "115-dom" : "media-element"
			};
		}
	};
	var SubtitleTimelineEngine = class {
		cues = [];
		sortedCues = [];
		prefixMaxEnd = [];
		offsetMs = 0;
		load(cues) {
			this.cues = cues;
			this.sortedCues = [...cues].sort((a, b) => a.startMs - b.startMs);
			this.prefixMaxEnd = [];
			let maxEnd = -Infinity;
			for (const cue of this.sortedCues) {
				if (cue.endMs > maxEnd) maxEnd = cue.endMs;
				this.prefixMaxEnd.push(maxEnd);
			}
		}
		setOffset(offsetMs) {
			this.offsetMs = offsetMs;
		}
		update(videoTimeSeconds) {
			if (!isFiniteNumber(videoTimeSeconds) || videoTimeSeconds < 0) return [];
			const t = videoTimeSeconds * 1e3 - this.offsetMs;
			return this.findActiveCues(t);
		}
		findActiveCues(t) {
			if (this.sortedCues.length === 0) return [];
			const idx = this.binarySearch(t);
			if (idx < 0) return [];
			const result = [];
			for (let i = idx; i >= 0; i--) {
				if (this.prefixMaxEnd[i] <= t) break;
				const cue = this.sortedCues[i];
				if (cue.startMs <= t && cue.endMs > t) result.push(cue);
			}
			for (let i = idx + 1; i < this.sortedCues.length; i++) {
				const cue = this.sortedCues[i];
				if (cue.startMs > t) break;
				if (cue.endMs <= t) continue;
				result.push(cue);
			}
			result.sort((a, b) => a.sourceOrder - b.sourceOrder);
			return result;
		}
		binarySearch(t) {
			let lo = 0;
			let hi = this.sortedCues.length - 1;
			let result = -1;
			while (lo <= hi) {
				const mid = lo + hi >> 1;
				if (this.sortedCues[mid].startMs <= t) {
					result = mid;
					lo = mid + 1;
				} else hi = mid - 1;
			}
			return result;
		}
		clear() {
			this.cues = [];
			this.sortedCues = [];
			this.prefixMaxEnd = [];
			this.offsetMs = 0;
		}
		dispose() {
			this.clear();
		}
	};
    var FONT_PRESETS = [
        {
            id: "cjk-sans",
            label: "苹方 / 思源黑体（推荐）",
            fontFamily: "\"PingFang SC\", \"Hiragino Sans GB\", \"Source Han Sans SC\", \"Noto Sans CJK SC\", \"Microsoft YaHei\", sans-serif"
        },
        {
            id: "heiti",
            label: "黑体（字幕常用）",
            fontFamily: "\"Heiti SC\", \"STHeiti\", \"SimHei\", \"Source Han Sans SC\", \"Noto Sans CJK SC\", sans-serif"
        },
        {
            id: "yuanti",
            label: "圆体",
            fontFamily: "\"Yuanti SC\", \"YouYuan\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
        },
        {
            id: "songti",
            label: "宋体",
            fontFamily: "\"Songti SC\", \"SimSun\", \"Noto Serif CJK SC\", serif"
        },
        {
            id: "kaiti",
            label: "楷体",
            fontFamily: "\"Kaiti SC\", \"KaiTi\", \"STKaiti\", \"Noto Serif CJK SC\", serif"
        },
        {
            id: "japanese",
            label: "日文（Hiragino / Yu Gothic）",
            fontFamily: "\"Hiragino Sans\", \"Hiragino Kaku Gothic ProN\", \"Yu Gothic\", \"Meiryo\", \"Noto Sans CJK JP\", sans-serif"
        },
        {
            id: "system",
            label: "系统默认",
            fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
        }
    ];
    var DEFAULT_SUBTITLE_FONT = FONT_PRESETS[0].fontFamily;

    function findFontPreset(fontFamily) {
        return FONT_PRESETS.find((preset) => preset.fontFamily === fontFamily);
    }

    function normalizeFontFamily(value) {
        if (typeof value !== "string" || value.trim().length === 0) return DEFAULT_SUBTITLE_FONT;
        if (/[;{}<>]/.test(value)) return DEFAULT_SUBTITLE_FONT;
        return value.slice(0, 300);
    }
	var Logger = class {
		enabled = false;
		prefix = "[115Sub]";
		setEnabled(enabled) {
			this.enabled = enabled;
		}
		debug(message, ...args) {
			if (this.enabled) console.debug(`${this.prefix} ${message}`, ...args);
		}
		info(message, ...args) {
			console.info(`${this.prefix} ${message}`, ...args);
		}
		warn(message, ...args) {
			console.warn(`${this.prefix} ${message}`, ...args);
		}
		error(message, ...args) {
			console.error(`${this.prefix} ${message}`, ...args);
		}
	};
	var logger = new Logger();
	var OverlayRenderer = class {
		host = null;
		container = null;
		root = null;
		stage = null;
		styleEl = null;
		currentCues = [];
		currentStyle = null;
		visible = true;
        positioning = false;
        onPositionCommit = null;
        pointerDrag = null;
		mount(host) {
			if (this.host === host && this.container?.isConnected) return;
			this.unmount();
			this.host = host;
			const container = document.createElement("div");
			container.className = "userscript-subtitle-root";
			container.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:9999;overflow:hidden;";
			container.style.display = this.visible ? "block" : "none";
			this.root = container.attachShadow({ mode: "open" });
			this.styleEl = document.createElement("style");
			this.root.appendChild(this.styleEl);
			this.stage = document.createElement("div");
			this.stage.className = "subtitle-stage";
            this.stage.addEventListener("pointerdown", this.handlePointerDown);
            this.stage.addEventListener("pointermove", this.handlePointerMove);
            this.stage.addEventListener("pointerup", this.handlePointerUp);
            this.stage.addEventListener("pointercancel", this.handlePointerUp);
			this.root.appendChild(this.stage);
			host.appendChild(container);
			this.container = container;
			logger.debug("Overlay mounted");
		}
		unmount() {
			this.container?.remove();
			this.container = null;
			this.host = null;
			this.root = null;
			this.stage = null;
			this.styleEl = null;
			this.currentCues = [];
            this.pointerDrag = null;
            this.positioning = false;
            this.onPositionCommit = null;
		}
		setCues(cues) {
            if (cues.length === this.currentCues.length && cues.every((cue, index) => cue === this.currentCues[index])) return;
			this.currentCues = cues;
			if (this.visible) this.render();
		}
		setVisible(visible) {
			if (this.visible === visible) return;
			this.visible = visible;
			if (this.container) this.container.style.display = visible ? "block" : "none";
			if (visible) this.render();
		}
		isVisible() {
			return this.visible;
		}

        setPositioningMode(enabled, onCommit) {
            this.positioning = enabled;
            this.onPositionCommit = onCommit ?? null;
            if (!enabled) this.pointerDrag = null;
            if (this.stage) {
                this.stage.style.cursor = enabled ? "move" : "";
                this.stage.style.pointerEvents = enabled ? "auto" : "none";
            }
            this.applyStyle();
            this.render();
        }

        isPositioningMode() {
            return this.positioning;
        }
		setStyle(style) {
			this.currentStyle = style;
			this.applyStyle();
			this.render();
		}
		applyStyle() {
			if (!this.styleEl || !this.currentStyle || !this.stage) return;
			const s = this.currentStyle;
			this.styleEl.textContent = `
      .subtitle-stage {
        position: absolute;
        left: ${s.xPercent}%;
        top: ${s.yPercent}%;
        transform: translate(-50%, -50%);
        max-width: ${s.maxWidthPercent}%;
        width: max-content;
        text-align: center;
        pointer-events: ${this.positioning ? "auto" : "none"};
        cursor: ${this.positioning ? "move" : "default"};
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
      }
      .subtitle-line {
        /* 字幕用中文字幕字体栈，避免中文回退到西文字体后字形发虚、字重不统一。 */
        font-family: ${normalizeFontFamily(s.fontFamily)};
        font-size: ${s.fontSize}px;
        font-weight: ${s.fontWeight};
        color: ${s.color};
        line-height: ${s.lineHeight};
        letter-spacing: 0.02em;
        white-space: pre-wrap;
        text-shadow: ${s.shadow ? `0 2px 4px rgba(0,0,0,0.85), 0 0 8px rgba(0,0,0,0.55)` : "none"};
        -webkit-text-stroke: ${s.outlineWidth}px ${s.outlineColor};
        paint-order: stroke fill;
        background-color: ${s.backgroundOpacity > 0 ? hexToRgba(s.backgroundColor, s.backgroundOpacity / 100) : "transparent"};
        padding: ${s.backgroundOpacity > 0 ? "4px 8px" : "0"};
        border-radius: 4px;
      }
      .seg-bold { font-weight: 700; }
      .seg-italic { font-style: italic; }
      .seg-underline { text-decoration: underline; }
    `;
		}
		render() {
			if (!this.stage || !this.visible) return;
			this.stage.replaceChildren();
            if (this.positioning && this.currentCues.length === 0) {
                const placeholder = document.createElement("div");
                placeholder.className = "subtitle-line";
                placeholder.textContent = "拖动字幕调整位置";
                this.stage.appendChild(placeholder);
                return;
            }
			for (const cue of this.currentCues) {
				const line = document.createElement("div");
				line.className = "subtitle-line";
				if (cue.segments && cue.segments.length > 0) for (const seg of cue.segments) {
					const span = document.createElement("span");
					const classes = [];
					if (seg.bold) classes.push("seg-bold");
					if (seg.italic) classes.push("seg-italic");
					if (seg.underline) classes.push("seg-underline");
					if (classes.length) span.className = classes.join(" ");
					if (seg.color) span.style.color = seg.color;
					span.textContent = seg.text;
					line.appendChild(span);
				}
				else line.textContent = cue.text;
				this.stage.appendChild(line);
			}
		}

        handlePointerDown = (event) => {
            if (!this.positioning || !this.stage || !this.host) return;
            if (event.button !== 0) return;
            const hostRect = this.host.getBoundingClientRect();
            const stageRect = this.stage.getBoundingClientRect();
            if (hostRect.width <= 0 || hostRect.height <= 0) return;
            event.preventDefault();
            event.stopPropagation();
            this.stage.setPointerCapture(event.pointerId);
            this.pointerDrag = {
                pointerId: event.pointerId,
                offsetX: event.clientX - (stageRect.left + stageRect.width / 2),
                offsetY: event.clientY - (stageRect.top + stageRect.height / 2),
                xPercent: this.currentStyle?.xPercent ?? 50,
                yPercent: this.currentStyle?.yPercent ?? 88
            };
        };
        handlePointerMove = (event) => {
            const drag = this.pointerDrag;
            if (!drag || drag.pointerId !== event.pointerId || !this.stage || !this.host) return;
            const hostRect = this.host.getBoundingClientRect();
            if (hostRect.width <= 0 || hostRect.height <= 0) return;
            event.preventDefault();
            event.stopPropagation();
            const xPercent = clampPercent((event.clientX - drag.offsetX - hostRect.left) / hostRect.width * 100, 5, 95);
            const yPercent = clampPercent((event.clientY - drag.offsetY - hostRect.top) / hostRect.height * 100, 20, 98);
            drag.xPercent = xPercent;
            drag.yPercent = yPercent;
            this.stage.style.left = `${xPercent}%`;
            this.stage.style.top = `${yPercent}%`;
        };
        handlePointerUp = (event) => {
            const drag = this.pointerDrag;
            if (!drag || drag.pointerId !== event.pointerId) return;
            this.pointerDrag = null;
            if (this.stage?.hasPointerCapture(event.pointerId)) this.stage.releasePointerCapture(event.pointerId);
            event.preventDefault();
            event.stopPropagation();
            this.onPositionCommit?.(drag.xPercent, drag.yPercent);
        };
		dispose() {
			this.unmount();
		}
	};

    function clampPercent(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }
	function hexToRgba(hex, alpha) {
		const h = hex.replace("#", "");
		return `rgba(${parseInt(h.substring(0, 2), 16)}, ${parseInt(h.substring(2, 4), 16)}, ${parseInt(h.substring(4, 6), 16)}, ${alpha})`;
	}

    function toSubtitleMeta(record) {
        return {
            id: record.id,
            videoKey: record.videoKey,
            code: record.code,
            providerId: record.providerId,
            sourceId: record.sourceId,
            title: record.title,
            language: record.language,
            format: record.format,
            cueCount: record.cueCount,
            checksum: record.checksum,
            size: record.rawBlob?.size ?? 0,
            createdAt: record.createdAt,
            lastUsedAt: record.lastUsedAt,
            parserVersion: record.parserVersion,
            sourceResult: record.sourceResult
        };
    }
	var DB_NAME = "115SubtitleAssistantDB";
	var Database = class {
		dbPromise = null;
		open() {
			if (this.dbPromise) return this.dbPromise;
			this.dbPromise = new Promise((resolve, reject) => {
                const request = indexedDB.open(DB_NAME, 2);
				request.onerror = () => reject(request.error);
				request.onblocked = () => reject(new Error("数据库被阻塞"));
				request.onsuccess = () => resolve(request.result);
                request.onupgradeneeded = (event) => this.upgrade(request.result, event.oldVersion);
			});
			return this.dbPromise;
		}

        upgrade(db, oldVersion) {
			if (!db.objectStoreNames.contains("subtitles")) {
				const store = db.createObjectStore("subtitles", { keyPath: "id" });
				store.createIndex("videoKey", "videoKey", { unique: false });
				store.createIndex("code", "code", { unique: false });
				store.createIndex("providerId", "providerId", { unique: false });
				store.createIndex("lastUsedAt", "lastUsedAt", { unique: false });
				store.createIndex("checksum", "checksum", { unique: false });
			}
			if (!db.objectStoreNames.contains("videoRecords")) db.createObjectStore("videoRecords", { keyPath: "videoKey" }).createIndex("lastPlayedAt", "lastPlayedAt", { unique: false });
			if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
            if (!db.objectStoreNames.contains("subtitleMeta")) {
                const metaStore = db.createObjectStore("subtitleMeta", {keyPath: "id"});
                metaStore.createIndex("videoKey", "videoKey", {unique: false});
                metaStore.createIndex("code", "code", {unique: false});
                metaStore.createIndex("providerId", "providerId", {unique: false});
                metaStore.createIndex("lastUsedAt", "lastUsedAt", {unique: false});
                metaStore.createIndex("checksum", "checksum", {unique: false});
                if (oldVersion < 2 && db.objectStoreNames.contains("subtitles")) {
                    const cursorReq = metaStore.transaction.objectStore("subtitles").openCursor();
                    cursorReq.onsuccess = () => {
                        const cursor = cursorReq.result;
                        if (!cursor) return;
                        const record = cursor.value;
                        if (record && typeof record.id === "string") metaStore.put(toSubtitleMeta(record));
                        cursor.continue();
                    };
                }
            }
		}
		async transaction(storeNames, mode) {
			const db = await this.open();
			const names = Array.isArray(storeNames) ? storeNames : [storeNames];
			const tx = db.transaction(names, mode);
			const stores = {};
			for (const name of names) stores[name] = tx.objectStore(name);
			return {
				tx,
				stores
			};
		}
		async close() {
			if (this.dbPromise) {
				(await this.dbPromise).close();
				this.dbPromise = null;
			}
		}
	};
	var database = new Database();
	var SubtitleError = class extends Error {
		code;
		cause;
		constructor(code, message, cause) {
			super(message);
			this.name = "SubtitleError";
			this.code = code;
			this.cause = cause;
		}
	};
	function isSubtitleError(error) {
		return error instanceof SubtitleError;
	}

    function normalizeCode$1(code) {
        return code.trim().toUpperCase().replace(/\s+/g, "");
    }
	var SubtitleRepository = class {
		async save(record) {
			try {
                const {tx, stores} = await database.transaction(["subtitles", "subtitleMeta"], "readwrite");
				stores.subtitles.put(record);
                stores.subtitleMeta.put(toSubtitleMeta(record));
				await this.waitForTransaction(tx);
			} catch (e) {
				if (e instanceof DOMException && e.name === "QuotaExceededError") throw new SubtitleError("CACHE_QUOTA_EXCEEDED", "缓存空间不足", e);
				throw new SubtitleError("CACHE_WRITE_FAILED", "写入字幕缓存失败", e);
			}
		}
		async getById(id) {
			try {
				const { tx, stores } = await database.transaction("subtitles", "readonly");
				const req = stores.subtitles.get(id);
				await this.waitForTransaction(tx);
				return req.result ?? null;
			} catch (e) {
				throw new SubtitleError("CACHE_READ_FAILED", "读取字幕缓存失败", e);
			}
		}
		async getByVideoKey(videoKey) {
			const { tx, stores } = await database.transaction("subtitles", "readonly");
			const req = stores.subtitles.index("videoKey").getAll(videoKey);
			await this.waitForTransaction(tx);
			return req.result ?? [];
		}

        async findBySource(videoKey, providerId, sourceId) {
            if (!sourceId) return null;
            return (await this.getByVideoKey(videoKey)).find((r) => r.providerId === providerId && r.sourceId === sourceId) ?? null;
        }

        async findByChecksum(videoKey, checksum) {
            if (!checksum) return null;
            return (await this.getByVideoKey(videoKey)).find((r) => r.checksum === checksum) ?? null;
        }
		async delete(id) {
            const {tx, stores} = await database.transaction([
                "subtitles",
                "subtitleMeta",
                "videoRecords"
            ], "readwrite");
			stores.subtitles.delete(id);
            stores.subtitleMeta.delete(id);
			const allReq = stores.videoRecords.index("lastPlayedAt").getAll();
			await new Promise((resolve) => {
				allReq.onsuccess = () => {
					const records = allReq.result ?? [];
					for (const rec of records) if (rec.selectedSubtitleId === id) {
						rec.selectedSubtitleId = void 0;
						stores.videoRecords.put(rec);
					}
					resolve();
				};
				allReq.onerror = () => resolve();
			});
			await this.waitForTransaction(tx);
		}
		async getAll() {
			const { tx, stores } = await database.transaction("subtitles", "readonly");
			const req = stores.subtitles.getAll();
			await this.waitForTransaction(tx);
			return req.result ?? [];
		}

        async getAllMetadata() {
            const {tx, stores} = await database.transaction("subtitleMeta", "readonly");
            const req = stores.subtitleMeta.getAll();
            await this.waitForTransaction(tx);
            return req.result ?? [];
        }

        async deduplicateByCode() {
            const all = await this.getAll();
            const groups = new Map();
            for (const record of all) {
                const key = normalizeCode$1(record.code ?? "");
                if (!key) continue;
                const list = groups.get(key);
                if (list) list.push(record);
                else groups.set(key, [record]);
            }
            const removedToKept = new Map();
            let mergedGroups = 0;
            for (const list of groups.values()) {
                if (list.length < 2) continue;
                mergedGroups++;
                const sorted = [...list].sort((a, b) => Math.max(b.createdAt ?? 0, b.lastUsedAt ?? 0) - Math.max(a.createdAt ?? 0, a.lastUsedAt ?? 0));
                const keep = sorted[0];
                for (const record of sorted.slice(1)) removedToKept.set(record.id, keep);
            }
            if (removedToKept.size === 0) return {
                removed: 0,
                kept: all.length,
                groups: 0
            };
            const {tx, stores} = await database.transaction([
                "subtitles",
                "subtitleMeta",
                "videoRecords"
            ], "readwrite");
            for (const id of removedToKept.keys()) {
                stores.subtitles.delete(id);
                stores.subtitleMeta.delete(id);
            }
            const videoReq = stores.videoRecords.getAll();
            await new Promise((resolve, reject) => {
                videoReq.onsuccess = () => {
                    const records = videoReq.result ?? [];
                    const now = Date.now();
                    for (const rec of records) {
                        if (!rec.selectedSubtitleId) continue;
                        const keep = removedToKept.get(rec.selectedSubtitleId);
                        if (!keep) continue;
                        rec.selectedSubtitleId = keep.videoKey === rec.videoKey ? keep.id : void 0;
                        rec.updatedAt = now;
                        stores.videoRecords.put(rec);
                    }
                    resolve();
                };
                videoReq.onerror = () => reject(videoReq.error);
            });
            await this.waitForTransaction(tx);
            return {
                removed: removedToKept.size,
                kept: all.length - removedToKept.size,
                groups: mergedGroups
            };
        }

        async replaceByCode(code, keepId) {
            const key = normalizeCode$1(code);
            if (!key) return {removed: 0};
            const all = await this.getAll();
            const keep = all.find((r) => r.id === keepId);
            if (!keep) return {removed: 0};
            const removed = all.filter((r) => r.id !== keepId && normalizeCode$1(r.code ?? "") === key);
            if (removed.length === 0) return {removed: 0};
            const removedIds = new Set(removed.map((r) => r.id));
            const {tx, stores} = await database.transaction([
                "subtitles",
                "subtitleMeta",
                "videoRecords"
            ], "readwrite");
            for (const id of removedIds) {
                stores.subtitles.delete(id);
                stores.subtitleMeta.delete(id);
            }
            const videoReq = stores.videoRecords.getAll();
            await new Promise((resolve, reject) => {
                videoReq.onsuccess = () => {
                    const records = videoReq.result ?? [];
                    const now = Date.now();
                    for (const rec of records) {
                        if (!rec.selectedSubtitleId || !removedIds.has(rec.selectedSubtitleId)) continue;
                        rec.selectedSubtitleId = rec.videoKey === keep.videoKey ? keep.id : void 0;
                        rec.updatedAt = now;
                        stores.videoRecords.put(rec);
                    }
                    resolve();
                };
                videoReq.onerror = () => reject(videoReq.error);
            });
            await this.waitForTransaction(tx);
            return {removed: removed.length};
        }
		async getSelectedForVideo(videoKey) {
			const { tx, stores } = await database.transaction("videoRecords", "readonly");
			const req = stores.videoRecords.get(videoKey);
			await this.waitForTransaction(tx);
			const record = req.result;
			if (!record?.selectedSubtitleId) return null;
			return this.getById(record.selectedSubtitleId);
		}

        async setManualCode(videoKey, code) {
            const now = Date.now();
            const {tx, stores} = await database.transaction("videoRecords", "readwrite");
            const getReq = stores.videoRecords.get(videoKey);
            await new Promise((resolve) => {
                getReq.onsuccess = () => {
                    const existing = getReq.result;
                    const record = existing ? {
                        ...existing,
                        code,
                        codeSource: "manual",
                        updatedAt: now
                    } : {
                        videoKey,
                        code,
                        codeSource: "manual",
                        subtitleEnabled: true,
                        offsetMs: 0,
                        lastPlayedAt: now,
                        updatedAt: now
                    };
                    stores.videoRecords.put(record);
                    resolve();
                };
                getReq.onerror = () => resolve();
            });
            await this.waitForTransaction(tx);
        }
		async setSelectedForVideo(videoKey, subtitleId) {
			const now = Date.now();
			const { tx, stores } = await database.transaction("videoRecords", "readwrite");
			const getReq = stores.videoRecords.get(videoKey);
			await new Promise((resolve) => {
				getReq.onsuccess = () => {
					const existing = getReq.result;
					const record = existing ? {
						...existing,
						selectedSubtitleId: subtitleId,
						updatedAt: now
					} : {
						videoKey,
						codeSource: "auto",
						subtitleEnabled: true,
						offsetMs: 0,
						selectedSubtitleId: subtitleId,
						lastPlayedAt: now,
						updatedAt: now
					};
					stores.videoRecords.put(record);
					resolve();
				};
				getReq.onerror = () => resolve();
			});
			await this.waitForTransaction(tx);
		}
		async getVideoRecord(videoKey) {
			const { tx, stores } = await database.transaction("videoRecords", "readonly");
			const req = stores.videoRecords.get(videoKey);
			await this.waitForTransaction(tx);
			return req.result ?? null;
		}

        async getAllVideoRecords() {
            const {tx, stores} = await database.transaction("videoRecords", "readonly");
            const req = stores.videoRecords.getAll();
            await this.waitForTransaction(tx);
            return req.result ?? [];
        }
		async saveVideoRecord(record) {
			const { tx, stores } = await database.transaction("videoRecords", "readwrite");
			stores.videoRecords.put(record);
			await this.waitForTransaction(tx);
        }

        async cleanup(options) {
            const all = await this.getAll();
            const now = options.now ?? Date.now();
            const protectIds = new Set(options.protectIds ?? []);
            const sizes = new Map();
            for (const record of all) sizes.set(record.id, record.rawBlob?.size ?? 0);
            const isProtected = (record) => protectIds.has(record.id);
            const removedIds = new Set();
            if (options.olderThanDays > 0) {
                const cutoff = now - options.olderThanDays * 24 * 60 * 60 * 1e3;
                for (const record of all) if (!isProtected(record) && (record.lastUsedAt ?? 0) < cutoff) removedIds.add(record.id);
            }
            let totalBytes = all.reduce((sum, record) => sum + (sizes.get(record.id) ?? 0), 0);
            for (const id of removedIds) totalBytes -= sizes.get(id) ?? 0;
            if (options.maxBytes > 0 && totalBytes > options.maxBytes) {
                const candidates = all.filter((record) => !removedIds.has(record.id) && !isProtected(record)).sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0));
                for (const record of candidates) {
                    if (totalBytes <= options.maxBytes) break;
                    removedIds.add(record.id);
                    totalBytes -= sizes.get(record.id) ?? 0;
                }
            }
            if (removedIds.size === 0) return {
                removed: 0,
                freedBytes: 0,
                totalBytes
            };
            const freedBytes = [...removedIds].reduce((sum, id) => sum + (sizes.get(id) ?? 0), 0);
            const {tx, stores} = await database.transaction([
                "subtitles",
                "subtitleMeta",
                "videoRecords"
            ], "readwrite");
            for (const id of removedIds) {
                stores.subtitles.delete(id);
                stores.subtitleMeta.delete(id);
            }
            const videoReq = stores.videoRecords.getAll();
            await new Promise((resolve, reject) => {
                videoReq.onsuccess = () => {
                    const records = videoReq.result ?? [];
                    const nowTs = Date.now();
                    for (const rec of records) {
                        if (!rec.selectedSubtitleId || !removedIds.has(rec.selectedSubtitleId)) continue;
                        rec.selectedSubtitleId = void 0;
                        rec.updatedAt = nowTs;
                        stores.videoRecords.put(rec);
                    }
                    resolve();
                };
                videoReq.onerror = () => reject(videoReq.error);
            });
            await this.waitForTransaction(tx);
            return {
                removed: removedIds.size,
                freedBytes,
                totalBytes
            };
		}
		async estimateSize() {
			const all = await this.getAll();
			let bytes = 0;
			for (const r of all) {
				bytes += r.rawBlob.size;
				bytes += JSON.stringify(r.cues).length;
			}
			return {
				count: all.length,
				bytes
			};
		}
		async clearAll() {
            const {tx, stores} = await database.transaction([
                "subtitles",
                "subtitleMeta",
                "videoRecords"
            ], "readwrite");
			stores.subtitles.clear();
            stores.subtitleMeta.clear();
			stores.videoRecords.clear();
			await this.waitForTransaction(tx);
		}
		waitForTransaction(tx) {
			return new Promise((resolve, reject) => {
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
				tx.onabort = () => reject(tx.error);
			});
		}
	};
	var subtitleRepository = new SubtitleRepository();
	var PlayerController = class {
		adapter;
		identityService = new VideoIdentityService();
		timeline = new SubtitleTimelineEngine();
		renderer = new OverlayRenderer();
		events;
		currentContext = null;
		currentIdentity = null;
		generation = 0;
		rafId = null;
		videoListeners = [];
		stopObserving = null;
		currentSubtitleId = null;
		settings = null;
		subtitleVisible = true;
        mediaMetadataReady = false;
		constructor(adapter, events = {}) {
			this.adapter = adapter;
			this.events = events;
		}
		setSettings(settings) {
			this.settings = settings;
			this.renderer.setStyle(settings.style);
		}
		start() {
			this.stopObserving = this.adapter.observe((ctx) => this.handleContext(ctx));
            document.addEventListener("fullscreenchange", this.handleFullscreenChange);
			const initial = this.adapter.detect();
			if (initial) this.handleContext(initial);
		}

        handleFullscreenChange = () => {
            const fullscreen = document.fullscreenElement;
            const context = this.currentContext;
            if (!fullscreen || !context) return;
            if (fullscreen === context.overlayHost || fullscreen.contains(context.overlayHost)) return;
            this.events.onOverlayUnsupported?.(fullscreen === context.video ? "当前为 video 原生全屏，自定义字幕层不会显示" : "当前全屏元素不包含字幕层");
        };
		handleContext(ctx) {
			if (!ctx) {
				this.detach();
				return;
			}
			if (this.currentContext && this.isSameVideo(this.currentContext, ctx)) {
				this.refreshIdentity(ctx);
				return;
			}
			this.attach(ctx);
		}
		refreshIdentity(ctx) {
			this.currentContext = ctx;
			const next = this.identityService.resolve(ctx.metadata);
			const prev = this.currentIdentity;
			if (prev && prev.videoKey === next.videoKey && prev.code === next.code && prev.originalFileName === next.originalFileName) return;
			this.currentIdentity = next;
			this.events.onVideoChange?.(next);
            if (prev && prev.videoKey !== next.videoKey && !this.currentSubtitleId && this.settings?.autoLoadCachedSubtitle) this.restoreCachedSubtitle(next);
		}

        async restoreCachedSubtitle(identity) {
			const gen = this.generation;
            const cached = await subtitleRepository.getSelectedForVideo(identity.videoKey);
            if (gen !== this.generation) return;
            if (!cached || this.currentSubtitleId) {
                this.events.onCacheRestoreSettled?.(identity, Boolean(cached));
                return;
            }
            const resolved = await this.events.resolveCachedSubtitle?.(cached);
            if (gen !== this.generation || this.currentSubtitleId) return;
            const loaded = resolved ?? cached;
            this.currentSubtitleId = loaded.id;
            this.loadCues(loaded.cues);
            this.events.onSubtitleLoaded?.(loaded.title, loaded.id);
            this.events.onCacheRestoreSettled?.(identity, true);
		}
		isSameVideo(a, b) {
			if (a.video !== b.video) return false;
			const aId = a.metadata.fileId;
			const bId = b.metadata.fileId;
			if (aId && bId) return aId === bId;
			return a.metadata.fileName === b.metadata.fileName;
		}
		async attach(ctx) {
			await this.detach();
            if (++this.generation !== this.generation) return;
			this.currentContext = ctx;
			this.renderer.mount(ctx.overlayHost);
			this.renderer.setVisible(this.subtitleVisible);
			if (this.settings) this.renderer.setStyle(this.settings.style);
            this.mediaMetadataReady = ctx.video.readyState >= 1;
			const identity = this.identityService.resolve(ctx.metadata);
			this.currentIdentity = identity;
			this.events.onVideoChange?.(identity);
			this.events.onPlayerContextAttached?.(ctx);
			this.bindVideoEvents(ctx.video);
			this.startRenderLoop(ctx.video);
            if (this.settings?.autoLoadCachedSubtitle) await this.restoreCachedSubtitle(identity);
		}
		async detach() {
			this.generation++;
			this.stopRenderLoop();
			this.unbindVideoEvents();
			this.timeline.clear();
			this.renderer.setCues([]);
            this.renderer.setPositioningMode(false);
			this.renderer.unmount();
			this.currentSubtitleId = null;
			this.currentContext = null;
			this.currentIdentity = null;
            this.mediaMetadataReady = false;
			this.events.onSubtitleCleared?.();
		}
		bindVideoEvents(video) {
			const handlers = [
                ["loadstart", () => {
                    this.mediaMetadataReady = false;
                }],
                ["emptied", () => {
                    this.mediaMetadataReady = false;
                }],
				["loadedmetadata", () => this.onMetadata(video)],
				["seeking", () => this.refresh()],
				["seeked", () => this.refresh()],
				["playing", () => this.startRenderLoop(video)],
				["pause", () => {
					this.refresh();
					this.stopRenderLoop();
				}],
				["ended", () => {
					this.renderer.setCues([]);
					this.stopRenderLoop();
				}],
				["ratechange", () => this.refresh()]
			];
			for (const [event, handler] of handlers) {
				video.addEventListener(event, handler);
				this.videoListeners.push({
					event,
					handler
				});
			}
		}
		unbindVideoEvents() {
			if (this.currentContext) for (const { event, handler } of this.videoListeners) this.currentContext.video.removeEventListener(event, handler);
			this.videoListeners = [];
		}
		onMetadata(video) {
            this.mediaMetadataReady = true;
			if (this.currentContext) {
				this.currentContext.metadata.duration = isFiniteNumber(video.duration) ? video.duration : void 0;
				this.currentContext.metadata.width = video.videoWidth || void 0;
				this.currentContext.metadata.height = video.videoHeight || void 0;
                this.refreshIdentity(this.currentContext);
			}
			this.refresh();
		}
		loadCues(cues) {
			this.timeline.load(cues);
			if (this.currentContext) this.startRenderLoop(this.currentContext.video);
			this.refresh();
		}
		selectSubtitle(subtitleId, cues) {
			this.currentSubtitleId = subtitleId;
			this.loadCues(cues);
		}
		getActiveCueCount() {
			if (!this.currentContext) return 0;
			return this.timeline.update(this.currentContext.video.currentTime).length;
		}
		setOffset(offsetMs) {
			this.timeline.setOffset(offsetMs);
			this.refresh();
		}
		clearSubtitle() {
			this.timeline.clear();
			this.renderer.setCues([]);
			this.currentSubtitleId = null;
		}
		setSubtitleVisible(visible) {
			this.subtitleVisible = visible;
			this.renderer.setVisible(visible);
		}

        setPositioningMode(enabled) {
            this.renderer.setPositioningMode(enabled, (xPercent, yPercent) => {
                this.events.onPositionChange?.(xPercent, yPercent);
            });
        }

        isPositioningMode() {
            return this.renderer.isPositioningMode();
        }
		getSubtitleVisible() {
			return this.subtitleVisible;
		}
		getCurrentIdentity() {
			return this.currentIdentity;
		}
		getCurrentSubtitleId() {
			return this.currentSubtitleId;
		}

        isMediaMetadataReady() {
            return this.mediaMetadataReady;
        }
		startRenderLoop(video) {
			if (this.rafId !== null) return;
			const tick = () => {
				if (video.paused) {
					this.rafId = null;
					return;
				}
				const cues = this.timeline.update(video.currentTime);
				this.renderer.setCues(cues);
				this.rafId = requestAnimationFrame(tick);
			};
			this.rafId = requestAnimationFrame(tick);
		}
		stopRenderLoop() {
			if (this.rafId !== null) {
				cancelAnimationFrame(this.rafId);
				this.rafId = null;
			}
		}
		refresh() {
			if (!this.currentContext) return;
			const cues = this.timeline.update(this.currentContext.video.currentTime);
			this.renderer.setCues(cues);
		}
		dispose() {
            document.removeEventListener("fullscreenchange", this.handleFullscreenChange);
			this.stopObserving?.();
			this.detach();
		}
	};
	var LocalFileProvider = class {
		id = "local";
		name = "本地文件";
		enabledByDefault = true;
		async search(_query) {
			return [];
		}
		async download(result) {
			throw new Error(`本地 Provider 不支持下载：${result.sourceId}`);
		}
		async fromFile(file) {
			return {
				bytes: await file.arrayBuffer(),
				fileName: file.name
			};
		}
	};
	var localFileProvider = new LocalFileProvider();
    var MAX_CONCURRENT_REQUESTS = 3;
    var MIN_HOST_INTERVAL_MS = 250;
	var GmRequestClient = class {
        activeRequests = 0;
        hostNextAllowedAt = new Map();
        waiters = [];
		async request(options) {
            const host = this.hostOf(options.url);
            await this.acquire(host, options.signal);
            try {
                let attempt = 0;
                const retries = Math.max(0, options.retry ?? 0);
                for (; ;) try {
                    return await this.requestOnce(options);
                } catch (error) {
                    if (attempt >= retries || !this.shouldRetry(error) || options.signal?.aborted) throw error;
                    attempt++;
                    await this.sleep(400 * 2 ** (attempt - 1), options.signal);
                }
            } finally {
                this.release();
            }
        }

        async requestOnce(options) {
            const {
                url,
                method = "GET",
                headers,
                data,
                responseType = "text",
                timeoutMs = 15e3,
                signal,
                maxBytes,
                allowedHosts
            } = options;
            if (typeof GM_xmlhttpRequest !== "function") return Promise.reject(new SubtitleError("NETWORK_UNAVAILABLE", "当前环境没有 GM_xmlhttpRequest，无法跨域请求字幕来源"));
			return new Promise((resolve, reject) => {
				const handle = GM_xmlhttpRequest({
					method,
					url,
					headers,
					data,
					responseType,
					timeout: timeoutMs,
					onload: (resp) => {
						if (resp.status < 200 || resp.status >= 300) {
							reject(new SubtitleError("PROVIDER_BAD_RESPONSE", `HTTP ${resp.status} ${resp.statusText}`));
							return;
						}
                        const finalUrl = resp.finalUrl ?? url;
                        if (allowedHosts && allowedHosts.length > 0) {
                            let finalHost;
                            try {
                                finalHost = new URL(finalUrl).hostname;
                            } catch {
                                reject(new SubtitleError("PROVIDER_BAD_RESPONSE", "响应地址不合法"));
                                return;
                            }
                            if (!allowedHosts.includes(finalHost)) {
                                reject(new SubtitleError("PROVIDER_BAD_RESPONSE", `响应重定向到未授权域名：${finalHost}`));
                                return;
                            }
                        }
						const body = resp.response;
						if (maxBytes && typeof body === "string" && body.length > maxBytes) {
							reject(new SubtitleError("FILE_TOO_LARGE", "响应体超过最大限制"));
							return;
						}
						if (maxBytes && body instanceof ArrayBuffer && body.byteLength > maxBytes) {
							reject(new SubtitleError("FILE_TOO_LARGE", "响应体超过最大限制"));
							return;
						}
						resolve({
							status: resp.status,
							statusText: resp.statusText,
							headers: resp.responseHeaders ? this.parseHeaders(resp.responseHeaders) : {},
							body,
                            finalUrl
						});
					},
					onerror: () => {
						reject(new SubtitleError("PROVIDER_NETWORK_ERROR", "网络请求失败"));
					},
					ontimeout: () => {
						reject(new SubtitleError("PROVIDER_TIMEOUT", "请求超时"));
					}
				});
				if (signal) {
					if (signal.aborted) {
						handle.abort();
						reject(new SubtitleError("PROVIDER_TIMEOUT", "请求已取消"));
						return;
					}
					signal.addEventListener("abort", () => {
						try {
							handle.abort();
						} catch (e) {
							logger.debug("abort failed", e);
						}
						reject(new SubtitleError("PROVIDER_TIMEOUT", "请求已取消"));
					});
				}
            });
        }

        hostOf(url) {
            try {
                return new URL(url).hostname;
            } catch {
                return "unknown-host";
            }
        }

        async acquire(host, signal) {
            if (signal?.aborted) throw new SubtitleError("PROVIDER_TIMEOUT", "请求已取消");
            while (this.activeRequests >= MAX_CONCURRENT_REQUESTS) {
                await new Promise((resolve) => this.waiters.push(resolve));
                if (signal?.aborted) throw new SubtitleError("PROVIDER_TIMEOUT", "请求已取消");
            }
            const waitMs = (this.hostNextAllowedAt.get(host) ?? 0) + MIN_HOST_INTERVAL_MS - Date.now();
            if (waitMs > 0) await this.sleep(waitMs, signal);
            if (signal?.aborted) throw new SubtitleError("PROVIDER_TIMEOUT", "请求已取消");
            this.activeRequests++;
            this.hostNextAllowedAt.set(host, Date.now());
        }

        release() {
            this.activeRequests = Math.max(0, this.activeRequests - 1);
            this.waiters.shift()?.();
        }

        shouldRetry(error) {
            if (!(error instanceof SubtitleError)) return false;
            if (error.code === "PROVIDER_NETWORK_ERROR") return true;
            return error.code === "PROVIDER_BAD_RESPONSE" && /^HTTP 5\d\d\b/.test(error.message);
        }

        sleep(ms, signal) {
            if (signal?.aborted) return Promise.reject(new SubtitleError("PROVIDER_TIMEOUT", "请求已取消"));
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    signal?.removeEventListener("abort", onAbort);
                    resolve();
                }, ms);
                const onAbort = () => {
                    clearTimeout(timer);
                    reject(new SubtitleError("PROVIDER_TIMEOUT", "请求已取消"));
                };
                signal?.addEventListener("abort", onAbort, {once: true});
			});
		}
		parseHeaders(raw) {
			const headers = {};
			for (const line of raw.split(/\r?\n/)) {
				const idx = line.indexOf(":");
				if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
			}
			return headers;
		}
	};
	var gmRequestClient = new GmRequestClient();
	async function computeChecksum(bytes) {
		const data = new Uint8Array(bytes);
		let hash = 0;
		for (let i = 0; i < data.length; i++) hash = hash * 31 + data[i] | 0;
		return `crc32:${hash.toString(16)}`;
	}
	function uuid() {
		if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
		return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
			const r = Math.random() * 16 | 0;
			return (c === "x" ? r : r & 3 | 8).toString(16);
		});
	}
	var SEARCH_ENDPOINT = "https://api-shoulei-ssl.xunlei.com/oracle/subtitle";
    var SEARCH_HOST = "api-shoulei-ssl.xunlei.com";
	var DOWNLOAD_HOST = "subtitle.v.geilijiasu.com";
	var SUPPORTED_FORMATS = [
		"srt",
		"ass",
		"ssa"
	];
	var XunleiProvider = class {
		id = "xunlei";
		name = "迅雷字幕";
		enabledByDefault = true;
		async search(query) {
			const keyword = query.normalizedCode || query.code;
			if (!keyword) return [];
			const url = new URL(SEARCH_ENDPOINT);
			url.searchParams.set("gcid", "");
			url.searchParams.set("cid", "");
			url.searchParams.set("name", keyword);
			logger.debug(`[xunlei] 搜索：${keyword}`);
			try {
				const resp = await gmRequestClient.request({
					url: url.toString(),
					method: "GET",
					responseType: "text",
					timeoutMs: 15e3,
                    signal: query.signal,
                    allowedHosts: [SEARCH_HOST],
                    retry: 1
				});
				const data = JSON.parse(resp.body);
				if (data.code !== 0 || !Array.isArray(data.data)) {
					logger.debug(`[xunlei] 响应异常：code=${data.code}, result=${data.result}`);
					return [];
				}
				const results = [];
				for (let i = 0; i < data.data.length; i++) {
					const item = data.data[i];
					const format = item.ext?.toLowerCase() ?? "";
					if (!SUPPORTED_FORMATS.includes(format)) continue;
					let downloadUrl;
					try {
						downloadUrl = new URL(item.url);
					} catch {
						continue;
					}
					if (downloadUrl.protocol !== "https:" || downloadUrl.hostname !== DOWNLOAD_HOST) {
						logger.debug(`[xunlei] 跳过非法下载地址：${item.url}`);
						continue;
					}
					const language = this.resolveLanguage(item);
					results.push({
						providerId: this.id,
						sourceId: item.cid || `xunlei-${i}`,
						title: item.name || `${keyword}.${format}`,
						code: this.extractCode(item.name, keyword),
						language,
						format,
						duration: item.duration ? item.duration / 1e3 : void 0,
						releaseInfo: item.extra_name,
						downloadUrl: downloadUrl.toString(),
						rating: item.score && item.score > 0 ? Math.min(10, item.score) : void 0
					});
				}
				logger.debug(`[xunlei] 搜索完成，共 ${results.length} 条结果`);
				return results;
			} catch (e) {
				if (e instanceof SubtitleError) throw e;
				throw new SubtitleError("PROVIDER_NETWORK_ERROR", "迅雷字幕搜索失败", e);
			}
		}

        async healthCheck() {
            try {
                const url = new URL(SEARCH_ENDPOINT);
                url.searchParams.set("name", "test");
                await gmRequestClient.request({
                    url: url.toString(),
                    method: "GET",
                    responseType: "text",
                    timeoutMs: 1e4,
                    allowedHosts: [SEARCH_HOST],
                    retry: 1
                });
                return {ok: true};
            } catch (e) {
                return {
                    ok: false,
                    message: e instanceof Error ? e.message : "迅雷字幕不可用"
                };
            }
        }
		async download(result, signal) {
			if (!result.downloadUrl) throw new SubtitleError("DOWNLOAD_FAILED", "缺少下载地址");
			if (new URL(result.downloadUrl).hostname !== DOWNLOAD_HOST) throw new SubtitleError("DOWNLOAD_FAILED", "下载地址域名不合法");
			logger.debug(`[xunlei] 下载字幕：${result.title}`);
			try {
				const resp = await gmRequestClient.request({
					url: result.downloadUrl,
					method: "GET",
					responseType: "arraybuffer",
					timeoutMs: 3e4,
					signal,
                    maxBytes: 5242880,
                    allowedHosts: [DOWNLOAD_HOST],
                    retry: 1
				});
				const fileName = result.title || `subtitle.${result.format}`;
				const checksum = await computeChecksum(resp.body);
				return {
					bytes: resp.body,
					fileName,
					checksum
				};
			} catch (e) {
				if (e instanceof SubtitleError) throw e;
				throw new SubtitleError("DOWNLOAD_FAILED", "迅雷字幕下载失败", e);
			}
		}
		resolveLanguage(item) {
			if (item.langs) return item.langs;
			if (item.languages && item.languages.length > 0) return item.languages.join(",");
		}
		extractCode(name, keyword) {
			const upper = name.toUpperCase();
			const match = upper.match(/[A-Z]{2,6}-\d{2,6}/);
			if (match) return match[0];
			const kwUpper = keyword.toUpperCase();
			if (upper.includes(kwUpper)) return kwUpper;
		}
	};
	var xunleiProvider = new XunleiProvider();
	var BASE_URL = "https://www.subtitlecat.com";
    var ALLOWED_HOSTS = ["www.subtitlecat.com"];
	var MAX_CANDIDATES = 20;
	var MAX_CONCURRENT_DETAIL = 5;
	var SubtitleCatProvider = class {
		id = "subtitlecat";
		name = "SubtitleCat";
		enabledByDefault = true;
		async search(query) {
			const keyword = query.normalizedCode || query.code;
			if (!keyword) return [];
			const searchUrl = new URL("/index.php", BASE_URL);
			searchUrl.searchParams.set("search", keyword);
			logger.debug(`[subtitlecat] 搜索：${keyword}`);
			try {
				const resp = await gmRequestClient.request({
					url: searchUrl.toString(),
					method: "GET",
					responseType: "text",
					timeoutMs: 15e3,
                    signal: query.signal,
                    allowedHosts: ALLOWED_HOSTS,
                    retry: 1
				});
				const candidates = this.parseSearchHtml(resp.body, keyword);
				if (candidates.length === 0) {
					logger.debug("[subtitlecat] 搜索页未找到候选字幕");
					return [];
				}
				const limited = candidates.slice(0, MAX_CANDIDATES);
				const results = await this.fetchDetails(limited, keyword, query.signal);
				logger.debug(`[subtitlecat] 搜索完成，共 ${results.length} 条结果`);
				return results;
			} catch (e) {
				if (e instanceof SubtitleError) throw e;
				throw new SubtitleError("PROVIDER_NETWORK_ERROR", "SubtitleCat 搜索失败", e);
			}
		}

        async healthCheck() {
            try {
                await gmRequestClient.request({
                    url: `${BASE_URL}/`,
                    method: "GET",
                    responseType: "text",
                    timeoutMs: 1e4,
                    allowedHosts: ALLOWED_HOSTS,
                    retry: 1
                });
                return {ok: true};
            } catch (e) {
                return {
                    ok: false,
                    message: e instanceof Error ? e.message : "SubtitleCat 不可用"
                };
            }
        }
		async download(result, signal) {
			if (!result.downloadUrl) throw new SubtitleError("DOWNLOAD_FAILED", "缺少下载地址");
            const url = new URL(result.downloadUrl);
            if (url.hostname !== "www.subtitlecat.com") throw new SubtitleError("DOWNLOAD_FAILED", "下载地址域名不合法");
			logger.debug(`[subtitlecat] 下载字幕：${result.title}`);
			try {
				const resp = await gmRequestClient.request({
					url: result.downloadUrl,
					method: "GET",
					responseType: "arraybuffer",
					timeoutMs: 3e4,
					signal,
                    maxBytes: 5242880,
                    allowedHosts: ALLOWED_HOSTS,
                    retry: 1
				});
                const titleHasExtension = /\.(srt|vtt|ass|ssa)$/i.test(result.title ?? "");
                const urlFileName = decodeURIComponent(url.pathname.split("/").pop() || "");
                const fileName = (titleHasExtension ? result.title : urlFileName) || `${result.title || "subtitle"}.${result.format}`;
				const checksum = await computeChecksum(resp.body);
				return {
					bytes: resp.body,
					fileName,
					checksum
				};
			} catch (e) {
				if (e instanceof SubtitleError) throw e;
				throw new SubtitleError("DOWNLOAD_FAILED", "SubtitleCat 字幕下载失败", e);
			}
		}
		parseSearchHtml(html, keyword) {
			const doc = new DOMParser().parseFromString(html, "text/html");
			const links = Array.from(doc.querySelectorAll("a[href^=\"subs/\"]"));
			const candidates = [];
			const seen = new Set();
			for (const link of links) {
				const href = link.getAttribute("href");
				if (!href) continue;
				try {
					const detailUrl = new URL(href, BASE_URL);
					if (seen.has(detailUrl.href)) continue;
					seen.add(detailUrl.href);
					const title = (link.textContent || "").trim() || keyword;
					candidates.push({
						title,
						url: detailUrl
					});
				} catch {
					continue;
				}
			}
			return candidates;
		}
		async fetchDetails(candidates, keyword, signal) {
			const results = [];
			const queue = [...candidates];
			const workers = Array.from({ length: Math.min(MAX_CONCURRENT_DETAIL, queue.length) }, async () => {
				while (queue.length > 0) {
					const candidate = queue.shift();
					if (!candidate) break;
					try {
						const result = await this.fetchDetail(candidate, keyword, signal);
						if (result) results.push(result);
					} catch (e) {
						logger.debug(`[subtitlecat] 详情页解析失败：${candidate.url.href}`, e);
					}
				}
			});
			await Promise.all(workers);
			return results;
		}
		async fetchDetail(candidate, keyword, signal) {
			const resp = await gmRequestClient.request({
				url: candidate.url.href,
				method: "GET",
				responseType: "text",
				timeoutMs: 15e3,
                signal,
                allowedHosts: ALLOWED_HOSTS
			});
			const doc = new DOMParser().parseFromString(resp.body, "text/html");
			const srtLinks = Array.from(doc.querySelectorAll("a[href*=\".srt\"]"));
			if (srtLinks.length === 0) return null;
			const href = (srtLinks.find((a) => /-zh-CN\.srt$/i.test(new URL(a.href, BASE_URL).pathname)) || srtLinks.find((a) => /-zh-TW\.srt$/i.test(new URL(a.href, BASE_URL).pathname)) || srtLinks[0]).getAttribute("href");
			if (!href) return null;
			let downloadUrl;
			try {
				downloadUrl = new URL(href, BASE_URL);
			} catch {
				return null;
			}
			if (downloadUrl.protocol !== "https:" || downloadUrl.hostname !== "www.subtitlecat.com") return null;
			const isZhCN = /-zh-CN\.srt$/i.test(downloadUrl.pathname);
			const isZhTW = /-zh-TW\.srt$/i.test(downloadUrl.pathname);
			const language = isZhCN ? "简体中文" : isZhTW ? "繁体中文" : "未知";
			return {
				providerId: this.id,
				sourceId: candidate.url.pathname,
				title: candidate.title,
				code: this.extractCode(candidate.title, keyword),
				language,
				format: "srt",
				downloadUrl: downloadUrl.href,
				detailUrl: candidate.url.href
			};
		}
		extractCode(title, keyword) {
			const upper = title.toUpperCase();
			const match = upper.match(/[A-Z]{2,6}-\d{2,6}/);
			if (match) return match[0];
			const kwUpper = keyword.toUpperCase();
			if (upper.includes(kwUpper)) return kwUpper;
		}
	};
	var subtitleCatProvider = new SubtitleCatProvider();
	var ProviderManager = class {
		providers = new Map();
		constructor() {
			this.register(localFileProvider);
			this.register(xunleiProvider);
			this.register(subtitleCatProvider);
		}
		register(provider) {
			this.providers.set(provider.id, provider);
		}
		get(id) {
			return this.providers.get(id);
		}
		getAll() {
			return Array.from(this.providers.values());
		}
		getEnabled(settings) {
			return this.getAll().filter((p) => {
				const ps = settings.providers[p.id];
				if (ps) return ps.enabled;
				return p.enabledByDefault;
			});
		}
	};
	var providerManager = new ProviderManager();
    var BOM_UTF8 = [
        239,
        187,
        191
    ];
    var BOM_UTF16_LE = [255, 254];
    var BOM_UTF16_BE = [254, 255];
    var DefaultEncodingDetector = class {
        detect(bytes) {
            const view = new Uint8Array(bytes);
            if (view.length >= 3 && view[0] === BOM_UTF8[0] && view[1] === BOM_UTF8[1] && view[2] === BOM_UTF8[2]) return "utf-8";
            if (view.length >= 2 && view[0] === BOM_UTF16_LE[0] && view[1] === BOM_UTF16_LE[1]) return "utf-16le";
            if (view.length >= 2 && view[0] === BOM_UTF16_BE[0] && view[1] === BOM_UTF16_BE[1]) return "utf-16be";
            if (looksLikeUtf8(view)) return "utf-8";
            return "gb18030";
        }

        decode(bytes, encoding) {
            const enc = encoding ?? this.detect(bytes);
            if (enc === "utf-8") {
                const view = new Uint8Array(bytes);
                const slice = view.length >= 3 && view[0] === BOM_UTF8[0] && view[1] === BOM_UTF8[1] && view[2] === BOM_UTF8[2] ? bytes.slice(3) : bytes;
                return new TextDecoder("utf-8").decode(slice);
            }
            if (enc === "utf-16le" || enc === "utf-16be") return new TextDecoder(enc).decode(bytes.slice(2));
            if (enc === "gb18030" || enc === "gbk") try {
                return new TextDecoder("gb18030").decode(bytes);
            } catch {
                return new TextDecoder("utf-8", {fatal: false}).decode(bytes);
            }
            return new TextDecoder("utf-8", {fatal: false}).decode(bytes);
        }
    };

    function looksLikeUtf8(view) {
        let i = 0;
        const len = Math.min(view.length, 8192);
        while (i < len) {
            const b = view[i];
            if (b < 128) {
                i++;
                continue;
            }
            let extra;
            if ((b & 224) === 192) extra = 1;
            else if ((b & 240) === 224) extra = 2;
            else if ((b & 248) === 240) extra = 3;
            else return false;
            if (i + extra >= len) break;
            for (let j = 1; j <= extra; j++) if ((view[i + j] & 192) !== 128) return false;
            i += extra + 1;
        }
        return true;
    }

    var encodingDetector = new DefaultEncodingDetector();
    var PREVIEW_MAX_CHARS = 2e5;
    var PREVIEW_MAX_LINES = 4e3;

    function decodeRawSubtitle(bytes, encoding) {
        try {
            return encodingDetector.decode(bytes, encoding);
        } catch {
            return "";
        }
    }

    function formatCuesWithTimestamps(cues) {
        return cues.map((cue, index) => {
            return `${index + 1}. ${formatTimestamp(cue.startMs)} --> ${formatTimestamp(cue.endMs)}\n${cue.text}`;
        }).join("\n\n");
    }

    function formatTimestamp(ms) {
        const total = Math.max(0, Math.round(ms));
        const hours = Math.floor(total / 36e5);
        const minutes = Math.floor(total % 36e5 / 6e4);
        const seconds = Math.floor(total % 6e4 / 1e3);
        const millis = total % 1e3;
        return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`;
    }

    function limitPreviewText(text) {
        const lines = text.split("\n");
        let truncated = false;
        let result = text;
        if (result.length > 2e5) {
            result = result.slice(0, PREVIEW_MAX_CHARS);
            truncated = true;
        }
        const limitedLines = result.split("\n");
        if (limitedLines.length > 4e3) {
            result = limitedLines.slice(0, PREVIEW_MAX_LINES).join("\n");
            truncated = true;
        }
        if (!truncated) return text;
        return `${result}\n\n…（字幕较长，仅显示前 ${Math.min(lines.length, PREVIEW_MAX_LINES)} 行）`;
    }

    function pad(value, length) {
        return String(value).padStart(length, "0");
    }
	var TABS = [
		{
			id: "subs",
			label: "字幕"
		},
		{
			id: "style",
			label: "样式"
		},
		{
			id: "sync",
			label: "同步"
		},
		{
			id: "cache",
			label: "缓存"
		}
	];
	var PANEL_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .panel {
    position: fixed; display: none; flex-direction: column;
    width: min(400px, calc(100vw - 16px)); max-height: min(62vh, 620px);
    background: #1e1e2e; color: #cdd6f4;
    border: 1px solid #45475a; border-radius: 10px;
    box-shadow: 0 12px 40px rgba(0,0,0,.55);
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color-scheme: dark;
    overflow: hidden;
  }
  .panel.open { display: flex; }
  .header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #181825; border-bottom: 1px solid #313244; }
  .title { flex: 1; font-size: 13px; font-weight: 600; }
  .pill { border: 1px solid #45475a; background: #313244; color: #cdd6f4; border-radius: 999px; padding: 2px 10px; font-size: 11px; cursor: pointer; }
  .pill.on { background: #a6e3a1; border-color: #a6e3a1; color: #1e1e2e; }
  .pill.off { color: #a6adc8; }
  .close { background: none; border: none; color: #a6adc8; font-size: 18px; line-height: 1; cursor: pointer; padding: 0 2px; }
  .close:hover { color: #f38ba8; }
  .tabs { display: flex; gap: 2px; padding: 8px 8px 0; background: #181825; }
  .tab { flex: 1; padding: 6px 0; background: none; border: none; border-bottom: 2px solid transparent; color: #a6adc8; font-size: 12px; cursor: pointer; }
  .tab:hover { color: #cdd6f4; }
  .tab.active { color: #89b4fa; border-bottom-color: #89b4fa; }
  .body { flex: 1; padding: 12px; overflow-y: auto; }
  .section { margin-bottom: 14px; }
  .section-title { font-size: 11px; color: #a6adc8; margin-bottom: 6px; display: flex; justify-content: space-between; }
  .info { padding: 8px 10px; background: #313244; border-radius: 6px; font-size: 12px; color: #a6adc8; margin-bottom: 8px; word-break: break-all; }
  .info b { color: #cdd6f4; font-weight: 500; }
  .row { display: flex; gap: 8px; align-items: center; }
  .row + .row { margin-top: 8px; }
  .slider { flex: 1; min-width: 0; accent-color: #89b4fa; }
  .value { min-width: 58px; text-align: right; font-size: 12px; color: #a6adc8; font-variant-numeric: tabular-nums; }
  .field-label { min-width: 62px; font-size: 12px; color: #a6adc8; }
  .input { flex: 1; min-width: 0; padding: 6px 10px; background: #313244; border: 1px solid #45475a; border-radius: 6px; color: #cdd6f4; font-size: 13px; }
  .input:focus { outline: none; border-color: #89b4fa; }
  .input:focus-visible, .btn:focus-visible, .tab:focus-visible, .pill:focus-visible, .close:focus-visible {
    outline: 2px solid #89b4fa; outline-offset: 2px;
  }
  select.input { cursor: pointer; }
  .btn { padding: 6px 12px; background: #89b4fa; color: #1e1e2e; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500; white-space: nowrap; }
  .btn:hover { background: #74c7ec; }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn-ghost { background: #313244; color: #cdd6f4; border: 1px solid #45475a; }
  .btn-ghost:hover { background: #45475a; }
  .btn-sm { padding: 3px 9px; font-size: 11px; }
  .btn-danger { background: #f38ba8; }
  .btn-danger:hover { background: #eba0ac; }
  .result { padding: 9px 10px; background: #313244; border: 1px solid transparent; border-radius: 6px; margin-bottom: 6px; }
  .result.active { border-color: #a6e3a1; background: rgba(166,227,161,.10); box-shadow: inset 3px 0 0 #a6e3a1; }
  .result.active .result-title { color: #a6e3a1; }
  .result-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .result-title-wrap { display: flex; align-items: center; gap: 4px; min-width: 0; max-width: 50%; }
  .badge-active { display: inline-block; flex-shrink: 0; padding: 1px 7px; border-radius: 999px; background: #a6e3a1; color: #1e1e2e; font-size: 10px; font-weight: 600; vertical-align: 1px; }
  .btn-active { background: rgba(166,227,161,.18) !important; color: #a6e3a1 !important; border: 1px solid #a6e3a1 !important; opacity: 1 !important; cursor: default; }
  .toast { position: fixed; left: 50%; bottom: 96px; transform: translate(-50%, 8px); z-index: 2147483001; max-width: 380px; padding: 9px 14px; border-radius: 8px; background: rgba(166,227,161,.97); color: #1e1e2e; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.45); opacity: 0; transition: opacity .16s ease, transform .16s ease; pointer-events: none; word-break: break-all; }
  .toast.show { opacity: 1; transform: translate(-50%, 0); }
  .toast.warn { background: rgba(249,226,175,.97); }
  .result-title { min-width: 0; font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .result-meta { font-size: 11px; color: #a6adc8; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .result-actions { display: flex; gap: 6px; margin-left: auto; flex-shrink: 0; }
  .empty { padding: 14px 10px; text-align: center; font-size: 12px; color: #6c7086; background: #181825; border-radius: 6px; }
  .chip { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 10px; margin-right: 4px; }
  .chip-success { background: rgba(166,227,161,.16); color: #a6e3a1; }
  .chip-error { background: rgba(243,139,168,.16); color: #f38ba8; }
  .chip-busy { background: rgba(137,180,250,.16); color: #89b4fa; }
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.72); display: flex; align-items: center; justify-content: center; padding: 24px; }
  .modal { display: flex; flex-direction: column; width: 640px; max-width: 92vw; max-height: 78vh; background: #1e1e2e; border: 1px solid #45475a; border-radius: 10px; overflow: hidden; }
  .modal-header { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: #181825; border-bottom: 1px solid #313244; }
  .modal-title { flex: 1; font-size: 13px; font-weight: 600; word-break: break-all; }
  .modal-body { flex: 1; overflow-y: auto; padding: 12px 14px; }
  .confirm-modal { width: 420px; }
  .confirm-text { padding: 18px 16px 8px; color: #cdd6f4; font-size: 13px; line-height: 1.7; white-space: pre-wrap; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 16px 16px; }
  .preview-line { padding: 3px 0; border-bottom: 1px solid #313244; font-size: 12px; line-height: 1.6; color: #cdd6f4; }
  .preview-line:last-child { border-bottom: none; }
  .preview-line:empty { border-bottom: none; padding: 0; height: 8px; }
  .preview-time { color: #89b4fa; font-variant-numeric: tabular-nums; }
  .preview-text { color: #cdd6f4; }
  @media (max-width: 520px) {
    .result-head { flex-wrap: wrap; }
    .result-title-wrap { max-width: 100%; flex: 1 1 100%; }
    .result-actions { margin-left: 0; flex-wrap: wrap; }
    .modal { width: 96vw; max-width: 96vw; max-height: 86vh; }
    .modal-overlay { padding: 8px; }
  }
`;
	function div(className, text) {
		const el = document.createElement("div");
		el.className = className;
		if (text !== void 0) el.textContent = text;
		return el;
	}
	function btn(className, text, onClick) {
		const el = document.createElement("button");
		el.type = "button";
		el.className = className;
		el.textContent = text;
		el.addEventListener("click", onClick);
		return el;
	}
	var SubtitlePanel = class {
		host = null;
		container = null;
		root = null;
		callbacks;
		panelEl = null;
		bodyEl = null;
		tabEls = new Map();
		statusPill = null;
		modalEl = null;
		visible = false;
		activeTab = "subs";
		identity = null;
		progress = null;
		currentSubtitle = null;
		currentSubtitleId = null;
		cachedSubtitles = [];
        remoteSubtitles = [];
        remoteSummary = {
            count: 0,
            bytes: 0,
            origins: []
        };
        cacheSummary = {
            count: 0,
            bytes: 0
        };
		settings = null;
		codeDraft = null;
		toastEl = null;
		toastTimer = null;
        confirmEl = null;
        confirmResolve = null;
        lastFocusedElement = null;
        renderScheduled = false;
        positioning = false;
		playerRoot = null;
		playerBarObserver = null;
        scheduleNativeToggle = throttle(() => this.ensureNativeToggle(), 100);
        nativeToggleWarned = false;
		nativeToggle = null;
		subtitleVisible = true;
        lastAnchorRect = null;
		constructor(callbacks) {
			this.callbacks = callbacks;
		}
		mount() {
			if (this.root) return;
			this.host = document.body;
			const container = document.createElement("div");
			container.className = "userscript-panel-host";
			container.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483000;";
			this.root = container.attachShadow({ mode: "open" });
			this.host.appendChild(container);
			this.container = container;
			this.buildShell();
			document.addEventListener("pointerdown", this.handleDocumentPointerDown, true);
			document.addEventListener("keydown", this.handleDocumentKeyDown, true);
			window.addEventListener("resize", this.handleViewportChange);
			window.addEventListener("scroll", this.handleViewportChange, true);
		}
		setIdentity(identity) {
			if (this.identity?.videoKey !== identity?.videoKey) this.codeDraft = null;
			this.identity = identity;
            this.requestRender(["subs"]);
		}
		setProgress(progress) {
			this.progress = progress;
            this.requestRender(["subs"]);
		}
		setCurrentSubtitle(title, subtitleId = null) {
			this.currentSubtitle = title;
			this.currentSubtitleId = subtitleId;
            this.requestRender(["subs"]);
		}
		setCachedSubtitles(subtitles) {
			this.cachedSubtitles = subtitles;
            this.requestRender(["subs", "cache"]);
		}

        setRemoteSubtitles(subtitles) {
            this.remoteSubtitles = subtitles;
            this.requestRender(["subs", "cache"]);
        }

        setRemoteSummary(summary) {
            this.remoteSummary = summary;
            this.requestRender(["cache"]);
        }

        setCacheSummary(summary) {
            const changed = this.cacheSummary.count !== summary.count || this.cacheSummary.bytes !== summary.bytes;
            this.cacheSummary = summary;
            if (changed) this.requestRender(["cache"]);
        }
		setSettings(settings, updateView = true) {
			this.settings = settings;
            if (updateView) this.requestRender([
                "subs",
                "style",
                "sync"
            ]);
		}
		show(tab = this.activeTab) {
			this.visible = true;
			this.setActiveTab(tab);
			this.panelEl?.classList.add("open");
			this.positionPanel();
		}
		hide() {
            if (this.positioning) {
                this.positioning = false;
                this.callbacks.onPositioningChange(false);
            }
			this.visible = false;
			this.panelEl?.classList.remove("open");
		}
		isOpen() {
			return this.visible;
		}
		showPreview(title, content) {
			this.modalEl?.remove();
			this.modalEl = null;
			if (!this.root) return;
            this.lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			const overlay = div("modal-overlay");
			overlay.addEventListener("click", (e) => {
				if (e.target === overlay) this.closePreview();
			});
			const modal = div("modal");
            modal.setAttribute("role", "dialog");
            modal.setAttribute("aria-modal", "true");
            modal.setAttribute("aria-label", `字幕预览：${title}`);
			const header = div("modal-header");
			header.appendChild(div("modal-title", title));
            const closeButton = btn("close", "×", () => this.closePreview());
            closeButton.setAttribute("aria-label", "关闭字幕预览");
            header.appendChild(closeButton);
			const body = div("modal-body");
			const lines = content.split("\n");
			for (const line of lines) {
                const className = line.includes("-->") ? "preview-line preview-time" : "preview-line preview-text";
                body.appendChild(div(className, line));
			}
			modal.appendChild(header);
			modal.appendChild(body);
			overlay.appendChild(modal);
			this.root.appendChild(overlay);
			this.modalEl = overlay;
            closeButton.focus();
        }

        showConfirm(message) {
            if (!this.root) return Promise.resolve(false);
            if (this.confirmEl) this.closeConfirm(false);
            this.lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            const overlay = div("modal-overlay");
            const modal = div("modal confirm-modal");
            modal.setAttribute("role", "dialog");
            modal.setAttribute("aria-modal", "true");
            modal.setAttribute("aria-label", "确认操作");
            const text = div("confirm-text", message);
            const actions = div("modal-actions");
            const cancel = btn("btn btn-ghost", "取消", () => this.closeConfirm(false));
            const confirm = btn("btn btn-danger", "确定", () => this.closeConfirm(true));
            cancel.type = "button";
            confirm.type = "button";
            actions.append(cancel, confirm);
            modal.append(text, actions);
            overlay.appendChild(modal);
            overlay.addEventListener("click", (event) => {
                if (event.target === overlay) this.closeConfirm(false);
            });
            this.root.appendChild(overlay);
            this.confirmEl = overlay;
            confirm.focus();
            return new Promise((resolve) => {
                this.confirmResolve = resolve;
            });
        }

        closeConfirm(value) {
            if (!this.confirmEl) return;
            this.confirmEl.remove();
            this.confirmEl = null;
            const resolve = this.confirmResolve;
            this.confirmResolve = null;
            resolve?.(value);
            this.lastFocusedElement?.focus();
            this.lastFocusedElement = null;
		}
		closePreview() {
            const hadFocus = this.lastFocusedElement;
			this.modalEl?.remove();
			this.modalEl = null;
            hadFocus?.focus();
            this.lastFocusedElement = null;
		}
		mountPlayerControls(playerRoot) {
			if (this.playerRoot === playerRoot) {
                this.scheduleNativeToggle();
				return;
			}
			this.teardownPlayerControls();
			this.playerRoot = playerRoot;
            this.nativeToggleWarned = false;
            this.scheduleNativeToggle();
            this.playerBarObserver = new MutationObserver(() => this.scheduleNativeToggle());
			this.playerBarObserver.observe(playerRoot, {
				childList: true,
				subtree: true
			});
		}
		setSubtitleVisible(visible) {
			this.subtitleVisible = visible;
			this.updateStatusPill();
            this.requestRender(["subs"]);
		}

        setPositioning(active) {
            if (this.positioning === active) return;
            this.positioning = active;
            this.requestRender(["style"]);
        }

        findNativeSubtitleControl(root) {
			const items = root.querySelectorAll(".operate-bar .bar-side > ul > li");
			for (const li of items) {
				const anchor = li.firstElementChild;
				if (!(anchor instanceof HTMLAnchorElement)) continue;
				if (!anchor.classList.contains("btn-cle")) continue;
                if (anchor.textContent?.trim() !== "字幕") continue;
                return {
                    container: li,
                    button: anchor,
                    mode: "legacy"
                };
            }
            const buttons = [...root.querySelectorAll("button")].filter((button) => !button.closest("[data-userscript=\"subtitle-toggle\"]")).filter((button) => button.getBoundingClientRect().width > 0);
            for (const button of buttons) if (button.textContent?.trim() === "字幕") {
                const container = button.parentElement;
                if (container) return {
                    container,
                    button,
                    mode: "modern"
                };
            }
            for (const button of buttons) {
                const label = `${button.getAttribute("aria-label") ?? ""} ${button.title ?? ""}`.toLowerCase();
                if (!label.includes("字幕") && !label.includes("subtitle")) continue;
                const container = button.parentElement;
                if (container) return {
                    container,
                    button,
                    mode: "modern"
                };
			}
			return null;
		}
		ensureNativeToggle() {
			if (!this.playerRoot) return;
            const native = this.findNativeSubtitleControl(this.playerRoot);
            if (!native) {
                if (!this.nativeToggleWarned) {
                    this.nativeToggleWarned = true;
                    const buttons = [...this.playerRoot.querySelectorAll("button, a")].slice(0, 12).map((el) => `${el.tagName.toLowerCase()}:${(el.textContent ?? "").trim().slice(0, 16)}`);
                    logger.warn("未找到 115 原生字幕按钮，CC 入口暂不可用", {
                        buttons,
                        root: this.playerRoot.className
                    });
                }
                return;
            }
            this.nativeToggleWarned = false;
            if (this.nativeToggle && this.nativeToggle.container.isConnected && this.nativeToggle.container.previousElementSibling === native.container) return;
            this.nativeToggle?.container.remove();
			this.nativeToggle = null;
            if (native.mode === "legacy") {
                const li = document.createElement("li");
                li.className = "userscript-subtitle-toggle";
                li.dataset.userscript = "subtitle-toggle";
                const anchor = document.createElement("a");
                anchor.href = "javascript:;";
                anchor.className = "btn-cle";
                anchor.setAttribute("role", "button");
                anchor.setAttribute("aria-label", "打开字幕助手列表");
                anchor.title = "字幕助手";
                const label = document.createElement("s");
                label.textContent = "CC";
                anchor.appendChild(label);
                const tooltip = div("tooltip");
                tooltip.textContent = "字幕助手";
                li.appendChild(anchor);
                li.appendChild(tooltip);
                anchor.addEventListener("click", this.handleNativeToggleClick);
                native.container.after(li);
                this.nativeToggle = {
                    container: li,
                    anchor
                };
                return;
            }
            const wrapper = document.createElement("div");
            wrapper.className = native.container.className || "relative";
            wrapper.dataset.userscript = "subtitle-toggle";
            const button = document.createElement("button");
            button.type = "button";
            button.className = "p-1 text-sm whitespace-nowrap transition-colors text-white hover:text-blue-400";
            button.dataset.userscript = "subtitle-toggle";
            button.setAttribute("role", "button");
            button.setAttribute("aria-label", "打开字幕助手列表");
            button.title = "字幕助手";
            button.textContent = "CC";
            button.addEventListener("click", this.handleNativeToggleClick);
            wrapper.appendChild(button);
            native.container.after(wrapper);
			this.nativeToggle = {
                container: wrapper,
                anchor: button
			};
		}
		handleNativeToggleClick = (event) => {
			event.preventDefault();
			event.stopPropagation();
			if (this.visible && this.activeTab === "subs") this.hide();
			else this.show("subs");
		};
		handleDocumentPointerDown = (event) => {
			if (!this.visible) return;
			const path = event.composedPath();
			if (this.container && path.includes(this.container)) return;
            if (this.nativeToggle && path.includes(this.nativeToggle.container)) return;
            if (path.some((node) => node instanceof HTMLElement && node.classList.contains("userscript-subtitle-root"))) return;
            if (this.positioning) {
                this.setPositioning(false);
                this.callbacks.onPositioningChange(false);
            }
			this.hide();
		};
		handleDocumentKeyDown = (event) => {
            if (this.confirmEl) {
                if (event.key === "Escape") {
                    event.preventDefault();
                    this.closeConfirm(false);
                }
                return;
            }
            if (this.handleShortcut(event)) return;
			if (event.key !== "Escape") return;
			if (this.modalEl) {
				this.closePreview();
				return;
            }
            if (this.positioning) {
                this.setPositioning(false);
                this.callbacks.onPositioningChange(false);
                return;
			}
			if (this.visible) this.hide();
		};

        handleShortcut(event) {
            if (!this.settings?.shortcuts.enabled) return false;
            if (this.modalEl || this.confirmEl) return false;
            if (!event.altKey || event.ctrlKey || event.metaKey) return false;
            if (this.isEditableTarget(event.target)) return false;
            const sync = this.settings.sync;
            switch (event.key) {
                case ",": {
                    const next = sync.offsetMs - sync.stepMs;
                    this.callbacks.onOffsetChange(next);
                    this.showToast(`字幕偏移 ${formatOffset(next)}`);
                    event.preventDefault();
                    return true;
                }
                case ".": {
                    const next = sync.offsetMs + sync.stepMs;
                    this.callbacks.onOffsetChange(next);
                    this.showToast(`字幕偏移 ${formatOffset(next)}`);
                    event.preventDefault();
                    return true;
                }
                case "0":
                    this.callbacks.onOffsetChange(0);
                    this.showToast("字幕偏移已重置");
                    event.preventDefault();
                    return true;
                case "c":
                case "C":
                    this.callbacks.onToggleSubtitle(!this.subtitleVisible);
                    event.preventDefault();
                    return true;
                default:
                    return false;
            }
        }

        isEditableTarget(target) {
            if (!(target instanceof HTMLElement)) return false;
            const tag = target.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
            return target.isContentEditable || target.closest("[contenteditable=\"true\"]") !== null;
        }
		handleViewportChange = () => {
			if (this.visible) this.positionPanel();
		};
		buildShell() {
			if (!this.root) return;
			const style = document.createElement("style");
			style.textContent = PANEL_CSS;
			this.root.appendChild(style);
			const panel = div("panel");
            panel.setAttribute("role", "dialog");
            panel.setAttribute("aria-label", "115 字幕助手");
			const header = div("header");
			header.appendChild(div("title", "115 字幕助手"));
			const pill = document.createElement("button");
			pill.type = "button";
			pill.className = "pill on";
			pill.addEventListener("click", () => {
				this.subtitleVisible = !this.subtitleVisible;
				this.updateStatusPill();
				this.callbacks.onToggleSubtitle(this.subtitleVisible);
                this.requestRender(["subs"]);
			});
			header.appendChild(pill);
			this.statusPill = pill;
            const closeButton = btn("close", "×", () => this.hide());
            closeButton.setAttribute("aria-label", "关闭字幕助手面板");
            header.appendChild(closeButton);
			panel.appendChild(header);
			const tabs = div("tabs");
            tabs.setAttribute("role", "tablist");
            tabs.setAttribute("aria-label", "字幕助手面板");
            tabs.addEventListener("keydown", this.handleTabKeyDown);
			for (const tab of TABS) {
				const el = btn("tab", tab.label, () => this.setActiveTab(tab.id));
                el.id = `userscript-tab-${tab.id}`;
                el.setAttribute("role", "tab");
                el.setAttribute("aria-controls", "userscript-tabpanel");
                el.setAttribute("aria-selected", "false");
                el.tabIndex = -1;
				tabs.appendChild(el);
				this.tabEls.set(tab.id, el);
			}
			panel.appendChild(tabs);
			const body = div("body");
            body.id = "userscript-tabpanel";
            body.setAttribute("role", "tabpanel");
            body.tabIndex = 0;
			panel.appendChild(body);
			this.root.appendChild(panel);
			this.panelEl = panel;
			this.bodyEl = body;
			this.updateStatusPill();
			this.setActiveTab(this.activeTab);
		}
		setActiveTab(tab) {
			this.activeTab = tab;
            for (const [id, el] of this.tabEls) {
                const active = id === tab;
                el.classList.toggle("active", active);
                el.setAttribute("aria-selected", String(active));
                el.tabIndex = active ? 0 : -1;
            }
            this.bodyEl?.setAttribute("aria-labelledby", `userscript-tab-${tab}`);
            this.scheduleRender();
        }

        handleTabKeyDown = (event) => {
            const currentIndex = TABS.findIndex((item) => item.id === this.activeTab);
            let nextIndex = null;
            if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + TABS.length) % TABS.length;
            else if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % TABS.length;
            else if (event.key === "Home") nextIndex = 0;
            else if (event.key === "End") nextIndex = TABS.length - 1;
            if (nextIndex === null) return;
            event.preventDefault();
            const next = TABS[nextIndex];
            this.setActiveTab(next.id);
            this.tabEls.get(next.id)?.focus();
        };
		updateStatusPill() {
			if (!this.statusPill) return;
			this.statusPill.textContent = this.subtitleVisible ? "字幕：开" : "字幕：关";
			this.statusPill.classList.toggle("on", this.subtitleVisible);
			this.statusPill.classList.toggle("off", !this.subtitleVisible);
			this.statusPill.setAttribute("aria-pressed", String(this.subtitleVisible));
			this.statusPill.title = this.subtitleVisible ? "点击隐藏字幕" : "点击显示字幕";
		}

        requestRender(tabs) {
            if (!this.visible) return;
            if (tabs && !tabs.includes(this.activeTab)) return;
            this.scheduleRender();
        }

        scheduleRender() {
            if (!this.bodyEl || this.renderScheduled) return;
            this.renderScheduled = true;
            const run = () => {
                this.renderScheduled = false;
                this.renderBody();
            };
            if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
            else queueMicrotask(run);
        }
		renderBody() {
			if (!this.bodyEl) return;
			this.bodyEl.replaceChildren();
			switch (this.activeTab) {
				case "subs":
					this.bodyEl.appendChild(this.renderSubsTab());
					break;
				case "style":
					this.bodyEl.appendChild(this.renderStyleTab());
					break;
				case "sync":
					this.bodyEl.appendChild(this.renderSyncTab());
					break;
				case "cache": this.bodyEl.appendChild(this.renderCacheTab());
			}
            if (this.visible) this.positionPanel();
		}
		renderSubsTab() {
			const pane = div("tab-pane");
			const infoSection = div("section");
			const info = div("info");
			if (this.identity) {
				const fileRow = div("info-row");
				fileRow.append("文件：");
				fileRow.appendChild(this.strong(this.identity.originalFileName ?? "未知"));
				const codeRow = div("info-row");
				codeRow.append("番号：");
				codeRow.appendChild(this.strong(this.identity.code ?? "未识别"));
				codeRow.append(`（${sourceLabel(this.identity.source)}）`);
				info.appendChild(fileRow);
				info.appendChild(codeRow);
			} else info.textContent = "尚未检测到播放器";
			infoSection.appendChild(info);
			pane.appendChild(infoSection);
			if (this.currentSubtitle) {
				const current = div("info");
				current.append("当前字幕：");
				current.appendChild(this.strong(this.currentSubtitle));
				pane.appendChild(current);
			}
			const searchSection = div("section");
			const searchRow = div("row");
			const codeInput = document.createElement("input");
			codeInput.type = "text";
			codeInput.className = "input";
			codeInput.placeholder = "输入番号后搜索";
            codeInput.setAttribute("aria-label", "番号");
			codeInput.value = this.codeDraft ?? this.identity?.code ?? "";
			codeInput.addEventListener("input", () => {
				this.codeDraft = codeInput.value;
			});
			codeInput.addEventListener("keydown", (e) => {
				if (e.key === "Enter") this.callbacks.onSearch(codeInput.value.trim());
			});
			const searching = this.progress !== null && !this.progress.done;
			const searchBtn = btn("btn", searching ? "搜索中…" : "搜索", () => {
				this.callbacks.onSearch(codeInput.value.trim());
			});
			searchBtn.disabled = searching;
			searchRow.appendChild(codeInput);
			searchRow.appendChild(searchBtn);
			searchSection.appendChild(searchRow);
            const autoRow = div("row");
            autoRow.appendChild(div("field-label", "无缓存自动搜"));
            const autoOn = this.settings?.autoSearch ?? true;
            const autoBtn = btn("btn btn-ghost btn-sm", autoOn ? "已开启" : "已关闭", () => {
                const next = !(this.settings?.autoSearch ?? true);
                autoBtn.textContent = next ? "已开启" : "已关闭";
                this.callbacks.onAutoSearchChange(next);
            });
            autoBtn.title = "先恢复该视频的缓存；没有缓存时才自动搜索，但不会自动使用搜索结果";
            autoBtn.setAttribute("aria-pressed", String(autoOn));
            const autoHint = div("value", "仅搜索，不自动使用");
            autoHint.style.minWidth = "0";
            autoHint.style.flex = "1";
            autoHint.style.textAlign = "left";
            autoRow.appendChild(autoBtn);
            autoRow.appendChild(autoHint);
            searchSection.appendChild(autoRow);
			const actionRow = div("row");
			const importBtn = btn("btn btn-ghost", "导入本地字幕", () => fileInput.click());
			const fileInput = document.createElement("input");
			fileInput.type = "file";
			fileInput.accept = ".srt,.vtt";
			fileInput.style.display = "none";
			fileInput.addEventListener("change", () => {
				const file = fileInput.files?.[0];
				if (file) this.callbacks.onImportFile(file);
				fileInput.value = "";
			});
			actionRow.appendChild(importBtn);
			actionRow.appendChild(fileInput);
			if (this.currentSubtitle) actionRow.appendChild(btn("btn btn-ghost", "关闭字幕", () => this.callbacks.onToggleSubtitle(false)));
			searchSection.appendChild(actionRow);
			pane.appendChild(searchSection);
			const online = this.renderOnlineResults();
			if (online) pane.appendChild(online);
			const cached = this.renderCachedList();
			if (cached) pane.appendChild(cached);
			return pane;
		}
		renderOnlineResults() {
			if (!this.progress) return null;
			const section = div("section");
			const title = div("section-title");
			title.appendChild(document.createTextNode(this.progress.done ? `在线结果（${this.progress.results.length}）` : "在线搜索结果…"));
			section.appendChild(title);
			const states = Object.values(this.progress.providerStates);
			const stateRow = div("row");
			stateRow.style.flexWrap = "wrap";
			stateRow.style.gap = "4px";
			for (const state of states) stateRow.appendChild(this.providerChip(state));
			if (stateRow.childElementCount > 0) section.appendChild(stateRow);
			const allFailed = this.progress.done && states.length > 0 && states.every((s) => s.status === "error" || s.status === "timeout");
            const networkUnavailable = allFailed && states.every((s) => s.errorCode === "NETWORK_UNAVAILABLE");
			if (this.progress.results.length === 0) {
				const empty = div("empty", !this.progress.done ? "正在搜索，请稍候…" : allFailed ? "所有字幕来源都搜索失败" : "没有搜索到字幕");
				empty.style.marginTop = "8px";
				section.appendChild(empty);
                if (networkUnavailable) {
                    const hint = div("empty", "当前环境无法发起跨域请求（缺少 GM_xmlhttpRequest），通常是开发模式加载器导致。请安装构建产物 dist/115-subtitle-assistant.user.js 后重试。");
                    hint.style.marginTop = "4px";
                    hint.style.fontSize = "11px";
                    hint.style.lineHeight = "1.5";
                    section.appendChild(hint);
                }
				return section;
			}
			for (const result of this.progress.results) {
				const meta = [
					providerManager.get(result.providerId)?.name ?? result.providerId,
					result.format.toUpperCase(),
					result.language,
					result.matchScore !== void 0 ? `匹配 ${Math.round(result.matchScore)}` : void 0
				].filter(Boolean).join(" · ");
				section.appendChild(this.createSubtitleRow({
					title: result.title,
					meta,
                    reasons: result.matchReasons,
					actions: [
						{
							label: "使用",
							primary: true,
							onClick: () => this.callbacks.onSelectResult(result)
						},
						{
							label: "查看",
							onClick: () => this.callbacks.onPreviewResult(result)
						},
						{
							label: "下载",
							onClick: () => this.callbacks.onDownloadResult(result)
						}
					]
				}));
			}
			return section;
		}
		renderCachedList() {
            if (this.cachedSubtitles.length === 0 && this.remoteSubtitles.length === 0) return null;
			const section = div("section");
            if (this.cachedSubtitles.length > 0) {
                section.appendChild(div("section-title", `已缓存（${this.cachedSubtitles.length}）`));
                for (const sub of this.cachedSubtitles) {
                    const meta = `${sub.format.toUpperCase()} · ${sub.cueCount} 条 · ${formatSize(sub.rawBlob.size)} · ${providerManager.get(sub.providerId)?.name ?? sub.providerId}`;
                    section.appendChild(this.createSubtitleRow({
                        title: sub.title,
                        meta,
                        active: sub.id === this.currentSubtitleId,
                        actions: [
                            {
                                label: "使用",
                                primary: true,
                                onClick: () => this.callbacks.onSelectCachedSubtitle(sub)
                            },
                            {
                                label: "查看",
                                onClick: () => {
                                    this.previewCached(sub);
                                }
                            },
                            {
                                label: "删除",
                                danger: true,
                                onClick: () => this.callbacks.onDeleteSubtitle(sub.id)
                            }
                        ]
                    }));
                }
            }
            if (this.remoteSubtitles.length > 0) {
                section.appendChild(div("section-title", `其他播放域名缓存（${this.remoteSubtitles.length}）`));
                section.appendChild(div("info", "来自其他 115 播放域名的索引；恢复时会重新下载字幕文件，不会复制本地 Blob。"));
                for (const sub of this.remoteSubtitles) {
                    const provider = providerManager.get(sub.providerId);
                    const providerEnabled = this.settings?.providers[sub.providerId]?.enabled ?? true;
                    const restorable = Boolean(sub.sourceResult && provider && providerEnabled);
                    const meta = `${provider?.name ?? sub.providerId} · ${sub.format.toUpperCase()} · ${sub.cueCount} 条 · ${formatSize(sub.size)} · ${sub.origin}`;
                    section.appendChild(this.createSubtitleRow({
                        title: sub.title,
                        meta,
                        actions: restorable ? [{
                            label: "恢复",
                            primary: true,
                            onClick: () => this.callbacks.onRestoreRemote(sub)
                        }] : [{
                            label: "说明",
                            onClick: () => this.showToast(!sub.sourceResult ? "这条字幕来自本地导入，无法在另一播放域名自动恢复；请在原域名使用或重新导入文件。" : "这条字幕的来源已禁用或不可用，启用对应字幕来源后才能恢复。", "warn")
                        }]
                    }));
                }
			}
			return section;
		}

        async previewCached(record) {
            let content = formatCuesWithTimestamps(record.cues);
            if (!content.trim()) try {
                content = decodeRawSubtitle(await record.rawBlob.arrayBuffer(), record.encoding);
            } catch {
                content = "";
            }
            this.showPreview(record.title, limitPreviewText(content.trim() ? content : "（无字幕内容）"));
		}
		renderStyleTab() {
			const pane = div("tab-pane");
			const style = this.settings?.style;
			if (!style) {
				pane.appendChild(div("empty", "设置尚未加载"));
				return pane;
			}
			const section = div("section");
			section.appendChild(div("section-title", "字幕样式"));
            section.appendChild(this.fontRow(normalizeFontFamily(style.fontFamily)));
			section.appendChild(this.sliderRow("字号", style.fontSize, 16, 72, 1, (v) => ({ fontSize: v })));
			section.appendChild(this.sliderRow("描边", style.outlineWidth, 0, 6, 1, (v) => ({ outlineWidth: v })));
			section.appendChild(this.sliderRow("垂直位置", style.yPercent, 20, 98, 1, (v) => ({ yPercent: v })));
			section.appendChild(this.sliderRow("水平位置", style.xPercent, 5, 95, 1, (v) => ({ xPercent: v })));
			section.appendChild(this.sliderRow("最大宽度", style.maxWidthPercent, 30, 100, 1, (v) => ({ maxWidthPercent: v })));
			section.appendChild(this.sliderRow("行间距", style.lineHeight, 1, 2.4, .1, (v) => ({ lineHeight: v })));
			section.appendChild(this.sliderRow("背景透明", style.backgroundOpacity, 0, 100, 1, (v) => ({ backgroundOpacity: v })));
			pane.appendChild(section);
			const colorSection = div("section");
			colorSection.appendChild(div("section-title", "颜色"));
			colorSection.appendChild(this.colorRow("字体颜色", style.color, (v) => ({ color: v })));
			colorSection.appendChild(this.colorRow("描边颜色", style.outlineColor, (v) => ({ outlineColor: v })));
			colorSection.appendChild(this.colorRow("背景颜色", style.backgroundColor, (v) => ({ backgroundColor: v })));
			pane.appendChild(colorSection);
			const toggleSection = div("section");
			const shadowRow = div("row");
			const shadowLabel = div("field-label", "文字阴影");
			const shadowToggle = btn("btn btn-ghost btn-sm", style.shadow ? "已开启" : "已关闭", () => {
				const next = !(this.settings?.style.shadow ?? true);
				shadowToggle.textContent = next ? "已开启" : "已关闭";
				this.callbacks.onStyleChange({ shadow: next });
			});
			shadowRow.appendChild(shadowLabel);
			shadowRow.appendChild(shadowToggle);
			toggleSection.appendChild(shadowRow);
			pane.appendChild(toggleSection);
            const positionSection = div("section");
            const positionRow = div("row");
            const positionBtn = btn("btn btn-ghost btn-sm", this.positioning ? "完成定位" : "调整位置", () => {
                const next = !this.positioning;
                this.setPositioning(next);
                this.callbacks.onPositioningChange(next);
            });
            positionBtn.setAttribute("aria-pressed", String(this.positioning));
            positionRow.appendChild(positionBtn);
            const positionHint = div("value", "拖动字幕到目标位置");
            positionHint.style.minWidth = "0";
            positionHint.style.flex = "1";
            positionHint.style.textAlign = "left";
            positionRow.appendChild(positionHint);
            positionSection.appendChild(positionRow);
            positionSection.appendChild(div("info", "定位模式会临时让字幕接收指针事件；按 Esc 或再次点击「完成定位」退出。"));
            pane.appendChild(positionSection);
			return pane;
		}
		renderSyncTab() {
			const pane = div("tab-pane");
			const sync = this.settings?.sync;
			const offset = sync?.offsetMs ?? 0;
			const step = sync?.stepMs ?? 500;
			const section = div("section");
			section.appendChild(div("section-title", "字幕时间偏移"));
			section.appendChild(div("info", "正值表示字幕延后，负值表示字幕提前。"));
			const row = div("row");
			const slider = document.createElement("input");
			slider.type = "range";
			slider.min = "-10000";
			slider.max = "10000";
			slider.step = "100";
			slider.value = String(offset);
			slider.className = "slider";
            slider.setAttribute("aria-label", "字幕时间偏移");
			const value = div("value", formatOffset(offset));
			slider.addEventListener("input", () => {
				value.textContent = formatOffset(Number(slider.value));
				this.callbacks.onOffsetChange(Number(slider.value));
			});
			row.appendChild(slider);
			row.appendChild(value);
			section.appendChild(row);
			const stepRow = div("row");
			stepRow.appendChild(btn("btn btn-ghost btn-sm", `-${step}ms`, () => {
				this.callbacks.onOffsetChange((this.settings?.sync.offsetMs ?? 0) - step);
			}));
			stepRow.appendChild(btn("btn btn-ghost btn-sm", `+${step}ms`, () => {
				this.callbacks.onOffsetChange((this.settings?.sync.offsetMs ?? 0) + step);
			}));
			stepRow.appendChild(btn("btn btn-ghost btn-sm", "重置", () => this.callbacks.onOffsetChange(0)));
			section.appendChild(stepRow);
			pane.appendChild(section);
            const providerSection = div("section");
            providerSection.appendChild(div("section-title", "字幕来源"));
            const checkRow = div("row");
            checkRow.appendChild(btn("btn btn-ghost btn-sm", "检测来源", () => this.callbacks.onCheckProviders()));
            const checkHint = div("value", "检查迅雷字幕 / SubtitleCat 是否可访问");
            checkHint.style.minWidth = "0";
            checkHint.style.flex = "1";
            checkHint.style.textAlign = "left";
            checkRow.appendChild(checkHint);
            providerSection.appendChild(checkRow);
            pane.appendChild(providerSection);
            const shortcutSection = div("section");
            shortcutSection.appendChild(div("section-title", "快捷键"));
            const shortcutRow = div("row");
            shortcutRow.appendChild(div("field-label", "字幕快捷键"));
            const shortcutEnabled = this.settings?.shortcuts.enabled ?? true;
            const shortcutToggle = btn("btn btn-ghost btn-sm", shortcutEnabled ? "已开启" : "已关闭", () => {
                const next = !(this.settings?.shortcuts.enabled ?? true);
                shortcutToggle.textContent = next ? "已开启" : "已关闭";
                this.callbacks.onShortcutChange(next);
            });
            shortcutToggle.setAttribute("aria-pressed", String(shortcutEnabled));
            shortcutRow.appendChild(shortcutToggle);
            shortcutSection.appendChild(shortcutRow);
            shortcutSection.appendChild(div("info", "Alt+, / Alt+. 调整偏移，Alt+0 重置，Alt+C 开关字幕；输入框中不生效。"));
            pane.appendChild(shortcutSection);
			return pane;
		}
		renderCacheTab() {
			const pane = div("tab-pane");
			const section = div("section");
			section.appendChild(div("section-title", "缓存管理"));
            const total = this.cacheSummary;
            const currentCount = this.cachedSubtitles.length;
            const remoteText = this.remoteSummary.count > 0 ? `；其他播放域名 ${this.remoteSummary.count} 条 / ${formatSize(this.remoteSummary.bytes)}` : "";
            const limitText = this.settings ? `；容量上限 ${formatSize(this.settings.cache.maxBytes)}` : "";
            const summaryText = (total.count === currentCount ? `本地缓存共 ${total.count} 条字幕，共 ${formatSize(total.bytes)}` : `本地缓存共 ${total.count} 条字幕，共 ${formatSize(total.bytes)}；当前视频 ${currentCount} 条`) + remoteText + limitText;
            section.appendChild(div("info", summaryText));
            if (this.remoteSummary.count > 0) section.appendChild(div("info", `已通过 GM 同步索引：${this.remoteSummary.origins.join("、")}`));
            if (currentCount > 0) {
                section.appendChild(div("section-title", "当前视频字幕"));
                for (const sub of this.cachedSubtitles) section.appendChild(this.createSubtitleRow({
                    title: sub.title,
                    meta: `${sub.format.toUpperCase()} · ${sub.cueCount} 条 · ${formatSize(sub.rawBlob.size)}`,
                    active: sub.id === this.currentSubtitleId,
                    actions: [{
                        label: "使用",
                        primary: true,
                        onClick: () => this.callbacks.onSelectCachedSubtitle(sub)
                    }, {
                        label: "删除",
                        danger: true,
                        onClick: () => this.callbacks.onDeleteSubtitle(sub.id)
                    }]
                }));
            } else section.appendChild(div("empty", "当前视频还没有缓存字幕"));
            const dedupeRow = div("row");
            dedupeRow.appendChild(btn("btn btn-ghost btn-sm", "缓存字幕去重", () => {
                this.showConfirm("将按番号合并缓存：同一番号只保留最新的一份字幕，较旧的记录会被删除。\n该操作不可撤销，确定继续？").then((ok) => {
                    if (ok) this.callbacks.onDeduplicateCache();
                });
            }));
            const dedupeHint = div("value", "同一番号只保留最新");
            dedupeHint.style.minWidth = "0";
            dedupeHint.style.flex = "1";
            dedupeHint.style.textAlign = "left";
            dedupeRow.appendChild(dedupeHint);
            section.appendChild(dedupeRow);
            const cleanupRow = div("row");
            cleanupRow.appendChild(btn("btn btn-ghost btn-sm", "清理未使用缓存", () => {
                const days = this.settings?.cache.cleanupAfterDays ?? 90;
                this.showConfirm(`将删除超过 ${days} 天未使用、且非当前播放的字幕，确定继续？`).then((ok) => {
                    if (ok) this.callbacks.onCleanupCache();
                });
            }));
            const cleanupHint = div("value", `超过 ${this.settings?.cache.cleanupAfterDays ?? 90} 天未使用`);
            cleanupHint.style.minWidth = "0";
            cleanupHint.style.flex = "1";
            cleanupHint.style.textAlign = "left";
            cleanupRow.appendChild(cleanupHint);
            section.appendChild(cleanupRow);
            const syncRow = div("row");
            syncRow.appendChild(btn("btn btn-ghost btn-sm", "刷新同步索引", () => this.callbacks.onRefreshSync()));
            const syncHint = div("value", "重新发布本地索引并读取其他播放域名");
            syncHint.style.minWidth = "0";
            syncHint.style.flex = "1";
            syncHint.style.textAlign = "left";
            syncRow.appendChild(syncHint);
            section.appendChild(syncRow);
            const remoteClearRow = div("row");
            remoteClearRow.appendChild(btn("btn btn-ghost btn-sm", "清理远程索引", () => {
                this.showConfirm("将删除 GM 存储中其他播放域名的缓存索引，不会删除任何本地字幕。确定继续？").then((ok) => {
                    if (ok) this.callbacks.onClearRemoteSync();
                });
            }));
            const remoteClearHint = div("value", "只删同步索引，不删本地字幕");
            remoteClearHint.style.minWidth = "0";
            remoteClearHint.style.flex = "1";
            remoteClearHint.style.textAlign = "left";
            remoteClearRow.appendChild(remoteClearHint);
            section.appendChild(remoteClearRow);
            const backfillRow = div("row");
            backfillRow.appendChild(btn("btn btn-ghost btn-sm", "补齐来源信息", () => this.callbacks.onBackfillSources()));
            const backfillHint = div("value", "为旧缓存补上下载地址，便于跨域名恢复");
            backfillHint.style.minWidth = "0";
            backfillHint.style.flex = "1";
            backfillHint.style.textAlign = "left";
            backfillRow.appendChild(backfillHint);
            section.appendChild(backfillRow);
			const clearRow = div("row");
			clearRow.appendChild(btn("btn btn-danger btn-sm", "清空全部缓存", () => {
                this.showConfirm("确定清空所有字幕缓存？该操作不可撤销。").then((ok) => {
                    if (ok) this.callbacks.onClearCache();
                });
			}));
            const exportBtn = btn("btn btn-ghost btn-sm", "导出所有字幕", () => this.callbacks.onExportAll());
            exportBtn.disabled = total.count === 0;
            exportBtn.title = "将所有字幕打包为 115autosubtitle.zip";
            clearRow.appendChild(exportBtn);
			section.appendChild(clearRow);
			pane.appendChild(section);
			return pane;
		}

        fontRow(current) {
            const row = div("row");
            row.appendChild(div("field-label", "字体"));
            const select = document.createElement("select");
            select.className = "input";
            select.setAttribute("aria-label", "字幕字体");
            for (const preset of FONT_PRESETS) {
                const option = document.createElement("option");
                option.value = preset.fontFamily;
                option.textContent = preset.label;
                select.appendChild(option);
            }
            if (!findFontPreset(current)) {
                const custom = document.createElement("option");
                custom.value = current;
                custom.textContent = `自定义（${current.split(",")[0].replace(/["']/g, "")}）`;
                select.appendChild(custom);
            }
            select.value = current;
            select.addEventListener("change", () => {
                this.callbacks.onStyleChange({fontFamily: select.value});
            });
            row.appendChild(select);
            return row;
        }
		sliderRow(label, value, min, max, step, toPatch) {
			const row = div("row");
			row.appendChild(div("field-label", label));
			const slider = document.createElement("input");
			slider.type = "range";
			slider.className = "slider";
			slider.min = String(min);
			slider.max = String(max);
			slider.step = String(step);
			slider.value = String(value);
            slider.setAttribute("aria-label", label);
			const valueEl = div("value", String(value));
			slider.addEventListener("input", () => {
				const next = Number(slider.value);
				valueEl.textContent = String(next);
				this.callbacks.onStyleChange(toPatch(next));
			});
			row.appendChild(slider);
			row.appendChild(valueEl);
			return row;
		}
		colorRow(label, value, toPatch) {
			const row = div("row");
			row.appendChild(div("field-label", label));
			const input = document.createElement("input");
			input.type = "color";
			input.value = value;
            input.setAttribute("aria-label", label);
			input.style.width = "44px";
			input.style.height = "26px";
			input.style.padding = "0";
			input.style.border = "1px solid #45475a";
			input.style.borderRadius = "6px";
			input.style.background = "#313244";
			input.addEventListener("change", () => this.callbacks.onStyleChange(toPatch(input.value)));
			const text = div("value", value.toUpperCase());
			text.style.minWidth = "70px";
			input.addEventListener("input", () => {
				text.textContent = input.value.toUpperCase();
			});
			row.appendChild(input);
			row.appendChild(text);
			return row;
		}
		providerChip(state) {
			const name = providerManager.get(state.providerId)?.name ?? state.providerId;
			const { label, tone } = describeProviderState(state);
			const chip = document.createElement("span");
			chip.className = `chip chip-${tone}`;
			chip.textContent = `${name} ${label}`;
			if (state.errorMessage) chip.title = state.errorMessage;
			return chip;
		}
		createSubtitleRow(opts) {
			const active = opts.active === true;
			const row = div(`result${active ? " active" : ""}`);
            const head = div("result-head");
            const titleWrap = div("result-title-wrap");
			const titleEl = div("result-title", opts.title);
            const reasons = opts.reasons?.filter(Boolean) ?? [];
            titleEl.title = reasons.length > 0 ? `${opts.title}\n匹配原因：${reasons.join("；")}` : opts.title;
            titleWrap.appendChild(titleEl);
			if (active) {
				const badge = document.createElement("span");
				badge.className = "badge-active";
				badge.textContent = "使用中";
                titleWrap.appendChild(badge);
			}
            head.appendChild(titleWrap);
			const actions = div("result-actions");
			for (const action of opts.actions) {
				const classes = ["btn", "btn-sm"];
				if (action.primary) classes.push("btn-ghost");
				if (action.danger) classes.push("btn-danger");
				const alreadyActive = active && action.primary;
				if (alreadyActive) classes.push("btn-active");
				const button = btn(classes.join(" "), alreadyActive ? "已使用" : action.label, action.onClick);
                button.title = action.title ?? action.label;
				if (alreadyActive) button.disabled = true;
				actions.appendChild(button);
			}
            head.appendChild(actions);
            row.appendChild(head);
            row.appendChild(div("result-meta", opts.meta));
			return row;
		}
		showToast(message, tone = "success") {
			if (!this.root) return;
			this.clearToast();
			const el = div(tone === "warn" ? "toast warn" : "toast", message);
            el.setAttribute("role", "status");
            el.setAttribute("aria-live", "polite");
            el.setAttribute("aria-atomic", "true");
			this.root.appendChild(el);
			this.toastEl = el;
			el.offsetWidth;
			el.classList.add("show");
			this.toastTimer = window.setTimeout(() => {
				el.classList.remove("show");
				this.toastTimer = window.setTimeout(() => {
					el.remove();
					if (this.toastEl === el) this.toastEl = null;
					this.toastTimer = null;
				}, 200);
			}, 2600);
		}
		clearToast() {
			if (this.toastTimer !== null) {
				window.clearTimeout(this.toastTimer);
				this.toastTimer = null;
			}
			this.toastEl?.remove();
			this.toastEl = null;
		}
		strong(text) {
			const el = document.createElement("b");
			el.textContent = text;
			return el;
		}
		positionPanel() {
			const panel = this.panelEl;
			if (!panel) return;
            const margin = 8;
            const width = panel.offsetWidth || 400;
            const height = panel.offsetHeight || 420;
			const anchor = this.nativeToggle?.anchor;
            const anchorRect = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
            const hasAnchor = !!anchorRect && anchorRect.width > 0 && anchorRect.height > 0;
            if (hasAnchor && anchorRect) this.lastAnchorRect = {
                right: anchorRect.right,
                top: anchorRect.top,
                bottom: anchorRect.bottom
            };
            const usable = hasAnchor && anchorRect ? {
                right: anchorRect.right,
                top: anchorRect.top,
                bottom: anchorRect.bottom
            } : this.lastAnchorRect;
            let left;
            let top;
            if (usable) {
                left = usable.right - width;
                top = usable.top - height - 10;
                if (top < margin) top = usable.bottom + 10;
            } else {
                left = window.innerWidth - width - 16;
                top = window.innerHeight - height - 16;
			}
            left = Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - width - margin));
            top = Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - height - margin));
			panel.style.left = `${Math.round(left)}px`;
            panel.style.top = `${Math.round(top)}px`;
			panel.style.right = "auto";
            panel.style.bottom = "auto";
		}
		teardownPlayerControls() {
			this.playerBarObserver?.disconnect();
			this.playerBarObserver = null;
            this.nativeToggle?.container.remove();
			this.nativeToggle = null;
            this.lastAnchorRect = null;
			this.playerRoot = null;
		}
		dispose() {
			this.teardownPlayerControls();
			document.removeEventListener("pointerdown", this.handleDocumentPointerDown, true);
			document.removeEventListener("keydown", this.handleDocumentKeyDown, true);
			window.removeEventListener("resize", this.handleViewportChange);
			window.removeEventListener("scroll", this.handleViewportChange, true);
			this.closePreview();
            this.closeConfirm(false);
			this.clearToast();
			this.container?.remove();
			this.container = null;
			this.host = null;
			this.root = null;
			this.panelEl = null;
			this.bodyEl = null;
			this.tabEls.clear();
			this.statusPill = null;
		}
	};
	function describeProviderState(state) {
		switch (state.status) {
			case "success": return {
				label: `✓ ${state.resultCount}`,
				tone: "success"
			};
			case "no-results": return {
				label: "无结果",
				tone: "success"
			};
			case "error": return {
				label: "失败",
				tone: "error"
			};
			case "timeout": return {
				label: "超时",
				tone: "error"
			};
			case "pending": return {
				label: "等待",
				tone: "busy"
			};
			default: return {
				label: "搜索中",
				tone: "busy"
			};
		}
	}
	function formatOffset(offsetMs) {
		return `${offsetMs > 0 ? "+" : ""}${(offsetMs / 1e3).toFixed(1)}s`;
	}
	function formatSize(bytes) {
		if (bytes < 1024) return `${bytes}B`;
		if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
		return `${(bytes / 1048576).toFixed(1)}MB`;
	}
	function sourceLabel(source) {
		switch (source) {
			case "115-dom": return "115 页面";
			case "media-element": return "播放器";
			case "manual": return "手动";
			default: return source;
		}
	}
	var FALLBACK_PREFIX = "115-subtitle-assistant:";
	function gmAvailable() {
		return typeof GM_getValue === "function" && typeof GM_setValue === "function";
	}
	function readStoredValue(key, fallback) {
		if (gmAvailable()) try {
			return GM_getValue(key, fallback);
		} catch {
			return fallback;
		}
		try {
			const raw = localStorage.getItem(FALLBACK_PREFIX + key);
			if (raw === null) return fallback;
			return JSON.parse(raw);
		} catch {
			return fallback;
		}
	}
	function writeStoredValue(key, value) {
		if (gmAvailable()) {
			GM_setValue(key, value);
			return;
		}
		localStorage.setItem(FALLBACK_PREFIX + key, JSON.stringify(value));
	}
	var DEFAULT_SETTINGS = {
        settingsVersion: 2,
		enabled: true,
        autoSearch: true,
		autoLoadCachedSubtitle: true,
		preferredLanguages: [
			"zh-CN",
			"zh-TW",
			"en"
		],
		defaultFormatOrder: [
			"srt",
			"vtt",
			"ass",
			"ssa"
		],
		style: {
            fontFamily: DEFAULT_SUBTITLE_FONT,
			fontSize: 32,
			fontWeight: 600,
			color: "#FFFFFF",
			outlineColor: "#000000",
			outlineWidth: 2,
			shadow: true,
			backgroundColor: "#000000",
			backgroundOpacity: 0,
			horizontal: "center",
			xPercent: 50,
			yPercent: 88,
			maxWidthPercent: 90,
			lineHeight: 1.2
		},
		sync: {
			offsetMs: 0,
			stepMs: 500
		},
		cache: {
			maxBytes: 209715200,
			cleanupAfterDays: 90
		},
		providers: {},
		shortcuts: { enabled: true },
		debug: false
	};
	var STORAGE_KEY = "115-subtitle-assistant-settings";
	var SettingsService = class {
		cache = null;
		async load() {
			if (this.cache) return this.cache;
			try {
				const raw = await this.readValue(STORAGE_KEY);
				const merged = this.mergeDefaults(raw);
				this.cache = merged;
				return merged;
			} catch {
				this.cache = { ...DEFAULT_SETTINGS };
				return this.cache;
			}
		}
		async save(settings) {
			this.cache = settings;
			await this.writeValue(STORAGE_KEY, settings);
		}
		async update(patch) {
			const merged = {
				...await this.load(),
				...patch
			};
			await this.save(merged);
			return merged;
		}
		mergeDefaults(raw) {
			if (!raw) return { ...DEFAULT_SETTINGS };
            const style = {
                ...DEFAULT_SETTINGS.style,
                ...raw.style
            };
            if (!style.fontFamily || style.fontFamily === "Arial, sans-serif") style.fontFamily = DEFAULT_SUBTITLE_FONT;
            const autoSearch = (typeof raw.settingsVersion === "number" ? raw.settingsVersion : 1) < 2 && raw.autoSearch === false ? DEFAULT_SETTINGS.autoSearch : raw.autoSearch ?? DEFAULT_SETTINGS.autoSearch;
			return {
				...DEFAULT_SETTINGS,
				...raw,
                settingsVersion: 2,
                autoSearch,
                style,
				sync: {
					...DEFAULT_SETTINGS.sync,
					...raw.sync
				},
				cache: {
					...DEFAULT_SETTINGS.cache,
					...raw.cache
				},
				shortcuts: {
					...DEFAULT_SETTINGS.shortcuts,
					...raw.shortcuts
				},
				providers: raw.providers ?? {}
			};
		}
		readValue(key) {
			return new Promise((resolve) => {
				try {
					resolve(readStoredValue(key, void 0));
				} catch {
					resolve(void 0);
				}
			});
		}
		writeValue(key, value) {
			return new Promise((resolve, reject) => {
				try {
					writeStoredValue(key, value);
					resolve();
				} catch (e) {
					reject(e);
				}
			});
		}
	};
	var settingsService = new SettingsService();
	var CODE_MATCH_WEIGHT = 40;
	var TITLE_SIMILARITY_WEIGHT = 15;
	var DURATION_WEIGHT = 20;
	var LANGUAGE_WEIGHT = 10;
	var RELIABILITY_WEIGHT = 5;
	function scoreResult(result, query) {
		let score = 0;
		const reasons = [];
		if (result.code && query.normalizedCode) {
			if (result.code.toUpperCase() === query.normalizedCode.toUpperCase()) {
				score += CODE_MATCH_WEIGHT;
				reasons.push("番号完全匹配");
			} else {
				score -= 30;
				reasons.push("番号不匹配");
			}
		}
		if (query.fileName && result.title) {
			const similarity = titleSimilarity(query.fileName, result.title);
			score += Math.round(similarity * TITLE_SIMILARITY_WEIGHT);
			if (similarity > .5) reasons.push("标题相似度高");
		}
		if (query.duration && result.duration) {
			const diff = Math.abs(query.duration - result.duration);
			if (diff < 5) {
				score += DURATION_WEIGHT;
				reasons.push("时长接近");
			} else if (diff < 30) {
				score += Math.round(DURATION_WEIGHT * .5);
				reasons.push("时长大致匹配");
			}
		}
		if (result.language && query.languagePreferences.length > 0) {
			const langIdx = query.languagePreferences.findIndex((l) => result.language.toLowerCase().includes(l.toLowerCase()));
			if (langIdx === 0) {
				score += LANGUAGE_WEIGHT;
				reasons.push("首选语言");
			} else if (langIdx > 0) {
				score += Math.round(LANGUAGE_WEIGHT * .6);
				reasons.push("次选语言");
			}
		}
		if (result.rating) score += Math.round(result.rating / 10 * RELIABILITY_WEIGHT);
		score = Math.max(0, Math.min(100, score));
		return {
			score,
			reasons
		};
	}
	function titleSimilarity(a, b) {
		const na = a.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, "");
		const nb = b.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, "");
		if (!na || !nb) return 0;
		if (na === nb) return 1;
		const longer = na.length >= nb.length ? na : nb;
		const shorter = na.length >= nb.length ? nb : na;
		if (longer.includes(shorter)) return shorter.length / longer.length;
		let common = 0;
		for (const ch of shorter) if (longer.includes(ch)) common++;
		return common / longer.length;
	}
	function sortResults(results) {
		return [...results].sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));
	}
	function deduplicateResults(results) {
		const seen = new Set();
		const out = [];
		for (const r of results) {
			const key = `${r.providerId}:${r.sourceId}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(r);
		}
		return out;
	}

    var PROVIDER_COOLDOWN_MS = 6e4;
	var SubtitleSearchEngine = class {
        providerCooldownUntil = new Map();
		async search(query, settings, callbacks) {
            const allProviders = providerManager.getEnabled(settings).filter((p) => p.id !== "local");
            const now = Date.now();
            const providers = allProviders.filter((provider) => query.force || (this.providerCooldownUntil.get(provider.id) ?? 0) <= now);
            if (allProviders.length === 0) return [];
			const providerStates = {};
            for (const provider of allProviders) {
                const coolingDown = !providers.includes(provider);
                providerStates[provider.id] = coolingDown ? {
                    providerId: provider.id,
                    status: "error",
                    errorMessage: "最近请求失败，自动搜索暂缓 60 秒；可手动搜索重试",
                    errorCode: "PROVIDER_NETWORK_ERROR",
                    resultCount: 0
                } : {
                    providerId: provider.id,
                    status: "pending",
                    resultCount: 0
                };
            }
			let allResults = [];
			const controller = new AbortController();
			const signal = query.signal;
			if (signal) signal.addEventListener("abort", () => controller.abort());
			const promises = providers.map(async (provider) => {
				providerStates[provider.id].status = "searching";
				callbacks?.onProgress?.({
					providerStates: { ...providerStates },
					results: allResults,
					done: false
				});
				try {
					const result = await Promise.race([provider.search({
						...query,
						signal: controller.signal
					}), this.timeout(12e3, provider.id)]);
                    this.providerCooldownUntil.delete(provider.id);
					providerStates[provider.id].status = result.length > 0 ? "success" : "no-results";
					providerStates[provider.id].resultCount = result.length;
					const scored = result.map((r) => {
						const { score, reasons } = scoreResult(r, query);
						return {
							...r,
							matchScore: score,
							matchReasons: reasons
						};
					});
					allResults = deduplicateResults([...allResults, ...scored]);
					allResults = sortResults(allResults);
				} catch (e) {
					if (isSubtitleError(e) && e.code === "PROVIDER_TIMEOUT") {
						providerStates[provider.id].status = "timeout";
						providerStates[provider.id].errorMessage = "搜索超时";
					} else if (controller.signal.aborted) {
						providerStates[provider.id].status = "error";
						providerStates[provider.id].errorMessage = "已取消";
					} else {
						providerStates[provider.id].status = "error";
						providerStates[provider.id].errorMessage = e instanceof Error ? e.message : "未知错误";
                        if (isSubtitleError(e)) {
                            providerStates[provider.id].errorCode = e.code;
                            if (e.code === "PROVIDER_NETWORK_ERROR" || e.code === "PROVIDER_TIMEOUT") this.providerCooldownUntil.set(provider.id, Date.now() + PROVIDER_COOLDOWN_MS);
                        }
						logger.warn(`Provider ${provider.id} 搜索失败`, e);
					}
				}
				callbacks?.onProgress?.({
					providerStates: { ...providerStates },
					results: allResults,
					done: false
				});
			});
			await Promise.allSettled(promises);
			callbacks?.onProgress?.({
				providerStates,
				results: allResults,
				done: true
			});
			return allResults;
		}
		timeout(ms, providerId) {
			return new Promise((_, reject) => {
				setTimeout(() => reject(new SubtitleError("PROVIDER_TIMEOUT", `${providerId} 搜索超时`)), ms);
			});
		}
	};
	var subtitleSearchEngine = new SubtitleSearchEngine();
	var SrtParser = class {
		format = "srt";
		parse(bytes, encoding) {
			const text = encodingDetector.decode(bytes, encoding);
			const warnings = [];
			const blocks = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split(/\n\n+/).filter((b) => b.trim().length > 0);
			const cues = [];
			let sourceOrder = 0;
			for (const block of blocks) {
				const lines = block.split("\n");
				if (lines.length < 2) {
					warnings.push(`跳过不完整字幕块：${block.slice(0, 40)}`);
					continue;
				}
				let timeLineIndex = 0;
				if (!/-->/.test(lines[0])) timeLineIndex = 1;
				const timeMatch = lines[timeLineIndex]?.match(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/);
				if (!timeMatch) {
					warnings.push(`无法解析时间轴：${lines[timeLineIndex] ?? block.slice(0, 40)}`);
					continue;
				}
				const startMs = timeToMs(Number(timeMatch[1]), Number(timeMatch[2]), Number(timeMatch[3]), Number(timeMatch[4]));
				const endMs = timeToMs(Number(timeMatch[5]), Number(timeMatch[6]), Number(timeMatch[7]), Number(timeMatch[8]));
				if (endMs < startMs) {
					warnings.push(`时间范围反向：${startMs} -> ${endMs}`);
					continue;
				}
				const rawText = lines.slice(timeLineIndex + 1).join("\n").trim();
				if (!rawText) {
					warnings.push("空字幕文本已跳过");
					continue;
				}
				const { text, segments } = parseInlineTags(rawText);
				cues.push({
					id: cues.length,
					startMs,
					endMs,
					text,
					segments,
					sourceOrder: sourceOrder++
				});
			}
			return {
				format: "srt",
				encoding: encoding ?? encodingDetector.detect(bytes),
				cues,
				warnings
			};
		}
	};
	function timeToMs(hours, minutes, seconds, millis) {
		return hours * 36e5 + minutes * 6e4 + seconds * 1e3 + millis;
	}
	var TAG_PATTERN = /<(\/?)([biu])>/gi;
	function parseInlineTags(raw) {
		const segments = [];
		let text = "";
		let lastIndex = 0;
		let bold = false;
		let italic = false;
		let underline = false;
		const pushSegment = (content) => {
			if (!content) return;
			segments.push({
				text: content,
				bold,
				italic,
				underline
			});
			text += content;
		};
		let match;
		TAG_PATTERN.lastIndex = 0;
		while ((match = TAG_PATTERN.exec(raw)) !== null) {
			pushSegment(raw.slice(lastIndex, match.index));
			const isClose = match[1] === "/";
			const tag = match[2].toLowerCase();
			if (tag === "b") bold = !isClose;
			else if (tag === "i") italic = !isClose;
			else if (tag === "u") underline = !isClose;
			lastIndex = TAG_PATTERN.lastIndex;
		}
		pushSegment(raw.slice(lastIndex));
		if (segments.length === 0) return {
			text: raw,
			segments: [{ text: raw }]
		};
		return {
			text,
			segments
		};
	}
	function parseSubtitle(bytes, format, encoding) {
		switch (format) {
			case "srt": return new SrtParser().parse(bytes, encoding);
			case "vtt": return new VttParser().parse(bytes, encoding);
			default: throw new SubtitleError("UNSUPPORTED_FORMAT", `不支持的字幕格式：${format}`);
		}
	}
	var VttParser = class {
		format = "vtt";
		parse(bytes, encoding) {
			const text = encodingDetector.decode(bytes, encoding);
			const warnings = [];
			const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
			if (!normalized.startsWith("WEBVTT")) throw new SubtitleError("PARSE_FAILED", "VTT 文件缺少 WEBVTT 文件头");
			const lines = normalized.split("\n");
			const cues = [];
			let sourceOrder = 0;
			let i = 0;
			while (i < lines.length && lines[i] !== "") i++;
			i++;
			while (i < lines.length) {
				while (i < lines.length && lines[i].trim() === "") i++;
				if (i >= lines.length) break;
				const blockStart = i;
				while (i < lines.length && lines[i].trim() !== "") i++;
				const block = lines.slice(blockStart, i);
				if (block.length === 0) continue;
				if (block[0].trim().toUpperCase().startsWith("NOTE")) continue;
				let timeLineIndex = 0;
				if (!block[0].includes("-->")) timeLineIndex = 1;
				const timeLine = block[timeLineIndex];
				const timeMatch = timeLine?.match(/(\d{1,2}:)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{1,2}:)?(\d{2}):(\d{2})\.(\d{3})/);
				if (!timeMatch) {
					warnings.push(`无法解析 VTT 时间轴：${timeLine ?? ""}`);
					continue;
				}
				const startMs = vttTimeToMs(timeMatch[1], timeMatch[2], timeMatch[3], timeMatch[4]);
				const endMs = vttTimeToMs(timeMatch[5], timeMatch[6], timeMatch[7], timeMatch[8]);
				if (endMs < startMs) {
					warnings.push(`时间范围反向：${startMs} -> ${endMs}`);
					continue;
				}
				const rawText = block.slice(timeLineIndex + 1).join("\n").trim();
				if (!rawText) {
					warnings.push("空字幕文本已跳过");
					continue;
				}
				const { text, segments } = parseVttTags(rawText);
				cues.push({
					id: cues.length,
					startMs,
					endMs,
					text,
					segments,
					sourceOrder: sourceOrder++
				});
			}
			return {
				format: "vtt",
				encoding: encoding ?? encodingDetector.detect(bytes),
				cues,
				warnings
			};
		}
	};
	function vttTimeToMs(hours, minutes, seconds, millis) {
		return (hours ? parseInt(hours, 10) : 0) * 36e5 + parseInt(minutes, 10) * 6e4 + parseInt(seconds, 10) * 1e3 + parseInt(millis, 10);
	}
	var VTT_TAG_PATTERN = /<\/?([biu]|c[^>]*)>/gi;
	function parseVttTags(raw) {
		const segments = [];
		let text = "";
		let lastIndex = 0;
		let bold = false;
		let italic = false;
		let underline = false;
		const pushSegment = (content) => {
			if (!content) return;
			segments.push({
				text: content,
				bold,
				italic,
				underline
			});
			text += content;
		};
		let match;
		VTT_TAG_PATTERN.lastIndex = 0;
		while ((match = VTT_TAG_PATTERN.exec(raw)) !== null) {
			pushSegment(raw.slice(lastIndex, match.index));
			const tag = match[1].toLowerCase();
			const isClose = match[0].startsWith("</");
			if (tag === "b") bold = !isClose;
			else if (tag === "i") italic = !isClose;
			else if (tag === "u") underline = !isClose;
			lastIndex = VTT_TAG_PATTERN.lastIndex;
		}
		pushSegment(raw.slice(lastIndex));
		if (segments.length === 0) return {
			text: raw,
			segments: [{ text: raw }]
		};
		return {
			text,
			segments
		};
	}
	function detectFormat(fileName) {
		switch (fileName.split(".").pop()?.toLowerCase()) {
			case "srt": return "srt";
			case "vtt": return "vtt";
			case "ass": return "ass";
			case "ssa": return "ssa";
			default: return "unknown";
		}
	}

    var CRC_TABLE = (() => {
        const table = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let bit = 0; bit < 8; bit++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
            table[i] = c >>> 0;
        }
        return table;
    })();

    function crc32(data) {
        let crc = 4294967295;
        for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 255] ^ crc >>> 8;
        return (crc ^ 4294967295) >>> 0;
    }

    async function deflateRaw(data) {
        if (typeof CompressionStream === "undefined") return null;
        try {
            return await transformBytes(new CompressionStream("deflate-raw"), data);
        } catch {
            return null;
        }
    }

    async function transformBytes(stream, data) {
        const reader = stream.readable.getReader();
        const writer = stream.writable.getWriter();
        const readPromise = (async () => {
            const chunks = [];
            let total = 0;
            for (; ;) {
                const {done, value} = await reader.read();
                if (done) break;
                chunks.push(value);
                total += value.length;
            }
            const output = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
                output.set(chunk, offset);
                offset += chunk.length;
            }
            return output;
        })();
        await writer.write(data);
        await writer.close();
        return readPromise;
    }

    function sanitizeFileName(name) {
        return (name.split(/[\\/]/).pop() ?? name).replace(/[\u0000-\u001f<>:"|?*]/g, "_").replace(/\s+/g, " ").trim() || "subtitle";
    }

    function ensureExtension(name, record) {
        if (/\.[a-z0-9]{1,5}$/i.test(name)) return name;
        return `${name}.${record.format === "unknown" ? "srt" : record.format}`;
    }

    function makeUniqueName(base, used) {
        if (!used.has(base.toLowerCase())) {
            used.add(base.toLowerCase());
            return base;
        }
        const dot = base.lastIndexOf(".");
        const stem = dot > 0 ? base.slice(0, dot) : base;
        const ext = dot > 0 ? base.slice(dot) : "";
        let index = 2;
        let candidate = `${stem} (${index})${ext}`;
        while (used.has(candidate.toLowerCase())) {
            index++;
            candidate = `${stem} (${index})${ext}`;
        }
        used.add(candidate.toLowerCase());
        return candidate;
    }

    function dosDateTime(timestamp) {
        const date = new Date(isFiniteNumber(timestamp) ? timestamp : Date.now());
        const year = Math.max(1980, date.getFullYear());
        return {
            time: date.getHours() << 11 | date.getMinutes() << 5 | Math.floor(date.getSeconds() / 2),
            date: year - 1980 << 9 | date.getMonth() + 1 << 5 | date.getDate()
        };
    }

    function localHeader(entry, time, date) {
        const nameBytes = new TextEncoder().encode(entry.name);
        const buf = new Uint8Array(30 + nameBytes.length);
        const view = new DataView(buf.buffer);
        view.setUint32(0, 67324752, true);
        view.setUint16(4, 20, true);
        view.setUint16(6, 2048, true);
        view.setUint16(8, entry.method, true);
        view.setUint16(10, time, true);
        view.setUint16(12, date, true);
        view.setUint32(14, entry.crc, true);
        view.setUint32(18, entry.payload.length, true);
        view.setUint32(22, entry.data.length, true);
        view.setUint16(26, nameBytes.length, true);
        view.setUint16(28, 0, true);
        buf.set(nameBytes, 30);
        return buf;
    }

    function centralHeader(entry, offset, time, date) {
        const nameBytes = new TextEncoder().encode(entry.name);
        const buf = new Uint8Array(46 + nameBytes.length);
        const view = new DataView(buf.buffer);
        view.setUint32(0, 33639248, true);
        view.setUint16(4, 20, true);
        view.setUint16(6, 20, true);
        view.setUint16(8, 2048, true);
        view.setUint16(10, entry.method, true);
        view.setUint16(12, time, true);
        view.setUint16(14, date, true);
        view.setUint32(16, entry.crc, true);
        view.setUint32(20, entry.payload.length, true);
        view.setUint32(24, entry.data.length, true);
        view.setUint16(28, nameBytes.length, true);
        view.setUint16(30, 0, true);
        view.setUint16(32, 0, true);
        view.setUint16(34, 0, true);
        view.setUint16(36, 0, true);
        view.setUint32(38, 0, true);
        view.setUint32(42, offset, true);
        buf.set(nameBytes, 46);
        return buf;
    }

    function endOfCentralDirectory(count, cdSize, cdOffset) {
        const buf = new Uint8Array(22);
        const view = new DataView(buf.buffer);
        view.setUint32(0, 101010256, true);
        view.setUint16(4, 0, true);
        view.setUint16(6, 0, true);
        view.setUint16(8, count, true);
        view.setUint16(10, count, true);
        view.setUint32(12, cdSize, true);
        view.setUint32(16, cdOffset, true);
        view.setUint16(20, 0, true);
        return buf;
    }

    async function buildSubtitleZip(records) {
        const usedNames = new Set();
        const entries = [];
        for (const record of records) {
            const name = makeUniqueName(ensureExtension(sanitizeFileName(record.title), record), usedNames);
            const data = new Uint8Array(await record.rawBlob.arrayBuffer());
            const compressed = await deflateRaw(data);
            entries.push({
                name,
                data,
                payload: compressed ?? data,
                crc: crc32(data),
                method: compressed ? 8 : 0
            });
        }
        const chunks = [];
        const centralChunks = [];
        let offset = 0;
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const source = records[i];
            const {
                time,
                date
            } = dosDateTime(source ? Math.max(source.createdAt ?? 0, source.lastUsedAt ?? 0) : Date.now());
            const local = localHeader(entry, time, date);
            chunks.push(local.buffer, entry.payload.buffer);
            centralChunks.push(centralHeader(entry, offset, time, date));
            offset += local.length + entry.payload.length;
        }
        const cdOffset = offset;
        const cdSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const eocd = endOfCentralDirectory(entries.length, cdSize, cdOffset);
        for (const chunk of centralChunks) chunks.push(chunk.buffer);
        chunks.push(eocd.buffer);
        return new Blob(chunks, {type: "application/zip"});
    }

    var SYNC_KEY = "metadataSync.v1";
    var SYNC_VERSION = 1;
    var MAX_SUBTITLES_PER_ORIGIN = 500;
    var MAX_VIDEOS_PER_ORIGIN = 500;

    function getCurrentOrigin() {
        return window.location.host || "unknown-origin";
    }

    function fileIdFromVideoKey(videoKey) {
        return /^id:([^|]+)/.exec(videoKey)?.[1];
    }

    function matchesVideo(metaVideoKey, videoKey, fileId) {
        if (metaVideoKey === videoKey) return true;
        if (!fileId) return false;
        return fileIdFromVideoKey(metaVideoKey) === fileId;
    }

    function sanitizeSourceResult(result) {
        if (!result) return void 0;
        return {
            providerId: result.providerId,
            sourceId: result.sourceId,
            title: result.title,
            code: result.code,
            language: result.language,
            format: result.format,
            fileSize: result.fileSize,
            duration: result.duration,
            releaseInfo: result.releaseInfo,
            downloadUrl: result.downloadUrl,
            detailUrl: result.detailUrl,
            rating: result.rating,
            updatedAt: result.updatedAt,
            checksum: result.checksum
        };
    }

    function subtitleSize(record) {
        return "size" in record ? record.size : record.rawBlob?.size ?? 0;
    }

    function toSyncedSubtitle(record) {
        return {
            id: record.id,
            videoKey: record.videoKey,
            code: record.code ?? "",
            providerId: record.providerId,
            sourceId: record.sourceId,
            title: record.title,
            language: record.language,
            format: record.format,
            cueCount: record.cueCount,
            checksum: record.checksum,
            size: subtitleSize(record),
            createdAt: record.createdAt,
            lastUsedAt: record.lastUsedAt,
            sourceResult: sanitizeSourceResult(record.sourceResult)
        };
    }

    function toSyncedVideo(record) {
        return {
            videoKey: record.videoKey,
            code: record.code,
            selectedSubtitleId: record.selectedSubtitleId,
            offsetMs: record.offsetMs,
            subtitleEnabled: record.subtitleEnabled,
            updatedAt: record.updatedAt
        };
    }

    function buildSyncBucket(subtitles, videos) {
        return {
            updatedAt: Date.now(),
            subtitles: [...subtitles].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)).slice(0, MAX_SUBTITLES_PER_ORIGIN).map(toSyncedSubtitle),
            videos: [...videos].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, MAX_VIDEOS_PER_ORIGIN).map(toSyncedVideo)
        };
    }

    function isObject(value) {
        return typeof value === "object" && value !== null;
    }

    function asString(value) {
        return typeof value === "string" ? value : void 0;
    }

    function asNumber(value, fallback = 0) {
        return isFiniteNumber(value) ? value : fallback;
    }

    function normalizeSourceResult(value) {
        if (!isObject(value)) return void 0;
        const providerId = asString(value.providerId);
        const sourceId = asString(value.sourceId);
        const title = asString(value.title);
        const format = asString(value.format);
        if (!providerId || !sourceId || !title || !format) return void 0;
        return {
            providerId,
            sourceId,
            title,
            code: asString(value.code),
            language: asString(value.language),
            format,
            fileSize: isFiniteNumber(value.fileSize) ? value.fileSize : void 0,
            duration: isFiniteNumber(value.duration) ? value.duration : void 0,
            releaseInfo: asString(value.releaseInfo),
            downloadUrl: asString(value.downloadUrl),
            detailUrl: asString(value.detailUrl),
            rating: isFiniteNumber(value.rating) ? value.rating : void 0,
            updatedAt: isFiniteNumber(value.updatedAt) ? value.updatedAt : void 0,
            checksum: asString(value.checksum)
        };
    }

    function normalizeSubtitle(value) {
        if (!isObject(value)) return null;
        const id = asString(value.id);
        const videoKey = asString(value.videoKey);
        const providerId = asString(value.providerId);
        const title = asString(value.title);
        const format = asString(value.format);
        if (!id || !videoKey || !providerId || !title || !format) return null;
        return {
            id,
            videoKey,
            code: asString(value.code) ?? "",
            providerId,
            sourceId: asString(value.sourceId),
            title,
            language: asString(value.language),
            format,
            cueCount: asNumber(value.cueCount),
            checksum: asString(value.checksum),
            size: asNumber(value.size),
            createdAt: asNumber(value.createdAt),
            lastUsedAt: asNumber(value.lastUsedAt),
            sourceResult: normalizeSourceResult(value.sourceResult)
        };
    }

    function normalizeVideo(value) {
        if (!isObject(value)) return null;
        const videoKey = asString(value.videoKey);
        if (!videoKey) return null;
        return {
            videoKey,
            code: asString(value.code),
            selectedSubtitleId: asString(value.selectedSubtitleId),
            offsetMs: asNumber(value.offsetMs),
            subtitleEnabled: value.subtitleEnabled !== false,
            updatedAt: asNumber(value.updatedAt)
        };
    }

    function normalizePayload$1(raw) {
        const empty = {
            version: SYNC_VERSION,
            buckets: {}
        };
        if (!isObject(raw) || raw.version !== SYNC_VERSION || !isObject(raw.buckets)) return empty;
        const buckets = {};
        for (const [origin, value] of Object.entries(raw.buckets)) {
            if (!origin || !isObject(value)) continue;
            const subtitles = Array.isArray(value.subtitles) ? value.subtitles.map(normalizeSubtitle).filter((s) => s !== null) : [];
            const videos = Array.isArray(value.videos) ? value.videos.map(normalizeVideo).filter((v) => v !== null) : [];
            buckets[origin] = {
                updatedAt: asNumber(value.updatedAt),
                subtitles,
                videos
            };
        }
        return {
            version: SYNC_VERSION,
            buckets
        };
    }

    var MetadataSyncService = class {
        origin;

        constructor(origin = getCurrentOrigin()) {
            this.origin = origin;
        }

        getOrigin() {
            return this.origin;
        }

        async publish() {
            try {
                const [subtitles, videos] = await Promise.all([subtitleRepository.getAllMetadata(), subtitleRepository.getAllVideoRecords()]);
                const payload = this.readPayload();
                payload.buckets[this.origin] = buildSyncBucket(subtitles, videos);
                writeStoredValue(SYNC_KEY, payload);
            } catch (e) {
                logger.warn("同步缓存元数据失败", e);
            }
        }

        getRemoteForVideo(videoKey, fileId) {
            const payload = this.readPayload();
            const byId = new Map();
            let selected = null;
            let selectedUpdatedAt = -1;
            for (const [origin, bucket] of Object.entries(payload.buckets)) {
                if (origin === this.origin) continue;
                const subtitles = bucket.subtitles.filter((sub) => matchesVideo(sub.videoKey, videoKey, fileId));
                for (const sub of subtitles) {
                    const existing = byId.get(sub.id);
                    if (!existing || sub.lastUsedAt > existing.lastUsedAt) byId.set(sub.id, {
                        ...sub,
                        origin
                    });
                }
                for (const video of bucket.videos) {
                    if (!video.selectedSubtitleId) continue;
                    if (!matchesVideo(video.videoKey, videoKey, fileId)) continue;
                    const sub = subtitles.find((item) => item.id === video.selectedSubtitleId);
                    if (!sub) continue;
                    if (video.updatedAt > selectedUpdatedAt) {
                        selected = {
                            ...sub,
                            origin
                        };
                        selectedUpdatedAt = video.updatedAt;
                    }
                }
            }
            return {
                subtitles: [...byId.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt),
                selected
            };
        }

        getRemoteSummary() {
            const payload = this.readPayload();
            const seen = new Set();
            let count = 0;
            let bytes = 0;
            const origins = [];
            for (const [origin, bucket] of Object.entries(payload.buckets)) {
                if (origin === this.origin || bucket.subtitles.length === 0) continue;
                origins.push(origin);
                for (const sub of bucket.subtitles) {
                    if (seen.has(sub.id)) continue;
                    seen.add(sub.id);
                    count++;
                    bytes += sub.size > 0 ? sub.size : 0;
                }
            }
            return {
                count,
                bytes,
                origins
            };
        }

        clearRemoteOrigins() {
            const payload = this.readPayload();
            const removed = [];
            for (const origin of Object.keys(payload.buckets)) {
                if (origin === this.origin) continue;
                delete payload.buckets[origin];
                removed.push(origin);
            }
            if (removed.length > 0) writeStoredValue(SYNC_KEY, payload);
            return removed;
        }

        watch(callback) {
            if (typeof GM_addValueChangeListener !== "function") return () => void 0;
            try {
                const listenerId = GM_addValueChangeListener(SYNC_KEY, (_name, _oldValue, _newValue, remote) => {
                    if (remote) callback();
                });
                return () => {
                    try {
                        if (typeof GM_removeValueChangeListener === "function") GM_removeValueChangeListener(listenerId);
                    } catch {
                    }
                };
            } catch (e) {
                logger.warn("注册 GM 存储变化监听失败，将使用轮询", e);
                return () => void 0;
            }
        }

        readPayload() {
            return normalizePayload$1(readStoredValue(SYNC_KEY, null));
        }
    };
    var metadataSync = new MetadataSyncService();
    var AUTO_SEARCH_CACHE_KEY = "autoSearchCache.v1";
    var MAX_ENTRIES = 20;

    function normalizeCode(code) {
        return code.trim().toUpperCase().replace(/\s+/g, "");
    }

    function normalizeFileName(name) {
        if (!name) return "";
        return name.trim().toLowerCase().replace(/\s+/g, " ");
    }

    function buildAutoSearchCacheKey(input) {
        const code = normalizeCode(input.code);
        if (!code) return "";
        if (input.duration !== void 0 && isFiniteNumber(input.duration) && input.duration > 0) return `${code}|dur:${Math.floor(input.duration / 60)}`;
        const fileName = normalizeFileName(input.fileName);
        return fileName ? `${code}|name:${fileName}` : `${code}|name:unknown`;
    }

    function emptyPayload() {
        return {
            version: 1,
            entries: {}
        };
    }

    function normalizePayload(raw) {
        if (!raw || typeof raw !== "object") return emptyPayload();
        const value = raw;
        if (value.version !== 1 || !value.entries || typeof value.entries !== "object") return emptyPayload();
        const entries = {};
        for (const [key, entry] of Object.entries(value.entries)) {
            if (!key || !entry || typeof entry !== "object") continue;
            const savedAt = entry.savedAt;
            const results = entry.results;
            if (typeof savedAt !== "number" || !Array.isArray(results)) continue;
            entries[key] = {
                savedAt,
                results: results.filter(isSearchResult)
            };
        }
        return {
            version: 1,
            entries
        };
    }

    function isSearchResult(value) {
        if (!value || typeof value !== "object") return false;
        const item = value;
        return typeof item.providerId === "string" && typeof item.sourceId === "string" && typeof item.title === "string" && typeof item.format === "string";
    }

    var AutoSearchCache = class {
        now;

        constructor(now = () => Date.now()) {
            this.now = now;
        }

        read(key) {
            if (!key) return null;
            try {
                const payload = normalizePayload(readStoredValue(AUTO_SEARCH_CACHE_KEY, null));
                const entry = payload.entries[key];
                if (!entry) return null;
                if (this.now() - entry.savedAt > 9e5) {
                    delete payload.entries[key];
                    this.writePayload(payload);
                    return null;
                }
                return entry.results;
            } catch {
                return null;
            }
        }

        write(key, results) {
            if (!key) return;
            try {
                const payload = normalizePayload(readStoredValue(AUTO_SEARCH_CACHE_KEY, null));
                payload.entries[key] = {
                    savedAt: this.now(),
                    results
                };
                const ordered = Object.entries(payload.entries).sort((a, b) => b[1].savedAt - a[1].savedAt).slice(0, MAX_ENTRIES);
                payload.entries = Object.fromEntries(ordered);
                this.writePayload(payload);
            } catch {
            }
        }

        clear() {
            writeStoredValue(AUTO_SEARCH_CACHE_KEY, emptyPayload());
        }

        writePayload(payload) {
            writeStoredValue(AUTO_SEARCH_CACHE_KEY, payload);
        }
    };
    var autoSearchCache = new AutoSearchCache();
	async function bootstrap() {
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
            onBackfillSources: () => void handleBackfillSources()
		});
		let lastAutoSearchKey = "";
        let autoSearchGeneration = 0;
        let searchEpoch = 0;
		let currentSettings = settings;
        let lastVideoToken = "";
        let currentManualCode = "";
        let manualCodeLoadedFor = "";
        let localSubtitleIds = new Set();
        let lastRemoteRestoreToken = "";
        let activeSearchAbort = null;
        let searchRequestId = 0;
        const activeDownloads = new Set();

        function beginDownload() {
            const controller = new AbortController();
            activeDownloads.add(controller);
            return controller;
        }

        function endDownload(controller) {
            activeDownloads.delete(controller);
        }

        function abortActiveRequests() {
            activeSearchAbort?.abort();
            activeSearchAbort = null;
            for (const controller of activeDownloads) controller.abort();
            activeDownloads.clear();
        }

        function showWarning(message) {
            panel.showToast(message, "warn");
        }

        function identityToken(identity) {
            if (!identity) return "";
            return identity.fileId ? `id:${identity.fileId}` : identity.videoKey;
        }

        let publishTimer = null;
        let lastCacheCheckAt = 0;

        function publishMetadata() {
            if (publishTimer !== null) window.clearTimeout(publishTimer);
            publishTimer = window.setTimeout(() => {
                publishTimer = null;
                metadataSync.publish();
            }, 300);
        }

        async function publishMetadataNow() {
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
                    panel.setProgress(null);
                }
				panel.setIdentity(identity);
                if (currentManualCode) panel.setIdentity({
                    ...identity,
                    code: currentManualCode,
                    source: "manual"
                });
				refreshCacheList();
                loadManualCode(identity);
			},
			onPlayerContextAttached: (ctx) => {
				panel.mountPlayerControls(ctx.playerRoot);
				panel.setSubtitleVisible(controller.getSubtitleVisible());
			},
			onSubtitleLoaded: (title, subtitleId) => {
				panel.setCurrentSubtitle(title, subtitleId);
				refreshCacheList();
			},
			onSubtitleCleared: () => {
				panel.setCurrentSubtitle(null);
            },
            onCacheRestoreSettled: (identity, restored) => {
                if (!restored) handleCacheMiss(identity);
            },
            resolveCachedSubtitle: (record) => ensureCurrentParser(record),
            onOverlayUnsupported: (reason) => {
                panel.showToast(`${reason}；请退出全屏或使用网页全屏`, "warn");
            },
            onPositionChange: (xPercent, yPercent) => {
                handleStyleChange({
                    xPercent: Math.round(xPercent * 10) / 10,
                    yPercent: Math.round(yPercent * 10) / 10
                }).then(() => panel.setSettings(currentSettings, true));
			}
		});
		controller.setSettings(settings);
		panel.setSettings(settings);
		panel.setSubtitleVisible(controller.getSubtitleVisible());
		panel.mount();
		controller.start();
        refreshCacheList();
        publishMetadata();
        let syncWatchTimer = null;
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
        }, 15e3);
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible" && panel.isOpen()) refreshRemoteCache();
        });

        function applySubtitle(title, subtitleId, cues, note) {
			controller.selectSubtitle(subtitleId, cues);
			controller.setSubtitleVisible(true);
			panel.setSubtitleVisible(true);
			panel.setCurrentSubtitle(title, subtitleId);
            logger.info(`应用字幕：${title}（${cues.length} 条）`);
			const hasCueNow = controller.getActiveCueCount() > 0;
            const suffix = note ? `（${note}）` : "";
            panel.showToast(hasCueNow ? `已使用：${title}${suffix}` : `已使用：${title}${suffix}（当前时间点没有字幕，拖动进度条查看）`, hasCueNow ? "success" : "warn");
        }

        async function ensureCurrentParser(record) {
            if (record.parserVersion >= 2) return record;
            if (record.format === "ass" || record.format === "ssa") return record;
            try {
                const parsed = parseSubtitle(await record.rawBlob.arrayBuffer(), record.format, record.encoding);
                const updated = {
                    ...record,
                    cues: parsed.cues,
                    cueCount: parsed.cues.length,
                    encoding: parsed.encoding,
                    parserVersion: 2
                };
                await subtitleRepository.save(updated);
                logger.info(`已按解析器 v2 重新解析缓存字幕：${record.title}`);
                return updated;
            } catch (e) {
                logger.warn(`重新解析缓存字幕失败，保留原记录：${record.title}`, e);
                return record;
            }
        }

        async function loadManualCode(identity) {
            if (!identity.videoKey || manualCodeLoadedFor === identity.videoKey) return;
            manualCodeLoadedFor = identity.videoKey;
            try {
                const record = await subtitleRepository.getVideoRecord(identity.videoKey);
                const current = controller.getCurrentIdentity();
                if (!current || current.videoKey !== identity.videoKey) return;
                if (record?.codeSource === "manual" && record.code) {
                    currentManualCode = record.code;
                    panel.setIdentity({
                        ...current,
                        code: record.code,
                        source: "manual"
                    });
                }
            } catch (e) {
                logger.warn("读取手动番号失败", e);
            }
        }

        async function persistManualCode(identity, code) {
            const token = identityToken(identity);
            const stable = await waitForStableIdentity(token, 3e3);
            if (!stable || identityToken(controller.getCurrentIdentity()) !== token) return;
            try {
                await subtitleRepository.setManualCode(stable.videoKey, code);
                manualCodeLoadedFor = stable.videoKey;
                publishMetadata();
            } catch (e) {
                logger.warn("保存手动番号失败", e);
            }
        }

        async function handleManualSearch(code) {
            const trimmed = code.trim();
            if (!trimmed) {
                showWarning("请输入番号");
                return;
            }
            const identity = controller.getCurrentIdentity();
            const autoCode = identity?.code ?? "";
            const isManualCorrection = !autoCode || trimmed.toUpperCase() !== autoCode.toUpperCase();
            if (identity && isManualCorrection) {
                currentManualCode = trimmed;
                panel.setIdentity({
                    ...identity,
                    code: trimmed,
                    source: "manual"
                });
                persistManualCode(identity, trimmed);
            }
            lastAutoSearchKey = "";
            await handleSearch(trimmed, identity, {
                cacheResults: true,
                forceProviders: true
            });
        }

        async function replaceCachedByCode(code, keepId) {
            if (!code) return 0;
            try {
                const result = await subtitleRepository.replaceByCode(code, keepId);
                if (result.removed > 0) logger.info(`已替换同番号旧缓存：删除 ${result.removed} 条`);
                return result.removed;
            } catch (e) {
                logger.error("替换同番号旧缓存失败", e);
                return 0;
            }
		}
		async function handleImportFile(file) {
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
                    refreshCacheList();
                    publishMetadata();
                    return;
                }
				const record = {
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
                    parserVersion: 2
				};
				await subtitleRepository.save(record);
                const replaced = await replaceCachedByCode(record.code, record.id);
				await subtitleRepository.setSelectedForVideo(identity.videoKey, record.id);
                applySubtitle(fileName, record.id, parsed.cues, replaced > 0 ? `已替换同番号旧缓存 ${replaced} 条` : void 0);
				refreshCacheList();
                publishMetadata();
                enforceCacheLimit();
				logger.info(`已加载本地字幕：${fileName}（${parsed.cues.length} 条）`);
			} catch (e) {
                showWarning(isSubtitleError(e) ? e.message : "导入字幕失败");
				logger.error("导入字幕失败", e);
			}
		}

        async function handleSearch(code, origin = controller.getCurrentIdentity(), options = {}) {
			if (!code) {
                showWarning("请输入番号");
                return [];
			}
            activeSearchAbort?.abort();
            const abort = new AbortController();
            activeSearchAbort = abort;
            const requestId = ++searchRequestId;
            const identity = origin;
            const originEpoch = searchEpoch;
            const originToken = identityToken(identity);
            const stillCurrent = () => requestId === searchRequestId && originEpoch === searchEpoch && identityToken(controller.getCurrentIdentity()) === originToken;
			let latest = {
				providerStates: {},
				results: [],
				done: false
			};
            try {
                const results = await subtitleSearchEngine.search({
                    code,
                    normalizedCode: code.toUpperCase(),
                    fileName: identity?.originalFileName,
                    duration: identity?.duration,
                    languagePreferences: currentSettings.preferredLanguages,
                    force: options.forceProviders,
                    signal: abort.signal
                }, currentSettings, {
                    onProgress: (progress) => {
                        latest = progress;
                        if (stillCurrent()) panel.setProgress(progress);
                    }
                });
                if (stillCurrent()) {
                    panel.setProgress({
                        ...latest,
                        results,
                        done: true
                    });
                    if (options.cacheResults) {
                        const key = buildAutoSearchCacheKey({
                            code,
                            duration: identity?.duration,
                            fileName: identity?.originalFileName
                        });
                        const hasFailure = Object.values(latest.providerStates).some((state) => state.status === "error" || state.status === "timeout");
                        if (key && !hasFailure) autoSearchCache.write(key, results);
                    }
                    return results;
                }
                return [];
            } finally {
                if (activeSearchAbort === abort) activeSearchAbort = null;
            }
        }

        async function handleAutoSearch() {
            if (!currentSettings.autoSearch) return;
            const generation = ++autoSearchGeneration;
            const epoch = searchEpoch;
            await new Promise((resolve) => window.setTimeout(resolve, 700));
            if (generation !== autoSearchGeneration || epoch !== searchEpoch) return;
            if (!currentSettings.autoSearch) return;
            let currentIdentity = controller.getCurrentIdentity();
            if (!currentIdentity) return;
            const code = currentManualCode || currentIdentity.code;
            if (!code) return;
            if (code === lastAutoSearchKey) return;
            const deadline = Date.now() + 3e3;
            for (; ;) {
                if (controller.getCurrentSubtitleId()) return;
                if (await subtitleRepository.getSelectedForVideo(currentIdentity.videoKey) || controller.getCurrentSubtitleId()) return;
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
                fileName: currentIdentity.originalFileName
            });
            const cachedResults = autoSearchCache.read(cacheKey);
            if (cachedResults) {
                lastAutoSearchKey = code;
                panel.setProgress({
                    providerStates: {},
                    results: cachedResults,
                    done: true
                });
                panel.showToast(cachedResults.length > 0 ? `使用 15 分钟内的自动搜索结果（${cachedResults.length} 条），请在列表中手动选择` : "最近一次自动搜索没有结果；可手动修改番号后搜索", cachedResults.length > 0 ? "success" : "warn");
                return;
            }
            lastAutoSearchKey = code;
            const results = await handleSearch(code, currentIdentity, {cacheResults: true});
            if (identityToken(controller.getCurrentIdentity()) !== identityToken(currentIdentity)) return;
            if (results.length > 0) panel.showToast(`已自动搜索到 ${results.length} 条字幕，请在列表中手动选择`);
        }

        async function handleCacheMiss(identity) {
            if (!currentSettings.autoLoadCachedSubtitle) return;
            if (controller.getCurrentSubtitleId()) return;
            const token = identityToken(identity);
            if (token && token === lastRemoteRestoreToken) return;
            const remote = metadataSync.getRemoteForVideo(identity.videoKey, identity.fileId);
            if (!remote.selected) {
                handleAutoSearch();
                return;
            }
            lastRemoteRestoreToken = token;
            if (await restoreRemoteSubtitle(remote.selected, identity)) return;
            if (identityToken(controller.getCurrentIdentity()) !== token) return;
            if (controller.getCurrentSubtitleId()) return;
            handleAutoSearch();
        }

        async function waitForStableIdentity(token, timeoutMs = 3e3, signal) {
            const deadline = Date.now() + timeoutMs;
            for (; ;) {
                if (signal?.aborted) return null;
                const current = controller.getCurrentIdentity();
                if (!current || identityToken(current) !== token) return null;
                if (current.duration !== void 0 && controller.isMediaMetadataReady()) return current;
                if (Date.now() >= deadline) return current;
                await new Promise((resolve) => window.setTimeout(resolve, 250));
            }
        }

        async function restoreRemoteSubtitle(meta, identity, allowReplace = false) {
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
                if (abort.signal.aborted || epoch !== searchEpoch || identityToken(controller.getCurrentIdentity()) !== token) return false;
                const latestIdentity = await waitForStableIdentity(token, 3e3, abort.signal);
                if (!latestIdentity) return false;
                if (!allowReplace && controller.getCurrentSubtitleId()) return false;
                const format = detectFormat(download.fileName);
                if (format === "unknown" || format === "ass" || format === "ssa") {
                    logger.warn(`跨播放域名恢复失败：不支持的字幕格式 ${download.fileName}`);
                    return false;
                }
                const parsed = parseSubtitle(download.bytes, format);
                const duplicate = await subtitleRepository.findByChecksum(latestIdentity.videoKey, download.checksum);
                if (duplicate) {
                    let current = duplicate;
                    if (!current.sourceResult && meta.sourceResult) {
                        current = {
                            ...current,
                            sourceResult: meta.sourceResult
                        };
                        await subtitleRepository.save(current);
                    }
                    current = await ensureCurrentParser(current);
                    await subtitleRepository.setSelectedForVideo(latestIdentity.videoKey, current.id);
                    applySubtitle(current.title, current.id, current.cues, `已从 ${meta.origin} 恢复`);
                    refreshCacheList();
                    publishMetadata();
                    return true;
                }
                const existingById = await subtitleRepository.getById(meta.id);
                const record = {
                    id: existingById && existingById.videoKey !== latestIdentity.videoKey ? uuid() : meta.id,
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
                    parserVersion: 2,
                    sourceResult: meta.sourceResult
                };
                await subtitleRepository.save(record);
                const replaced = await replaceCachedByCode(record.code, record.id);
                await subtitleRepository.setSelectedForVideo(latestIdentity.videoKey, record.id);
                const note = replaced > 0 ? `已从 ${meta.origin} 恢复，替换 ${replaced} 条旧缓存` : `已从 ${meta.origin} 恢复`;
                applySubtitle(record.title, record.id, parsed.cues, note);
                refreshCacheList();
                publishMetadata();
                enforceCacheLimit();
                return true;
            } catch (e) {
                if (!abort.signal.aborted) logger.warn("跨播放域名恢复字幕失败", e);
                return false;
            } finally {
                endDownload(abort);
            }
        }

        async function handleRestoreRemote(meta) {
            const identity = controller.getCurrentIdentity();
            if (!identity) {
                showWarning("未检测到视频");
                return;
            }
            if (!meta.sourceResult) {
                panel.showToast("这条字幕来自本地导入，无法在另一播放域名自动恢复", "warn");
                return;
            }
            if (!await restoreRemoteSubtitle(meta, identity, true) && identityToken(controller.getCurrentIdentity()) === identityToken(identity)) panel.showToast("跨播放域名恢复失败，请重试或手动搜索", "warn");
		}
		async function handleSelectResult(result) {
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
                if (identity) {
                    const cached = await subtitleRepository.findBySource(identity.videoKey, result.providerId, result.sourceId);
                    if (cached) {
                        let current = cached;
                        try {
                            if (!current.sourceResult) {
                                current = {
                                    ...current,
                                    sourceResult: result,
                                    lastUsedAt: Date.now()
                                };
                                await subtitleRepository.save(current);
                            }
                            current = await ensureCurrentParser(current);
                            await subtitleRepository.setSelectedForVideo(identity.videoKey, current.id);
                        } catch (e) {
                            logger.warn("更新字幕缓存失败，仍使用已解析内容", e);
                        }
                        applySubtitle(current.title, current.id, current.cues, "缓存命中，无需重复下载");
                        refreshCacheList();
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
                    const duplicate = await subtitleRepository.findByChecksum(identity.videoKey, download.checksum);
                    if (duplicate) {
                        let current = duplicate;
                        try {
                            if (!current.sourceResult) {
                                current = {
                                    ...current,
                                    sourceResult: result,
                                    lastUsedAt: Date.now()
                                };
                                await subtitleRepository.save(current);
                            }
                            current = await ensureCurrentParser(current);
                            await subtitleRepository.setSelectedForVideo(identity.videoKey, current.id);
                        } catch (e) {
                            logger.warn("更新字幕缓存失败，仍使用已解析内容", e);
                        }
                        applySubtitle(current.title, current.id, current.cues, "内容相同，已复用缓存");
                        refreshCacheList();
                        publishMetadata();
                        return;
                    }
					const record = {
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
                        parserVersion: 2,
                        sourceResult: result
					};
                    let replaced = 0;
                    let cacheFailed = false;
                    try {
                        await subtitleRepository.save(record);
                        replaced = await replaceCachedByCode(record.code, record.id);
                        await subtitleRepository.setSelectedForVideo(identity.videoKey, record.id);
                    } catch (e) {
                        cacheFailed = true;
                        logger.warn("写入字幕缓存失败，但仍应用字幕", e);
                    }
                    applySubtitle(result.title, record.id, parsed.cues, cacheFailed ? "字幕已生效，但缓存写入失败" : replaced > 0 ? `已替换同番号旧缓存 ${replaced} 条` : void 0);
					refreshCacheList();
                    if (!cacheFailed) {
                        publishMetadata();
                        enforceCacheLimit();
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
		async function handlePreviewResult(result) {
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
                let content = formatCuesWithTimestamps(parsed.cues);
                if (!content.trim()) content = decodeRawSubtitle(download.bytes, parsed.encoding);
                panel.showPreview(result.title, limitPreviewText(content.trim() ? content : "（无字幕内容）"));
			} catch (e) {
                if (abort.signal.aborted) return;
                showWarning(isSubtitleError(e) ? e.message : "预览字幕失败");
				logger.error("预览字幕失败", e);
            } finally {
                endDownload(abort);
			}
		}
		async function handleDownloadResult(result) {
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
				setTimeout(() => URL.revokeObjectURL(url), 1e3);
				logger.info(`已下载字幕：${download.fileName}`);
			} catch (e) {
                if (abort.signal.aborted) return;
                showWarning(isSubtitleError(e) ? e.message : "下载字幕失败");
				logger.error("下载字幕失败", e);
            } finally {
                endDownload(abort);
			}
		}
		async function handleStyleChange(patch) {
			const newStyle = {
				...currentSettings.style,
				...patch
			};
			currentSettings = await settingsService.update({ style: newStyle });
			controller.setSettings(currentSettings);
			panel.setSettings(currentSettings, false);
		}
		async function handleOffsetChange(offsetMs) {
			currentSettings = await settingsService.update({ sync: {
				...currentSettings.sync,
				offsetMs
			} });
			controller.setOffset(offsetMs);
			panel.setSettings(currentSettings, false);
        }

        async function handleAutoSearchChange(enabled) {
            currentSettings = await settingsService.update({autoSearch: enabled});
            panel.setSettings(currentSettings, false);
            if (enabled) {
                lastAutoSearchKey = "";
                handleAutoSearch();
            }
        }

        async function handleShortcutChange(enabled) {
            currentSettings = await settingsService.update({
                shortcuts: {
                    ...currentSettings.shortcuts,
                    enabled
                }
            });
            panel.setSettings(currentSettings, false);
		}
		async function handleSelectCachedSubtitle(record) {
			try {
                const current = await ensureCurrentParser(record);
				const identity = controller.getCurrentIdentity();
                if (identity) try {
                    await subtitleRepository.setSelectedForVideo(identity.videoKey, current.id);
					await subtitleRepository.save({
                        ...current,
                        videoKey: current.videoKey === identity.videoKey ? current.videoKey : identity.videoKey,
						lastUsedAt: Date.now()
					});
                } catch (e) {
                    logger.warn("更新缓存选中状态失败，仍应用字幕", e);
				}
                applySubtitle(current.title, current.id, current.cues);
				refreshCacheList();
                publishMetadata();
			} catch (e) {
                showWarning(isSubtitleError(e) ? e.message : "加载缓存字幕失败");
				logger.error("加载缓存字幕失败", e);
			}
		}

        async function handleDeduplicateCache() {
            try {
                const result = await subtitleRepository.deduplicateByCode();
                const currentId = controller.getCurrentSubtitleId();
                if (currentId) {
                    if (!await subtitleRepository.getById(currentId)) {
                        const identity = controller.getCurrentIdentity();
                        const selected = identity ? await subtitleRepository.getSelectedForVideo(identity.videoKey) : null;
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
                panel.showToast(result.removed > 0 ? `去重完成：合并 ${result.groups} 组，删除 ${result.removed} 条重复字幕` : "没有需要去重的字幕", result.removed > 0 ? "success" : "warn");
                logger.info(`缓存去重完成：删除 ${result.removed} 条`);
            } catch (e) {
                showWarning(isSubtitleError(e) ? e.message : "缓存去重失败");
                logger.error("缓存去重失败", e);
            }
        }

        async function handleExportAll() {
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
                setTimeout(() => URL.revokeObjectURL(url), 2e3);
                panel.showToast(`已导出 ${records.length} 条字幕`);
                logger.info(`已导出字幕压缩包（${records.length} 条）`);
            } catch (e) {
                showWarning("导出字幕失败");
                logger.error("导出字幕失败", e);
            }
        }

        function handlePositioningChange(enabled) {
            controller.setPositioningMode(enabled);
            panel.setPositioning(enabled);
            if (enabled) panel.showToast("拖动字幕到目标位置；按 Esc 或再次点击「完成定位」退出");
        }

        async function handleCheckProviders() {
            const providers = providerManager.getAll().filter((provider) => provider.id !== "local");
            const checks = await Promise.allSettled(providers.map(async (provider) => {
                if (!provider.healthCheck) return {
                    name: provider.name,
                    ok: true,
                    message: "未提供检测"
                };
                const result = await provider.healthCheck();
                return {
                    name: provider.name,
                    ...result
                };
            }));
            const failed = [];
            const passed = [];
            checks.forEach((check, index) => {
                const fallbackName = providers[index]?.name ?? "未知来源";
                if (check.status === "fulfilled" && check.value.ok) passed.push(check.value.name);
                else {
                    const reason = check.status === "fulfilled" ? check.value.message ?? "不可用" : check.reason instanceof Error ? check.reason.message : "检测失败";
                    failed.push(`${fallbackName}：${reason}`);
                }
            });
            panel.showToast(failed.length === 0 ? `来源检测通过：${passed.join("、")}` : `可用：${passed.join("、") || "无"}；失败：${failed.join("；")}`, failed.length === 0 ? "success" : "warn");
        }

        async function handleBackfillSources() {
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
            const missing = (await subtitleRepository.getByVideoKey(identity.videoKey)).filter((record) => record.providerId !== "local" && record.sourceId && !record.sourceResult);
            if (missing.length === 0) {
                panel.showToast("当前视频没有需要补齐来源信息的缓存", "warn");
                return;
            }
            const results = await handleSearch(code, identity, {forceProviders: true});
            const bySource = new Map(results.map((result) => [`${result.providerId}:${result.sourceId}`, result]));
            let filled = 0;
            for (const record of missing) {
                const result = bySource.get(`${record.providerId}:${record.sourceId}`);
                if (!result) continue;
                await subtitleRepository.save({
                    ...record,
                    sourceResult: result,
                    lastUsedAt: Date.now()
                });
                filled++;
            }
            await refreshCacheList();
            if (filled > 0) publishMetadata();
            panel.showToast(filled > 0 ? `已补齐 ${filled} 条字幕的来源信息，可在其他播放域名恢复` : "本次搜索结果中没有匹配的来源条目", filled > 0 ? "success" : "warn");
        }

        async function handleClearRemoteSync() {
            try {
                const origins = metadataSync.clearRemoteOrigins();
                await refreshCacheList();
                panel.showToast(origins.length > 0 ? `已清理 ${origins.length} 个其他播放域名的同步索引` : "没有可清理的远程同步索引", origins.length > 0 ? "success" : "warn");
            } catch (e) {
                logger.error("清理远程同步索引失败", e);
                panel.showToast("清理远程同步索引失败", "warn");
            }
        }

        async function handleRefreshSync() {
            try {
                await publishMetadataNow();
                await refreshCacheList();
                panel.showToast("已刷新跨播放域名缓存索引");
            } catch (e) {
                logger.error("刷新同步索引失败", e);
                panel.showToast("刷新同步索引失败", "warn");
            }
        }
		async function handleClearCache() {
            try {
                await subtitleRepository.clearAll();
                controller.clearSubtitle();
                panel.setCurrentSubtitle(null);
                refreshCacheList();
                publishMetadata();
                panel.showToast("已清空所有字幕缓存");
            } catch (e) {
                logger.error("清空缓存失败", e);
                panel.showToast("清空缓存失败", "warn");
            }
		}
		async function handleDeleteSubtitle(id) {
			await subtitleRepository.delete(id);
			if (controller.getCurrentSubtitleId() === id) {
				controller.clearSubtitle();
				panel.setCurrentSubtitle(null);
			}
			refreshCacheList();
            publishMetadata();
		}

        function formatByteSize(bytes) {
            if (bytes < 1024) return `${bytes}B`;
            if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
            return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
        }

        function protectedSubtitleIds() {
            const current = controller.getCurrentSubtitleId();
            return current ? [current] : [];
        }

        async function handleCleanupCache() {
            try {
                const result = await subtitleRepository.cleanup({
                    maxBytes: 0,
                    olderThanDays: currentSettings.cache.cleanupAfterDays,
                    protectIds: protectedSubtitleIds()
                });
                lastCacheCheckAt = Date.now();
                if (result.removed > 0) {
                    await refreshCacheList();
                    publishMetadata();
                    panel.showToast(`清理完成：删除 ${result.removed} 条，释放 ${formatByteSize(result.freedBytes)}`);
                } else panel.showToast("没有可清理的未使用缓存", "warn");
            } catch (e) {
                logger.error("清理缓存失败", e);
                panel.showToast("清理缓存失败", "warn");
            }
        }

        async function enforceCacheLimit(force = false) {
            const now = Date.now();
            if (!force && now - lastCacheCheckAt < 6e4) return;
            lastCacheCheckAt = now;
            try {
                const result = await subtitleRepository.cleanup({
                    maxBytes: currentSettings.cache.maxBytes,
                    olderThanDays: 0,
                    protectIds: protectedSubtitleIds()
                });
                if (result.removed > 0) {
                    await refreshCacheList();
                    publishMetadata();
                    panel.showToast(`缓存超出上限，已自动清理 ${result.removed} 条旧字幕，释放 ${formatByteSize(result.freedBytes)}`, "warn");
                }
            } catch (e) {
                logger.warn("自动清理缓存失败", e);
            }
        }
		async function refreshCacheList() {
            const all = await subtitleRepository.getAll();
            const bytes = all.reduce((sum, record) => sum + record.rawBlob.size, 0);
            panel.setCacheSummary({
                count: all.length,
                bytes
            });
			const identity = controller.getCurrentIdentity();
            if (!identity) {
                localSubtitleIds = new Set();
                panel.setCachedSubtitles([]);
                refreshRemoteCache();
                return;
            }
            const local = all.filter((record) => record.videoKey === identity.videoKey || identity.fileId !== void 0 && fileIdFromVideoKey(record.videoKey) === identity.fileId);
            panel.setCachedSubtitles(local);
            localSubtitleIds = new Set(local.map((record) => record.id));
            refreshRemoteCache();
        }

        function refreshRemoteCache() {
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

    var url = new URL(window.location.href);
    if (url.searchParams.has("pickcode") || parseModernPlayerUrl(url.href) !== null) bootstrap().catch((e) => {
		logger.error("启动失败", e);
	});
    else logger.debug("当前页面不是受支持的 115 播放页，跳过启动");
})();
