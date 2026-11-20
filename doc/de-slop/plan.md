# NexTerm De-Slop 与主题治理计划

> 生成日期：2026-11-20。基于只读探索，未修改任何业务代码。
> 配套分步提示词见 [`doc/de-slop-prompt/`](../de-slop-prompt/)，供编码 Agent 逐步执行。
> **状态：六步已全部实施并验收（5/5 通过），见 [`verify.md`](./verify.md)；阶段 5 迁移裁定 NO-GO，见 [`accent-colormix-report.md`](./accent-colormix-report.md)。**

## 探索结论（审计基线）

仓库治理程度**高于预期**，三个"已知问题"目前是假设，必须以证据确认或排除：

1. **主色调跟随**：派生体系已存在且已接线——`src/theme/accent.ts`（406 行，从单一 hex 派生 accent 梯度、语义色、终端 16 色、中性化）由 `src/theme/ThemeProvider.tsx:106-125` 在基底主题之后应用。组件层 grep 未发现 Tailwind 调色板类（`bg-blue-500` 等）、内联 color 样式或 `rgba()` 硬编码。合法 hex 只出现在数据文件：`src/theme/themes.ts`（swatches/预设）、`src/theme/terminalTheme.ts`（16 色板）、`src/theme/accent.ts` 预设。
2. **AI 演示风文案**：`src/i18n/dictionaries/`（core/panels/settings/terminal/workspace 五分片）抽样为专业口吻；`seamless/effortless/supercharge/🚀` 等模式全仓 grep 无命中。需人工通读双语全量确认。
3. **开发者注释泄露**：源码注释（如 `XtermCanvas.tsx` 引用 GitHub issue 编号）不面向用户，属合法 WHY 注释。**确认的泄露点**：`src-tauri/src/themes/schema.json:49` 的 `description` 含仓库内部路径 `src/theme/layout-tokens.css`，该文件随 `themes_list` 扫描写出到**用户主题文件夹**，面向终端用户。需排查是否还有同类。
4. **规范沉淀**：`AGENTS.md`（根目录）已含大量主题/布局 token 规范；探索时无 Skill 目录（现已建立 `.agents/skills/deslop-ui`）。既有机器可查门禁：`contrast.test.ts`（WCAG AA）、`layoutTokens.test.ts`（禁 `text-[11px]` 等）、`terminalTheme.test.ts`、`skinRules.test.ts`、`themes.test.ts`、`accentReport.test.ts`（ACCENT_REPORT=1 手动报告）、i18n `index.test.ts`（中英键位一致）。

## 可复用的验收命令（全部已存在，勿编造新命令）

- `npm run typecheck` / `npm run lint` / `npm run format:check`
- `npm run test:run`（vitest，全量）；单文件：`npx vitest run src/theme/contrast.test.ts`
- `npm run check`（typecheck + lint + test:run）
- Rust：`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test`（工作目录 `src-tauri/`）
- CI：`.github/workflows/ci.yml` 已跑 `npm run test:run`，新增 vitest 测试自动纳入，无需改 workflow

---

## 第 1 步：审计（01-audit.md）

- **目标**：把三个假设变成带文件/行号证据的清单；只读，不改任何文件。
- **涉及文件**：`src/theme/`（tokens.css、accent.ts、themes.ts、terminalTheme.ts、ThemeProvider.tsx、skin-tokens.css、skins/）、`src/components/**`、`src/windows/**`、`src/i18n/dictionaries/*`、`src-tauri/src/themes/schema.json`、`tailwind.config.js`、`AGENTS.md`。
- **验收标准**：产出 `doc/de-slop/audit.md`，每条发现含 路径:行号、类别（颜色硬编码 / 文案 / 注释泄露 / 规范缺口）、严重度、建议处置；明确"确认/排除"三个假设；无发现也要写明检查过什么、用什么命令。
- **风险**：审计者把合法数据文件（themes.ts 的 hex 色板）误报为 slop——提示词中要写明豁免清单。

## 第 2 步：颜色 token 治理（02-color-tokens.md）

- **目标**：修复第 1 步确认的颜色硬编码；验证 accent 自定义在 UI 全链路生效（按钮/链接/focus-ring/终端光标/语义色）；**新增机器门禁**：一个扫描测试，禁止 `src/components/**` 与 `src/windows/**` 出现裸 hex / `rgb()` / Tailwind 调色板类 / 内联 color 样式（豁免经审计确认的合法处）。
- **涉及文件**：审计清单中的违规文件；`src/theme/accent.ts`、`src/theme/ThemeProvider.tsx`（仅当发现派生 bug）；新增 `src/theme/noHardcodedColors.test.ts`（名称可在执行时定，需确认与现有测试不冲突）。
- **验收标准**：新扫描测试通过且 `npm run check` 全绿；`ACCENT_REPORT=1 npx vitest run src/theme/accentReport.test.ts` 输出正常；`contrast.test.ts` 通过；手动验证：设置 > 外观改强调色后，链接、focus-ring、终端 ANSI 2-6 槽同步变色。
- **风险**：误伤合法数据文件导致测试脆弱；把 accent 派生的"色相偏移"当 bug 改坏（AGENTS.md 已写明设计意图，改动前必读）。

## 第 3 步：文案与注释清理（03-copy-comments.md）

- **目标**：(a) 通读五份 i18n 分片的中英全量，修正 AI 演示风/翻译腔/不一致标点；(b) 清理**面向用户产物**中的开发者信息：`src-tauri/src/themes/schema.json` 的 description 去仓库路径（改为面向用户的表述），排查导出 JSON 备份、错误提示等其它用户可见字符串；(c) 源码内 WHY 注释（GitHub issue 引用等）**保留**，只删无信息量的 WHAT 注释。
- **涉及文件**：`src/i18n/dictionaries/{core,panels,settings,terminal,workspace}.ts`、`src-tauri/src/themes/schema.json`、`src-tauri/src/themes/mod.rs`（若 schema 写出逻辑相关）、审计清单指出的组件。
- **验收标准**：`npx vitest run src/i18n` 通过（中英键位一致）；`cargo test` 通过（schema 有 Rust 单测钉死枚举/键）；grep `src-tauri/src/themes/schema.json` 不再含 `src/` 路径；文案变更列表人工复核。
- **风险**：schema.json 的 `extends` 枚举与 `structure` 键被单测钉死，只能改 description 措辞不能动结构；i18n 改动可能破坏 `{count}` 等占位符——提示词要求占位符原样保留。

## 第 4 步：令牌快照与 CI（04-token-ci.md）

- **目标**：把派生结果固化为可回归的快照：(a) 新增 vitest 测试，对固定 accent 输入 + 每个内置基底主题，快照 `accentVars()` 输出的 CSS 变量集（vitest snapshot 或内联期望值）；(b) 快照 `tokens.css` 中每主题的 token 键集合（防漏键/多键），与 `contrast.test.ts` 互补；(c) 确认 `ci.yml` 的 `npm run test:run` 已覆盖新测试（应无需改 workflow）。
- **涉及文件**：新增 `src/theme/accentSnapshot.test.ts`、`src/theme/tokenKeys.test.ts`（命名执行时定）；`.github/workflows/ci.yml`（原则上只读确认）。
- **验收标准**：`npm run test:run` 全绿；故意改一个 accent 派生系数能让快照测试失败（执行时验证一次再还原）；CI 无需新命令（若需要，标注"需确认"并说明理由）。
- **风险**：快照过细会把有意的调色改动变成维护负担——快照粒度定在"变量键集合 + 代表性数值"，不逐变量锁死全部 14 主题。

## 第 5 步：Skill 与 AGENTS 路由（05-skill-routing.md）

- **目标**：把 de-slop/主题 token 规范沉淀为仓库内可更新的 Skill，并在 `AGENTS.md` 加路由指针，使后续 Agent 会话自动遵守。**已落地**：`.agents/skills/deslop-ui/SKILL.md`（目录约定已确认为 `.agents/skills/`，宿主实时注册），内容：token 分层（tokens.css / derived-tokens.css / skin-tokens.css / layout-tokens.css / accent.ts）、禁止事项（裸 hex、`text-[11px]`、主题覆盖布局键、组件内 Tailwind 调色板类）、门禁命令清单（ds:lint / ds:tokens:check / check）、审计简表（clean / flagged / 有意保留）。`AGENTS.md` "开发约定"节追加 12 条不可协商边界与加载路由。
- **涉及文件**：`.agents/skills/deslop-ui/SKILL.md`（新增）、`AGENTS.md`（追加指针，不重写）。
- **验收标准**：SKILL.md 中每条规则都能对应到一个已存在的机器门禁或可执行命令；`AGENTS.md` 变更 ≤ 10 行；`npm run format:check` 对 md 通过（lint-staged 会 prettier md）。
- **风险**：Skill 与 AGENTS.md 内容重复漂移——规则正文只放 Skill 与 `scripts/ds-lint.mjs`，AGENTS.md 只留边界与指针。目录约定已确认为 `.agents/skills/`（宿主实时注册验证通过）。

## 第 6 步：最终验收（06-verify.md）

- **目标**：全量回归 + 人工走查，确认无回归、无残留 slop。
- **涉及文件**：无新增；只运行命令与人工检查。
- **验收标准**：`npm run check`、`npm run format:check`、`npm run build` 全绿；`src-tauri/` 下 `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test` 全绿；手动走查：切换 14 款主题 × 明暗、改强调色（含中性化预设）、自定义主题 drop-in 一个 JSON 验证 schema 描述面向用户；审计清单中每条"确认"项都有对应修复或"有意保留"结论。
- **风险**：`npm run build` 含 `tsc`，前面步骤的类型错误会在此暴露——属预期门禁；手动走查在 Windows 上依赖 `npm run tauri dev`（耗时），可降级为 `npm run dev` 浏览器走查 + 标注终端 WebGL 相关项未验证。
