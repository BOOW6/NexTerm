# 终端折行与尺寸消抖：实现契约、与 VS Code 的对照、版本策略

> 状态：实现见 `src/components/terminal/XtermCanvas.tsx`、`src/lib/terminalResize*.ts`，
> 本文描述**当前必须成立的行为**。历史排查过程（ConPTY 字节流探针、readline 8.2 源码、
> xterm headless 回放）不再重复，只在需要解释动机时引用结论。

## 1. 问题域

横向改变终端宽度时，终端模拟器与对端程序对“重排后屏幕长什么样”必须先达成一致。分歧
会表现为四类症状：

| 场景             | 症状                                                        |
| ---------------- | ----------------------------------------------------------- |
| Windows 本地 cmd | 缩放宽后提示符被截断（`(c) Microsoft Chelp`），或输入落错行 |
| Windows 本地 cmd | 提示符恰好填满最后一行时，下一次输入覆盖提示符              |
| Linux / SSH bash | 收缩后提示符重复成两行；放大后吞掉提示符上一行              |
| 任意会话         | 拖拽过程中文字叠印、幽灵空行、光标错位                      |

共同点：**缩放发生在“光标所在行需要重新折行”时**，且终端与 shell 的重绘动作交错。

## 2. 两条判据（不要混为一谈）

### 2.1 谁负责重排光标行：由 shell 能力决定

xterm.js 的 reflow 默认跳过包含光标的折行组，注释写得很清楚：程序会自己修光标行。
问题是对端程序分两类：

- **不重画提示符**：cmd.exe / conhost，以及 PowerShell / PSReadLine。后者不在 SIGWINCH
  时输出，而是在下一次按键发 `DSR 6n`，拿到光标位置后**只重画输入行**。两者都要求终端
  先把光标行重排好，否则提示符前缀永久丢失。
- **重画整个提示符**：bash / zsh / fish（readline、zle、fish）。它们按自己记录的光标行
  向上回退再重画；只要终端移动过光标行，回退基准就错了，表现为重复或吞行。

因此 `cursorLineResizeMode` 只能由会话的 shell 能力推导，**不能**按“这一行会不会被截断”
判断。判定实现在 `src/lib/terminalResizePolicy.ts`：

| 会话                                         | 模式            | 理由                                                     |
| -------------------------------------------- | --------------- | -------------------------------------------------------- |
| 本地 Windows `cmd.exe`、默认 ConPTY shell    | `local-reflow`  | conhost 不重画提示符                                     |
| 本地 PowerShell 5 / pwsh                     | `local-reflow`  | PSReadLine 只重画输入行，提示符需本地重排                |
| 本地 Git Bash / WSL / *nix bash / zsh / fish | `shell-repaint` | readline / zle / fish 自己重画                           |
| SSH / Telnet / Serial                        | `shell-repaint` | 远端通常是 readline 类；Telnet/Serial 的 resize 是 no-op |
| 自定义 shell                                 | `shell-repaint` | 未知程序不应被本地重排（保守侧）                         |

`local-reflow` 同时启用 xterm 6 的 `reflowCursorLine: true`；`shell-repaint` 保持 xterm
stock（跳过光标组 + 截断）。

### 2.2 ConPTY 的重绘字节必须裁剪

随包 ConPTY 1.25 在 resize 时**不是静默**，而是只重绘光标行尾部：

```text
CUP, Erase-to-end, CUP, <文本 + 尾部补空格>, CUP
```

补空格在光标行正好位于视口最后一行时会触发自动折行、滚动视口，使随后的绝对 CUP 落到
空行。裁剪只剥掉**最终 CUP 前的尾部空格**；整批关闭 DECAWM 会吃掉合法折行（16–18 列时
`help` 正好从最后一列开始折行）。

## 3. 数据流与不变量

### 3.1 写入路径

```text
Tauri 事件 (32 KiB / 次)
  → enqueueWrite (16ms 批处理，最多 4 MiB 积压)
  → flushWrites → issueWrite (按 16 KiB 切片)
  → xterm.write
```

不变量：

- **FIFO**：所有输出（含 resize 期间的 ConPTY 重绘、通知直写、快照恢复）严格按到达顺序
  进入 xterm。
- **切片解析**：`terminal.write` 的回调只在**整块**解析完后触发。`issueWrite` 按
  `PARSE_SLICE_CHARS`（16 KiB）切片，保证 resize 的“解析无进展”检测能看到中间进度；
  切片不切断 UTF-16 代理对（转义序列可以跨片，xterm 解析器有状态）。

### 3.2 resize 状态机

```text
requestResize(cols, rows, immediate)
  ├─ 网格未变            → 取消防抖与在途目标，不发 SIGWINCH
  ├─ immediate           → applyResize 立即
  ├─ rows 变化           → 立即 applyResize(currentCols, rows)
  └─ cols 变化           → 300ms 尾防抖，收敛 latestDimensions

applyResize
  → 若通知/快照直写中         → 停在 desiredDimensions，序列结束后 resume
  → 等上一轮重绘窗口落定      → whenSettled 后再进入（见 3.3）
  → 冻结写队列 + 取消 16ms flush
  → 队列余量经 repaintFilter.consume() 写入
  → 等已发出写入解析完（回退定时器只在“整窗无进展”时才放行）
  → local-reflow：保持冻结，sendBackendResize 并等待 ack；
     shell-repaint：直接 applyGridResize（远端重画，不必等网络 RTT）
  → ack 后 applyGridResize（队列仍然冻结）
  → 解冻、恢复 flush：ack 窗口内到达的字节按新网格解析
  → 若 desiredDimensions 仍新则重入
```

**两阶段 reflow 的原因**：xterm 的 reflow 与 ConPTY 自己回并折行行是两个独立事件。
如果 xterm 先 reflow、`resize_pty` 还在途，PTY 里按旧几何产出的回显 CUP 会在新网格上
渲染，落点正好是回并后提示符下方 N 行（N = 回并掉的折行组数）——表现为提示符下方隔
行出现重复命令、光标错位。因此 `local-reflow` 会话必须等后端 ack 后再 reflow；
`shell-repaint` 会话由 shell 在 SIGWINCH 后自行重画，逐帧等网络 RTT 会毁掉手感，保持
立即 reflow。

**ack 窗口内保持冻结**：发送 resize 后，新到达的字节可能是“PTY 尚未处理 resize 的旧几何
输出”，也可能是“已处理后的新几何重绘”。两者无法从字节流区分，而把新几何重绘放在旧网格
上解析会直接写坏缓冲区（探针场景：`CUP 4;16 ... \e[J` 被当成旧网格第 4 行，擦掉横幅）。
因此统一在 reflow 后再解析：新几何重绘一定落在正确网格；旧几何回显即使错位到下方，随后
到达的 `CUP ... \e[J` 重绘会把它擦掉（光标行及以下）。不要为了“让旧输出继续渲染”而在
ack 前解冻。

`sendBackendResize` 返回“最新目标已被后端确认”的 Promise；相同尺寸去重（`onResize`
在 `applyGridResize` 后会重发同一网格），仍保持单飞与“收敛到最新值”。等待 ack 设有
500ms 兜底：IPC 回复丢失时不能把后续 resize 与直写通知永远堵在 `applyInProgress`
后面（也限制冻结窗口内的输出积压）；超时会打日志并提前 reflow（会重新引入旧 CUP
错位风险，仅作为卡死逃生口）。

**连接窗口内的 resize 不丢**：`resizeTarget` 为 null（PTY 创建中、重连窗口）时请求
进入 `queuedResizeWithoutTarget`，由 `flushQueuedBackendResize` 在 transport 注册
target 时补发；没有排队值时发送当前网格。三条 connect 路径（local / SSH / Telnet）
统一走这个入口，boot 输出从第一字节起就按同一几何产出与渲染。

`applyGridResize` 的顺序不可交换：

1. 记录 `previousCols/previousRows`；
2. **resize 前**判定 pending wrap（见 3.4）；
3. 同步空 buffer 容量，`instance.resize()`；
4. 命中 pending wrap 且 normal buffer → 补一个 `LF`；
5. `local-reflow` + normal buffer → `armResizeRepaintFilter()`（打开 150ms 重绘窗口）。

`resize()` 触发的 `onResize` 会把最终尺寸同步给后端 PTY（PTY / SSH / Telnet）。

### 3.3 `ResizeRepaintFilter` 契约

```ts
arm(): string                 // 打开窗口，返回上一窗口 hold 的残余字节
consume(data): string         // 命中裁掉补空格；否则透传并 hold 未完成前缀
whenSettled(cb): void         // 命中/超时/取消后异步触发
takeCarry(): string           // 取出 hold 的字节（不解除）
cancel(): string              // 解除窗口并返回 hold 的字节
```

必须全部成立：

- **重绘尾部有三种真实变体**（bundled ConPTY 1.25 探针采集）：缩小时是
  `<文本><空格 padding><CUP>`；从折行光标行放大时是 `<文本>\e[K<CUP>`；其余放大是
  `<文本><CUP>`。三者都算 `complete`，只有“空格 run”（保留 `\e[K`）算 padding。
  旧实现只认“空格 + CUP”，后两种会一直 armed 到 150ms 超时，既延迟最终 CUP，也让
  下一轮 resize 卡在 `whenSettled`。
- **不是“首个批次一次性”**。重绘可能和别的输出同批、带前缀、或被 IPC 切成两半。匹配
  不到就继续 armed 直到命中或 150ms 超时；`repaintHoldLength` 只保留“仍是重绘前缀”的
  尾部，其余立即透传。hold 上限 8 KiB：宽终端的长提示符重绘可能超过 512 字节，上限太
  小会让跨块的 padding 原样写入。
- **任何路径都不许吞字节**：超时、`cancel()`、`arm()` 重入时，hold 住的字节要么由调用方
  立即写回，要么随返回值带回。
- **前一个窗口落定才能开始下一次重排**。否则冻结写队列会让上一轮重绘到达不了过滤器，
  补空格原样写进 xterm，下一轮 reflow 在已滚动的缓冲上进行——这就是重影的根因。
  等待期间**不冻结队列**，常规 16ms flush 照常经过过滤器。
- 队列余量出队时必须走 `consume()`，禁止裸 `issueWrite`。
- 直写拦截（快照恢复、断线/重连通知）前先 `cancel()` 并把返回字节写回；直写期间
  `directWriteDepth > 0`，任何 resize 只停在 `desiredDimensions`。
- 备用缓冲（alt buffer）不启用：vim/less 自己重画，终端不得裁剪。

### 3.4 pending wrap 契约

ConPTY 在缩小列宽时，如果光标已越过最后一个字形、且该行内容恰好等于新宽度，会在内部
先滚动一行；xterm 只会重排、不提交 pending wrap。下一次输入的 `CUP` 就覆盖了提示符。

判定必须**在 `resize()` 之前**，因为 resize 会把 pending-wrap 的 `cursorX === cols` 夹到
`cols - 1`，之后与“光标停在最后一个字形上”无法区分，而后者 ConPTY 不滚动。

```ts
shouldCommitConptyPendingWrap(buffer, previousCols, previousRows, targetCols);
```

命中条件（全部满足）：

- normal buffer；
- 光标在最后一行；
- `occupiedCellEnd(line, previousCols) === targetCols`（行末内容恰好填满目标宽度）；
- `cursorX >= contentEnd`（光标在内容之后，即 pending wrap，而不是停在最后一个字形上）。

`occupiedCellEnd` 必须按单元格宽度累加：宽字符占两格，后半格 `getWidth() === 0`，不能
当成空列。中文提示恰好填满时必须命中。**已写单元格按 `getCode() !== 0` 判定**：用户
真正键入的空格 code 为 32，未写/擦除的单元格 code 为 0；按 `getChars().trim()` 判空会
漏掉“提示符 + 尾随空格恰好填满”的 pending wrap。

命中后行为：`resize()` 之后补一个 `LF`。放大不执行。

### 3.5 ConPTY DA1

ConPTY 1.22+ 启动时发 `CSI c` 并等待设备属性应答；不应答会卡住首个提示符与首轮
SIGWINCH，表现为“消抖迟迟不生效”。本地 ConPTY 会话在创建 `Terminal` 后注册
`parser.registerCsiHandler({ final: 'c' })`：

- 主 DA（无参数或 `0`）→ 回 `\x1b[?61;4c`，返回 `true` 吞掉该序列；
- `CSI > c` 等带 prefix 的次级 DA 不匹配该 handler，交给 xterm；
- PTY id 尚未就绪时先排队，`resizeTarget` 赋值后补发。

### 3.6 尺寸事件来源

- **ResizeObserver**：一律视为连续变化。rows 立即应用，cols 走 300ms 防抖。
- **隐藏标签页**：observer 仍更新缓存宽高再返回（忽略的通知不会重发）；`visible` 变化时
  `flushPendingResize()` + 离散 `refit(true)`。
- **最大化 / 恢复**：窗口状态变化后等两帧再 `refit(true)`，绕过防抖。
- **标签卸载**：先 `cancel()` 重绘窗口并写回残余字节，再以同一 `applyGridResize` 提交最后
  尺寸（不开启新窗口），保证 PTY 尺寸与 pending wrap 与画面一致。
- 请求的 cols/rows 与当前网格一致时不得调用 `resize()`。

## 4. 与 VS Code 的对照

对照对象：`microsoft/vscode` main 分支（2026-11）的
`src/vs/workbench/contrib/terminal/browser/terminalResizeDebouncer.ts`、
`terminalInstance.ts`、`xterm/xtermTerminal.ts`。

| 维度              | VS Code main                                                    | 本项目                              | 结论                                                         |
| ----------------- | --------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------ |
| 水平防抖          | 100ms；normal buffer < 200 行时完全不防抖                       | 恒定 300ms，小缓冲也防抖            | 保留本项目取值（见下）                                       |
| 垂直防抖          | 立即                                                            | 立即                                | 一致                                                         |
| 无变化不发 resize | 有（逐轴比较）                                                  | 有（网格一致即取消）                | 一致                                                         |
| 隐藏终端          | `requestIdleCallback` 收敛                                      | 记录尺寸 + 显示时离散 refit         | 本项目更简单，行为等价                                       |
| 光标行重排        | `reflowCursorLine = backend === 'conpty'`，**所有 ConPTY 会话** | 只对 cmd / PowerShell / pwsh        | **不跟随 VS Code**：Git Bash 走 readline，本地重排会双提示符 |
| ConPTY 重绘裁剪   | 无                                                              | `ResizeRepaintFilter`               | 本项目独有，ConPTY 1.25 的补空格必须处理                     |
| pending wrap      | 无                                                              | `shouldCommitConptyPendingWrap`     | 本项目独有                                                   |
| DA1 应答          | 有（`processTraits.windowsPty.backend === 'conpty'`）           | 有                                  | 已对齐                                                       |
| 解析等待          | 无显式解析边界，依靠 debounce                                   | 写队列冻结 + 解析等待 + 卡死回退    | 本项目更强，代价是状态机复杂                                 |
| xterm 版本        | `6.1.0-beta.337` + 一串 addon beta                              | `6.0.0`（npm `latest`）+ 稳定 addon | **不同步**，见第 6 节                                        |

VS Code 为什么在 100ms 下还能用：它的 `reflowCursorLine` 对所有 ConPTY 会话开启，配合
shell integration 的重绘，问题被放大成“提示符重复”，于是社区提了
[microsoft/vscode#334532](https://github.com/microsoft/vscode/pull/334532) 把延迟改成
300ms。该 PR **没有合入 main**，main 仍是 100ms。本项目采用 300ms 是为了给
`shell-repaint` 会话留出“上一次 SIGWINCH 重画完成”的窗口，语义不同，不要因为看到
VS Code 用 100ms 就改回去。

反过来，本项目不应对 `< 200` 行的小缓冲取消防抖：逐帧 resize 会让 xterm reflow 与
ConPTY 光标行重绘逐帧交错，小缓冲同样叠印。小缓冲的收益是“少等 300ms”，代价不可接受；
需要立即收敛的路径（最大化、标签激活、字体变更）已经走 `refit(true)`。

## 5. 回归矩阵

自动化分层：

| 文件                                        | 覆盖                                                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/terminalResizePolicy.test.ts`      | 会话 → `local-reflow` / `shell-repaint` 判定表                                                                                            |
| `src/lib/terminalResizeRepaint.test.ts`     | 三种重绘尾部、按 padding 裁剪、`\e[0J`、同批前缀、无关输出、跨 consume 拼接、长行、超时、取消                                             |
| `src/lib/terminalResizePendingWrap.test.ts` | 精确填满、尾随空格、擦除格、光标停在最后字形、宽字符、alt buffer、未到末列                                                                |
| `src/lib/terminalResizeReplay.test.ts`      | 真实 ConPTY 顶部/底部 + 13–18 列矩阵 + pending wrap + 折行横幅拖宽 30→100 + 折行光标行 18→100 + 系统 ConPTY 整屏重印 + readline 缩小/放大 |

场景坐标：顶部提示符 / 最后一行提示符 / 已折行命令 / 行中光标 / 长于视口的命令 /
光标下方有输出 / alt buffer / CJK 与 emoji / 1 列边界。

每个场景至少断言：

1. 可见文本按逻辑顺序拼接后与缩放前一致（不丢、不重）；
2. `buffer.active.cursorX/Y` 落在预期行列；
3. 缩放后发送哨兵字符，落在预期光标位置；
4. 放大回原宽度后哨兵仍在同一逻辑行；
5. 提示符上一行内容未被吞；
6. 不出现 `isWrapped` 的幽灵空白行。

Rust 侧：`src-tauri/src/pty/conpty_resize_probe.rs` 保留为字节流探针（`#[ignore]`）：
`conpty_resize_byte_stream_probe`（原始 100→12→100）、
`conpty_wrapped_banner_resize_probe`（30 列折行横幅 → 100 列，光标上方回并两组）、
`conpty_wrapped_cursor_line_resize_probe`（18 列折行光标行 → 100，`\e[K` 重绘）、
`conpty_system_wrapped_banner_resize_probe`（不加载 bundled DLL，观察系统 ConPTY 的
整屏重印契约）。ConPTY 升级后先跑它们重新采集 fixture。

## 6. 版本策略：不同步 VS Code 的 xterm 预发布线

| 包                       | 本项目   | VS Code main       |
| ------------------------ | -------- | ------------------ |
| `@xterm/xterm`           | `6.0.0`  | `^6.1.0-beta.337`  |
| `@xterm/headless`        | `6.0.0`  | `^6.1.0-beta.335`  |
| `@xterm/addon-webgl`     | `0.19.0` | `^0.20.0-beta.330` |
| `@xterm/addon-search`    | `0.16.0` | `^0.17.0-beta.331` |
| `@xterm/addon-serialize` | `0.14.0` | `^0.15.0-beta.331` |
| `@xterm/addon-unicode11` | `0.9.0`  | `^0.10.0-beta.331` |

结论与条件：

- npm `latest` 仍是 `6.0.0`，`6.1` 只有 beta。VS Code 的 pin 组合是“核心 beta.337 +
  webgl beta.330 + headless beta.335”这种非对称组合，只有同时改 xterm 与 VS Code 的
  维护者能保证兼容。
- 6.0.0 中与折行直接相关的改动是
  [#5321](https://github.com/xtermjs/xterm.js/pull/5321)（reflow 靠近 ConPTY 语义）与
  [#5358](https://github.com/xtermjs/xterm.js/releases)（撤回 ConPTY 专用 reflow）。
  `reflowCursorLine`（[#5234](https://github.com/xtermjs/xterm.js/issues/5295)）已知在
  [#5295](https://github.com/xtermjs/xterm.js/issues/5295) 中报“重排后光标位置错误”，
  尚无稳定修复；本项目只用它覆盖 cmd / PowerShell 的精确填满场景，并由 pending wrap 与
  回放夹具兜底。
- 现有回放夹具按 **6.0.0 + ConPTY 1.25** 的真实字节写成。升级到 6.1 beta 会同时改 reflow
  语义与 addon 私有 API（`_core`、WebGL atlas），夹具全部失效，而换不来已发布的折行修复。
- 升级条件（满足任一再动）：6.1 发布稳定版；或某个 beta 明确修复 #5295 且回放夹具在
  升级后全绿；且 addon 与核心版本成组升级、`terminalResizeReplay` 全部重跑。
- **不要**把 Unreleased 的 300ms/100ms 差异或 VS Code 的“全 ConPTY 开启 reflowCursorLine”
  当成本项目的对齐项。

## 7. 已知边界（P2 待办）

1. **远端 Windows cmd（SSH 到 cmd）**：仍按 `shell-repaint`，会被截断。需要会话级覆盖
   （`cursorLineResize` = `auto` / `local-reflow` / `shell-repaint`）。
2. **自定义包装脚本**（`cmd /c bash`、`powershell -NoProfile`）：按 basename 判定可能误判。
   注意当前代码对 `cmd /c bash` 仍返回 `local-reflow`（它是已知可执行文件），与“默认
   `shell-repaint` 是安全侧”不一致；`powershell -NoProfile` 仍是 PowerShell，判定本身正确。
   等会话级覆盖统一解决。
3. **重绘窗口与行重绘的竞态**：行数立即提交时 ConPTY 也会发一次重绘。当前实现把
   “上一窗口落定”作为下一轮 resize 的前置条件，通常行重绘会在 300ms 防抖内到达；若某后端
   把重绘延迟到 150ms 之后，会走超时放行，随后列 resize 才 arm 新窗口——此时旧重绘已原样
   写入，仍可能留下幽灵行。需要现场日志或更长的 fixture 才能进一步收紧。
4. **解析等待的回退窗口**：`RESIZE_PARSE_FALLBACK_MS = 250`。切片后单次回调的最大间隔是
   一片解析耗时；极端宽字符/装饰器场景下仍可能超窗，届时会在未解析完成时 reflow。两阶段
   reflow 的第二次等待也使用同一个回退，因此后端 ack 后若旧几何输出仍在解析，最坏会晚
   250ms 才 reflow。
5. **连续拖拽的 300ms 延迟**：容器先变窄、画布后折行，靠 `overflow-hidden` 裁剪。这是
   正确性换手感的有意取舍。`local-reflow` 还要再叠加一次 resize IPC 往返与最多 250ms 的
   第二段解析等待，最终尺寸的落地上限比 `shell-repaint` 更长。
6. **行数 + 列数同时变化**：先提交 rows，再提交 cols，会产生两次 SIGWINCH。`shell-repaint`
   会话对连续两次重画敏感；300ms 只是把窗口拉长，不能消除“松开手再拖一次”的竞态。
7. **卸载路径**：只提交最后尺寸与 pending wrap，不等待解析、不 arm 重绘窗口（实例即将
   dispose）；两阶段路径在 dispose 后直接返回。分屏卸载瞬间的折行可能不完美。
8. **Telnet / Serial**：后端 resize 为 no-op，前端只改视口，不重排光标行。记录为不支持。
9. **系统 ConPTY 回退**：bundled `conpty.dll` 加载失败时，后端改用系统 ConPTY，resize
   契约完全不同（整屏重印 + 回显裸文本，不重锚定 CUP）。前端在 `pty_platform_info`
   发现 `bundled === false` 时输出一次 `console.warn`；`terminalResizeReplay` 有对应的
   整屏重印夹具。系统 ConPTY 的完整适配（专门处理整屏重印）仍待办；Win10（build <
   21376）下 xterm 还会关闭自身 reflow，只能依赖重印字节。
10. **测试覆盖缺口**：`XtermCanvas` 的重绘窗口序列化、两阶段 reflow、后端 resize 排队、
    DA1 应答、卸载路径目前只有纯函数与 headless 回放覆盖，没有组件级测试（jsdom 里也没有
    真实 PTY）。这些路径必须在 Windows 实机烟测：cmd / PowerShell / pwsh 拖拽缩放、
    Git Bash 与 WSL 收缩/放大、SSH Linux bash，以及分屏拖拽、侧栏开合、最大化/还原、
    字体缩放、标签切换、重连后缩放。排查时先打开
    `localStorage['nexterm.debug.resize'] = '1'` 看 request / parse-drained /
    backend-send / backend-ack / grid-apply 序列。

## 8. 本次修复记录

相对上一版实现（首个批次一次性裁剪 + resize 后判定 pending wrap + 大块写入）修正了：

- **重绘过滤器改为流式窗口**：不再“首个批次不匹配就解除”；支持同批前缀、跨 consume
  拼接、超时/取消时保留残余字节。
- **重绘尾部三种变体**：`空格 padding`、`\e[K`、裸 CUP 都算 complete；`\e[0J` 也算
  erase。旧实现只认第一种，grow 重绘会卡满 150ms。
- **hold 上限 8 KiB 与 `getCode()` 判占位**：修复长行跨块 padding 原样写入、尾随空格
  漏判 pending wrap。
- **两阶段 reflow**：`local-reflow` 会话先 drain 旧几何输出、等 `resize_pty` ack、再 drain
  一次、最后 reflow；旧几何产出的回显 CUP 不会落到回并后的网格上。
- **连接窗口 resize 排队**：`resizeTarget` 为 null 时的请求不再丢，transport 注册时补发。
- **队列余量不再绕过过滤器**：`runResize` 出队时走 `consume()`，消除“上一轮补空格被裸写
  进 xterm”的重影路径。
- **重绘窗口序列化**：下一次 reflow 等待上一窗口落定（命中或 150ms 超时），等待期间不冻结
  队列；通知直写通过 `directWriteDepth` 守卫避免被 waiter 拉起重排。
- **pending wrap 在 resize 前判定**，并用 `occupiedCellEnd` 兼容宽字符；不再把“光标停在
  最后一个字形”误判为 pending wrap。
- **写入切片 16 KiB**：让解析等待的“有进展”检测真正可观察，避免大块写入时在未解析状态下
  reflow。
- **DA1 应答**：本地 ConPTY 会话注册 `CSI c` 处理并回 `\x1b[?61;4c`，PTY id 未就绪时排队。
- **隐藏标签页**：observer 在 `visible=false` 时仍更新缓存尺寸。
- **卸载路径**统一走 `applyGridResize`，并先写回过滤器残余字节。
- **注释修正**：`terminalResizePolicy.ts` 头部不再把 PSReadLine 描述成“重画提示符”。

验证：`npm run check`（typecheck + eslint + vitest，476 通过）与 `cargo fmt --check` /
`cargo clippy --all-targets -- -D warnings` / `cargo test`（101 通过）全绿。
Bundled 与系统 ConPTY 各跑了真实 PTY 探针，字节已写入回放夹具。**未做**应用内交互式
烟测（拖拽、分屏、标签切换）——见第 7 节第 10 条；组件级状态机（两阶段 reflow、后端排队、
DA1、卸载）仍没有自动化测试，实机拖拽是交付前必须补的一步。
