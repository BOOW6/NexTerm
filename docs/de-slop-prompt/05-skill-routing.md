# 05 Skill 与 AGENTS 路由

## 角色

你是一名负责 Agent 工程规范的开发者体验工程师，熟悉 `AGENTS.md` 约定与 Agent Skill（SKILL.md）格式。

## 目标

把 de-slop 与主题 token 规范沉淀为仓库内可实时更新、可检查的 Skill，并在 `AGENTS.md` 留路由指针，使后续 Agent 会话自动遵守：

1. 新增 `.claude/skills/theme-token-guard/SKILL.md`（仓库当前**没有** `.claude/` 目录，属全新创建；若目标 Agent 工具使用别的约定目录如 `.qoder/skills/`，先向用户确认再定路径——标注"需确认"）；
2. `AGENTS.md` 追加 ≤10 行指针：在"开发约定"节加一条"主题/token/文案治理规则见 `.claude/skills/theme-token-guard/SKILL.md`"，正文规则不复制进 AGENTS.md（避免双份漂移）。

## 先计划、后修改

先输出 SKILL.md 的章节大纲与每条规则的"门禁对应物"（见下），经确认后再写文件。

## SKILL.md 必须包含的内容

每条规则都要对应一个**已存在的**机器门禁或可执行命令，不写无法验证的口号：

- **Token 分层**：`tokens.css`（颜色+结构 token，逐主题声明）→ `skin-tokens.css`（交互/骨架规则）→ `skins/<族>.css`（结构差异）→ `layout-tokens.css`（字号/字重/字距/几何，唯一来源，主题禁止覆盖）→ `accent.ts`（强调色派生）；
- **禁止事项**（各配门禁命令）：
  - 组件层裸 hex / rgb() / Tailwind 调色板类 → `src/theme/noHardcodedColors.test.ts`（第 2 步产物）
  - `text-[11px]` / `font-semibold` 等任意值 → `src/theme/layoutTokens.test.ts`
  - 主题块覆盖布局键 → `layoutTokens.test.ts` + Rust 扫描器（"is layout, not theme"）
  - 对比度回归 → `src/theme/contrast.test.ts`
  - token 键漂移 → `src/theme/tokenKeys.test.ts`（第 4 步产物）
  - accent 派生回归 → `src/theme/accentSnapshot.test.ts`（第 4 步产物）
  - 中英键位不一致 → `src/i18n/index.test.ts`
  - 面向用户产物含仓库内部路径 → `grep -n "src/" src-tauri/src/themes/schema.json` 应无命中
- **标准流程**：新增主题（tokens.css 块 → themes.ts 注册 → skins → i18n → 对比度测试 → 截图，见 AGENTS.md）；新增设置项（store 字段 → 面板控件 → 使用处读取）；改强调色派生（先读 accent.ts 头注释，附失败测试先行）；
- **验收总命令**：`npm run check`、`npm run format:check`，Rust 侧 `cargo fmt --check` / `cargo clippy --all-targets -- -D warnings` / `cargo test`（在 `src-tauri/`）。

## 输入文件

- `AGENTS.md`（现有规范正文，Skill 的规则来源；注意其"主题质量门禁""Token + 皮肤分层""开发约定"节）
- 第 1-4 步的全部产出（审计报告、新测试文件名以实际落地为准）
- `src/theme/*.test.ts` 现有测试清单（写门禁命令前逐个确认存在）
- `package.json` scripts（命令必须与之一致，禁止编造）

## 允许修改范围

- 新增 `.claude/skills/theme-token-guard/SKILL.md`（或确认后的其它路径）；
- `AGENTS.md`：仅追加指针条目，≤10 行，不重写既有内容。

## 禁止事项

- 禁止把 AGENTS.md 既有规则正文搬进 Skill（只留指针与增量操作细节，单一事实来源仍在 AGENTS.md 与测试代码）；
- 禁止在 Skill 中引用不存在的测试文件、脚本或命令——写入前逐条核实（第 2/4 步产物以其实际文件名为准）；
- 禁止修改任何业务代码与测试；
- 禁止改动 AGENTS.md 中"不要重新启用 React StrictMode"等既有条目。

## 输出格式

1. 大纲 + 规则↔门禁对应表（计划阶段）；
2. `SKILL.md` 全文与 `AGENTS.md` 的 diff；
3. 变更摘要：Skill 路径、规则条数、AGENTS.md 增加行数。

## 验收命令

```bash
test -s .claude/skills/theme-token-guard/SKILL.md   # 路径按最终确认结果调整
git diff --stat AGENTS.md                            # 增加行数 ≤ 10
npm run format:check                                 # prettier 覆盖 md（lint-staged 同款）
# SKILL.md 中每条命令逐一手抄执行一次，全部存在且可运行（测试命令允许红，命令本身必须存在）
```

## 失败时如何处理

- `format:check` 对 md 报格式问题：运行 `npx prettier --write` 修复对应文件后重查；
- 某规则找不到对应门禁：要么降级为"人工检查项"并明确标注，要么先补门禁（回到第 2/4 步范围）再写入，禁止写成无法验证的断言；
- Skill 目录约定不确定（`.claude/skills` vs `.qoder` vs 其它）：停下来问用户，不要两个目录都建；
- AGENTS.md 指针与既有条目冲突/重复：合并进既有条目而非新增段落。
