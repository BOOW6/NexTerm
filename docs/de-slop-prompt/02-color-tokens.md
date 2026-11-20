# 02 颜色 Token 治理

## 角色

你是一名负责设计系统治理的前端工程师，熟悉 CSS Variables + Tailwind token 映射与 vitest 静态扫描测试。

## 目标

1. 修复 `docs/de-slop-audit.md`（第 1 步产出）中确认的全部颜色硬编码违规：组件层改用 `hsl(var(--token))` 体系或 Tailwind 语义类（`bg-accent`、`text-muted-foreground` 等，映射见 `tailwind.config.js`）；
2. 验证强调色全链路跟随：改 `themeAccent` 后 accent 梯度、focus-ring、链接、success/warning/error、终端光标与 ANSI 2-6 槽均由 `src/theme/accent.ts` 派生生效；
3. 新增一个机器门禁测试，禁止 `src/components/**` 与 `src/windows/**` 再引入裸 hex / `rgb()` / Tailwind 调色板类 / 内联 color 样式（参考 `src/theme/layoutTokens.test.ts` 的静态扫描写法）。

## 先计划、后修改

动手前先输出计划：每条审计发现 → 对应改哪个文件哪一行 → 用哪个 token 替换 → 如何验证。计划中若发现某条应归入豁免（见审计报告"合法豁免"节），标注后跳过。计划先行，未列出的文件不得修改。

## 输入文件

- `docs/de-slop-audit.md`（工作清单）
- `AGENTS.md` —— "Token + 皮肤分层（P5-1）"与"强调色自定义"两节是本次改动的宪法，改 accent 相关代码前必读
- `tailwind.config.js`（token → 工具类映射）
- `src/theme/tokens.css`、`skin-tokens.css`、`layout-tokens.css`、`accent.ts`、`ThemeProvider.tsx`
- `src/theme/layoutTokens.test.ts`（扫描测试的既有范式）
- 审计指出的违规组件文件

## 允许修改范围

- 审计报告中"确认"的组件/窗口文件（改为 token 引用）；
- 新增一个测试文件 `src/theme/noHardcodedColors.test.ts`；
- **仅当**审计报告或手动验证确认 accent 派生存在真实 bug 时，才可改 `src/theme/accent.ts` / `ThemeProvider.tsx`，且必须附带能复现该 bug 的失败测试先行。

## 禁止事项

- 禁止修改 `tokens.css` 中任何主题的颜色值（那是调色，不是治理）；
- 禁止在组件里新增 Tailwind 任意值（`text-[11px]`、`bg-[#...]`）；
- 禁止改动 accent 的"色相偏移"设计（语义色跟随强调色移动色相是特性）；
- 禁止改布局 token（字号/字重/字距/标签几何归 `layout-tokens.css`，主题不得覆盖）；
- 禁止修改豁免清单文件（`themes.ts`、`terminalTheme.ts`、`accent.ts` 的预设 hex、测试文件）；
- 禁止顺手重构无关代码。

## 输出格式

1. 计划（markdown 列表，改动前输出）；
2. 代码改动（逐文件小步提交粒度）;
3. 完成后输出变更摘要：每条审计发现 → 处置（已修复 / 豁免 / 需人工裁决）→ 涉及文件:行号。

## 验收命令

```bash
npm run check                                   # typecheck + lint + 全量 vitest
npx vitest run src/theme/noHardcodedColors.test.ts
npx vitest run src/theme/contrast.test.ts       # WCAG AA 不回归
ACCENT_REPORT=1 npx vitest run src/theme/accentReport.test.ts   # 派生数值人工过目
```

手动验证（需确认：在 Windows 上运行 `npm run tauri dev` 或 `npm run dev`）：设置 > 外观改强调色为一个高饱和色与一个中性灰预设，观察按钮、链接、focus-ring、状态色、终端光标是否全部跟随。

## 失败时如何处理

- `contrast.test.ts` 失败：说明替换的 token 对比度不达标，换语义正确的 token 而不是放宽测试；
- 新扫描测试把合法代码报违规：给测试加**显式命名的豁免列表**（文件路径级，带一行理由注释），禁止全局放宽正则；
- accent 派生行为与预期不符但不确定是 bug：停下来，在变更摘要中标注"需人工裁决 + 复现步骤"，不要改 `accent.ts`；
- `npm run check` 中与本步骤无关的既有失败：记录并上报，不要顺手修。
