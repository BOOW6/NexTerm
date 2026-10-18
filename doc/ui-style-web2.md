# NexTerm UI 风格规范：2008–2014 中文 Web 2.0 经典后台风格

> 状态：设计提案（Design Proposal）
> 适用范围：应用外壳、会话管理、面板、表单、表格、状态栏；终端内容区沿用同色系但保持可读性。
> 说明：本文档先产出「设计 tokens / 布局草图 / 组件清单」，**确认后再进入代码实现**。

---

## 1. 提示词与本项目的契合度评估

### 1.1 结论

**整体契合，建议采用，但需做三项适配后落地。**

该风格适合 NexTerm 的「工具型、信息密集、长时间使用」场景：紧凑间距、12–14px 字号、2–4px 圆角、1px 实线面板、表格化列表，都与终端/远程管理类应用高度一致。复古后台语言也能让产品形成鲜明辨识度，避免落入现代 SaaS 模板。

但原提示词是**单浅色、面向 Web 后台页面**的规范，直接套到 Tauri 桌面终端应用会有以下缺口，需要在本项目中补齐：

| # | 原提示词的问题 | 本项目需要调整 |
| --- | --- | --- |
| 1 | 只定义浅色 tokens | 必须同时定义**暗黑 tokens**，并预留 `data-theme` 主题系统 |
| 2 | 未覆盖终端/Dockview | 需把 `--dv-*`（dockview）与 xterm theme 映射到同一套 tokens |
| 3 | 大量渐变/拟物质感 | **仅用于 chrome**（顶栏、面板标题栏、主按钮），终端内容区保持低干扰 |
| 4 | 字体列了 SimSun | UI 正文用「微软雅黑 / Tahoma / PingFang SC」，宋体仅作可选的公告类装饰，避免可读性下降 |
| 5 | 未定义状态色/焦点色 | 补充 success / warning / error / focus-ring，且两套主题都要满足对比度 |
| 6 | 面向网页布局 | 桌面优先：顶栏 + 左侧会话栏 + 停靠工作区 + 状态栏，不使用整页滚动 |
| 7 | 交互组件库未定 | 现有 `src/components/ui` 为自研轻量组件，可继续沿用；复杂交互可选用 Radix UI headless，但样式必须完全自定义 |

### 1.2 明确契合的点

- **信息密度**：12–14px、4/8/12/16 间距、28–36px 行高，适合会话列表与文件列表。
- **面板化布局**：左侧菜单 + 右侧内容面板，与「会话管理器 + 工作区」天然对应。
- **表格/树/状态灯**：正是 Session 列表、SFTP 文件列表、连接状态所需的组件。
- **克制圆角与阴影**：与终端应用的「工具感」一致。
- **蓝色主色**：与现有 `accent` 语义位可平滑替换。

### 1.3 需要警惕的冲突

1. **暗色终端 vs 浅色外壳**：浅色外壳 + 深色终端是可行的（类似旧版 Xshell/SecureCRT），但需要明确「终端区域独立配色」，避免外壳渐变干扰阅读。
2. **渐变滥用**：如果每个面板、每个按钮都用渐变，长时间使用会显得廉价且疲劳。规范中限定渐变使用位置。
3. **Dockview 默认主题**：当前使用 `dockview-theme-dark`，必须同时提供 light/dark 两套 `--dv-*` 覆盖，否则与外壳风格割裂。
4. **xterm 主题写死**：`XtermCanvas` 中 `background: '#09090b'` 需改为从主题 tokens 读取。
5. **无头组件缺失**：目前未引入 Radix。可先自研；若后续加入 Tabs / Menu / Tooltip 等复杂交互，再引入 Radix，但外观由本项目 tokens 完全接管。
6. **品牌复刻风险**：只提取「共同视觉语言」，不逐像素复刻 LuCI / Discuz / QQ 邮箱。

### 1.4 与既有视觉方向的关系

此前 P0 采用的是「现代深色 + Shadcn 风格」的语义 token 架构。本次调整**改变的是视觉语言，不改变架构**：

- 保留：CSS Variables + Tailwind theme 扩展、语义 token 命名、自研基础组件。
- 替换：具体色值、渐变、边框、圆角、字号、阴影、Dockview / xterm 主题。
- 新增：亮/暗双主题与未来主题系统。

---

## 2. 设计原则

1. **提取语言，不复刻品牌**：以经典后台的「渐变标题栏 + 1px 边框 + 表格密度」为骨架。
2. **Chrome 复古，内容克制**：渐变只出现在顶栏、面板标题栏、主按钮；终端与文件内容区保持低干扰。
3. **双主题同构**：亮/暗使用同一套 token 名称，只替换取值。
4. **桌面优先**：固定视口、内部滚动；移动端沿用同一视觉语言，不转换为现代卡片流。
5. **状态可读**：连接状态、危险操作、焦点态在两套主题下都清晰。
6. **克制动效**：仅保留 120–150ms 的淡入/展开，禁止 blob、视差、复杂过渡。

---

## 3. 设计 Tokens

### 3.1 语义色（明亮主题）

| Token | 建议值 | 用途 |
| --- | --- | --- |
| `--background` | `#F5F7FA` | 应用背景 |
| `--background-alt` | `#EEF2F6` | 交替行 / 次级背景 |
| `--surface` | `#FFFFFF` | 面板、弹窗、卡片 |
| `--surface-header` | `#EAF1F8` | 面板标题栏底色（渐变起点/终点） |
| `--surface-hover` | `#E6EEF7` | 悬停行 / 按钮悬停 |
| `--surface-active` | `#D7E3F0` | 选中行 / 按下态 |
| `--border` | `#B6C4D4` | 面板外框 |
| `--border-muted` | `#C9D4E0` | 内部细分隔线 |
| `--border-strong` | `#9FB1C4` | 强调边框 / 输入框 |
| `--foreground` | `#1F2D3D` | 主文本 |
| `--muted` | `#5A6B7B` | 次要文本 |
| `--muted-foreground` | `#8494A4` | 占位符 / 弱提示 |
| `--accent` | `#2E75B6` | 主色 |
| `--accent-strong` | `#1E5A96` | 主色深 |
| `--accent-soft` | `#5B9BD5` | 主色浅 |
| `--link` | `#0645AD` | 链接（默认带下划线） |
| `--link-hover` | `#0066CC` | 链接悬停 |
| `--success` | `#2E8B57` | 已连接 / 成功 |
| `--warning` | `#C77700` | 连接中 / 警告 |
| `--error` | `#C0392B` | 错误 / 断开 |
| `--focus-ring` | `#2E75B6` | 焦点环 |
| `--table-header` | `#E3EBF4` | 表头底色 |
| `--row-hover` | `#F0F6FC` | 表格行悬停 |
| `--row-selected` | `#DCEAF7` | 表格行选中 |

### 3.2 语义色（暗黑主题）

> 保留「深蓝外壳 + 钢蓝边框」的语言，不做纯黑霓虹风。

| Token | 建议值 |
| --- | --- |
| `--background` | `#16202B` |
| `--background-alt` | `#1B2632` |
| `--surface` | `#223040` |
| `--surface-header` | `#2A3B4E` |
| `--surface-hover` | `#2C3D50` |
| `--surface-active` | `#365068` |
| `--border` | `#3A4A5E` |
| `--border-muted` | `#334455` |
| `--border-strong` | `#4C6076` |
| `--foreground` | `#DCE6F2` |
| `--muted` | `#9FB0C2` |
| `--muted-foreground` | `#7A8DA0` |
| `--accent` | `#5B9BD5` |
| `--accent-strong` | `#2E75B6` |
| `--accent-soft` | `#7FB2E5` |
| `--link` | `#7FB2E5` |
| `--link-hover` | `#A8CBEF` |
| `--success` | `#4CAF70` |
| `--warning` | `#E0A030` |
| `--error` | `#D9534F` |
| `--focus-ring` | `#7FB2E5` |
| `--table-header` | `#2A3B4E` |
| `--row-hover` | `#263748` |
| `--row-selected` | `#365068` |

### 3.3 渐变

| Token | 明亮 | 暗黑 | 用途 |
| --- | --- | --- | --- |
| `--gradient-header` | `linear-gradient(180deg, #5B9BD5, #2E75B6)` | `linear-gradient(180deg, #2F5E8C, #173A5C)` | 顶部导航条 |
| `--gradient-panel-title` | `linear-gradient(180deg, #F4F8FC, #DCE8F4)` | `linear-gradient(180deg, #31465B, #243445)` | 面板标题栏 |
| `--gradient-button` | `linear-gradient(180deg, #FEFEFE, #E6EEF7)` | `linear-gradient(180deg, #34465A, #263646)` | 次级按钮 |
| `--gradient-button-primary` | `linear-gradient(180deg, #5B9BD5, #2E75B6)` | `linear-gradient(180deg, #3D7CB3, #245C8C)` | 主按钮 |
| `--gradient-button-hover` | `linear-gradient(180deg, #FFFFFF, #DCE8F4)` | `linear-gradient(180deg, #3A4E63, #2C3D50)` | 按钮悬停 |

**使用限制**：渐变只用于顶栏、面板标题栏、按钮、Tab 激活态；表格、终端、文件列表不使用渐变。

### 3.4 字体与字号

| 用途 | 字体栈 | 字号 | 行高 |
| --- | --- | --- | --- |
| UI 正文 | `"Microsoft YaHei", "微软雅黑", Tahoma, Arial, "PingFang SC", "Hiragino Sans GB", sans-serif` | 12px | 18px |
| 次级文本 | 同上 | 11px | 16px |
| 面板/对话框标题 | 同上，600 | 13px | 20px |
| 顶栏标题 | 同上，600 | 14px | 20px |
| 表格/列表 | 同上 | 12px | 28–36px |
| 等宽（主机/SFTP 路径/终端） | `Consolas, "Courier New", "Sarasa Mono SC", monospace` | 12–13px | 20px |
| 装饰性公告（可选） | `SimSun, "宋体", serif` | 12px | 18px |

> 不推荐将宋体用于常规 UI：在 macOS/Linux 上缺失且可读性差；仅用于「公告栏」等少量装饰场景。

### 3.5 间距、圆角、边框、阴影

| Token | 值 | 说明 |
| --- | --- | --- |
| `--space-1` | 4px | 图标与文本 |
| `--space-2` | 8px | 组件内边距 |
| `--space-3` | 12px | 面板内边距 |
| `--space-4` | 16px | 区块间距 |
| `--radius-sm` | 2px | 输入框、按钮、标签 |
| `--radius-md` | 3px | 面板、对话框 |
| `--radius-lg` | 4px | 顶栏/特殊容器（上限） |
| `--border-width` | 1px | 所有面板/控件边框 |
| `--shadow-panel` | `0 1px 2px rgba(0,0,0,.08)` | 面板 |
| `--shadow-popup` | `0 2px 6px rgba(0,0,0,.12)` | 菜单/对话框 |
| `--control-height` | 26–28px | 输入框/按钮 |
| `--row-height` | 28px 紧凑 / 32px 默认 / 36px 宽松 | 表格与列表 |

**禁止**：圆角 > 4px、重阴影、毛玻璃、霓虹、紫色渐变。

### 3.6 CSS 变量骨架（提案）

```css
:root,
[data-theme='light'] {
  --background: #f5f7fa;
  --background-alt: #eef2f6;
  --surface: #ffffff;
  --surface-header: #eaf1f8;
  --surface-hover: #e6eef7;
  --surface-active: #d7e3f0;
  --border: #b6c4d4;
  --border-muted: #c9d4e0;
  --border-strong: #9fb1c4;
  --foreground: #1f2d3d;
  --muted: #5a6b7b;
  --muted-foreground: #8494a4;
  --accent: #2e75b6;
  --accent-strong: #1e5a96;
  --accent-soft: #5b9bd5;
  --link: #0645ad;
  --link-hover: #0066cc;
  --success: #2e8b57;
  --warning: #c77700;
  --error: #c0392b;
  --focus-ring: #2e75b6;

  --gradient-header: linear-gradient(180deg, #5b9bd5, #2e75b6);
  --gradient-panel-title: linear-gradient(180deg, #f4f8fc, #dce8f4);
  --gradient-button: linear-gradient(180deg, #fefefe, #e6eef7);

  --radius-sm: 2px;
  --radius-md: 3px;
  --radius-lg: 4px;
  --shadow-panel: 0 1px 2px rgba(0, 0, 0, 0.08);

  color-scheme: light;
}

[data-theme='dark'] {
  --background: #16202b;
  --background-alt: #1b2632;
  --surface: #223040;
  --surface-header: #2a3b4e;
  --surface-hover: #2c3d50;
  --surface-active: #365068;
  --border: #3a4a5e;
  --border-muted: #334455;
  --border-strong: #4c6076;
  --foreground: #dce6f2;
  --muted: #9fb0c2;
  --muted-foreground: #7a8da0;
  --accent: #5b9bd5;
  --accent-strong: #2e75b6;
  --accent-soft: #7fb2e5;
  --link: #7fb2e5;
  --link-hover: #a8cbef;
  --success: #4caf70;
  --warning: #e0a030;
  --error: #d9534f;
  --focus-ring: #7fb2e5;

  --gradient-header: linear-gradient(180deg, #2f5e8c, #173a5c);
  --gradient-panel-title: linear-gradient(180deg, #31465b, #243445);
  --gradient-button: linear-gradient(180deg, #34465a, #263646);

  color-scheme: dark;
}
```

---

## 4. 布局草图

### 4.1 主窗口

```text
+--------------------------------------------------------------------------------------+
| [Logo] NexTerm    会话   工具   视图   帮助        [ 搜索会话/主机... ]   [设置] [?]  |  ← 深蓝渐变顶栏
+--------------------------------------------------------------------------------------+
| 首页 > 会话 > 生产服务器                                                             |  ← 面包屑
+------------------------+-------------------------------------------------------------+
| 会话管理器             | +-- 面板标题栏 · 工作区 ---------------------- [分屏] [×] + |
| [新建会话] [快速连接]  | |  +-- 标签: 本地终端 --+  +-- 标签: 生产服务器 --+          | |
| [ 搜索会话...        ] | |  |                     |  |                        |          | |
|                        | |  |   xterm 终端内容    |  |   xterm 终端内容       |          | |
| ★ 收藏                 | |  |                     |  |                        |          | |
| ▾ 本地                 | |  +---------------------+  +------------------------+          | |
|   ● 本地终端           | +-------------------------------------------------------------+ |
| ▾ 服务器               | +-- 面板标题栏 · SFTP ---------------------------------------+ |
|   ● 生产 (SSH)         | |  路径: /var/www > logs                      [上传] [刷新]    | |
|   ○ 测试 (SFTP)        | |  名称        大小      修改时间      权限      操作           | |
|                        | |  ...                                                         | |
+------------------------+-------------------------------------------------------------+
| ● 已连接 · 生产服务器 · 12ms · UTF-8 · 120x32 · SSH                       10:32:00   |  ← 状态栏
+--------------------------------------------------------------------------------------+
```

### 4.2 对话框（新建会话 / 连接）

```text
+------------------------------------------+
| 新建会话                              ×  |  ← 面板标题栏（渐变）
+------------------------------------------+
| 类型    [ 本地终端 ▾ ]                   |
| 名称    [____________________________]   |
| 主机    [________________]  端口 [ 22 ]  |
| 用户名  [________________]               |
| 分组    [________________]               |
|                                          |
|              [ 取消 ]  [ 连接 ]          |
+------------------------------------------+
```

### 4.3 响应式策略

- 桌面优先：`grid-template-columns: 240px 1fr`，状态栏固定底部。
- 窄屏（< 900px）：左侧会话栏可折叠为 48px 图标条；仍保持 1px 边框与紧凑间距。
- 移动端：不做现代卡片流；列表、表格、面板维持同一套 Web 2.0 语言。

---

## 5. 组件清单

### 5.1 基础组件（`src/components/ui`）

| 组件 | 状态 | Web 2.0 化要求 |
| --- | --- | --- |
| Button | 已有，需重绘 | 2px 圆角、1px 边框、上浅下深渐变、按下内阴影、26–28px 高 |
| Input | 已有，需重绘 | 白底、1px `--border-strong` 边框、内阴影、focus 时蓝色外框 |
| Select | 已有，需重绘 | 原生 select 外观统一，箭头图标 12–14px |
| Dialog | 已有，需重绘 | 方形窗口感：渐变标题栏 + 内容区 + 底部分隔线，最大圆角 3px |
| DropdownMenu | 已有，需重绘 | 1px 边框、白底、行高 24–28px、悬停蓝底白字 |
| Tooltip | 已有，需重绘 | 小方块、1px 边框、无圆角或 2px |
| Toast | 已有，需重绘 | 类似旧式消息条，右上/右下角，2px 圆角 |
| **Panel** | 新增 | 面板容器：标题栏 + 内容区 + 1px 边框 |
| **Breadcrumb** | 新增 | `首页 > 当前页`，链接蓝色 |
| **Table / DataTable** | 新增 | 表头浅蓝底、行高 28–36px、斑马纹可选 |
| **Pagination** | 新增 | 数字分页 + 上一页/下一页 |
| **Tabs** | 新增 | 文件夹式/下划线式，激活态渐变 |
| **StatusLight** | 新增 | 8px 圆点 + 文本，连接状态复用 |
| **NoticeBar / 公告栏** | 新增 | 浅黄底、1px 边框、可选宋体 |
| **Fieldset / GroupBox** | 新增 | 经典分组框，标题嵌入边框 |

### 5.2 应用组件

| 组件 | 文件 | Web 2.0 化要求 |
| --- | --- | --- |
| TitleBar（顶栏） | `components/layout/TitleBar.tsx` | 深蓝渐变、Logo + 主导航 + 搜索 + 设置 |
| SessionSidebar | `components/sessions/SessionSidebar.tsx` | 左侧菜单样式：分组标题、状态灯、悬停高亮 |
| SessionRow | `components/sessions/SessionRow.tsx` | 行高 28–32px、状态灯、收藏星标 |
| QuickConnectWindow | `windows/QuickConnectWindow.tsx` | 经典表单对话框 |
| HostKeyWindow | `windows/HostKeyWindow.tsx` | 主机密钥确认 / 不匹配提示 |
| DockLayout | `components/layout/DockLayout.tsx` | 标签页与分组映射到 `--dv-*` tokens |
| TerminalTab | `components/terminal/TerminalTab.tsx` | 面板边框 + 标签；终端内部主题独立 |
| SshConnectForm | `components/terminal/SshConnectForm.tsx` | 连接前的 SSH 认证表单 |
| SFTPPanel | `components/sftp/SFTPPanel.tsx` | 路径栏 + 数据表格 + 分页 |
| StatusBar | `components/layout/StatusBar.tsx` | 深色/浅色状态条，等宽数字 |

---

## 6. 主题系统设计（后期落地）

### 6.1 目标

支持「明亮 / 暗黑 / 后续自定义主题」，且组件不感知具体主题，只消费语义 token。

### 6.2 机制

1. `ThemeProvider` 将主题名写入 `<html data-theme="light|dark">`。
2. 所有颜色通过 CSS Variables 暴露，Tailwind 只映射语义名（`bg-surface`、`text-muted`、`border-border` 等）。
3. 主题包 = 一组 CSS 变量；新增主题只需新增 `[data-theme='xxx']` 变量块。
4. 持久化：localStorage 保存用户选择；支持 `system`（跟随 `prefers-color-scheme`）。
5. 终端主题：从同一组 CSS 变量读取，构造 xterm `ITheme`；主题切换时调用 `terminal.options.theme = ...`。
6. Dockview：把 `--dv-*` 映射到语义 token，两套主题分别覆盖。

### 6.3 建议目录

```text
src/theme/
  tokens.css          # light/dark/自定义主题变量
  ThemeProvider.tsx   # data-theme、持久化、system 跟随
  useTheme.ts
  terminalTheme.ts    # tokens → xterm ITheme
```

### 6.4 迁移关系

- 现有 `src/index.css` 中的 `:root` / `.light` 变量将被 `[data-theme]` 方案替代。
- `tailwind.config.js` 中的语义色映射保持，仅调整取值与新增 token。
- Dockview 的 `dockview-theme-dark` 从「单独暗色主题」改为「由本项目 tokens 驱动的 light/dark 覆盖」。

---

## 7. Dockview 与 xterm 适配

### 7.1 Dockview

需要覆盖的关键变量：

```css
[data-theme='light'] .dockview-theme-dark,
[data-theme='dark'] .dockview-theme-dark {
  --dv-group-view-background-color: var(--background);
  --dv-tabs-and-actions-container-background-color: var(--surface-header);
  --dv-activegroup-visiblepanel-tab-background-color: var(--surface);
  --dv-activegroup-hiddenpanel-tab-background-color: var(--surface-header);
  --dv-inactivegroup-visiblepanel-tab-background-color: var(--surface);
  --dv-inactivegroup-hiddenpanel-tab-background-color: var(--background-alt);
  --dv-tab-divider-color: var(--border-muted);
  --dv-activegroup-visiblepanel-tab-color: var(--foreground);
  --dv-activegroup-hiddenpanel-tab-color: var(--muted);
  --dv-inactivegroup-visiblepanel-tab-color: var(--muted);
  --dv-inactivegroup-hiddenpanel-tab-color: var(--muted-foreground);
  --dv-separator-border: var(--border);
  --dv-tabs-and-actions-container-font-size: 12px;
  --dv-tabs-and-actions-container-height: 30px;
}
```

> 主题系统落地后改用 `[data-theme]` 选择器；不再写死 `dockview-theme-dark`。

### 7.2 xterm

- 移除 `XtermCanvas` 中写死的 `background: '#09090b'`。
- 通过 `terminalTheme.ts` 从 `--background`、`--foreground`、`--accent` 等派生 `ITheme`。
- 深色终端在浅色外壳下也应保持可读；必要时为终端单独提供 `terminal.background` token。
- 字体保持等宽字体栈，字号 12–13px。

---

## 8. 实施顺序（确认后执行）

| 阶段 | 内容 |
| --- | --- |
| A | 建立 `src/theme/`：双主题 tokens、`data-theme`、ThemeProvider、Tailwind 语义映射 |
| B | 重绘基础组件（Button/Input/Select/Dialog/Dropdown/Toast/Tooltip）+ 新增 Panel/Breadcrumb/Table/Pagination/Tabs/StatusLight |
| C | 改造应用外壳：Toolbar 渐变、Breadcrumb、SessionSidebar、StatusBar |
| D | 适配 Dockview 与 xterm 主题，接管 `--dv-*` 与终端配色 |
| E | 主题切换入口（浅色/深色/跟随系统）+ 持久化 |
| F | 视觉验收、对比度检查、窄屏适配 |

---

## 9. 验收清单

- [ ] 顶栏为深蓝渐变，含 Logo、主导航、搜索框。
- [ ] 面板均为 1px 实线边框，圆角 ≤ 4px，阴影仅 `0 1px 2px`。
- [ ] 按钮为「上浅下深」渐变，26–28px 高，按下有内阴影。
- [ ] 表格表头浅蓝底，行高 28–36px，悬停/选中态清晰。
- [ ] 链接默认 `#0645AD`（暗色为 `#7FB2E5`），可下划线。
- [ ] 字体 12–14px，紧凑间距 4/8/12/16。
- [ ] 明亮与暗黑主题均通过对比度检查。
- [ ] 终端、Dockview、弹窗、菜单全部跟随主题。
- [ ] 无大圆角、玻璃拟态、霓虹、紫渐变、Bento、大留白。
- [ ] 窄屏下保持同一复古语言，不变成现代移动卡片。

---

## 10. 当前实现状态（P2）

- **主题系统**：`src/theme/tokens.css` 提供明亮/暗黑 tokens；`ThemeProvider` 支持 `light` / `dark` / `system`，写入 `<html data-theme>` 并持久化到 localStorage；`terminalTheme.ts` 从 tokens 派生 xterm 配色。
- **基础组件**：`Button / Input / Select / Dialog / DropdownMenu / Tooltip / Toast` 已按 Web 2.0 重绘；新增 `Panel / ContextMenu`。
- **应用外壳**：渐变顶栏（Logo、搜索、操作、主题切换）、面包屑、左侧会话管理器、底部状态栏、SFTP 占位面板、连接占位框均已套用新视觉。
- **P2 工作区**：
  - 自定义标签页：状态灯 + 类型图标 + 标题 + 关闭按钮。
  - 标签右键菜单：向右/向下分屏、复制会话、重连、关闭其他、关闭。
  - 命令面板：`Ctrl+K` / `Ctrl+Shift+P`，支持搜索会话、创建会话、切换主题、分屏、重连、收藏、关闭。
  - 终端工具条：查找（addon-search）、清屏、复制选中、字号增减、重连。
  - `defaultRenderer="always"` 保持隐藏标签的终端实例存活，避免重复创建 PTY。
- **已知偏差**：
  - 未引入 Radix UI，继续使用自研 headless 组件。
  - 顶栏主导航暂只保留“会话”标识，避免加入无功能的死链接。
  - `Table / Tabs / Pagination / NoticeBar` 已在组件清单中规划，尚未全部落地。
  - 关闭标签暂未通知 Rust 后端终止 PTY（待补 `close_pty_session` 命令）。

---

## 附录 A：原始提示词（存档）

> 你是资深前端工程师和 UI 设计师。请用现代技术栈实现 {{页面/组件}}，但视觉上采用 2008-2014 中文 Web 2.0 经典后台/论坛/网盘/邮箱风格。
>
> **技术栈：**
> - React 18 + TypeScript + Vite + Tailwind CSS
> - 使用 CSS Variables 和 Tailwind theme 扩展做设计 tokens
> - 语义化 HTML，组件化，CSS Grid/Flex 布局
> - 可用 Radix UI 等 headless 组件处理交互，但外观必须完全自定义
> - 不要使用 Ant Design / MUI / Bootstrap / shadcn 的默认现代外观
> - 不要用 jQuery，不要用 table 做整体布局，但数据列表可以用 table
>
> **视觉参考方向：**
> 经典后台系统、传统路由器后台、旧贴吧、旧百度网盘、QQ邮箱经典主题、OpenWrt LuCI 默认主题、Discuz 论坛。不要逐像素复刻具体品牌，而是提取共同视觉语言。
>
> **设计 tokens：**
> - 主色：#2E75B6 / #1E5A96 / #5B9BD5
> - 链接：#0645AD 或 #0066CC
> - 背景：#F5F7FA / #EEF2F6
> - 面板：#FFFFFF
> - 边框：#C9D4E0 / #B6C4D4 / #D7DEE8
> - 标题栏渐变：linear-gradient(#5B9BD5, #2E75B6)
> - 按钮渐变：linear-gradient(#FEFEFE, #E6EEF7)
> - 字体：12-14px，中文 Microsoft YaHei / SimSun / Tahoma / Arial
> - 圆角：2-4px
> - 阴影：0 1px 2px rgba(0,0,0,.08)，不要大阴影
> - 间距紧凑：4/8/12/16px
> - 表格行高：28-36px
>
> **布局与组件：**
> - 顶部深蓝渐变导航条，Logo + 主导航 + 搜索框
> - 面包屑：首页 > 当前页
> - 左侧菜单/快捷入口，右侧内容面板
> - 面板有标题栏和内容区，1px 实线边框
> - 表格、分页、Tab、按钮、输入框、下拉框、状态灯、公告栏
> - 链接默认蓝色，可下划线
> - 图标 14-16px，线条或像素感
>
> **禁止：**
> - 大圆角、玻璃拟态、霓虹、紫渐变、Bento、大留白
> - 大 Hero、大插图、3D、动态 blob、过度动画
> - 现代 SaaS 落地页风格
> - 默认组件库外观
> - 12px 以上圆角和重阴影
>
> **交付要求：**
> 先输出设计 tokens、布局草图、组件清单；我确认后再写代码。
> 代码要求可维护、响应式，但桌面优先，移动端保持同样复古视觉语言，不要变成现代移动卡片。
