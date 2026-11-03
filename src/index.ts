import { bootstrap } from "./app/bootstrap";
import {parseModernPlayerUrl} from "./player/m115-video-adapter";
import { logger } from "./utils/logger";

const url = new URL(window.location.href);
// 旧播放页用查询参数 pickcode；新播放页是 /players/video/<pickcode>。
const isPlayerPage = url.searchParams.has("pickcode") || parseModernPlayerUrl(url.href) !== null;
if (isPlayerPage) {
  void bootstrap().catch((e) => {
    logger.error("启动失败", e);
  });
} else {
    logger.debug("当前页面不是受支持的 115 播放页，跳过启动");
}