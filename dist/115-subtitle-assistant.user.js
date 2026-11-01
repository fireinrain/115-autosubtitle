// ==UserScript==
// @name         115 Subtitle Assistant
// @namespace    https://example.invalid/115-subtitle-assistant
// @version      0.1.0
// @description  115 网页播放器字幕搜索、显示与本地缓存
// @match        https://115vod.com/*
// @connect      api-shoulei-ssl.xunlei.com
// @connect      subtitle.v.geilijiasu.com
// @connect      www.subtitlecat.com
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
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
	var M115VideoAdapter = class {
		id = "115-video";
		detect() {
			const video = document.querySelector(VIDEO_SELECTOR);
			if (!video) return null;
			const style = getComputedStyle(video);
			if (style.display === "none" || style.visibility === "hidden") return null;
			const playerRoot = document.querySelector(PLAYER_BOX_SELECTOR) ?? video.parentElement ?? document.body;
			if (getComputedStyle(playerRoot).position === "static") playerRoot.style.position = "relative";
			return {
				video,
				playerRoot,
				overlayHost: playerRoot,
				metadata: this.readMetadata(video)
			};
		}
		readMetadata(video) {
			return {
				platform: "115",
				fileName: this.findFileName(),
				fileId: this.findFileId(),
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
			const activeItem = document.querySelector("#js-video_list li.hover[pickcode], #js-video_list li[pickcode]");
			if (activeItem) {
				const pc = activeItem.getAttribute(PICKCODE_PARAM);
				if (pc) return pc;
			}
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
				subtree: true,
				attributes: true,
				attributeFilter: [
					"class",
					"style",
					"src"
				]
			});
			const onFullscreenChange = () => scheduleDetect();
			document.addEventListener("fullscreenchange", onFullscreenChange);
			const videoEl = document.querySelector(VIDEO_SELECTOR);
			const onSrcChange = () => scheduleDetect();
			if (videoEl) {
				videoEl.addEventListener("loadstart", onSrcChange);
				videoEl.addEventListener("loadedmetadata", onSrcChange);
			}
			const timers = [];
			timers.push(window.setTimeout(scheduleDetect, 500));
			timers.push(window.setTimeout(scheduleDetect, 1500));
			timers.push(window.setTimeout(scheduleDetect, 3e3));
			return () => {
				observer.disconnect();
				document.removeEventListener("fullscreenchange", onFullscreenChange);
				if (videoEl) {
					videoEl.removeEventListener("loadstart", onSrcChange);
					videoEl.removeEventListener("loadedmetadata", onSrcChange);
				}
				for (const t of timers) clearTimeout(t);
			};
		}
	};
	var m115VideoAdapter = new M115VideoAdapter();
	function normalizeFileName(input) {
		return input.normalize("NFKC").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[\s_.]+/g, " ").replace(/[\[\]【】（）()]/g, " ").replace(/\s+/g, " ").trim().toUpperCase();
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
			const normalizedFileName = originalFileName ? normalizeFileName(originalFileName) : void 0;
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
		}
		setCues(cues) {
			if (cues.length === this.currentCues.length && cues.every((c, i) => c.id === this.currentCues[i]?.id)) return;
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
        pointer-events: none;
      }
      .subtitle-line {
        font-family: ${s.fontFamily};
        font-size: ${s.fontSize}px;
        font-weight: ${s.fontWeight};
        color: ${s.color};
        line-height: ${s.lineHeight};
        white-space: pre-wrap;
        text-shadow: ${s.shadow ? `2px 2px 4px rgba(0,0,0,0.8)` : "none"};
        -webkit-text-stroke: ${s.outlineWidth}px ${s.outlineColor};
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
		dispose() {
			this.unmount();
		}
	};
	function hexToRgba(hex, alpha) {
		const h = hex.replace("#", "");
		return `rgba(${parseInt(h.substring(0, 2), 16)}, ${parseInt(h.substring(2, 4), 16)}, ${parseInt(h.substring(4, 6), 16)}, ${alpha})`;
	}
	var DB_NAME = "115SubtitleAssistantDB";
	var Database = class {
		dbPromise = null;
		open() {
			if (this.dbPromise) return this.dbPromise;
			this.dbPromise = new Promise((resolve, reject) => {
				const request = indexedDB.open(DB_NAME, 1);
				request.onerror = () => reject(request.error);
				request.onblocked = () => reject(new Error("数据库被阻塞"));
				request.onsuccess = () => resolve(request.result);
				request.onupgradeneeded = () => this.upgrade(request.result);
			});
			return this.dbPromise;
		}
		upgrade(db) {
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
	var SubtitleRepository = class {
		async save(record) {
			try {
				const { tx, stores } = await database.transaction("subtitles", "readwrite");
				stores.subtitles.put(record);
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
		async delete(id) {
			const { tx, stores } = await database.transaction(["subtitles", "videoRecords"], "readwrite");
			stores.subtitles.delete(id);
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
		async getSelectedForVideo(videoKey) {
			const { tx, stores } = await database.transaction("videoRecords", "readonly");
			const req = stores.videoRecords.get(videoKey);
			await this.waitForTransaction(tx);
			const record = req.result;
			if (!record?.selectedSubtitleId) return null;
			return this.getById(record.selectedSubtitleId);
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
		async saveVideoRecord(record) {
			const { tx, stores } = await database.transaction("videoRecords", "readwrite");
			stores.videoRecords.put(record);
			await this.waitForTransaction(tx);
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
			const { tx, stores } = await database.transaction(["subtitles", "videoRecords"], "readwrite");
			stores.subtitles.clear();
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
			const initial = this.adapter.detect();
			if (initial) this.handleContext(initial);
		}
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
			const myGen = ++this.generation;
			if (myGen !== this.generation) return;
			this.currentContext = ctx;
			this.renderer.mount(ctx.overlayHost);
			this.renderer.setVisible(this.subtitleVisible);
			if (this.settings) this.renderer.setStyle(this.settings.style);
			const identity = this.identityService.resolve(ctx.metadata);
			this.currentIdentity = identity;
			this.events.onVideoChange?.(identity);
			this.events.onPlayerContextAttached?.(ctx);
			this.bindVideoEvents(ctx.video);
			if (this.settings?.autoLoadCachedSubtitle) {
				const cached = await subtitleRepository.getSelectedForVideo(identity.videoKey);
				if (myGen !== this.generation) return;
				if (cached) {
					this.loadCues(cached.cues);
					this.currentSubtitleId = cached.id;
					this.events.onSubtitleLoaded?.(cached.title, cached.id);
					return;
				}
			}
			this.startRenderLoop(ctx.video);
		}
		async detach() {
			this.generation++;
			this.stopRenderLoop();
			this.unbindVideoEvents();
			this.timeline.clear();
			this.renderer.setCues([]);
			this.renderer.unmount();
			this.currentSubtitleId = null;
			this.currentContext = null;
			this.currentIdentity = null;
			this.events.onSubtitleCleared?.();
		}
		bindVideoEvents(video) {
			const handlers = [
				["loadedmetadata", () => this.onMetadata(video)],
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
			if (this.currentContext) {
				this.currentContext.metadata.duration = isFiniteNumber(video.duration) ? video.duration : void 0;
				this.currentContext.metadata.width = video.videoWidth || void 0;
				this.currentContext.metadata.height = video.videoHeight || void 0;
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
		getSubtitleVisible() {
			return this.subtitleVisible;
		}
		getCurrentIdentity() {
			return this.currentIdentity;
		}
		getCurrentSubtitleId() {
			return this.currentSubtitleId;
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
	var GmRequestClient = class {
		async request(options) {
			const { url, method = "GET", headers, data, responseType = "text", timeoutMs = 15e3, signal, maxBytes } = options;
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
							finalUrl: resp.finalUrl ?? url
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
					signal: query.signal
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
					maxBytes: 5242880
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
					signal: query.signal
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
		async download(result, signal) {
			if (!result.downloadUrl) throw new SubtitleError("DOWNLOAD_FAILED", "缺少下载地址");
			if (new URL(result.downloadUrl).hostname !== "www.subtitlecat.com") throw new SubtitleError("DOWNLOAD_FAILED", "下载地址域名不合法");
			logger.debug(`[subtitlecat] 下载字幕：${result.title}`);
			try {
				const resp = await gmRequestClient.request({
					url: result.downloadUrl,
					method: "GET",
					responseType: "arraybuffer",
					timeoutMs: 3e4,
					signal,
					maxBytes: 5242880
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
				signal
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
    width: 400px; max-height: min(62vh, 620px);
    background: #1e1e2e; color: #cdd6f4;
    border: 1px solid #45475a; border-radius: 10px;
    box-shadow: 0 12px 40px rgba(0,0,0,.55);
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
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
  .badge-active { display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 999px; background: #a6e3a1; color: #1e1e2e; font-size: 10px; font-weight: 600; vertical-align: 1px; }
  .btn-active { background: rgba(166,227,161,.18) !important; color: #a6e3a1 !important; border: 1px solid #a6e3a1 !important; opacity: 1 !important; cursor: default; }
  .toast { position: fixed; left: 50%; bottom: 96px; transform: translate(-50%, 8px); z-index: 2147483001; max-width: 380px; padding: 9px 14px; border-radius: 8px; background: rgba(166,227,161,.97); color: #1e1e2e; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.45); opacity: 0; transition: opacity .16s ease, transform .16s ease; pointer-events: none; word-break: break-all; }
  .toast.show { opacity: 1; transform: translate(-50%, 0); }
  .toast.warn { background: rgba(249,226,175,.97); }
  .result-title { font-size: 12px; font-weight: 500; margin-bottom: 2px; word-break: break-all; }
  .result-meta { font-size: 11px; color: #a6adc8; }
  .result-actions { display: flex; gap: 6px; margin-top: 7px; }
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
  .preview-line { padding: 3px 0; border-bottom: 1px solid #313244; font-size: 12px; line-height: 1.6; color: #cdd6f4; }
  .preview-line:last-child { border-bottom: none; }
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
		settings = null;
		codeDraft = null;
		toastEl = null;
		toastTimer = null;
		playerRoot = null;
		playerBarObserver = null;
		nativeToggle = null;
		subtitleVisible = true;
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
			this.renderBody();
		}
		setProgress(progress) {
			this.progress = progress;
			this.renderBody();
		}
		setCurrentSubtitle(title, subtitleId = null) {
			this.currentSubtitle = title;
			this.currentSubtitleId = subtitleId;
			this.renderBody();
		}
		setCachedSubtitles(subtitles) {
			this.cachedSubtitles = subtitles;
			this.renderBody();
		}
		setSettings(settings, updateView = true) {
			this.settings = settings;
			if (updateView) this.renderBody();
		}
		show(tab = this.activeTab) {
			this.visible = true;
			this.setActiveTab(tab);
			this.panelEl?.classList.add("open");
			this.positionPanel();
		}
		hide() {
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
			const overlay = div("modal-overlay");
			overlay.addEventListener("click", (e) => {
				if (e.target === overlay) this.closePreview();
			});
			const modal = div("modal");
			const header = div("modal-header");
			header.appendChild(div("modal-title", title));
			header.appendChild(btn("close", "×", () => this.closePreview()));
			const body = div("modal-body");
			const lines = content.split("\n");
			for (const line of lines) {
				const lineEl = div("preview-line", line);
				body.appendChild(lineEl);
			}
			modal.appendChild(header);
			modal.appendChild(body);
			overlay.appendChild(modal);
			this.root.appendChild(overlay);
			this.modalEl = overlay;
		}
		closePreview() {
			this.modalEl?.remove();
			this.modalEl = null;
		}
		mountPlayerControls(playerRoot) {
			if (this.playerRoot === playerRoot) {
				this.ensureNativeToggle();
				return;
			}
			this.teardownPlayerControls();
			this.playerRoot = playerRoot;
			this.ensureNativeToggle();
			this.playerBarObserver = new MutationObserver(() => this.ensureNativeToggle());
			this.playerBarObserver.observe(playerRoot, {
				childList: true,
				subtree: true
			});
		}
		setSubtitleVisible(visible) {
			this.subtitleVisible = visible;
			this.updateStatusPill();
			if (this.visible && this.activeTab === "subs") this.renderBody();
		}
		findNativeSubtitleItem(root) {
			const items = root.querySelectorAll(".operate-bar .bar-side > ul > li");
			for (const li of items) {
				const anchor = li.firstElementChild;
				if (!(anchor instanceof HTMLAnchorElement)) continue;
				if (!anchor.classList.contains("btn-cle")) continue;
				if (anchor.textContent?.trim() === "字幕") return li;
			}
			return null;
		}
		ensureNativeToggle() {
			if (!this.playerRoot) return;
			const nativeItem = this.findNativeSubtitleItem(this.playerRoot);
			if (!nativeItem || this.nativeToggle && this.nativeToggle.li.isConnected && this.nativeToggle.li.previousElementSibling === nativeItem) return;
			this.nativeToggle?.li.remove();
			this.nativeToggle = null;
			if (!nativeItem) return;
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
			nativeItem.after(li);
			this.nativeToggle = {
				li,
				anchor,
				tooltip
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
			if (this.nativeToggle && path.includes(this.nativeToggle.li)) return;
			this.hide();
		};
		handleDocumentKeyDown = (event) => {
			if (event.key !== "Escape") return;
			if (this.modalEl) {
				this.closePreview();
				return;
			}
			if (this.visible) this.hide();
		};
		handleViewportChange = () => {
			if (this.visible) this.positionPanel();
		};
		buildShell() {
			if (!this.root) return;
			const style = document.createElement("style");
			style.textContent = PANEL_CSS;
			this.root.appendChild(style);
			const panel = div("panel");
			const header = div("header");
			header.appendChild(div("title", "115 字幕助手"));
			const pill = document.createElement("button");
			pill.type = "button";
			pill.className = "pill on";
			pill.addEventListener("click", () => {
				this.subtitleVisible = !this.subtitleVisible;
				this.updateStatusPill();
				this.callbacks.onToggleSubtitle(this.subtitleVisible);
				if (this.visible && this.activeTab === "subs") this.renderBody();
			});
			header.appendChild(pill);
			this.statusPill = pill;
			header.appendChild(btn("close", "×", () => this.hide()));
			panel.appendChild(header);
			const tabs = div("tabs");
			for (const tab of TABS) {
				const el = btn("tab", tab.label, () => this.setActiveTab(tab.id));
				tabs.appendChild(el);
				this.tabEls.set(tab.id, el);
			}
			panel.appendChild(tabs);
			const body = div("body");
			panel.appendChild(body);
			this.root.appendChild(panel);
			this.panelEl = panel;
			this.bodyEl = body;
			this.updateStatusPill();
			this.setActiveTab(this.activeTab);
		}
		setActiveTab(tab) {
			this.activeTab = tab;
			for (const [id, el] of this.tabEls) el.classList.toggle("active", id === tab);
			this.renderBody();
		}
		updateStatusPill() {
			if (!this.statusPill) return;
			this.statusPill.textContent = this.subtitleVisible ? "字幕：开" : "字幕：关";
			this.statusPill.classList.toggle("on", this.subtitleVisible);
			this.statusPill.classList.toggle("off", !this.subtitleVisible);
			this.statusPill.setAttribute("aria-pressed", String(this.subtitleVisible));
			this.statusPill.title = this.subtitleVisible ? "点击隐藏字幕" : "点击显示字幕";
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
			if (this.progress.results.length === 0) {
				const empty = div("empty", !this.progress.done ? "正在搜索，请稍候…" : allFailed ? "所有字幕来源都搜索失败" : "没有搜索到字幕");
				empty.style.marginTop = "8px";
				section.appendChild(empty);
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
			if (this.cachedSubtitles.length === 0) return null;
			const section = div("section");
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
							onClick: () => this.previewCached(sub)
						},
						{
							label: "删除",
							danger: true,
							onClick: () => this.callbacks.onDeleteSubtitle(sub.id)
						}
					]
				}));
			}
			return section;
		}
		previewCached(record) {
			const lines = record.cues.slice(0, 60).map((cue, i) => `${i + 1}. ${cue.text}`);
			const content = lines.length > 0 ? lines.join("\n") : "（无字幕内容）";
			this.showPreview(record.title, content);
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
			return pane;
		}
		renderCacheTab() {
			const pane = div("tab-pane");
			const section = div("section");
			section.appendChild(div("section-title", "缓存管理"));
			const bytes = this.cachedSubtitles.reduce((sum, s) => sum + s.rawBlob.size, 0);
			section.appendChild(div("info", `当前视频已缓存 ${this.cachedSubtitles.length} 条字幕，共 ${formatSize(bytes)}`));
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
			const clearRow = div("row");
			clearRow.appendChild(btn("btn btn-danger btn-sm", "清空全部缓存", () => {
				if (confirm("确定清空所有字幕缓存？该操作不可撤销。")) this.callbacks.onClearCache();
			}));
			section.appendChild(clearRow);
			pane.appendChild(section);
			return pane;
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
			const titleEl = div("result-title", opts.title);
			if (active) {
				const badge = document.createElement("span");
				badge.className = "badge-active";
				badge.textContent = "使用中";
				titleEl.appendChild(badge);
			}
			row.appendChild(titleEl);
			row.appendChild(div("result-meta", opts.meta));
			const actions = div("result-actions");
			for (const action of opts.actions) {
				const classes = ["btn", "btn-sm"];
				if (action.primary) classes.push("btn-ghost");
				if (action.danger) classes.push("btn-danger");
				const alreadyActive = active && action.primary;
				if (alreadyActive) classes.push("btn-active");
				const button = btn(classes.join(" "), alreadyActive ? "已使用" : action.label, action.onClick);
				if (alreadyActive) button.disabled = true;
				actions.appendChild(button);
			}
			row.appendChild(actions);
			return row;
		}
		showToast(message, tone = "success") {
			if (!this.root) return;
			this.clearToast();
			const el = div(tone === "warn" ? "toast warn" : "toast", message);
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
			const width = 400;
			const anchor = this.nativeToggle?.anchor;
			if (!anchor || !anchor.isConnected) {
				panel.style.left = "auto";
				panel.style.right = "16px";
				panel.style.top = "64px";
				panel.style.bottom = "auto";
				return;
			}
			const rect = anchor.getBoundingClientRect();
			const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
			panel.style.left = `${Math.round(left)}px`;
			panel.style.right = "auto";
			panel.style.top = "auto";
			panel.style.bottom = `${Math.round(Math.max(8, window.innerHeight - rect.top + 10))}px`;
		}
		teardownPlayerControls() {
			this.playerBarObserver?.disconnect();
			this.playerBarObserver = null;
			this.nativeToggle?.li.remove();
			this.nativeToggle = null;
			this.playerRoot = null;
		}
		dispose() {
			this.teardownPlayerControls();
			document.removeEventListener("pointerdown", this.handleDocumentPointerDown, true);
			document.removeEventListener("keydown", this.handleDocumentKeyDown, true);
			window.removeEventListener("resize", this.handleViewportChange);
			window.removeEventListener("scroll", this.handleViewportChange, true);
			this.closePreview();
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
		enabled: true,
		autoSearch: false,
		autoLoadCachedSubtitle: true,
		autoSelectHighConfidence: false,
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
			fontFamily: "Arial, sans-serif",
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
			return {
				...DEFAULT_SETTINGS,
				...raw,
				style: {
					...DEFAULT_SETTINGS.style,
					...raw.style
				},
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
	var SubtitleSearchEngine = class {
		async search(query, settings, callbacks) {
			const providers = providerManager.getEnabled(settings).filter((p) => p.id !== "local");
			if (providers.length === 0) return [];
			const providerStates = {};
			for (const p of providers) providerStates[p.id] = {
				providerId: p.id,
				status: "pending",
				resultCount: 0
			};
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
				return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
			}
			return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
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
			onDeleteSubtitle: (id) => handleDeleteSubtitle(id)
		});
		let lastAutoSearchKey = "";
		let currentSettings = settings;
		const controller = new PlayerController(adapter, {
			onVideoChange: (identity) => {
				panel.setIdentity(identity);
				refreshCacheList();
				if (currentSettings.autoSearch && identity.code && identity.code !== lastAutoSearchKey) {
					lastAutoSearchKey = identity.code;
					handleSearch(identity.code);
				}
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
			}
		});
		controller.setSettings(settings);
		panel.setSettings(settings);
		panel.setSubtitleVisible(controller.getSubtitleVisible());
		panel.mount();
		controller.start();
		function applySubtitle(title, subtitleId, cues) {
			controller.selectSubtitle(subtitleId, cues);
			controller.setSubtitleVisible(true);
			panel.setSubtitleVisible(true);
			panel.setCurrentSubtitle(title, subtitleId);
			const hasCueNow = controller.getActiveCueCount() > 0;
			panel.showToast(hasCueNow ? `已使用：${title}` : `已使用：${title}（当前时间点没有字幕，拖动进度条查看）`, hasCueNow ? "success" : "warn");
		}
		async function handleImportFile(file) {
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
				const record = {
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
					isFavorite: false
				};
				await subtitleRepository.save(record);
				await subtitleRepository.setSelectedForVideo(identity.videoKey, record.id);
				applySubtitle(fileName, record.id, parsed.cues);
				refreshCacheList();
				logger.info(`已加载本地字幕：${fileName}（${parsed.cues.length} 条）`);
			} catch (e) {
				const msg = isSubtitleError(e) ? e.message : "导入字幕失败";
				alert(msg);
				logger.error("导入字幕失败", e);
			}
		}
		async function handleSearch(code) {
			if (!code) {
				alert("请输入番号");
				return;
			}
			const identity = controller.getCurrentIdentity();
			let latest = {
				providerStates: {},
				results: [],
				done: false
			};
			const results = await subtitleSearchEngine.search({
				code,
				normalizedCode: code.toUpperCase(),
				fileName: identity?.originalFileName,
				duration: identity?.duration,
				languagePreferences: currentSettings.preferredLanguages
			}, currentSettings, { onProgress: (progress) => {
				latest = progress;
				panel.setProgress(progress);
			} });
			panel.setProgress({
				...latest,
				results,
				done: true
			});
		}
		async function handleSelectResult(result) {
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
					const record = {
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
						isFavorite: false
					};
					await subtitleRepository.save(record);
					await subtitleRepository.setSelectedForVideo(identity.videoKey, record.id);
					applySubtitle(result.title, record.id, parsed.cues);
					refreshCacheList();
				} else {
					applySubtitle(result.title, null, parsed.cues);
					logger.info("已加载字幕但未检测到视频，无法关联缓存");
				}
			} catch (e) {
				alert(isSubtitleError(e) ? e.message : "下载字幕失败");
				logger.error("下载字幕失败", e);
			}
		}
		async function handlePreviewResult(result) {
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
				const previewLines = parseSubtitle(download.bytes, format).cues.slice(0, 30).map((cue, i) => `${i + 1}. ${cue.text}`);
				const content = previewLines.length > 0 ? previewLines.join("\n") : "（无字幕内容）";
				panel.showPreview(result.title, content);
			} catch (e) {
				alert(isSubtitleError(e) ? e.message : "预览字幕失败");
				logger.error("预览字幕失败", e);
			}
		}
		async function handleDownloadResult(result) {
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
				setTimeout(() => URL.revokeObjectURL(url), 1e3);
				logger.info(`已下载字幕：${download.fileName}`);
			} catch (e) {
				alert(isSubtitleError(e) ? e.message : "下载字幕失败");
				logger.error("下载字幕失败", e);
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
		async function handleSelectCachedSubtitle(record) {
			try {
				const identity = controller.getCurrentIdentity();
				if (identity) {
					await subtitleRepository.setSelectedForVideo(identity.videoKey, record.id);
					await subtitleRepository.save({
						...record,
						lastUsedAt: Date.now()
					});
				}
				applySubtitle(record.title, record.id, record.cues);
				refreshCacheList();
			} catch (e) {
				alert(isSubtitleError(e) ? e.message : "加载缓存字幕失败");
				logger.error("加载缓存字幕失败", e);
			}
		}
		async function handleClearCache() {
			await subtitleRepository.clearAll();
			controller.clearSubtitle();
			panel.setCurrentSubtitle(null);
			refreshCacheList();
		}
		async function handleDeleteSubtitle(id) {
			await subtitleRepository.delete(id);
			if (controller.getCurrentSubtitleId() === id) {
				controller.clearSubtitle();
				panel.setCurrentSubtitle(null);
			}
			refreshCacheList();
		}
		async function refreshCacheList() {
			const identity = controller.getCurrentIdentity();
			if (!identity) return;
			const subs = await subtitleRepository.getByVideoKey(identity.videoKey);
			panel.setCachedSubtitles(subs);
		}
	}
	if (new URL(window.location.href).searchParams.has("pickcode")) bootstrap().catch((e) => {
		logger.error("启动失败", e);
	});
	else logger.debug("当前页面无 pickcode 参数，跳过启动");
})();
