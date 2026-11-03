import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {M115VideoAdapter, parseModernPlayerUrl} from "../../src/player/m115-video-adapter";
import {VideoIdentityService} from "../../src/identity/video-identity";

const URL_UNDER_TEST =
    "https://115.com/players/video/e5exo0rcveo9ozlcb?name=4k688.com%40SNOS-392.mp4&fid=3537357567493670828&sort_field=user_utime&sort_asc=0";

describe("parseModernPlayerUrl", () => {
    it("解析新版播放页的 pickcode、文件名和文件 ID", () => {
        expect(parseModernPlayerUrl(URL_UNDER_TEST)).toEqual({
            pickcode: "e5exo0rcveo9ozlcb",
            fileId: "e5exo0rcveo9ozlcb",
            fileName: "4k688.com@SNOS-392.mp4",
        });
    });

    it("兼容 www.115.com 和缺少 name 参数的情况", () => {
        const info = parseModernPlayerUrl("https://www.115.com/players/video/abc123?fid=42");
        expect(info).toEqual({pickcode: "abc123", fileId: "abc123", fileName: undefined});
    });

    it("非新版播放页返回 null", () => {
        expect(parseModernPlayerUrl("https://115.com/storage/allfiles")).toBeNull();
        expect(parseModernPlayerUrl("https://115vod.com/?pickcode=abc")).toBeNull();
        expect(parseModernPlayerUrl("not a url")).toBeNull();
    });

    it("解析结果可以生成番号与稳定 videoKey", () => {
        const info = parseModernPlayerUrl(URL_UNDER_TEST);
        expect(info).not.toBeNull();
        const identity = new VideoIdentityService().resolve({
            platform: "115",
            fileId: info?.fileId,
            fileName: info?.fileName,
            duration: 8868.426,
            sourcePageUrl: URL_UNDER_TEST,
        });
        expect(identity.code).toBe("SNOS-392");
        expect(identity.videoKey).toBe("id:e5exo0rcveo9ozlcb|dur:8868");
        expect(identity.confidence).toBe("strong");
    });
});

describe("M115VideoAdapter legacy fileId fallback", () => {
    const adapter = new M115VideoAdapter();

    beforeEach(() => {
        document.body.innerHTML = "";
        history.replaceState({}, "", "/");
    });

    afterEach(() => {
        document.body.innerHTML = "";
    });

    function renderPlaylist(items: Array<{ pickcode: string; hover?: boolean }>): void {
        document.body.innerHTML = `
      <div id="js-video_box"><video id="js-video"></video></div>
      <ul id="js-video_list">
        ${items
            .map(
                (item) =>
                    `<li pickcode="${item.pickcode}"${item.hover ? ' class="hover"' : ""}></li>`,
            )
            .join("")}
      </ul>
    `;
    }

    it("优先使用 hover 的播放列表项", () => {
        renderPlaylist([{pickcode: "first"}, {pickcode: "active", hover: true}]);
        expect(adapter.detect()?.metadata.fileId).toBe("active");
    });

    it("多个列表项且没有 hover 时不猜第一个", () => {
        renderPlaylist([{pickcode: "first"}, {pickcode: "second"}]);
        expect(adapter.detect()?.metadata.fileId).toBeUndefined();
    });

    it("只有一个列表项时允许回退", () => {
        renderPlaylist([{pickcode: "only"}]);
        expect(adapter.detect()?.metadata.fileId).toBe("only");
    });
});
