export function debounce<T extends (...args: never[]) => void>(
  fn: T,
  delayMs: number,
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      fn(...args);
      timer = null;
    }, delayMs);
  };
}

/**
 * 节流：保证在持续高频触发时仍然会按固定间隔执行。
 *
 * 115 播放页的进度条、弹幕和广告位会持续修改页面属性，
 * 若使用 debounce，MutationObserver 会被无限重置，回调永远不执行
 * （实测：播放器标题后到时身份信息一直无法刷新）。
 */
export function throttle<T extends (...args: never[]) => void>(
  fn: T,
  intervalMs: number,
): (...args: Parameters<T>) => void {
  let lastRun = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: Parameters<T> | null = null;

  const run = (args: Parameters<T>): void => {
    lastRun = Date.now();
    fn(...args);
  };

  return (...args: Parameters<T>) => {
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
