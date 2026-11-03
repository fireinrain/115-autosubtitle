import {defineConfig} from "vitest/config";
import monkey from "vite-plugin-monkey";
import pkg from "./package.json" with {type: "json"};

export default defineConfig({
  // 固定端口：Tampermonkey 里的开发版加载器把 dev server 地址写死在脚本里，
  // 端口漂移会导致脚本静默不执行（ERR_CONNECTION_REFUSED）。
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  plugins: [
    monkey({
      entry: "src/index.ts",
      userscript: {
        name: "115 Subtitle Assistant",
        namespace: "https://example.invalid/115-subtitle-assistant",
        version: pkg.version,
        description: "115 网页播放器字幕搜索、显示与本地缓存",
        "run-at": "document-idle",
        match: [
          "https://115vod.com/*",
            "https://115.com/players/*",
        ],
        grant: [
          "GM_getValue",
          "GM_setValue",
          "GM_xmlhttpRequest",
          "GM_registerMenuCommand",
          "GM_addStyle",
          "GM_addValueChangeListener",
          "GM_removeValueChangeListener",
        ],
        connect: [
          "api-shoulei-ssl.xunlei.com",
          "subtitle.v.geilijiasu.com",
          "www.subtitlecat.com",
        ],
      },
      build: {
        fileName: "115-subtitle-assistant.user.js",
        autoGrant: true,
      },
    }),
  ],
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
  },
});