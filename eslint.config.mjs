import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
    {
        ignores: ["dist/**", "node_modules/**", "coverage/**"],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ["**/*.ts"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
        },
        rules: {
            // TypeScript 自己负责标识符解析；GM_* 与 DOM 全局由 tsconfig 声明。
            "no-undef": "off",
            "no-empty": ["error", {allowEmptyCatch: true}],
            // 项目里已有少量为兼容外部数据而保留的显式 any；先把 lint 基线建立起来。
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unused-vars": [
                "error",
                {argsIgnorePattern: "^_", varsIgnorePattern: "^_"},
            ],
        },
    },
);
