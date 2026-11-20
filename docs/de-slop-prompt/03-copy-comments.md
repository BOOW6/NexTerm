# 03 文案与注释清理

## 角色

你是一名负责产品文案与开发者体验的工程师，中文母语、英文流利，熟悉 i18n 字典结构与 JSON Schema 写作。

## 目标

1. 通读 `src/i18n/dictionaries/` 五分片的中英全量文案，修正 AI 演示风（浮夸形容词、翻译腔、空洞副标题）、中英语气不一致、标点混用（中文文案用全角、英文用半角）；
2. 清理**面向用户产物**中的开发者信息：`src-tauri/src/themes/schema.json` 全部 `description` 字段逐条通读，去掉仓库内部路径（已知第 49 行含 `src/theme/layout-tokens.css`），改为面向终端用户的表述；同法排查审计报告指出的其它用户可见字符串（导出备份、错误提示、tooltip）；
3. 源码内 WHY 注释（GitHub issue 引用、非显而易见约束）**保留不动**；只删纯复述代码的 WHAT 注释——且仅限审计报告点名的文件。

## 先计划、后修改

先输出计划：(a) 五分片各自通读后拟改动的键列表（键名 + 现文案 + 拟改文案）；(b) schema.json 拟改的 description 字段列表。计划未列出的键不得修改。改文案是主观操作，计划本身就是评审材料。

## 输入文件

- `docs/de-slop-audit.md`（假设 2、3 的发现）
- `src/i18n/dictionaries/{core,panels,settings,terminal,workspace}.ts`、`src/i18n/index.ts`、`types.ts`
- `src-tauri/src/themes/schema.json`、`src-tauri/src/themes/mod.rs`（了解 schema 如何写出到用户主题文件夹）
- `src/i18n/index.test.ts`（中英键位一致性门禁）
- Rust 侧钉死 schema 的单测（在 `src-tauri/src/themes/mod.rs` 的 `#[cfg(test)]` 内，改前先读）

## 允许修改范围

- 五份 i18n 分片中**字符串值**的措辞；
- `schema.json` 的 `description` 字段文字；
- 审计报告点名的组件文件中的 WHAT 注释删除。

## 禁止事项

- 禁止增删或重命名任何 i18n **键**（会破坏中英一致测试与组件引用）；
- 禁止改动占位符（`{count}`、`{name}` 等）与转义字符；
- 禁止改 `schema.json` 的结构：`extends` 枚举、`structure` 键名、`$schema`、字段名均被 Rust 单测钉死，只能改 description 措辞；
- 禁止删除解释"为什么"的注释（issue 引用、约束说明、workaround）；
- 禁止改技术术语的既有译法（会话/片段/跳板机/断点续传等以 AGENTS.md 与现有字典为准）；
- 禁止引入 emoji。

## 输出格式

1. 改动计划表（键名 / 字段路径 → 原文 → 新文 → 理由，一行一条）；
2. 代码改动；
3. 变更摘要：改动键数、schema description 改动数、删除注释数（按文件统计）。

## 验收命令

```bash
npx vitest run src/i18n          # 中英键位一致性
npm run check                    # 全量前端门禁
cd src-tauri && cargo test       # schema 单测（枚举/键未动）
grep -n "src/" src-tauri/src/themes/schema.json   # 不应再命中仓库内部路径
```

（`cargo test` 需在 `src-tauri/` 下运行，环境准备见 `doc/build.md`。）

## 失败时如何处理

- i18n 测试失败：多半是误动了键名或占位符，回滚该条重改，禁止改测试；
- `cargo test` 失败：说明动了 schema 结构，`git diff src-tauri/src/themes/schema.json` 检查，只保留 description 内的文字改动；
- 拿不准某条文案算不算"AI 风"：保守保留，记入变更摘要"存疑"节交人工裁决；
- 中英语气冲突（中文简洁、英文冗长）：以中文信息量为基准对齐英文，不反向扩写中文。
