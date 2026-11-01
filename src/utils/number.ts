/**
 * 安全的「有限数字」判断。
 *
 * 115 播放页会把 `Number.isFinite` / `Number.isInteger` 从 `Number` 上删除
 * （实测 `typeof Number.isFinite === "undefined"`）。开发模式（vite-plugin-monkey）
 * 下脚本注入到页面上下文运行，直接调用会抛 `TypeError`，因此这里不使用任何
 * 可能被页面改写的内置函数。
 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && value === value && value !== Infinity && value !== -Infinity;
}
