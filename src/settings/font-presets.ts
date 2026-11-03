/**
 * 字幕字体预设。
 *
 * 不使用远程 Web Font：CJK 字体文件动辄数 MB，且外部字体请求需要新增
 * `@connect` 与网络权限，离线/全屏时还可能加载失败。这里只用系统已安装的
 * 中文字幕常用字体做优先级栈，由浏览器选择第一个可用的字体。
 */
export interface FontPreset {
    id: string;
    label: string;
    fontFamily: string;
}

export const FONT_PRESETS: FontPreset[] = [
    {
        id: "cjk-sans",
        label: "苹方 / 思源黑体（推荐）",
        fontFamily:
            '"PingFang SC", "Hiragino Sans GB", "Source Han Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
    },
    {
        id: "heiti",
        label: "黑体（字幕常用）",
        fontFamily:
            '"Heiti SC", "STHeiti", "SimHei", "Source Han Sans SC", "Noto Sans CJK SC", sans-serif',
    },
    {
        id: "yuanti",
        label: "圆体",
        fontFamily: '"Yuanti SC", "YouYuan", "PingFang SC", "Microsoft YaHei", sans-serif',
    },
    {
        id: "songti",
        label: "宋体",
        fontFamily: '"Songti SC", "SimSun", "Noto Serif CJK SC", serif',
    },
    {
        id: "kaiti",
        label: "楷体",
        fontFamily: '"Kaiti SC", "KaiTi", "STKaiti", "Noto Serif CJK SC", serif',
    },
    {
        id: "japanese",
        label: "日文（Hiragino / Yu Gothic）",
        fontFamily:
            '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Noto Sans CJK JP", sans-serif',
    },
    {
        id: "system",
        label: "系统默认",
        fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    },
];

/** 默认使用字幕后黑体系；旧配置里的 `Arial, sans-serif` 也能被识别为自定义。 */
export const DEFAULT_SUBTITLE_FONT = FONT_PRESETS[0].fontFamily;

export function findFontPreset(fontFamily: string): FontPreset | undefined {
    return FONT_PRESETS.find((preset) => preset.fontFamily === fontFamily);
}

/**
 * 字体栈会直接拼进 Shadow DOM 的 <style>，必须挡住 CSS 注入字符。
 * 只允许字体名、引号、逗号、空格和常见连接符。
 */
export function normalizeFontFamily(value: unknown): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        return DEFAULT_SUBTITLE_FONT;
    }
    if (/[;{}<>]/.test(value)) return DEFAULT_SUBTITLE_FONT;
    return value.slice(0, 300);
}
