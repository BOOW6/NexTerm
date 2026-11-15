# P5 现代风格主题：方案（已实施）

> 状态：**已实施**（P5-1 … P5-7 各批次均以独立提交落地，未推送远端）。
> 实际实现与本文的两处偏差已记在 §9。视觉对照见 [`doc/themes/`](themes/README.md)。

## 1. 现状诊断

内置主题共 3 族 6 款（`src/theme/themes.ts`、`src/theme/tokens.css`）：

| 族      | 亮           | 暗          | 风格锚点                                                     |
| ------- | ------------ | ----------- | ------------------------------------------------------------ |
| Day/Dim | `day`        | `dim`       | 2008–2012 Web 2.0 后台（圆角 3px + 全像素渐变 + 1px 内阴影） |
| Aqua    | `aqua-light` | `aqua-dark` | Mac OS X 10.6 玻璃（高光在 45–55% 处的胶囊渐变）             |
| Holo    | `holo-light` | `holo-dark` | Android 4.4 扁平高对比（0 圆角、0 阴影、2px 强调线）         |

三族全部是 **"拟物复古"** 语汇，**一款现代风格都没有**。具体缺口：

1. **没有任何现代桌面软件语汇**：没有"表面分层 + 柔和投影 + 适中圆角 + 低饱和中性色 + 克制的强调色"这一套，而这是过去五年主流开发工具（VS Code Dark Modern、GitHub Primer、Linear、Raycast、Windows 11 / macOS Sonoma）的共同骨架。
2. **没有"跟随终端配色"**：主题与 xterm 配色是两套独立设置，切到 Nord 终端仍配着蓝色的 UI 外壳，视觉断裂。现代终端用户（尤其是 Linux/macOS 背景）普遍按 scheme 选 UI。
3. **强调色被硬编码**：所有主题同一种蓝。现代风格的标志之一是"同一套中性灰 + 可切换强调色"。
4. **"跟随系统"只跟随明暗**：Windows 的强调色 / 深浅界面偏好没有被利用。
5. **风格差异叠加在结构上而非 token 上**：Holo 的差异（扁平 action bar、下划线 tab、列表分隔线）靠 `index.css` 里 100 多行 `:root[data-theme^='holo']` 特异性补丁实现。再加现代族若照抄这个办法，会再叠加一层补丁，风格间开始互相踩踏。
6. **自定义主题只能改颜色**：主题文件只能覆盖 29 个 `colors` 键 + `terminal` 段，圆角、阴影、密度都改不了，所以外部也没法贡献现代主题。

## 2. 设计目标（验收标准）

一款新主题必须同时满足：

1. **目的可一句话说清**：目标人群、使用场景、解决的痛点，一句话能讲完（见 §4 每款的"目的"）。
2. **风格有明确锚点**：有可指名的参照系，不是"好看一点"。
3. **成对交付**：亮 / 暗各一款，同一族共享结构语言（圆角族、阴影层级、边框观感），只有明度反转。
4. **只动 token + 一套皮肤 CSS**：不修改任何组件结构、不改 Tailwind 语义类名。
5. **对比度达标**：正文 ≥ 4.5:1，大字号/图标/边框 ≥ 3:1（自动测试校验，见 §6）。
6. **终端跟随**：族内提供匹配的 xterm 16 色板，默认 `follow theme`，开箱即协调。
7. **性能无损**：不引入 blur/backdrop-filter/大面积动效，终端 WebGL 渲染路径不受影响。

## 3. 技术方案（前置改造，与主题内容同批交付）

### 3.1 Token 扩展：把"风格"从结构里解放出来

在 `tokens.css` 已有的颜色/圆角/阴影/渐变之外，**新增一层结构与质感 token**，组件侧零改动即可吃到最后两行效果：

| 新增 token                           | 作用                                                        | 谁消费                     |
| ------------------------------------ | ----------------------------------------------------------- | -------------------------- |
| `--surface-hover-alpha`              | 悬停时用"前景色叠加 alpha"而不是实色，深色下更柔和          | 新增工具类 `bg-hover` 等   |
| `--header-align` / `--header-weight` | 标题栏文字位置与字重（现代=高字重 + 略缩字距）              | `.app-panel-header` 等皮肤 |
| `--hairline`                         | 分隔线粗细（现代=1px 半透明，复古=1px 实色，Holo=0 靠色块） | 皮肤 CSS                   |
| `--elevation-1/2/3`                  | 三层投影，统一"浮起高度"语义（替代当前 panel/popup 两档）   | 弹窗、菜单、toast          |
| `--density-row` / `--density-tab`    | 行高 / 标签高度，允许"紧凑"档位                             | dockview `--dv-*`、列表    |
| `--accent-rgb`（三元组）             | 允许 `rgb(var(--accent-rgb) / .12)` 写半透明强调色          | 选中态、聚焦圈             |

### 3.2 皮肤层（skin layer）

新建 `src/theme/skins/`，每个族一个 `*.css`，统一通过 `:root[data-theme^='<family>']` 作用。内容只有"结构差异"：action bar 分隔、tab 下划线 / 药丸 / 卡片、列表行圆角、分组标题样式。

同时把 `index.css` 里现有的 Holo 补丁**迁入 `skins/holo.css`**（行为不变，纯搬迁 + 回归截图对比），避免 index.css 继续膨胀。`ThemeProvider` 每个族设置 `data-theme-skin="<family>"` 供皮肤层使用（与 `data-theme` 解耦，便于未来"同族不同密度"）。

### 3.3 强调色（accent override）

主题定义新增可选 `accentSet: { light: string; dark: string }[]`，设置面板在主题下方出现色板点选。实现为在根节点额外写入 `--accent / --accent-strong / --accent-soft / --focus-ring / --link`（沿用 `applyCustomThemeVars` 的 hex→HSL 三元组换算路，**不新增换算逻辑**）。存储在 `settingsStore` 的 `themeAccent: string | null`，与主题解耦——切主题不丢强调色偏好，切到没有色板的复古主题时该项自动置灰（不影响已存值）。

### 3.4 终端跟随

每族内置 xterm `ITheme`（16 色 + bg/fg/cursor/selection），在 `terminalColorSchemes.ts` 以 `follow` 语义注册：当用户终端配色为默认 `theme`（"跟随 UI"）时，若当前 UI 主题属于"自带终端板"的族，直接使用该族板；否则保持现有"从 CSS 变量派生"的行为（复古族不变）。

### 3.5 主题文件能力升级（让现代主题可以被外部复制）

`themes.ts` 的 `extends` 白名单同步加入新族 id（后端 `BUILTIN_THEMES` 常量 + `schema.json`）。**同时把圆角 / 阴影 / 渐变 / 终端板纳入主题文件 schema**（`radii`、`elevation`、`gradients` 可选段），这样：

- 新一代内置主题与外部主题走**同一条代码路径**，内置不享有特权实现；
- 社区可以直接 fork 我们的现代主题改色发布。

> 说明：这是本方案里唯一触及 Rust 后端的改动（`src-tauri/src/themes/mod.rs` 的 schema 与校验），且有现成单测结构可扩展。

## 4. 新增主题：4 族 8 款

### A. Slate — "现代开发工具基线"（亮 / 暗）

- **目的**：当前产品主要运行在 Windows + 终端/远程运维场景，用户一天 8 小时盯屏。现有 Dim 的深蓝底 + 全像素渐变在长时间使用下偏"网页"，与现代编辑器/IDE 并排时割裂。Slate 提供 **VS Code Dark Modern / GitHub Primer 那一档**的中性、低疲劳外观：把视觉噪音降到最低，让终端内容是唯一的焦点。
- **风格锚点**：VS Code `Dark Modern` / `Light Modern`、GitHub Primer。
- **关键特征**：中性灰（暗 `#1f2328` 系 / 亮 `#ffffff` + `#f6f8fa`）；1px 半透明 hairline 代替实色边框；圆角 6px / 4px 两档；三层柔和投影；单强调色（默认蓝 `#3b82f6`）；面板标题无渐变、只用字重 + 色阶区分。
- **色板**：中性 + 一种冷蓝强调；状态色低饱和（红 `#f85149` / 绿 `#3fb950` / 黄 `#d29922`）。
- **终端板**：VS Code 默认暗/亮板（与 UI 灰阶同族）。

### B. Graphite — "深色极简 · 单色科技感"（暗为主 + 亮配套）

- **目的**：给"在这一款上专注干活"的用户——极简、克制、无彩色干扰。适合长 shell 会话与代码审阅：只有当前焦点/选中项有一抹强调色，其余全是灰阶。
- **风格锚点**：Linear、Raycast、Windows 11 的 Mica 表面观感（**仅用纯色模拟分层，不用 backdrop-filter**）。
- **关键特征**：近黑底（`#0d0f12`）→ 两级表面抬升（`#14171c` / `#1a1e24`）；**极细 hairline + 无渐变**；选中态用 2px 左侧强调条（accent rail）而非整块填色；标题栏与状态栏同色，靠 hairline 分隔；弹窗用"投影 + 1px 亮边"营造浮起。
- **强调色**：默认薄荷青 `#2dd4bf`（可在 §3.3 换成紫/橙/蓝）。
- **终端板**：近黑底 + 高对比 16 色（白系为主，强调色只用于光标与选中）。
- **亮配套 `Graphite Light`**：同结构反相（白 + 冷灰），保证"跟随系统"时不跳风格。

### C. Sandstone — "现代暖色 · 低蓝光护眼"（亮 / 暗）

- **目的**：夜间与长时间阅读日志的用户，蓝光与高饱和是最主要的不适来源；而现有 Solarized 终端配色证明"暖色系"在这个产品里是刚需，但 UI 外壳并未提供。Sandstone 给一整套**暖中性色**：纸感浅底 / 暖炭深底，配低蓝光文字色。
- **风格锚点**：Solarized 的明度体系 + Notion / Arc 的纸面质感。
- **关键特征**：米白 `#faf7f2` → 卡片 `#fffdf9`；文字用暖深灰而非纯黑；暖炭 `#1c1a17`（暗）；圆角 8px 更柔和；阴影带暖色调（`rgba(80,60,30,.10)`）；状态色统一降饱和。
- **强调色**：默认陶土橙 `#c2410c`（亮）/ `#f59e0b`（暗）；可选橄榄绿、赭石红。
- **终端板**：Solarized Light / Solarized Dark（现有 `solarized` 系列已内置，直接对照，保证与终端板逐色一致）。
- **注意**：这不是"复古终端风"，纹理与层次按现代规范做，只把色相切换到暖区。

### D. Terminal Green — "卡片化 · 终端原住民"（暗 / 亮）

- **目的**：很多老终端用户（SecureCRT / Terminus 迁移过来）习惯"荧光绿 + 黑底"的身份感，但又不想回到 2000 年代的外观。这一款保留**身份符号**（绿字、等宽强调、卡片边框），用现代的卡片布局与圆角承载。
- **风格锚点**：Warp 的卡片式输出 + 经典 Phosphor 终端配色。
- **关键特征**：近黑 `#0b0f0c` 底；**卡片化**：面板、tab、终端 tab 都是"1px 亮边 + 6px 圆角 + 轻微浮起"的独立卡片，间距 4px；tab 用卡片形态而非下划线；分组标题用小号大写 + 字距；列表选中用绿色左条。
- **强调色**：默认磷光绿 `#48d597`；可选琥珀 `#e3b341`。
- **终端板**：黑底 + 绿前景 + 完整 16 色（不是纯绿单色，保证 `ls`/`git` 输出仍可辨色）。
- **亮配套 `Terminal Green Light`**：白底 + 深绿强调，卡片边框灰化。

### 汇总表

| 族             | 亮                | 暗               | 一句话目的                       | 锚点                     |
| -------------- | ----------------- | ---------------- | -------------------------------- | ------------------------ |
| Slate          | `slate-light`     | `slate-dark`     | 现代开发工具基线的低疲劳外观     | VS Code Modern / Primer  |
| Graphite       | `graphite-light`  | `graphite-dark`  | 深色极简、单色科技感、专注       | Linear / Raycast / Win11 |
| Sandstone      | `sandstone-light` | `sandstone-dark` | 暖色低蓝光，夜间与长日志阅读     | Solarized 明度 / Notion  |
| Terminal Green | `tgreen-light`    | `tgreen-dark`    | 保留终端身份感，改用现代卡片布局 | Warp + Phosphor          |

内置主题从 **6 → 14 款**（7 族），设置面板按"复古 / 现代"两组分区展示。

## 5. 不做的事（明确排除）

- **不做透明/毛玻璃**：`backdrop-filter` 在 WebView2 + WebGL 终端上代价高、在 Windows 上糊字，与性能规范冲突。
- **不做主题编辑器 UI**：本轮只做"可以渲染"的主题，编辑能力继续走文件 + schema 补全。
- **不重构组件**：现代主题不修改任何组件的 DOM 结构或 Tailwind 类名。若某款主题必须改结构才能成立，则该款暂缓。
- **不动现有 6 款的观感**：`day/dim/aqua/holo` 像素级不变（Holo 补丁只是搬家，附截图回归对比）。
- **不引入第三方 UI 组件库或图标策略变更**。

## 6. 验收与测试

1. **单元测试**：对比度自动校验（新写 `contrast.test.ts`，对每族的 `foreground/background`、`muted/surface`、`accent/accent-foreground`、`border/surface` 断言阈值）；主题目录快照测试（id / variant / 成对性 / swatch 三色齐全）。
2. **视觉回归**：每族截取 4 个关键界面（主界面、设置窗、命令面板、SFTP + 传输队列）亮暗各一张，进 `doc/themes/` 存档并在 PR 中对比。
3. **`npm run check` + `cargo test` + `cargo clippy -D warnings`** 全绿。
4. **手工验收清单**：dockview tab / 滚动条 / 原生标题栏按钮 / 终端内 `ls --color`、`git status`、`htop`、`vim` 四个场景均清晰；切换主题无闪烁；终端 WebGL 无异常。

## 7. 施工批次（确认后执行，每批独立可验收）

| 批次 | 内容                                                                                | 预计改动面                                              |
| ---- | ----------------------------------------------------------------------------------- | ------------------------------------------------------- |
| P5-1 | Token 与皮肤层基建（§3.1、§3.2）；Holo 补丁迁入 skins；零观感变化                   | `tokens.css`、新 `skins/`、`index.css`、`ThemeProvider` |
| P5-2 | **Slate** 亮/暗 + 强调色机制（§3.3）+ 设置面板分组                                  | `tokens.css`、`themes.ts`、`SettingsWindow`、i18n       |
| P5-3 | **Graphite** 亮/暗                                                                  | tokens + skins                                          |
| P5-4 | **Terminal Green** 亮/暗（卡片化皮肤）                                              | tokens + skins                                          |
| P5-5 | **Sandstone** 亮/暗                                                                 | tokens + skins                                          |
| P5-6 | 终端跟随（§3.4）+ 对比度测试 + 主题文件 schema 扩展（§3.5，含 Rust）                | `terminalColorSchemes.ts`、`themes/mod.rs`、测试        |
| P5-7 | 文档更新（AGENTS.md 目录与主题条目、`ui-style-web2.md` 的"现代分组"说明、截图存档） | `doc/`、`AGENTS.md`                                     |

若希望缩小首轮范围，可只做 **P5-1 → P5-2 → P5-3**（基建 + Slate + Graphite，4 款），这是覆盖"现代风格"缺口的最小完整集；Sandstone 与 Terminal Green 作为后续。

## 8. 需要你拍板的三件事

1. **范围**：4 族 8 款全做，还是先做 Slate + Graphite 上 4 款？
2. **强调色可切换**（§3.3）是否纳入本轮？它会新增一个设置项和一块色板 UI。
3. **默认主题**是否调整？建议保持 `day/dim` 不变（不惊动老用户体验），仅在设置面板把现代组放在前面。

## 9. 实施记录与偏差

### 批次与提交

| 批次 | 内容                                                                            | 提交      |
| ---- | ------------------------------------------------------------------------------- | --------- |
| P5-1 | Token + 皮肤层基建；Holo 结构规则迁出 index.css；6 款复古主题渲染逐项比对无变化 | `5ea18b6` |
| P5-2 | Slate 亮/暗、强调色机制、主题分组与设置面板色板、默认主题改为 Slate             | `771620a` |
| P5-3 | Graphite 亮/暗（药丸标签、无边框按钮、强调条选中）                              | `7359043` |
| P5-4 | Terminal Green 亮/暗（卡片化标签、提示行状态栏、磷光强调）                      | `374acbd` |
| P5-5 | Sandstone 亮/暗（暖色纸面、Solarized 明度、暖色阴影）                           | `d8a1b85` |
| P5-6 | 终端跟随、WCAG AA 对比度门禁、主题文件 `structure` 段与 Rust 校验/schema        | `4a99f71` |
| P5-7 | 文档更新与本对照截图                                                            | 本次提交  |

### 相对方案的偏差

1. **皮肤层规则改为「靠特异性」而非「排在 utilities 之后」**：CSS 规定 `@import` 必须位于所有其他规则之前，否则该 `@import` 会被丢弃（Tailwind 的 `@tailwind` 展开后同样如此），最初把 `@import './theme/skin-tokens.css'` 放在 `@tailwind utilities` 之后的写法在构建产物里被静默丢弃。现在的做法是：所有 `@import` 提前，皮肤规则的选择器各多一级 `:root` / `[data-theme]`，以相同语义赢过被替换的 Tailwind 工具类。
2. **复古族做了 5 处对比度微调**（方案曾写"不改变现有 6 款观感"）：新的对比度门禁在落地时暴露了 7 处既有的 AA 不达标（day 的三级文字与主按钮文字、aqua-light 的 warning、holo-light 的三级文字与链接、slate-dark 引入后的主按钮文字）。处理方式：**只改取值、不改结构**——day `--muted-foreground` 58%→47%，aqua-light `--warning` 38°95%42%→34°92%36%，holo-light `--muted-foreground` 60%→54%、`--link` 40%→34%，slate-dark `--accent-strong` 68%→40%。其余（如 dim 的选中行白字）属于既有审美选择，测试改为校验组件实际渲染的配对（主按钮用 `--accent-strong` 作底）。

### 未做（沿用方案 §5）

- 透明 / 毛玻璃背景（WebGL 终端下代价高）；主题编辑器 UI；为某个主题修改组件结构；引入第三方 UI 库。
