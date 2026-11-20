# De-Slop 审计报告

> 日期：2026-11-20。只读审计，未修改任何业务代码。
> 方法：逐类 grep/通读，全部行号来自实际命令输出。审计矩阵执行记录见文末。

## 假设结论速览

| 假设                          | 结论                                                                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 主色调不跟随用户自选强调色 | **部分确认（高）**：现代 4 族已跟随；复古 4 主题（day/dim/aqua/holo）的 `--gradient-*` 结构 token 为硬编码 hex，不参与 accent 派生，且强调色选择器不按主题族 gate |
| 2. UI 文案 AI 演示风          | **基本排除（低）**：无空泛措辞/hero 文案/特性网格；仅 7 处英文 em dash 与 1 处省略号风格不一致                                                                    |
| 3. 面向用户产物泄露开发者信息 | **确认 1 处（中）**：`schema.json:49` description 含仓库内部路径，该文件写出到用户主题文件夹                                                                      |

---

## A. 颜色硬编码 / accent 不跟随

### A1（高）复古主题的 `--gradient-*` 不跟随强调色

- **证据链**：
  - 全部 14 个主题在 `src/theme/tokens.css` 中以硬编码 hex 定义 5 个渐变 token（`--gradient-header/-panel-title/-button/-button-hover/-button-primary`）：day `tokens.css:91-95`、dim `186-190`、aqua-light `278-282`、aqua-dark `376-380`、holo-light `474-478`、holo-dark `566-570`、slate-light `654-658`、slate-dark `736-740`、graphite `829/911`、tgreen `1001/1082`、sandstone `1170/1252`。
  - `src/theme/accent.ts:226-336` 的 `accentVars()` 输出键集合中**没有任何 `--gradient-*`**——强调色派生不重染渐变 token。
  - **现代族被 skin 救回**：`skins/slate.css:59-72`（graphite/tgreen/sandstone 均 `@import './slate.css'`，另有 `tgreen.css:57-67`、`sandstone.css:36-43`）对 `.app-button[data-variant='primary']` 设 `background-image: none; background-color: var(--button-primary-bg)`，而 `--button-primary-bg: hsl(var(--accent-strong))`（`tokens.css:110-112` 等，14/14 主题均有）→ 跟随 accent。slate 系的渐变 token 本身也已是 `0deg` 平面色或 `transparent`（`tokens.css:654-655`）。
  - **复古族无人救**：day/dim/aqua 没有任何 skin 文件（`src/theme/skins/` 仅 graphite/holo/sandstone/slate/tgreen）；`holo.css` 只覆盖了 dialog header（`holo.css:16-23`），**无 primary button 规则**。于是复古主题下主按钮走 `bg-button-primary` 工具类（`src/components/ui/button.tsx:9`，映射 `var(--gradient-button-primary)`，`tailwind.config.js:61-67`）→ 保持主题原 hex（aqua 蓝 `#5b9bd5→#2e75b6` 等）。
  - 面板/对话框头同理：`bg-panel-title` 工具类设置 `background-image`，会盖在 `skin-tokens.css:175-177` 的 `background-color: var(--panel-header-bg)` 之上；受影响处：`CommandPalette.tsx:450`、`DockLayout.tsx:66`、`SessionSidebar.tsx:322`、`SshConnectForm.tsx:120`、`SettingsWindow.tsx:241`。现代族渐变多为 `transparent` 所以无感，复古族显示硬编码渐变。
  - **触发条件真实存在**：强调色色板选择器不按主题族 gate（`SettingsWindow.tsx:1160-1209` 对所有主题渲染 `ACCENT_SWATCHES`），`ThemeProvider.tsx:111-123` 无条件应用 accent。用户在 Aqua 下选 terracotta → 链接/状态色/终端变橙红，主按钮与面板头仍是 Web 2.0 蓝——正是"半个界面没跟上"的割裂。
- **建议修复**（三选一，按侵入性排序）：
  1. 复古族渐变 token 改为从 accent 变量派生（如 `linear-gradient(180deg, hsl(var(--accent) / 0.85), hsl(var(--accent-strong)))`），未设 accent 时由主题原值兜底——需同步核对 `contrast.test.ts` 是否解析这些值；
  2. `accent.ts` 的 `accentVars()` 为复古族追加 `--gradient-header/-panel-title/-button-primary` 等重染键（沿用现有色相偏移逻辑）；
  3. 最低成本：强调色 UI 按 `group === 'modern'` gate 或提示"仅现代主题完整跟随"（牺牲功能一致性，不推荐单独作为终态）。
- 修复后应新增回归测试（accent 快照需覆盖 gradient 键）。

### A2（低）现代族渐变 token 的 hex 与主题强调色双份数据

- `tokens.css:658`（slate-light `#1f6feb`）、`740`（slate-dark `#2f81f7`）、`829/911`（graphite）、`1001/1082`（tgreen）、`1170/1252`（sandstone）：虽被 skin 覆盖为平面渲染（primary 按钮）或值本身 transparent/平面，但 hex 与同块 `--accent` 值重复维护，存在漂移风险；且 `bg-button`/`bg-button-hover`（次要按钮，`button.tsx:11`）在无 skin 覆盖路径下仍消费它们。
- **建议**：随 A1 一并把现代族渐变 token 改为 `hsl(var(--accent*))` 派生或 `transparent` + 平面色 token，消除双份数据。

### A3（低）组件层 Tailwind 任意值引用 token

- `src/windows/settings/TerminalPreview.tsx:307`：`bg-[hsl(var(--terminal-background))]`。不是硬编码色值，但违反 AGENTS.md"组件里禁止任意值"约定。
- **建议**：在 `tailwind.config.js` 的 colors 增加 `terminal.background` 映射后改用 `bg-terminal-background`。

### A4（豁免，勿改）

- `SettingsWindow.tsx:1202` 内联 `backgroundColor: swatch.accent`：数据驱动的主题色板预览，色值来自 `themes.ts` 预设，合法。
- `src/theme/themes.ts`（swatches/accent 预设）、`terminalTheme.ts`（16 色板）、`accent.ts`（预设 hex）：token 单一来源的数据文件。
- 组件/窗口层 grep：无裸 hex、无 `rgb()/hsl()` 字面量、无 Tailwind 调色板类（`bg-blue-500` 等）、无其它内联颜色样式（其余 `style={{}}` 均为宽度/缩进/字体/百分比，见 `TitleBar.tsx:420`、`SessionSidebar.tsx:63,319`、`TransferPanel.tsx:247`、`input.tsx:23`、`select.tsx:22`、`SettingsWindow.tsx:1364-1370` 字体预览）。

### A5（排除）派生色覆盖完整

- `--surface-hover`、`--surface-active`、`--border-muted`、`--border-strong`、`--muted-foreground`、`--row-hover`、`--panel-header-bg`、`--accent-strong`、`--focus-ring` 在 `tokens.css` 中均 **14/14** 主题声明（逐 token `grep -c`）。不存在"缺失 hover/active/muted/border 派生色"问题。
- 注意：复古 6 主题块 82 vars vs 现代 8 主题块 72 vars（awk 统计），差异即 5 个渐变 token 等复古专属结构 token——第 4 步 tokenKeys 快照测试应**按族**比较键集合，不能全量对齐。

---

## B. 用户可见文案

### B1（低）英文文案中的 em dash（—）×7

em dash 是典型 AI 文案指纹，建议改为冒号/句号/逗号：

| 位置                                     | 现文案（节选）                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `src/i18n/dictionaries/core.ts:164`      | 'Session is connected — disconnect before clearing credentials'             |
| `src/i18n/dictionaries/panels.ts:210`    | 'Receiving "{name}" via ZMODEM — progress in the transfer queue'            |
| `src/i18n/dictionaries/settings.ts:386`  | 'No custom themes yet — open the themes folder to add some.'                |
| `src/i18n/dictionaries/settings.ts:571`  | 'New version {version} found — download it from the releases page.'         |
| `src/i18n/dictionaries/settings.ts:595`  | 'No snippets yet — add one above.'                                          |
| `src/i18n/dictionaries/workspace.ts:367` | 'Macro recording started — keystrokes on the current terminal are captured' |
| `src/i18n/dictionaries/workspace.ts:373` | '{count} keystroke steps — replay into the current terminal'                |

### B2（低）省略号风格不一致

- `core.ts:11` `'ui.loading': '加载中...'`（三个点）vs `core.ts:70` `'正在重连会话…'`、`panels.ts:70/72` 等（单字符 …）。统一为 `…`。

### B3（排除/豁免）

- "unlock/unlocked/解锁"（`core.ts:95,198,201,209`、`settings.ts:173-195,471-493` 等）：凭据保险库的**真实功能术语**，非营销措辞，保留。
- elevate / seamless / revolutionize / supercharge / delve / effortless / game-changing / ✨ / 🚀：全仓（src）grep **零命中**。
- 空泛 hero 文案、三卡片特性网格：不适用——桌面工具应用，空状态文案（如 `app.workspaceHint`、`sidebar.empty`）均为可操作指引。
- 中英文案整体为专业工具口吻，信息密度合理。

---

## C. 面向用户产物中的开发者信息泄露

### C1（中）主题 schema 描述泄露仓库内部路径

- `src-tauri/src/themes/schema.json:49`：`structure` 字段 description 含 `"...they live in src/theme/layout-tokens.css and cannot be overridden."`。该 schema 随 `themes_list` 扫描**写出到用户主题文件夹**（供编辑器 `$schema` 补全），面向终端用户，仓库路径对其无意义且泄露内部结构。
- **建议**：改为面向用户表述，如 "Sizes, spacing, font weight and letter spacing are controlled by the app's layout and cannot be overridden in a theme."。注意：`extends` 枚举与 `structure` 键名被 Rust 单测钉死，只能改 description 措辞。

### C2（排除）

- `TODO/FIXME/HACK/XXX/AI generated/generated by/Copilot/ChatGPT`：src（除测试）grep **零命中**。
- 源码 WHY 注释（`XtermCanvas.tsx:130,166,1708,2148` 引用 microsoft/vscode#334532、xtermjs/xterm.js#6163 等）：不面向用户，是 AGENTS.md 要求保留的约束说明，**合法**。
- `schema.json:5` 提及 `%APPDATA%/com.boow6.nexterm/themes`：用户目录指引，面向用户，合法。

---

## D. AI 视觉指纹

| 检查项                | 结论                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 紫→蓝渐变             | **排除**。渐变均为复古族有意的 Web 2.0 造型（Office 蓝 `#5b9bd5`、Aqua 蓝、Holo 青），无紫色营销渐变。其"不跟随 accent"问题归 A1 |
| 占位渐变 Logo         | **排除**。`src-tauri/app-icon.svg` 为真实图标源，UI 无 logo 占位                                                                 |
| `hover:scale-105/110` | **1 处，豁免**：`SettingsWindow.tsx:1199` `hover:scale-110` 用于强调色色板圆点的选中反馈，功能性微交互，非装饰性放大             |
| emoji 功能图标        | **排除**。图标全部来自 lucide-react；src/components、src/windows、src/i18n 无 emoji（Unicode 范围 grep 零命中）                  |

---

## E. 仓库规范资产盘点

| 资产               | 状态                                                                                                                                                                                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token 单一来源     | **有**：`tokens.css`（颜色+结构，逐主题）、`layout-tokens.css`（字号/字重/字距/几何，唯一来源）、`skin-tokens.css` + `skins/*.css`（结构规则）、`accent.ts`（强调色派生）；`tailwind.config.js` 全量映射语义 token                                                                                  |
| 机器门禁测试       | **有**：`contrast.test.ts`（WCAG AA，解析 tokens.css）、`layoutTokens.test.ts`（禁任意值/主题覆盖布局键）、`skinRules.test.ts`、`terminalTheme.test.ts`（16 色板完整）、`themes.test.ts`、`accentReport.test.ts`（ACCENT_REPORT=1 手动）、`i18n/index.test.ts`（中英键位一致）、Rust 侧 schema 单测 |
| 令牌快照           | **无**：`accentVars()` 输出无回归快照；tokens.css 各主题键集合无断言（A5 指出复古/现代键数不同，正是需要按族快照的原因）                                                                                                                                                                            |
| 组件层颜色扫描门禁 | **无**：无禁止组件裸 hex/调色板类的测试（当前靠自觉，本次 grep 干净）                                                                                                                                                                                                                               |
| CI                 | **有**：`.github/workflows/ci.yml`（typecheck/lint/format/test/build + 三平台 Rust fmt/clippy/test + npm/cargo audit + tauri build）、`release.yml`                                                                                                                                                 |
| AGENTS.md          | **有**：根目录，含主题分层、accent 派生设计意图、xterm 性能规范、开发约定                                                                                                                                                                                                                           |
| Skill              | **无**：无 `.claude/`、`.qoder/` 或任何 skills 目录                                                                                                                                                                                                                                                 |

---

## 建议执行顺序

1. **A1 + A2**（高）：让复古族渐变 token 跟随强调色（或 gate UI），同步消除现代族渐变 hex 双份数据；附回归测试。这是"主色调不跟随"假设的实质命中点。
2. **C1**（中）：`schema.json:49` description 去仓库路径。改动极小，`cargo test` 验收。
3. **门禁补强**：新增组件层颜色扫描测试（把本次 A4 的干净状态固化）+ 按族 token 键集合快照 + accent 派生快照（覆盖 A1 修复后的 gradient 键）。
4. **B1 + B2**（低）：7 处 em dash 与省略号统一，`npx vitest run src/i18n` 验收。
5. **A3**（低）：TerminalPreview 任意值改 token 映射。
6. **Skill 沉淀**：把上述规则写入 `.claude/skills/theme-token-guard/SKILL.md`（目录约定需确认），AGENTS.md 加 ≤10 行指针。

## 不建议本次处理

- `themes.ts` / `terminalTheme.ts` / `accent.ts` 中的 hex 预设数据（token 单一来源本体，改了反而破坏体系）；
- 源码 WHY 注释与 GitHub issue 引用（AGENTS.md 明确要求保留）；
- `SettingsWindow.tsx:1199` 的 `hover:scale-110`（功能性选中反馈）；
- `SettingsWindow.tsx:1202` 内联 swatch 色（数据驱动预览）；
- 复古族 Web 2.0 渐变造型本身（只修"不跟随 accent"，不去渐变化——那是设计风格，AGENTS.md 记载为有意设计）；
- "unlock/解锁"等保险库术语（真实功能词汇）。

## 审计矩阵执行记录

| 检查手段                                                                        | 范围                                                                                                                                              | 命中                                     |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 裸 hex grep（排除 issue 引用）                                                  | components + windows, tsx/ts                                                                                                                      | 0                                        |
| `rgb()/hsl()` 字面量 grep                                                       | 同上                                                                                                                                              | 1（TerminalPreview，token 引用型任意值） |
| 内联 `style={{` 颜色 grep                                                       | 同上                                                                                                                                              | 2（均为豁免项 A4）                       |
| Tailwind 调色板类 grep（19 色族 × bg/text/border/ring/from/to/via/fill/stroke） | 同上                                                                                                                                              | 0                                        |
| 渐变定义与消费方追踪                                                            | tokens.css → tailwind.config.js → button.tsx / bg-panel-title 5 处 / skins                                                                        | A1/A2 证据链                             |
| 派生 token 覆盖统计（9 个关键 token）                                           | tokens.css                                                                                                                                        | 全部 14/14                               |
| em dash / AI 措辞 / emoji grep                                                  | i18n 五分片 + components                                                                                                                          | 7 / 0 / 0                                |
| TODO/FIXME/AI-generated grep                                                    | src（除测试）                                                                                                                                     | 0                                        |
| schema.json description 逐条通读                                                | src-tauri/src/themes/schema.json                                                                                                                  | 1（C1）                                  |
| accent 派生输出键分析                                                           | accent.ts:226-336                                                                                                                                 | 无 gradient 键（A1 根因）                |
| 规范资产盘点                                                                    | 根目录 / .github / src/theme/*.test.ts                                                                                                            | 见 E 表                                  |
| 未完成项                                                                        | 手动 GUI 走查（改强调色观察复古主题按钮）未执行——只读审计未起应用；A1 结论基于静态证据链，置信度高，修复时建议以 `npm run tauri dev` 实测复核一次 |
