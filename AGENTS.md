## 项目上下文

NexTerm 是一个基于 **Tauri 2.0** 的跨平台终端与远程管理应用，目标定位为现代开源版的 MobaXterm。项目由一次 Copilot 生成的 PR 奠定基础，现已完成本地 PTY、会话管理、多标签/分屏、SSH/SFTP 与设置面板。

### 平台脚手架（Tauri + React + TypeScript）

- 搭建了前端 `src/` 与后端 `src-tauri/` 的完整工作区结构。
- 配置了 Vite、TailwindCSS、PostCSS、TypeScript、Tauri 构建/打包与 capability 权限脚手架。
- 引入了模块化的 UI 结构，区分终端（terminal）、布局（layout）与 SFTP（sftp）界面。

### 本地 PTY 与 IPC

- 基于 `portable-pty` 实现了带状态管理的 PTY 会话管理器（会话映射表 + 生命周期管理）。
- Tauri invoke 命令：
  - `create_pty_session(cols, rows, log_path?, command?, args?)` —— 创建 PTY 会话，返回会话 id；`command`/`args` 为本地会话可选的自定义 Shell（PowerShell / WSL / Git Bash / 自定义等，`probe_shell_availability` 供 UI 探测可用性）。
  - `write_pty(id, data)` —— 向指定会话写入用户输入。
  - `resize_pty(id, cols, rows)` —— 调整会话终端尺寸。
  - `close_pty_session(id)` —— 关闭并回收 PTY 会话。
- 会话级事件：`pty-output-{id}`；每 32 KiB 读取一次并批量写入 xterm。`pty-closed-{id}` 带 `exitStatus`（watcher 线程 `child.wait()` 接住 `ExitStatus`；Unix 下 reader-EOF 先 finalize 时为 null，Windows 上 ConPTY 无 EOF、wait 是唯一退出探测点所以总有码）。

### 前端终端集成

- `XtermCanvas` 基于 `@xterm/xterm`，挂载 `@xterm/addon-fit`、`@xterm/addon-search` 与 `@xterm/addon-webgl`。
- 键盘输入、尺寸变化分别接入 `write_*` / `resize_*`；输出事件渲染进 xterm。
- 终端主题从 CSS tokens 派生；通过 imperative handle 暴露查找、清屏、复制、字号等操作。
- **会话终态结束块与键盘操作**：会话退出/断开/重连穷尽时在缓冲内输出下方写入 MobaXterm 式结束块（`endBlockText` 纯函数生成：暗色分隔线 + 消息 + 暗色按键提示行），随缓冲滚动、不遮盖内容；`writeScrollbackNotice` 的 `keepVisible` 模式让块保持可见（默认语义仍是把记录类提示推入滚动缓冲并清空视口）。键盘交互经 `attachCustomKeyEventHandler`（注册一次，`endStateRef` 镜像读取，仅在终态生效，拒绝修饰键与 IME 组合）：`R` 重连（倒计时中为立即重连）、`Enter` 关闭标签（仅终态）、`Esc` 取消自动重连（仅倒计时）、`S` 保存终端输出（`terminalTranscript` 缓冲转纯文本 + `export_terminal_transcript` 后端弹保存对话框落盘，路径不过 IPC）。自动重连倒计时渲染为右下角浮动小条（`SessionEndBar`，仅 reconnecting 态，deadline 本地逐秒 tick + [立即重连 R][取消 Esc]），终态另渲染 `sr-only aria-live` 供屏幕阅读器。重连梯子 `scheduleReconnect` 已参数化，SSH 与 Telnet 共用（Telnet 由 `telnetAutoReconnect` 设置控制，`reason=closed` 的主动断开永不重连；Serial 与本地 PTY 维持永不自动重连）。滚动缓冲里的一次性「已断开」通知保留作记录，每轮退避不再往缓冲写倒计时行。SSH 断开且关闭自动重连的路径经 `writeScrollbackNotice` 退出备用缓冲（裸 `\x1b[?1049l` 会把视口恢复到过时的滚动位置、跳到缓冲顶部）。状态枚举含 `disconnected`（已断开的深灰灯，区别于未连接的浅灰）。

### 停靠布局与多标签

- 使用 `dockview-react` 搭建布局，支持标签页、分屏、拖拽与布局持久化。
- 自定义标签页 `SessionTab`：连接状态灯、类型图标、关闭按钮与右键菜单（分屏/复制/重连/关闭其他）。
- `defaultRenderer="always"` 保持隐藏标签的终端实例存活，避免重复创建 PTY。

### 会话管理与命令面板

- 左侧会话管理器：搜索、收藏、分组、编辑、删除。
- 快速连接：本地 / SSH / SFTP / **Telnet**，支持密码与私钥认证；远程会话可选择另一 SSH/SFTP 会话作为**跳板机（ProxyJump）**（编辑窗口内选择，构建时校验循环引用；跳板机认证沿用其自身配置）。Telnet 在连接建立后于终端内登录，不保存凭据。
- 命令面板 `Ctrl+K`：搜索会话、创建会话、切换主题、分屏、重连、收藏、打开 SFTP/传输队列/设置，以及**命令片段**（管理入口在设置 > 片段；发送到当前终端并自动执行回车）。
- 会话数据与工作区布局持久化到 localStorage。

### SSH 与 SFTP（第三阶段）

- 基于 `russh` 实现**密码认证**、**私钥认证**（可选 passphrase）、**OpenSSH 用户证书认证**（私钥 + `*-cert.pub`，SSH config 导入识别 `CertificateFile`）与 **SSH Agent 认证**的交互式 SSH 终端。**ProxyJump** 在后端通过跳板连接上的 `direct-tcpip` 通道（`ssh -J` 语义）承载目标握手，跳板与目标两台主机分别做 known_hosts 校验；跳板传输随目标会话存亡。
- **主机密钥校验（TOFU）**：首次连接弹出 SHA256 指纹确认，写入应用配置目录的 `known_hosts.json`；后续自动比对，不匹配则中止。支持 OpenSSH `known_hosts` 导入/导出（导出可选 hashed host 格式；导入会跳过哈希与通配符条目）。
- 后端命令：`ssh_connect` / `ssh_write` / `ssh_resize` / `ssh_disconnect` / `ssh_host_key_response` / `known_hosts_list` / `known_hosts_remove` / `known_hosts_import` / `known_hosts_export`；`set_session_log` 用于对活动会话（SSH / PTY / Telnet）即时切换输出日志。
- **Telnet**（`src-tauri/src/telnet/mod.rs`）：RFC 854 NVT 实现，只接受控制台必需的协商（服务端 ECHO、SGA；应答 NAWS 与 TTYPE=VT100），其余选项一律拒绝（`decode_telnet` 纯函数处理 IAC 转义/子协商跨块、带单测）；resize 在对端接受 NAWS 后发送窗口尺寸子协商，未协商时静默忽略。输出走同一解码/事件/日志管线，事件 `telnet-output-{id}`、`telnet-closed-{id}`（closed 事件带 `closed`/`eof`/`error` 原因与可选错误串）。
- **串口**（`src-tauri/src/serial.rs`）：命令 `serial_list` / `serial_connect` / `serial_write` / `serial_resize`（no-op）/ `serial_disconnect`；事件 `serial-output-{id}`、`serial-closed-{id}`；复用日志管线与 `Utf8StreamDecoder`；断开即关闭端口句柄，由读取线程统一发出关闭事件。
- 输出事件：`ssh-output-{id}`、`ssh-closed-{id}`；主机密钥事件：`ssh-host-key`、`ssh-host-key-mismatch`。
- **端口转发**：命令 `port_forward_list` / `port_forward_start` / `port_forward_stop`，事件 `port-forwards-changed`；支持本地（`-L`）、远程（`-R`）与动态 SOCKS5（`-D`）。UI 为独立「端口转发」面板。
- SFTP：
  - 命令：`sftp_list` / `sftp_download` / `sftp_upload` / `sftp_remove` / `sftp_rename` / `sftp_mkdir` / `sftp_pause_transfer` / `sftp_cancel_transfer`；远程文件编辑：`remote_edit_open` / `remote_edit_stop`（临时副本 + size/mtime 轮询回传，事件 `remote-edit-synced` / `remote-edit-error`）
  - 事件：`sftp-progress`、`sftp-transfer-done`
  - 每个 SSH 会话复用一条 SFTP 子系统通道；传输支持递归目录、聚合进度、断点续传、暂停/取消/重试与冲突策略（询问/覆盖/跳过/重命名/较新才覆盖）。断点续传实现：下载写本地 `<file>.part`，上传写远端 `<file>.nexterm-part`，均带侧车元数据（来源 size + mtime 指纹）做续传校验，完成后原子替换目标文件，目标路径上只出现完整内容。传输任务绑定会话而非后端连接 id：断线自动重连后自动从 part 续传；conflict=ask 时经 `sftp-conflict` 事件弹出独立确认窗口（`sftp_conflict_response` 应答，支持"应用到全部"）。OS 拖拽上传与面板内拖动移动复用同一传输/重命名管线。
  - **传输失败路径 fail-closed**：`ConflictPolicy` 是 serde 强类型枚举（未知值在 IPC 边界拒绝，缺省回落 ask）；rename 候选耗尽与远程目录创建失败会让传输报错终止，绝不回退原路径覆盖。
  - ZMODEM 接收（`src-tauri/src/zmodem.rs`，纯状态机 + 单测）：SSH 读循环在 UTF-8 解码前拦截 `sz` 流，文件落系统下载目录；进度复用 `sftp-progress`（id 前缀 `zmodem-`，取消走取消序列，暂停被拒绝）。本地写失败即终态（关文件、删 part、队列报错、发送取消序列），且接收有单文件 2 GiB / 会话批次 8 GiB 配额（FileStart 拒绝 + 逐块校验，谎报 size 逃不过）。接收确认模式（设置 `zmodemAutoReceive` 关闭）：`BatchStartScanner` 在握手应答前拦截 ZRQINIT，经 `zmodem-receive-request` 事件弹确认框、`zmodem_receive_response` 应答，120s 超时视为拒绝并发送取消序列。
  - 远程文件本地编辑：baseline 仅在上传成功后推进（失败保持 dirty 并按 2s→60s 指数退避重试）；scratch 副本随 watcher 退出删除、启动时清理遗留。
  - UI：目录浏览、文件/文件夹上传、文件/文件夹下载、新建文件夹、重命名、删除、传输队列、远程文件本地编辑、拖拽上传/移动。

### 设置与主题（P4 / P5）

- 主题目录 7 族 14 款，分为「现代」与「复古」两组（`THEME_FAMILIES` 的 `group` 字段，设置面板分组渲染）：现代化 Slate / Graphite / Terminal Green / Sandstone，复古为 Day-Dim / Aqua / Holo。默认明暗为 `slate-light` / `slate-dark`（DEFAULT_*_THEME；持久化选择不受影响）。
- **布局 token 单一来源**：`src/theme/layout-tokens.css` 是字号（`--text-micro/tiny/meta/body/body-lg`）、字重、字距、字体族以及由间距决定的几何（`--layout-tab-height`、`--layout-menu-padding`、`--layout-row-accent-bar`、`--layout-tab-indicator`）的唯一来源，只在 `:root` 声明一次。**主题不得覆盖**：`[data-theme]` 块、皮肤、强调色推导、主题文件 `structure` 一律不含这些键（Rust 扫描器对 `tabHeight`/`panelWeight`/`letterSpacing` 等返回 "is layout, not theme"）。Tailwind 已把字号/字重/字距映射为具名工具类（`text-meta`、`text-tiny`、`font-emphasis`、`font-medium`、`tracking-wide`），组件里禁止再写 `text-[11px]` / `font-semibold`；`layoutTokens.test.ts` 守住这条线。改密度只改 layout-tokens.css。
- **Token + 皮肤分层**（P5-1）：`tokens.css` 的每个 `[data-theme]` 块同时定义颜色与「结构 token」（操作栏/状态栏底色、交互覆盖色、细线、圆角；标签几何、字重与字距归 layout-tokens.css）——必须逐主题声明，因为自定义属性在声明处替换 `var()`，写在 `:root` 会冻结首个主题的调色板。`skin-tokens.css` 把结构 token 落成交互与骨架规则（选择器多一级 `:root`，靠特异性而非顺序赢过 Tailwind 工具类，因为 `@import` 必须排在 `@tailwind` 之前）；`theme/skins/<族>.css` 只放无法用 token 表达的结构差异，Graphite/Terminal Green/Sandstone 先 `@import './slate.css'` 再叠加。
- **强调色自定义（全局色调）**：设置 `themeAccent`（hex，空=主题自带）→ `theme/accent.ts` 由单色派生整套色调，而不是只换按钮色：
  - 强调色梯度：`--accent(-strong/-soft/-rgb/-foreground/-text)`、focus-ring、链接、hover/选中混合色、`--terminal-selection`；
  - 语义色跟随：success / warning / error / 终端光标按「相对主题原强调色的偏移比例」移动色相（越靠近原强调色移动越接近满额，最远不低于 60%），光度不变，所以状态仍可辨、且不会再出现半个界面没跟上的割裂；
  - 终端配色跟随：`--terminal-ansi-2/3/4/5/6` 及亮色槽由族自带 16 色板重染，黑/白槽不动；经典族同样读取这些槽；
  - 中性化：低饱和 / 中性黑 / 中性白预设（`NEUTRAL_ACCENT_PRESETS`）额外把底色、边框、文字改为该预设的色相与饱和度、保留原亮度，纯灰预设得到纯灰界面。
    基底色在写入基底主题之后、应用强调色之前由 `readBaseThemeColors()` 读取，因此自定义主题延伸现代族时同样生效；`BaseThemeColors.accent`（主题原强调色）是色相偏移的参考原点，缺了它偏移会算成 0。预设见 `MODERN_THEME_ACCENTS` / `allAccentPresets`。
- **终端跟随**：`terminalTheme.ts` 的 `FAMILY_TERMINAL_THEMES` 为 8 款现代主题各带一份 xterm 16 色板；终端配色为「跟随界面主题」时优先使用，复古族保持从 CSS token 派生。显式配色始终优先。
- Web 2.0 视觉（复古族）：CSS Variables + Tailwind 语义 token，支持明亮 / 暗黑 / 跟随系统。
- **自定义主题（插件化）**：把主题文件放入主题文件夹（`app_config_dir/themes/`）即生效——NexTerm JSON（`name`+`variant`，可选 `extends` 内置基底 / `colors` 语义色（hex）/ `terminal` 16 色板 / `structure` 结构覆盖：圆角与 chrome 颜色（字号/字重/字距/标签几何属于布局，已移出主题格式）），并按内容识别导入 Windows Terminal scheme 与 iTerm2 `.itermcolors`；后端 `src-tauri/src/themes/` 扫描校验（`themes_list` / `themes_open_folder`，坏文件逐个报错不拖垮扫描），notify watcher 节流发 `themes-changed`，前端注册表 `customThemesStore` 两窗口共享、`ThemeProvider` 用内联 CSS 变量在 `extends` 基底上叠加（hex→HSL 三元组换算与 `STRUCTURE_VARS` 映射见 `applyCustomTheme.ts`）；`theme.schema.json`（`src-tauri/src/themes/schema.json`）随扫描写出到主题文件夹供编辑器 `$schema` 自动补全，其 `extends` 枚举与 `structure` 键由单元测试钉死。
- **主题质量门禁**：`src/theme/contrast.test.ts` 直接解析 `tokens.css` 校验 14 个主题的 WCAG AA 对比度（正文 4.5:1、微标签/链接/状态色 3:1）；`terminalTheme.test.ts` 要求每个现代主题自带完整 16 色板。视觉对照截图存于 [`doc/themes/`](doc/themes/README.md)。
- 新增主题的约定：在 `tokens.css` 追加完整的颜色 + 结构 token 块 → 在 `themes.ts` 注册（含 `group` 与 `family`）→ 需要结构差异再写 `skins/<族>.css` → 补 i18n 文案 → 跑对比度测试与截图脚本（`doc/themes/README.md`）。不要用组件内的 Tailwind 覆盖实现主题差异。
- 设置面板：外观、终端外观（字体/字号/光标/回滚/行高）、命令片段管理、SSH 默认值、可配置快捷键、known_hosts 管理、恢复默认。
- **会话日志**：设置 > 终端 开启并选择目录后，PTY 与 SSH 读循环把解码后的输出（含 ANSI 序列）追加写入 `会话名-时间.log`（`src-tauri/src/log_sink.rs`，`Arc<LogSink>` 挂在会话上，零额外 IPC）；日志路径在终端面板挂载时决定，自动重连续写同一文件，切换开关对活动会话即时生效。`session_logs_clear` 后端命令删除配置日志根（canonicalize 校验）下的顶层 `.log`，入口在设置 > 终端。
- **敏感缓存保留**：终端快照（明文滚动缓冲，localStorage）超过 24 个会话按 LRU 淘汰（`terminalSnapshot.ts` 索引键），设置 > 终端 提供一键清除全部快照；远程编辑 scratch 副本随 watcher 退出删除并在启动时清理遗留。
- **凭据删除可观察**：`forgetSessionCredentials` 返回 `{ removed, failed }`，失败键写入持久化墓碑（`nexterm.pendingVaultDeletes.v1`）并在每次解锁后重试（`retryPendingVaultDeletions`），删除会话与快速连接改认证方式时失败弹警告。
- **自动更新**：`tauri-plugin-updater` 已接线（capability `updater:default`；公钥与更新源在 `tauri.conf.json` 的 `plugins.updater`），设置 > 关于 提供「检查更新」。签名私钥在 `~/.tauri/nexterm-updater.key`（不进仓库），发布流程见 `doc/build.md`。

## 技术栈

| 层次            | 技术                                                                                 |
| --------------- | ------------------------------------------------------------------------------------ |
| 应用外壳        | Tauri 2.0（Rust 后端）                                                               |
| 前端            | React 18 + TypeScript + Vite                                                         |
| 状态管理        | Zustand                                                                              |
| UI / 样式       | TailwindCSS + CSS Variables + Lucide React（token + 皮肤分层，现代 / 复古两组主题）  |
| 停靠/多标签布局 | `dockview-react`                                                                     |
| 终端模拟器      | `@xterm/xterm` + `addon-fit` + `addon-search` + `addon-webgl`                        |
| Rust 核心依赖   | `tokio`、`portable-pty`、`russh`、`russh-sftp`、`serialport`、`serde` / `serde_json` |
| 桌面集成        | `tauri-plugin-clipboard-manager`、`tauri-plugin-dialog`、`tauri-plugin-decorum`      |

## 目录结构

```text
├── src/
│   ├── components/
│   │   ├── command/          # 命令面板
│   │   ├── layout/           # TitleBar / DockLayout / SessionTab / StatusBar
│   │   ├── forward/          # 端口转发面板
│   │   ├── sessions/         # 会话侧栏、会话行
│   │   ├── settings/         # 设置面板与快捷键输入
│   │   ├── sftp/             # SFTP 文件面板
│   │   ├── terminal/         # xterm、终端标签、SSH 认证表单
│   │   ├── transfers/        # 传输队列面板
│   │   └── ui/               # 基础组件（Button/Input/Dialog/Menu/Toast…）
│   ├── features/workspace/   # 工作区上下文与会话操作
│   ├── hooks/                # useTauriPty / useTauriSsh / 事件与快捷键
│   ├── i18n/                 # 中英文文案与 useI18n
│   ├── lib/                  # cn、快捷键、格式化、会话导入、终端快照、凭据保险库
│   ├── stores/               # session / workspace / ui / credentials / vault / connections / transfer / settings
│   ├── theme/                # tokens、skins、ThemeProvider、accent、xterm 主题
│   ├── types/
│   ├── windows/              # 设置、快速连接、主机密钥等独立窗口
│   ├── App.tsx
│   ├── main.tsx
│   └── index.css
├── src-tauri/
│   ├── src/
│   │   ├── pty/mod.rs        # 本地 PTY 会话管理
│   │   ├── ssh/mod.rs        # SSH / SFTP 连接管理
│   │   ├── telnet/mod.rs     # Telnet（最小 NVT）
│   │   ├── serial.rs         # 串口会话（serialport + 阻塞读线程）
│   │   ├── zmodem.rs         # ZMODEM 接收状态机（含 tests/）
│   │   ├── remote_edit.rs    # 远程文件本地编辑（下载/监视/回传）
│   │   ├── vault.rs          # 加密凭据保险库（Argon2id + AES-256-GCM）
│   │   ├── commands/mod.rs   # Tauri IPC 命令
│   │   ├── windows.rs        # 模态窗口与原生菜单
│   │   ├── windows_ext.rs    # WebView 平台补丁
│   │   ├── lib.rs
│   │   └── main.rs
│   ├── capabilities/default.json
│   ├── icons/                # 由 app-icon.svg 生成的各平台图标
│   ├── app-icon.svg          # 应用图标矢量源
│   ├── app-icon.png          # 应用图标位图源
│   ├── Cargo.toml
│   └── tauri.conf.json
├── doc/                      # 设计、构建与阶段说明（doc/themes/ 存主题对照截图）
├── package.json
├── vite.config.ts
├── tailwind.config.js
└── tsconfig.json
```

## 构建与运行

环境准备、构建步骤、IPC 接口与常见问题统一维护在 [`doc/build.md`](doc/build.md)，此处不再重复。

- 前端类型检查：`npm run typecheck`
- 前端代码规范：`npm run lint` / `npm run format:check`（CI 会校验）
- 前端测试：`npm run test:run`（Vitest + jsdom）
- Rust 检查：`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test`
- 一键前端校验：`npm run check`
- **不要重新启用 React StrictMode**：其开发期双调用会为每个终端创建两个 PTY 会话。

## 开发约定

- 设置项统一放 `src/stores/settingsStore.ts`，持久化键名 `nexterm.settings.v1`。
- 主题由 `src/theme/ThemeProvider.tsx` 管理，UI 通过 `useTheme()` 读写；任何绕过设置窗口直接修改设置的路径（如命令面板切主题）必须广播 `nexterm-settings-applied`，供设置窗口合并进其草稿。
- 安全相关数据（known_hosts）由 Rust 后端持久化，前端只通过命令读写。
- 新增设置项：先加 store 字段 → 在设置面板加控件 → 在使用处读取，避免散落的 localStorage 键。
- known_hosts 为本项目自有 JSON 格式，暂不与 OpenSSH 的 `~/.ssh/known_hosts` 互通。

### UI de-slop 边界（不可协商）

- 组件与窗口颜色只消费语义令牌（Tailwind 语义类或 `hsl(var(--token))`）；裸 hex、`rgb()` 字面量、调色板类、任意值颜色由 `npm run ds:lint` 拦截。
- 新派生色先入令牌层再被组件消费：逐主题结构色写 `src/theme/tokens.css`，跨主题交互 ramp 写 `src/theme/derived-tokens.css`。
- 令牌层改动后运行 `npm run ds:tokens` 更新 `.ai/ds/ds-tokens.json` 快照；`npm run ds:tokens:check` 失败即视为变更未交付。
- 布局键（字号/字重/字距/标签几何）只改 `src/theme/layout-tokens.css`，主题块与皮肤不得覆盖。
- 用户可见文案（i18n 值、schema description、组件字符串字面量）禁止 em dash（—）与间隔中点（·）。
- 用户可见文案禁止 AI 演示风动词：elevate / seamless / revolutionize / supercharge / effortless / delve / unleash / empower。
- 用户可见字符串禁止开发者标记：TODO / FIXME / "AI generated" / "This component"；逻辑代码中的 WHY 注释保留。
- 面向用户的产物（主题 schema、导出文件、错误提示）不得含仓库内部路径（如 `src/…`）。
- `unlock`/「解锁」是凭据保险库功能术语，豁免于禁词，不得按营销措辞改写。
- 装饰性 `hover:scale-*` 禁止；功能性豁免只能登记在 `scripts/ds-lint.mjs` 的 EXEMPTIONS 并附理由。
- UI 变更交付前依次通过 `npm run ds:lint` → `npm run ds:tokens:check` → `npm run check`；失败时修复或登记豁免，禁止放宽检查正则。
- 生成或审查 Tauri UI（`src/components`、`src/windows`、`src/theme`、`src/i18n`、用户可见模板）时，加载 `.agents/skills/deslop-ui/SKILL.md` 并按其生成前约束、生成后自检与审计简表执行。

## xterm.js 开发与性能规范

在开发本项目的高性能终端功能时，所有涉及 `xterm.js` 的组件编写、重构或数据流处理，**必须严格遵守**以下架构与性能准则，严禁直接在主线程同步挂载或进行未经节流的高频数据渲染。

### 1. 渲染与性能优化 (Performance & Rendering)

- **强制启用 WebGL 渲染器**：所有终端实例在成功调用 `term.open()` 后，必须加载并优先启用 `@xterm/addon-webgl` (`WebglAddon`)，避免默认 DOM 渲染器在多行、高频输出时触发严重的 Reflow/Repaint 导致 UI 卡死。同时必须做好回退处理（当 WebGL 不可用时降级为 Canvas/DOM 渲染器）。
- **异步错峰初始化**：禁止在 React 组件的 `useEffect` 初始触发点直接同步创建 `Terminal` 实例。必须使用 `requestAnimationFrame` 或 `setTimeout` 错开首屏关键渲染路径。
- **内存与资源释放 (Dispose)**：所有 `Terminal` 实例、`Addon` 插件以及监听的 Tauri 事件监听器（`unlisten`），必须在组件卸载（`return () => {...}`）时显式调用 `.dispose()` 和清理函数，防止内存泄漏和 IPC 句柄残留。

### 2. 生命周期与标签页管理 (Lifecycle & Mount Strategy)

- **按需挂载 (Lazy Mount)**：参考 VS Code 架构，后台未激活的终端标签页（Background Tabs）严禁在 DOM 中真实渲染 `xterm` 实例。仅保留其 Buffer 状态或通过虚拟化/状态缓存管理，切到当前标签页时再动态挂载并执行 `FitAddon.fit()`。
- **尺寸自适应 (Resize Handling)**：窗口大小改变或侧边栏收起/展开时，必须结合 `ResizeObserver` 或 Tauri 窗口缩放事件计算目标行列；垂直方向立即应用，水平方向防抖，离散突变（最大化/还原）绕过防抖。

### 3. 数据流与 IPC 传输节流 (Stream Throttling & Batching)

- **防止主线程雪崩**：当 Rust 后端通过 Tauri 事件高频向前端推送终端标准输出（Stdout）时，前端严禁“来一条写一条（`term.write()`）”。
- **批处理与帧同步**：对后端传来的高频文本数据进行队列缓存（Buffer Queue），利用 `requestAnimationFrame` 或定时节流（如每 16ms / 32ms 批量写入一次），合并渲染帧，保证终端滚动的 60fps 流畅度。
- **跨块 UTF-8 边界解码**：后端推送前必须经 `text_stream::Utf8StreamDecoder` 增量解码（PTY 与 SSH 两侧均已接入；SSH 的 stdout/stderr 各用独立解码器），多字节字符跨读取边界时不得把两半替换成 U+FFFD 烧入滚动缓冲。
- **阻塞操作不得进入主线程**：可能阻塞的 IPC 命令（PTY 管道写、大文件读写、Argon2 派生）必须是 async 命令并配合 `spawn_blocking`/`tokio::fs`，禁止在 UI 主线程同步执行。

### 4. 缓冲区与尺寸突变防丢行/防重复策略 (Buffer Safety & Mutation Strategy)

在使用 ConPTY (Windows) 或 PTY (UNIX) 进行窗口尺寸调整时，必须严格遵守以下防止文本“重影/丢行”的交互策略：

- **混合尺寸同步策略 (Hybrid Debounce Strategy)**：
  - **按事件来源区分连续与离散**：ResizeObserver 驱动的变化（分屏拖拽、窗口拖拽缩放、侧栏开合）一律视为**连续变化**，即使单次跳变超过 200px 或缓冲区很小——逐帧 resize 会让 xterm reflow 与 ConPTY 重绘交错，造成文字叠印。
  - **垂直缩放（rows）**：立即应用。行变化不触发水平 reflow，且能避免 DOM 与 PTY 行数脱节。
  - **水平缩放（cols）**：连续变化**始终**走约 300ms 防抖（按最新目标收敛），给 shell 留出处理 SIGWINCH 与重绘提示符的时间，避免提示符重影；拖拽/变化停止后由最后一次防抖尾火收敛到最终尺寸。300ms 是本项目取值（理由同 microsoft/vscode#334532），**不要**照抄 VS Code `TerminalResizeDebouncer`：其 main 分支仍是 100ms，且 normal buffer 少于 200 行时完全不防抖。
  - **离散突变（窗口最大化 / 恢复、标签页激活、字体设置变更）**：**必须绕过防抖（Bypass Debounce）**，立即应用最新尺寸并强同步给 PTY。
  - **无变化不发送**：请求的 cols/rows 与当前网格一致时不得调用 `resize()`，避免无意义的 SIGWINCH 风暴。
  - **隐藏标签页不得丢弃尺寸事件**：`ResizeObserver` 在 `visible=false` 时仍要更新缓存的宽高再返回；被忽略的通知不会重发，切回标签页依赖 `resume()` 的离散 refit。
  - **防抖窗口内的视觉裁剪**：终端宿主容器必须 `overflow-hidden`，防抖生效前旧尺寸画布被裁剪而不是溢出到相邻面板。
  - **解析等待回退是卡死检测而非超时硬切**：resize 等待已发出写入解析完成时，回退定时器在解析器仍有进展（有 write 回调完成）时必须重臂；只有整整一个窗口无任何进展才允许在未解析状态下 reflow。单次 `terminal.write` 的回调只在**整块**解析完后触发，所以批量写入必须按约 16 KiB 切片（`PARSE_SLICE_CHARS`），否则一次大块写入会让“有进展”永远观察不到。
  - **reflow 必须等后端 resize ack（两阶段，ack 窗口内保持冻结）**：xterm 的 reflow 与 ConPTY 自己回并折行行是两个独立事件。`local-reflow` 会话在 `instance.resize()` 之前，先写完旧几何输出并等解析，然后**保持写队列冻结**、`await sendBackendResize(...)`（后端已采纳新尺寸），ack 后立即 reflow，最后解冻——ack 窗口内到达的字节一律按新网格解析。不能把新几何重绘在旧网格上解析（会直接写坏缓冲区），也不要为了“让旧输出继续渲染”而在 ack 前解冻；旧几何回显即使错位到提示符下方，随后到达的重绘 `CUP ... \e[J` 会擦掉它。不这样做时，按旧几何产出的回显 CUP 会在新网格上渲染，落点正好是回并后提示符下方 N 行（N = 回并组数），表现为提示符下方隔行重复命令、光标错位。`shell-repaint` 会话（SSH/Telnet/readline）不等网络 RTT，直接 reflow。`sendBackendResize` 对相同尺寸去重、单飞、收敛最新值，并返回 ack Promise；等待有 500ms 卡死兜底，超时会提前 reflow 并记日志。
  - **连接窗口内的 resize 不得丢弃**：`resizeTarget` 为 null（PTY 创建中、重连窗口）时请求进 `queuedResizeWithoutTarget`，transport 注册 target 时由 `flushQueuedBackendResize` 补发；没有排队值时发送当前网格。不要恢复成 `if (!resizeTarget) return`。
  - **光标行重排按 shell 能力分流（cursor-line policy）**：xterm.js 的 reflow 默认跳过包含光标的折行组。cmd.exe / conhost 在 SIGWINCH 后**不重画**提示符；PowerShell / pwsh 的 PSReadLine 也**不重画**，而是在下一次按键时发 `DSR 6n`、拿到光标位置后只重画输入行。因此本地 cmd / PowerShell / pwsh 会话必须启用 xterm 6 的 `reflowCursorLine: true`，由终端自己拆分/回并光标组；bash / zsh / fish / Git Bash / WSL 使用 readline、zle、fish，会在 SIGWINCH 后从“它认为的当前光标行”重画提示符，**绝不能** park 或本地重排光标行，否则会重复提示符或吞掉上一行。会话类型与 `shellCommand` 经 `src/lib/terminalResizePolicy.ts` 解析为 `local-reflow` / `shell-repaint`，SSH / Telnet / Serial 一律 `shell-repaint`；自定义 shell 默认 `shell-repaint`。禁止再按“这一行会不会被截断”判断是否 park。
  - **ConPTY 重绘的尾部有三种变体**：缩小是 `CUP, Erase, CUP, 文本 + 补空格, CUP`；从折行光标行放大是 `... 文本, \e[K, CUP`；其余放大是 `... 文本, CUP`。`ResizeRepaintFilter` 三种都算 complete，只剥掉“最终 CUP 前的空格 run”（保留 `\e[K`），`\e[0J` 也认作 erase。当光标行位于视口最后一行时，补空格会触发自动折行、滚动视口，使后续 CUP 落到空行；保留可能合法折行的文本（16–18 列时 `help` 正好从最后一列开始折行，整批关闭 DECAWM 会丢字）。hold 上限 8 KiB，避免宽终端长提示符重绘跨块时 padding 漏裁。
    - 过滤器**不是“首个批次一次性”**：重绘可能和别的输出同批、前面带前缀、被 IPC 切成两半。匹配不到就继续 armed 直到命中或 150ms 超时；只保留“仍是重绘前缀”的尾部（`repaintHoldLength`），其余立刻透传，超时/取消时把 hold 住的字节原样发出去，不许吞。
    - **前一个重绘窗口必须先落定再开始下一次重排**（`runResize` 等待 `whenSettled`）：否则冻结写队列会让上一轮重绘到达不了过滤器，补空格原样写进 xterm 后再叠加新一轮 reflow，正是重影来源。等待期间不冻结队列，常规 16ms flush 仍走过滤器。
    - 队列数据出队时**必须经过 `repaintFilter.consume()`**，禁止裸 `issueWrite`，否则上一轮重绘绕过裁剪。
    - 拦截直写（快照恢复、断线通知）与被取消的重绘窗口都要把 `cancel()` 返回的残余字节写回，保持 FIFO。
    - 备用缓冲不启用。回归用例见 `src/lib/terminalResizePolicy.test.ts`、`src/lib/terminalResizeReplay.test.ts`、`src/lib/terminalResizeRepaint.test.ts`。
  - **底部精确填满时提交 pending wrap**：缩小前若行末内容恰好等于目标 cols、且光标已越过最后一个字形（pending wrap），ConPTY 会在内部先滚动一行，xterm 不会；下一次输入用 `CUP row30 col1` 会覆盖提示符。`local-reflow` 缩小 cols 时，**在 `resize()` 之前**用 `shouldCommitConptyPendingWrap(buffer, previousCols, previousRows, targetCols)` 判定（normal buffer、光标在最后一行、`occupiedCellEnd === targetCols`、`cursorX >= contentEnd`），命中时 resize 后向 xterm 补一个 `LF`；放大不执行。判定必须在 resize 前：resize 会把 pending-wrap 的 `cursorX === cols` 夹到 `cols - 1`，之后与“光标停在最后一个字形上”无法区分，而后者 ConPTY 不滚动。
    - `occupiedCellEnd` 必须按单元格宽度累加，宽字符的后半格 `getWidth() === 0` 不能当成空列（中文提示恰好填满时必须命中）。回归用例见 `src/lib/terminalResizePendingWrap.test.ts`。
  - **ConPTY DA1 必须应答**：ConPTY 1.22+ 启动时会发 `CSI c` 并等待设备属性，不应答会卡住首个提示符与首轮 SIGWINCH。本地 ConPTY 会话在 `Terminal` 创建后注册 `parser.registerCsiHandler({ final: 'c' })`，主 DA（无参数或 `0`）回 `\x1b[?61;4c` 并返回 `true` 吞掉该序列；`CSI > c` 等带 prefix 的次级 DA 不匹配该 handler，仍交给 xterm。PTY id 尚未就绪时先排队，`resizeTarget` 赋值后补发。
- **ConPTY 与缓冲区安全 (ConPTY Buffer Safety)**：
  - Windows 端随包加载 Microsoft ConPTY 1.25（`conpty-assets`），确保 `PSEUDOCONSOLE_RESIZE_QUIRK` 生效，避免系统 ConPTY 在 resize 时重印整屏；许可证与哈希见 `src-tauri/THIRD_PARTY_NOTICES.md`。`pty_platform_info` 会报告 `bundled`；加载失败回退系统 ConPTY 时前端 `console.warn`，因为系统后端是另一套契约（整屏重印 + 回显裸文本、不重锚定 CUP），不要按光标行重绘假设去调它。
  - 创建 Terminal 时注入真实的 `windowsPty: { backend, buildNumber }`，启用 xterm 针对 ConPTY 的行增长与 reflow 策略；本地 cmd / PowerShell / pwsh 另开 xterm 6 的 `reflowCursorLine`。
  - resize 前同步空 `alt` buffer 的 `lines.maxLength` 到目标行数，规避 xtermjs/xterm.js#6163 在垂直 grow 时把幻影行拉回视口造成的重影。
  - 针对 Windows ConPTY 在 resize 时发送的重绘与清屏控制符（如 `\x1b[2J` / 光标定位符），前端在 resize 期间**严禁主动清空或截断 `xterm.js` 的 `write` 缓存队列**；通知类直写（断线/重连提示等）在冻结期必须等待解冻后再写，保持 FIFO。
  - 数据流接收必须保证**FIFO（先进先出）严格顺序**，防止 resize 事件与 PTY 吐出的重绘数据发生乱序交织。
- **状态切换防抖清理 (Debounce Flush on Unmount/State Change)**：
  - 在标签页切换、窗口状态改变前，必须显式调用防抖函数的 `.flush()`，确保队列中积压的最后一次 `resize` 指令无条件送达 Rust PTY，避免出现“DOM 已变大但 PTY 停留在旧尺寸”导致的中间行丢失。

## 路线图

- [x] 平台脚手架（Tauri + React + TypeScript）
- [x] 本地 PTY 会话与 xterm 集成
- [x] Dockview 多面板布局
- [x] 会话管理、分屏、命令面板与布局持久化
- [x] Web 2.0 主题系统（明亮 / 暗黑 / 跟随系统）
- [x] SSH 密码 / 私钥认证
- [x] known_hosts 校验与首次指纹确认、OpenSSH 格式导入/导出（原子写 + 损坏保留、裸 IPv6 导入、指纹确认超时自动关窗、握手期间可取消的连接占位）
- [x] SSH Agent 认证
- [x] 端口转发（本地 / 远程 / 动态 SOCKS5）
- [x] SFTP 目录浏览、上传/下载与传输队列
- [x] SFTP 新建 / 重命名 / 删除
- [x] 设置面板（主题 / 终端外观 / SSH 默认值 / 快捷键 / known_hosts）
- [x] 递归传输、断点续传、暂停/取消/重试、冲突策略
- [x] SSH 保活（30s / 3 次）、断线自动重连（指数退避）、断线后端口转发清理与会话状态回收
- [x] 加密凭据保险库（主密码、Argon2id + AES-256-GCM、KDF 参数随文件持久化、异步命令 + 磁盘操作互斥）
- [x] 会话导入（SSH config / MobaXterm / PuTTY）、v2 全字段 JSON 备份（Telnet/Serial/证书/ProxyJump/自定义 Shell 无损 round-trip，兼容 v1）、树形分组
- [x] 终端 WebLinks / Unicode11 / 选中即复制 / 滚动缓冲恢复
- [x] i18n 骨架（中 / 英核心工作区）
- [x] OpenSSH 证书认证、跳板机 / ProxyJump（单跳；SFTP 与端口转发复用隧道）
- [x] 命令片段、会话日志、updater 自动更新脚手架（设置 > 关于 检查更新）
- [x] Telnet 会话（最小 NVT：协商全拒、终端内登录、复用日志管线）
- [x] i18n 全量迁移（五分片字典 + 中英键位一致性测试；组件用 useI18n、非组件用 tStatic）
- [x] 多会话广播输入（会话标签右键 / 命令面板加入，状态栏徽标；PTY/Telnet/Serial 传输 id 已在连接表登记，条目存在 ⇔ 有活跃连接）
- [x] 本地会话可选 Shell（预设探测 + 自定义可执行文件与参数，参数支持引号）
- [x] SFTP 拖拽上传（OS 拖入，命中测试 + 覆盖层）与面板内拖动移动（SFTP rename）
- [x] 远程文件本地编辑（临时副本 + 保存自动回传，走 SFTP 上传引擎与传输队列）
- [x] ZMODEM 接收（sz 自动下载到系统下载目录，纯状态机 + 离线单测；复用传输队列展示与取消）
- [x] 发布 CI（release.yml：v* 标签三平台构建 + updater 签名产物 + Draft Release）
- [x] 系统托盘（快速启动菜单 + 左键唤起）、全局唤起快捷键、关闭最小化到托盘（设置 > 外观）
- [x] 宏录制/回放（命令面板录制/保存/回放，按键与停顿按序发送；设置 > 片段 管理）
- [x] 片段变量占位（{{变量}} 顺序提示输入）与执行前确认（单片段开关）
- [x] 串口会话（serialport；端口探测/波特率预设；无自动重连，手动重连）
- [x] 自定义主题（主题文件夹 drop-in JSON + Windows Terminal / iTerm2 配色导入、notify 热重载、编辑器 schema 自动补全；structure 结构覆盖）
- [x] 会话终态结束块与键盘操作（缓冲内 MobaXterm 式结束块 + R 重连/Enter 关闭/Esc 取消重连/S 保存输出到文件；自动重连倒计时右下角浮条；SSH 断开路径视口跳顶修复）
- [x] 现代主题 4 族 8 款（Slate / Graphite / Terminal Green / Sandstone）、强调色自定义、终端配色跟随界面、对比度门禁
- [x] 依赖审计门禁（cargo audit + npm audit --omit=dev）与 SECURITY.md 漏洞披露流程
- [x] 质量审计整改第一批：transport 连接表不变量与 Serial 广播、SFTP/ZMODEM/远程编辑失败路径 fail-closed、凭据删除墓碑重试、backup v2、设置迁移加固、根级/面板级 Error Boundary、de-slop 检查器增强（black/white + 原始 JSX 文案）、i18n 键使用扫描、敏感缓存保留与清理入口
- [x] 质量审计整改第二批：SFTP 健康检查不再持锁等待 RTT（5s 信任窗 + 无锁探测）、sftp-transfer-done 按面板会话过滤并合并刷新、ssh 后端抽边界第一批（known_hosts 存储与编解码移入 ssh/host_keys.rs，14 个测试随迁）、SettingsWindow 抽边界第一批（known_hosts 卡片拆为展示组件）
- [x] 产品决策落地：滚动缓冲快照改为三态范围设置（所有 / 仅本地（默认）/ 关闭，legacy 布尔迁移），ZMODEM 接收确认（`zmodemAutoReceive` 关闭时经 `BatchStartScanner` 在握手应答前拦截，复用主机密钥式 120s 超时对话框，拒绝发取消序列）
- [ ] 拆分续批：XtermCanvas（建议边界：TransportAttempt 连接编排 → TerminalOutputPipeline 写队列/解析等待 → ResizeCoordinator，先补组件测试再动）；ssh/mod.rs 剩余（连接握手、SFTP 传输引擎、端口转发各成模块）；SettingsWindow 剩余（Vault、主题、片段各成卡片组件）
- [ ] IPC Rust/TS 共享 schema 或生成绑定（消除手写字段与字符串枚举；需引入 schemars/ts-rs 或等价方案并评估构建链影响）
- [ ] 后台标签资源释放：DockLayout defaultRenderer="always" 使全部 xterm/WebGL 上下文常驻；需要休眠策略 + WebGL 释放 + LRU 上限（改动触及渲染管线，须实机回归）
- [ ] 需要外部资源，暂缓（仅记录）：Windows 代码签名 / macOS 公证（需要证书与公证账号）、真实 SSH/SFTP 服务器集成测试容器与 E2E（需要测试基础设施）、终端高输出/大目录性能基准（需要实机测量）、cargo audit 本地运行（此前 TLS 握手失败，CI 已覆盖）、ConPTY resize 探针进默认 CI（需 Windows runner 验证）
- [ ] trzsz / rz 发送端（ZMODEM 上行）、SSH Agent 转发、多跳 ProxyJump；待收敛 IPC 面（known_hosts 导入导出路径、ZMODEM 接收前确认、统一本地文件授权模型）
