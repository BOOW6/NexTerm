# 04 令牌快照与 CI

## 角色

你是一名负责回归测试基建的前端工程师，熟悉 vitest 快照测试与 GitHub Actions。

## 目标

把主题派生结果固化为可回归的机器门禁，防止未来改动悄悄破坏 token 体系：

1. 新增 `src/theme/accentSnapshot.test.ts`：对固定 accent 输入（至少：一个高饱和 hex、一个中性灰预设、空/未设置）× 代表性基底主题（至少 `slate-light`、`slate-dark`，复用 `accentReport.test.ts` 里从 `tokens.css` 解析基底 triplet 的 `block()` 手法），快照 `accentVars()` 返回的 CSS 变量集；
2. 新增 `src/theme/tokenKeys.test.ts`：断言 `tokens.css` 中**每个** `[data-theme]` 块的自定义属性键集合与基准主题一致（防漏键/多键/拼写漂移），与 `contrast.test.ts`（管对比度）互补；
3. 确认 `.github/workflows/ci.yml` 的 `npm run test:run` 已自动覆盖新测试（预期**无需改 workflow**；若确需改动，先说明理由并标注"需确认"）。

## 先计划、后修改

先输出计划：每个测试文件 → 测什么 → 快照粒度（键集合 / 代表性数值 / 全量数值）→ 预期失败场景。快照粒度原则：**锁键集合 + 代表性数值**，不逐变量锁死全部 14 主题的全部变量（否则每次有意调色都变成维护负担）。

## 输入文件

- `src/theme/accent.ts`（`accentVars` 签名与返回结构）
- `src/theme/accentReport.test.ts`（`block()` 解析 `tokens.css` 的既有范式，直接复用）
- `src/theme/tokens.css`（14 个 `[data-theme]` 块）
- `src/theme/contrast.test.ts`（避免与其职责重叠）
- `.github/workflows/ci.yml`（只读确认）

## 允许修改范围

- 新增上述两个测试文件（命名如与现有文件冲突可调整，但须在 `src/theme/` 下）；
- `.github/workflows/ci.yml`：默认不改。

## 禁止事项

- 禁止修改 `accent.ts`、`tokens.css` 或任何业务代码——本步骤只加测试；若测试揭示派生 bug，停下来上报，不要顺手修；
- 禁止用 `expect.any()` 之类把快照放宽到无意义；
- 禁止引入新依赖（vitest 自带 snapshot 能力）；
- 禁止在 CI 增加新 step 来跑这两个测试（`npm run test:run` 已覆盖 `src/**/*.test.ts`）。

## 输出格式

1. 测试计划（文件 → 用例列表 → 快照粒度）；
2. 代码；
3. 变更摘要 + 一次"故意破坏"验证记录：临时改 `accent.ts` 中一个派生系数（或 `tokens.css` 中一个键名），确认对应快照/键集合测试**变红**，然后 `git checkout` 还原该文件并确认变绿。此验证必须做，结果写入摘要。

## 验收命令

```bash
npx vitest run src/theme/accentSnapshot.test.ts src/theme/tokenKeys.test.ts
npm run test:run     # 全量，确认无既有用例被新快照干扰
npm run check
```

CI 覆盖确认（只读）：`ci.yml` frontend job 含 `npm run test:run`，新测试自动纳入。

## 失败时如何处理

- 快照在不同机器/Node 版本下不稳定（如浮点舍入）：在 `accent.ts` 输出层面无需改动，测试内对数值做显式 `Math.round` 后断言；仍不稳定则改为区间断言并记录原因；
- `tokenKeys.test.ts` 发现既有主题真的漏键：这是审计发现，**上报**并等待裁决（补键属于改 `tokens.css`，超出本步骤范围）；
- "故意破坏"验证中测试没有变红：说明快照没测到点子上，重写断言而不是接受；
- 全量 `npm run test:run` 出现与本步骤无关的失败：记录上报，不顺手修。
