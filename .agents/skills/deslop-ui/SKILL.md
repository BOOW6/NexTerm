---
name: deslop-ui
description: NexTerm UI de-slop 守卫。生成或审查 Tauri UI（组件、窗口、主题令牌、i18n 文案、用户可见模板）时加载：语义令牌消费约束、派生色工作流、生成后自检命令与 clean/flagged/有意保留审计简表。
---

# deslop-ui

规则正文的单一事实来源是 `scripts/ds-lint.mjs`（拦截模式与豁免）与令牌层文件；本 Skill 只维护工作流与路由。更新规则时改脚本，不在本文复制正则。

## 1. 何时加载

- 生成或修改 `src/components`、`src/windows`、`src/theme`、`src/i18n`、`src-tauri/src/themes/schema.json`（随扫描写出到用户主题文件夹，属用户可见产物）时。
- 审查 UI 变更、执行 de-slop 审计时。
- 不适用：纯 Rust 后端逻辑；终端 resize/渲染管线走 `AGENTS.md` 的 xterm.js 规范，本 Skill 不覆盖。

## 2. 生成前约束

**颜色**

- 只消费语义令牌：Tailwind 语义类（`bg-accent`、`text-muted-foreground` 等，映射见 `tailwind.config.js`）或 `hsl(var(--token))`。
- 禁止：裸 hex、`rgb()/hsl()` 数字字面量、Tailwind 调色板类（`bg-blue-500` 等）、任意值颜色（`bg-[#…]`）、内联 style 字面量颜色。数据驱动的颜色预览（如主题色板 swatch）不受限。
- 新派生色先入令牌层，再在组件消费：
  - 逐主题结构色 → `src/theme/tokens.css` 对应 `[data-theme]` 块；
  - 跨主题交互 ramp → `src/theme/derived-tokens.css`（单一 `:root` 层，`color-mix(in oklch, var(--primary) …)`，暗色模式不重复定义）。
- 令牌层改动后必须 `npm run ds:tokens` 更新 `.ai/ds/ds-tokens.json` 快照并随代码提交。
- 布局键（字号/字重/字距/标签几何）只改 `src/theme/layout-tokens.css`；主题块、皮肤、强调色预设不得覆盖（`layoutTokens.test.ts` 钉死）。

**文案与注释**

- 用户可见文案（i18n 值、schema description、组件字符串字面量）禁 em dash（—），用句号/冒号/短句替代。
- 用户可见文案禁间隔中点（·），含 JSX 文本子节点；并列信息用逗号（中文「，」/ 英文 ", "）或连字符 " - " 替代。
- 禁 AI 演示风动词：elevate / seamless / revolutionize / supercharge / effortless / delve / unleash / empower；禁 emoji 功能图标（图标用 lucide-react）。
- 禁开发者标记进入用户可见字符串：TODO / FIXME / "AI generated" / "This component" / lorem ipsum。
- `unlock`/「解锁」是凭据保险库真实功能术语，**豁免**，不得改写。
- 面向用户产物禁仓库内部路径（`src/…`）；schema 只改 description 措辞，`extends` 枚举与 `structure` 键被 Rust 单测钉死。
- 源码注释只解释"为什么"（约束、workaround、issue 引用），不解释"这是什么"；WHY 注释保留，不属清理对象。

**交互**

- 禁装饰性 `hover:scale-105/110/125/150`；功能性微交互豁免只能登记在 `scripts/ds-lint.mjs` 的 `EXEMPTIONS`（文件 + 规则 + 理由），当前唯一条目：SettingsWindow 色板圆点选中反馈。

## 3. 生成后自检（按序执行，全绿才算完成）

```bash
npm run ds:lint          # 10 规则：color-hex / color-fn / color-palette /
                         # color-arbitrary / hover-scale / copy-emdash /
                         # copy-middot / copy-ai-keyword / copy-dev-marker /
                         # schema-repo-path
npm run ds:tokens:check  # 令牌快照新鲜度；改过令牌层先 npm run ds:tokens
npm run check            # typecheck + eslint + vitest 全量
                         # （contrast / layoutTokens / derivedTokens / skinRules / i18n 门禁）
```

失败处置：修复违规，或在 `EXEMPTIONS` 登记带理由的豁免；**禁止放宽脚本正则或删测试**。快照过期时按提示重生成并提交，不得手改 `.ai/ds/ds-tokens.json`。

## 4. 输出审计简表（审查任务必产出）

| 文件:行号 | 规则        | 判定     | 理由/处置                  |
| --------- | ----------- | -------- | -------------------------- |
| src/…:NN  | color-hex   | flagged  | 改为 `bg-accent`（已修复） |
| src/…:NN  | hover-scale | 有意保留 | EXEMPTIONS：色板选中反馈   |
| src/…:NN  | copy-emdash | clean    | 已为句号短句               |

- 判定三值：**clean / flagged / 有意保留**。
- "有意保留"必须引用 `doc/de-slop/audit.md` 的裁定或 `EXEMPTIONS` 条目，不允许裸豁免。
- 表尾给三类计数汇总；flagged 未清零时结论只能是"未通过"。

## 5. 规则演进（实时更新方式）

- 新增/修改拦截模式 → 改 `scripts/ds-lint.mjs`（规则数组 / EXEMPTIONS），CI 的 `ds:lint` 步骤即时生效。
- 令牌结构变化 → `npm run ds:tokens` 重生成快照，git diff 即变更追溯。
- 本 Skill 与 `AGENTS.md` 只维护流程与指针；规则正文不在这两处复制，避免三处漂移。
