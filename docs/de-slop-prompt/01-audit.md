# 01 审计（只读）

## 角色

你是一名资深前端代码审计员，熟悉 Tauri + React + TailwindCSS + CSS Variables 的主题体系。你只做只读审计，不修改任何文件。

## 目标

对 NexTerm 仓库做 de-slop 审计，把以下三个假设逐条"确认"或"排除"，输出带证据的清单：

1. 主题主色调是否跟随用户自选强调色（`themeAccent`）——是否存在绕过 `--accent*` token 的硬编码派生色；
2. UI 文案是否有 AI 演示风（浮夸形容词、翻译腔、中英不一致、占位废话）；
3. 面向用户的产物（主题 schema、导出备份、错误提示、tooltip）中是否泄露开发者注释或仓库内部信息。

## 先计划、后动手

开始前先列出你的检查矩阵（每类问题 × 检查手段），再逐项执行。禁止跳过任何一项后凭印象下结论。

## 输入文件（必读）

- `AGENTS.md`（根目录）——"xterm.js 开发与性能规范"与主题 token 分层是判断合法/违规的依据
- `src/theme/tokens.css`、`skin-tokens.css`、`layout-tokens.css`、`accent.ts`、`ThemeProvider.tsx`、`themes.ts`、`terminalTheme.ts`、`applyCustomTheme.ts`、`skins/`
- `src/components/**/*.tsx`、`src/windows/**/*.tsx`
- `src/i18n/dictionaries/{core,panels,settings,terminal,workspace}.ts`
- `src-tauri/src/themes/schema.json`、`src-tauri/src/themes/mod.rs`
- `tailwind.config.js`、`.github/workflows/ci.yml`
- 既有门禁测试：`src/theme/contrast.test.ts`、`layoutTokens.test.ts`、`skinRules.test.ts`、`terminalTheme.test.ts`、`src/i18n/index.test.ts`

## 检查手段（命令均存在，可直接用）

```bash
# 组件层裸 hex / rgb(a) / 内联颜色样式 / Tailwind 调色板类
grep -rnE "#[0-9a-fA-F]{3,8}\b" src/components src/windows --include="*.tsx"
grep -rnE "rgba?\(" src/components src/windows --include="*.tsx"
grep -rnE "style=\{\{[^}]*(color|background|border)" src/components src/windows --include="*.tsx"
grep -rnE "(bg|text|border|ring|from|to|via)-(red|blue|green|yellow|purple|pink|indigo|emerald|amber|slate|gray|zinc|orange|cyan|teal|sky|violet|fuchsia|rose|lime)-[0-9]{2,3}" src/components src/windows --include="*.tsx"

# 面向用户产物中的仓库内部路径 / 开发者信息
grep -rn "src/" src-tauri/src/themes/schema.json
grep -rniE "(TODO|FIXME|HACK|XXX)" src/i18n src-tauri/src/themes/schema.json

# AI 演示风模式
grep -rniE "(seamless|effortless|supercharge|delve|revolutioniz|game.chang|✨|🚀)" src/i18n src/components

# accent 派生报告（手动，需 ACCENT_REPORT=1）
ACCENT_REPORT=1 npx vitest run src/theme/accentReport.test.ts
```

## 豁免清单（不得报为问题）

- `src/theme/themes.ts`、`terminalTheme.ts`、`accent.ts` 中的 hex：它们是主题数据/预设，本就是"单一来源"；
- `XtermCanvas.tsx` 等源码中引用 GitHub issue 编号的 WHY 注释（如 microsoft/vscode#334532）：不面向用户，保留；
- accent 派生对语义色做色相偏移是设计意图（见 `accent.ts` 头注释与 AGENTS.md），不是 bug；
- 测试文件（`*.test.ts`）中的 hex 断言。

## 允许修改范围

无。本步骤**只读**，唯一产出是审计报告文件（见下）。

## 禁止事项

- 禁止修改任何业务代码、样式、文案、配置；
- 禁止运行 `npm run dev` / `tauri dev`（审计不需要起应用）；
- 禁止把豁免清单项写入发现清单；
- 禁止编造不存在的命令或脚本。

## 输出格式

写入 `docs/de-slop-audit.md`，结构：

```markdown
# De-Slop 审计报告（日期）

## 假设 1：颜色硬编码 / accent 不跟随

结论：确认 / 排除 / 部分确认
| # | 文件:行号 | 证据（代码摘录） | 类别 | 严重度(高/中/低) | 建议处置 |

## 假设 2：AI 演示风文案

（同上表格式；排除时列出已检查的分片与 grep 模式）

## 假设 3：面向用户产物泄露开发者信息

（同上；必须包含对 schema.json 全部 description 字段的逐条通读结论）

## 已确认的合法豁免（列出，防止后续步骤误改）

## 检查矩阵执行记录（每项手段 → 命中数）
```

每条发现必须有 `路径:行号`，行号来自实际 grep/读文件输出，禁止凭记忆填写。

## 验收命令

```bash
# 报告存在且非空
test -s docs/de-slop-audit.md
# 只读审计没有污染工作区（除报告本身）
git status --porcelain | grep -v "docs/de-slop"   # 应无输出
```

## 失败时如何处理

- grep 超时（本仓库发生过）：改用 `Bash` 的原生 grep 限定子目录逐批执行，不要放弃该项；
- 某项检查无法完成（如工具报错）：在报告"检查矩阵执行记录"中如实标注"未完成 + 原因"，不得默认通过；
- 发现与 AGENTS.md 规范冲突但不确定是否有意为之：记为"需人工裁决"，不自行定性。
