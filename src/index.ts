import { bootstrap } from "./app/bootstrap";
import { logger } from "./utils/logger";

const url = new URL(window.location.href);
if (url.searchParams.has("pickcode")) {
  void bootstrap().catch((e) => {
    logger.error("启动失败", e);
  });
} else {
  logger.debug("当前页面无 pickcode 参数，跳过启动");
}