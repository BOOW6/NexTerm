# 06 最终验收

## 角色

你是一名发布把关人（release gatekeeper），只运行验证与走查，不做功能性改动。

## 目标

对第 1-5 步的全部产出做全量回归与人工走查，确认：无回归、审计清单每条"确认"项都已闭环（修复或"有意保留"结论）、无残留 slop。产出一份验收报告。

## 先计划、后执行

先列出验收矩阵（命令项 × 走查项 × 闭环核对项），逐项打勾，禁止凭前几步的记忆跳过任何一项。

## 输入文件

- `docs/de-slop-audit.md`（逐条核对闭环）
- 第 2-5 步的变更摘要与 `git log` / `git diff main...HEAD`（如分支执行）
- `AGENTS.md`（走查依据：14 款主题、明暗、accent 预设、自定义主题流程）

## 允许修改范围

- 新增 `docs/de-slop-verification.md`（验收报告）；
- **仅当**验收发现前几步引入的小问题（格式、漏改一处 token）时可做最小修复，并在报告中记录；超出最小修复范围的问题一律记为"未闭环"退回对应步骤，不得自行大改。

## 禁止事项

- 禁止新增功能、重构或"顺手"改动；
- 禁止放宽任何测试来让验收通过；
- 禁止在验收未全绿时宣布完成。

## 验收命令（全部为仓库既有命令）

```bash
# 前端全量
npm run check            # typecheck + lint + vitest 全量
npm run format:check
npm run build            # tsc + vite build

# Rust 全量（在 src-tauri/ 下；环境准备见 doc/build.md）
cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test

# 新增门禁点名复跑
cd ..
npx vitest run src/theme   # contrast / layoutTokens / skinRules / terminalTheme / accentSnapshot / tokenKeys / noHardcodedColors（以实际落地文件名为准）
npx vitest run src/i18n
grep -n "src/" src-tauri/src/themes/schema.json   # 应无命中
```

## 人工走查清单

运行 `npm run dev`（浏览器走查；涉及终端 WebGL/PTY 的项需 `npm run tauri dev`，在 Windows 上耗时较长——若降级为浏览器走查，须在报告中**明确标注哪些项未经原生验证**）：

1. 切换 14 款主题 × 明亮/暗黑/跟随系统，无布局错位、无半主题未跟随的割裂色；
2. 设置 > 外观：改强调色为高饱和色 → 按钮/链接/focus-ring/状态色/终端光标/ANSI 2-6 槽跟随；换中性灰预设 → 底色/边框/文字同步中性化；清空 → 恢复主题自带色；
3. 自定义主题 drop-in：向主题文件夹放一个最小 JSON（用设置里的"打开主题文件夹"入口），确认热重载生效、schema 的 description 面向用户无仓库路径；
4. i18n 中英切换走查主要面板（会话侧栏、设置、SFTP、命令面板），文案口吻一致、占位符渲染正常；
5. 终端 resize 冒烟：拖拽分屏改宽度，无重影/丢行（验证第 2 步改动未触碰 resize 管线；如未改过终端文件可标注"不适用"）。

## 闭环核对

对 `docs/de-slop-audit.md` 每条发现，在报告中标注：已修复（对应提交/文件）/ 豁免（理由）/ 有意保留（裁决人）/ **未闭环**（退回第几步）。存在"未闭环"时验收结论只能是"不通过"。

## 输出格式

写入 `docs/de-slop-verification.md`：

```markdown
# De-Slop 验收报告（日期）

## 结论：通过 / 不通过（列出未闭环项）

## 命令矩阵（命令 → 结果 → 耗时/备注）

## 走查矩阵（项 → 已验证方式：原生/浏览器/不适用 → 结果）

## 审计闭环表（发现# → 处置 → 证据）

## 最小修复记录（若有）

## 遗留风险与建议
```

## 失败时如何处理

- 命令失败且原因是前几步引入：定位到步骤，做最小修复或退回，报告中记录根因；
- 命令失败且是既有问题（`git stash` 后在干净树上复现确认）：记入"遗留风险"，不阻塞本次验收结论，但要写明复现方式；
- 走查项在浏览器环境无法验证（WebGL、PTY、托盘）：标注"未经原生验证"并列出，不得默认通过；
- 发现新的 slop（前几步漏网）：记入报告"遗留风险"并建议回到第 1 步补审计，本次不扩大范围。
