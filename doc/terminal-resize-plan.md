# 终端横向缩放导致光标错位 / 文本重复 / 截断的修复规划

> 状态：已实施（P0 + P1a + P1b）。本文基于真实 ConPTY 字节流探针、xterm headless 回放、
> 以及 readline 8.2 源码的复现结果，给出分阶段修复方案与回归清单；实施记录见第 9 节。

## 1. 问题现象

横向缩小到比当前提示符行更窄（该行需要折行）时，前端与 PTY 对“重排后屏幕长什么样”
产生分歧，出现以下四类症状：

| 场景               | 现象                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| Windows 本地 cmd   | `C:\Users\46838>help` 缩放宽后变 `(c) Microsoft Chelp`，或提示符与 `help` 被拆到两行且中间带前导空格 |
| Linux / SSH bash   | `dietpi@NanoPC-T4:~$ help` 缩宽后提示符重复成两行；恢复宽度时可能把提示符上一行吞掉                  |
| 提示符在最后一行   | 缩小后提示符尾部被截断（`C:\Users:46`），后续输入落在错误行                                          |
| 光标在折行命令中间 | 光标可能跳到相邻行，或命令尾部进入下一行后与旧文本叠印                                               |

共同点：**缩放发生在“光标所在行需要重新折行”时**。提示符行不需要折行、或只是纵向
改变行数时，当前实现基本正常。

## 2. 现有实现与关键假设

相关代码：

- `src/components/terminal/XtermCanvas.tsx`
  - `applyResize()` / `finish()`：冻结写队列 → 等已发写入解析完 → 调 `buildCursorGroupResizePlan()`
    → 写 `plan.before`（把光标 CUP 到组下方空行）→ `instance.resize()` → `buildCursorRestore()`。
  - 初始化时仅本地 PTY 注入 `windowsPty`（ConPTY reflow 语义）。
- `src/lib/terminalCursorReflow.ts`：游标组 parking / restore 的纯函数。
- `src/lib/terminalResizePrompt.test.ts`、`terminalCursorReflow.test.ts`：现有回归用例。
- `src-tauri/src/pty/conpty_resize_probe.rs`：ConPTY 字节流探针。
- `src-tauri/src/pty/conpty_bundle.rs`：注释称 quirk 模式“resize 时不输出”，与实际不符。

现有策略的核心假设有两个：

1. **“光标行会被截断时，就把光标停到组下方空行”**。这是为了绕开 xterm.js 的设计：
   reflow 会跳过包含光标的折行组（`Buffer._reflowSmaller` / `reflowLargerGetLinesToRemove`
   都显式 `continue`，注释为 “the program will handle fixing up wrapped lines with the cursor”）。
2. **“park 之后 xterm 的重排结果与 PTY 端一致”**。对 cmd/ConPTY 而言，这依赖 ConPTY
   内部也做贪心重排，且不重画提示符。

问题在于：**是否需要本地重排光标行，取决于对端程序在 SIGWINCH 后是否自己重画提示符**，
而不是取决于“这一行是否会被截断”。现有实现把两者混为一谈，导致对不同 shell 做反了。

## 3. 复现与验证结论

### 3.1 ConPTY 真实字节流（cmd.exe）

用 `portable-pty` + 随包 ConPTY 1.25 启动 cmd.exe，在提示符行输入 `help` 后缩放到 12 列，
捕获到的 resize 输出不是“空”，而是光标行局部重绘（节选）：

```text
# 100x30 -> 12x30
\e[11;4H\e[J\e[11;4Hhelp            \e[11;8H

# 再放大回 100x30
\e[4;16H\e[J\e[4;16HhelpX\e[4;21H
```

含义：ConPTY 自己完成了整屏重排，但**只重绘光标所在行的尾部**，并假定终端已经把上面的
提示符行重排好。因此对 cmd 来说，xterm 必须本地重排光标行；否则提示符前缀被截断，而
ConPTY 的绝对 CUP 会落在错误行——这正是 `(c) Microsoft Chelp` 一类现象的来源。

同时，重绘尾部会补空格到行尾。当光标行正好在视口最后一行时，这些空格会触发 xterm 的
自动折行，多出一行并滚动视口；ConPTY 随后的 `\e[30;8H` 就落到新的空行上，后续输入也
跟着错位。注意该模式在非最后一行时只会留下一个“幽灵空行”，不会立刻可见，但会污染下一次
放大时的重排。

### 3.2 readline/bash 的 SIGWINCH 行为

readline 8.2 的 `_rl_redisplay_after_sigwinch()`（`display.c`）执行顺序是：

1. `_rl_move_vert(_rl_vis_botlin)`：移动到“当前可见逻辑行的最后一行”；
2. `\r` + `clreol`：清掉**光标当前所在行**；
3. `_rl_move_vert(0)`：按**旧布局**的行数向上回到提示符首行；
4. `rl_forced_update_display()`：从当前行开始重画整个提示符 + 输入。

关键点：readline 假设终端在 resize 时**没有移动光标、也没有重排光标行**，它靠 `_rl_last_v_pos`
（旧行号）向上找提示符首行。只要我们在 resize 前把光标 CUP 到组下方空行，或让 xterm 6 的
`reflowCursorLine` 把光标移到折行后的最后一行，readline 的“向上 N 行”就会从错误位置起算：

- 单行提示符 + park：`_rl_vis_botlin = 0`，readline 认为还在首行，直接在 park 行重画提示符
  → 原提示符行保留，出现重复；
- 原本已折行的提示符 + 放大：旧 `_rl_last_v_pos > 0`，readline 会多向上移动一行，落到提示符
  上一行开始重画 → 吞掉上一行。

用 readline 实际会输出的字节序列回放（`\r\x1b[K` + prompt + input）可以稳定复现：

```text
# 80 -> 22，park / reflowCursorLine:
row0  dietpi@NanoPC-T4:~$ he
row1  dietpi@NanoPC-T4:~$ he   <- 重复
row2  lp

# 同样缩放，stock（不 park、不重排光标行）:
row0  dietpi@NanoPC-T4:~$ he
row1  lp                        <- 正确
```

这与用户报告的 Linux 现象逐字对应。Git Bash / WSL bash、zsh、fish 都属于“resize 后自己
重画”的一类，park 同样会造成重复或吞行。

PowerShell 5 / pwsh 是另一种情况：实测 resize 时**不输出**，在下一次按键时发 `DSR 6n`
（CPR），拿到光标位置后只重画输入行，不重画提示符。因此它们需要和 cmd 一样本地重排
光标行；若交给 stock 行为，提示符前缀会被截断且不会被补回。

### 3.3 xterm.js 版本能力

当前使用 `@xterm/xterm 5.5.0`，没有“重排光标行”的开关。xterm.js 6.0 新增了
`reflowCursorLine` 选项（PR #5234），默认 `false`；设为 `true` 时 `_reflowSmaller` /
`reflowLargerGetLinesToRemove` 不再跳过光标组。它正好可以替代手写 parking，但**只能用于
不会自己重画提示符的客户端（cmd/conhost）**，不能用于 readline 类 shell。

用 xterm 6 headless 回放上面的 ConPTY 字节流可验证：

- `reflowCursorLine: true` + 无 park：顶部/底部提示符在缩小后都得到正确的两行布局；
- 但在 resize 重绘期间临时关闭 DECAWM（`\e[?7l` / `\e[?7h`），让 ConPTY 的行尾补空格被
  裁掉而不是折行，底部提示符的“幽灵行 + 光标落到空行”问题消失；
- 放大回原宽度后，光标也落在正确的提示符行，不再依赖 ConPTY 的补救 CUP。

结论：**按会话能力选择“本地重排”或“交给 shell 重排”，是比“按组形状判断是否 park”更可靠
的判据。**

## 4. 修复方案

### 4.1 策略表

新增一个由 `TerminalTab` / 会话元数据推导出的能力，传给 `XtermCanvas`：

```ts
type CursorLineResizeMode = 'local-reflow' | 'shell-repaint';
```

| 会话                                                     | 模式                         | 理由                                                                          |
| -------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| 本地 Windows `cmd.exe`，或未指定命令的默认 Windows shell | `local-reflow`               | cmd/conhost 不重画提示符，只补光标行尾部                                      |
| 本地 PowerShell 5 / pwsh                                 | `local-reflow`               | resize 时不输出；下次按键 DSR 后只重画输入行，提示符需本地重排                |
| 本地 Git Bash / WSL / *nix bash / zsh / fish             | `shell-repaint`              | readline / zle / fish 自己重画                                                |
| SSH                                                      | `shell-repaint`              | 远端通常是 readline/zle/fish；远端 Windows cmd 作为已知边界，后续加会话级覆盖 |
| Telnet                                                   | `shell-repaint`              | 后端 resize 是 no-op，绝不能本地移动光标行                                    |
| Serial                                                   | `shell-repaint`              | 同上                                                                          |
| 自定义 shell                                             | 默认 `shell-repaint`（保守） | 未知程序不应被本地重排；可在会话设置中覆盖                                    |

判定建议放在纯函数里（便于测试），输入：`transport`、`shellCommand`、`args`：

- 取 `basename(shellCommand)` 小写；`cmd.exe` / `powershell.exe` / `pwsh.exe` / 空且 Windows → `local-reflow`；
- `bash` / `wsl.exe` / `zsh` / `fish` / 其他 → `shell-repaint`；
- SSH / telnet / serial 一律 `shell-repaint`（不看远端命令）。

### 4.2 P0：先止血（不升级依赖也能做）

1. 在 `XtermCanvas` 增加 `cursorLineResizeMode` prop，默认 `shell-repaint`。
2. **仅当 `local-reflow`** 时调用 `buildCursorGroupResizePlan` / `buildCursorRestore`；
   `shell-repaint` 路径完全删除 park，让 xterm 保持“跳过光标组 + 截断”的 stock 行为，由
   shell 的 SIGWINCH 重画修复。
3. 保留现有 `windowsPty` 注入（本地 ConPTY 的行增长语义）。
4. 补测试：
   - readline 字节序列回放（缩小/放大、单行/已折行提示符、光标在行中）；
   - `shell-repaint` 模式下断言 `buildCursorGroupResizePlan` 不被调用（或用 spy）。
5. 这一步可立即修复 Linux/SSH 的重复提示符与吞行；Windows cmd 的底部提示符问题仍在，
   作为 P1 的验收项。

### 4.3 P1：升级 xterm 6，用 `reflowCursorLine` 取代 park

1. 升级依赖（需同步验证 addon peer 兼容）：
   - `@xterm/xterm` → `6.0.x`，`@xterm/headless` → `6.0.x`；
   - `@xterm/addon-fit` → `0.11.x`，`@xterm/addon-webgl` → `0.19.x`；
   - `addon-search` / `addon-serialize` / `addon-unicode11` / `addon-web-links` 按兼容版本
     收敛；升级后跑一遍 WebGL、搜索、Unicode 11、快照恢复、断线重连的冒烟。
2. `new Terminal({ ..., reflowCursorLine: mode === 'local-reflow' })`。
3. 删除 `terminalCursorReflow.ts` 的 park/restore 与 `applyResize` 中的 `cursorPlan` 分支；
   对应的旧用例改写成 xterm 6 回放用例（保留“不得截断/不得重复”的断言）。
4. **ConPTY 行尾补空格裁剪（关键）**：仅 `local-reflow` 且 `cols` 变化时：
   - resize 前记录 `instance.modes.wraparoundMode`；
   - 解冻写队列前写 `\e[?7l`（若原本开启）；
   - 让 resize 后的第一段后端输出（ConPTY 的 `CUP / J / CUP / 文本+空格 / CUP` 重绘）
     在关自动折行状态下解析；
   - 在该段解析完成（或 50–100ms 超时）后按原状态写 `\e[?7h`；
   - 只改前端 xterm 的 DECAWM，不写 PTY；恢复必须覆盖 dispose / 断线 / 重连路径。
   - 已验证：该组合下顶部与底部提示符在 100→12→100 往返后文本与光标均正确，`X`/`Y`
     落在正确行，无幽灵行。
5. `shell-repaint` 路径保持 `reflowCursorLine: false`，不写 DECAWM，不做任何 CUP。
6. 修正 `conpty_bundle.rs` 的过时注释：quirk 模式不是“静默”，而是“只重绘光标行尾部”，
   且该重绘依赖终端侧重排。

### 4.4 P2：可配置与可观测

- 会话级覆盖：`cursorLineResize` = `auto` / `local-reflow` / `shell-repaint`，用于自定义
  shell、SSH 到 Windows cmd、以及未来发现行为不同的程序。
- 开发期日志（仅 dev）：transport、shell、模式、old/new cols、是否触发裁剪、resize 后
  第一段输出长度、cursor before/after。用于现场确认“是谁重画”。
- 把 ConPTY 探针升级为可重复的 fixture 生成器：
  - 场景：提示符在顶部/底部、折行命令、行中光标、CJK/emoji、内容在光标下方、alt buffer、
    仅改 rows、连续拖拽；
  - 输出到 `src/lib/__fixtures__/terminal-resize/*.bin`（体积小），`replay` 测试直接消费；
  - 探针保持 `#[ignore]`，在 CI 之外按需运行。
- Telnet/serial 的 resize 语义单独复核：后端 no-op 时，前端不应单方面重排光标行，
  否则本地布局与远端永远不一致；必要时保持旧网格直到重新连接。
- 关注上游：ConPTY 的 DSR/CPR 重绘（microsoft/terminal#19089）与 cooked read 重排
  （#17668）。若随包 ConPTY 升级后行为改变，优先以 fixture 回放重新评估裁剪逻辑。

## 5. 回归测试矩阵

坐标：顶部提示符 / 最后一行提示符 / 已折行命令 / 行中光标（左方向键）/ 长于视口的命令 /
光标下方有输出 / alt buffer（vim、less）/ CJK 与 emoji 边界 / 1 列宽边界。

宽度：120 → 80 → 60 → 40 → 30 → 20 → 12 → 8，逐步缩小、逐步放大、一次拖到最窄、
最窄后立即放大（验证防抖尾火与离散突变）。

每个场景至少断言：

1. 可见文本按逻辑顺序拼接后与缩放前一致（提示符、已输入命令、输出都不丢/不重）；
2. `buffer.active.cursorX/Y` 落在预期行列；
3. 缩放后发送一个哨兵字符，必须落在预期光标位置；
4. 放大回原宽度后，哨兵字符仍在同一逻辑行；
5. 提示符上一行内容未被吞掉；
6. 不出现 `isWrapped` 的幽灵空白行（底部补空格场景）。

自动化分层：

- `terminalResizePolicy.test.ts`：会话 → 模式判定表。
- `terminalResizeReadline.test.ts`：用 readline 实际重绘序列回放，覆盖 park/reflow 回归。
- `terminalResizeConptyReplay.test.ts`：读取真实 ConPTY fixture，按 `applyResize` 顺序回放。
- `terminalDecawmGuard.test.ts`：保存/恢复 DECAWM、超时恢复、dispose 恢复。
- 手动：Windows cmd / PowerShell 5 / pwsh / Git Bash；SSH Linux bash/zsh；分屏拖拽、侧栏
  开合、字体缩放、最大化/还原、标签切换、重连后缩放。

## 6. 同类潜在问题清单

按风险从高到低：

1. **底部提示符**：没有组下方空行，park 返回 null；`reflowCursorLine` 可解决，但必须叠加
   行尾补空格裁剪，否则 ConPTY 重绘会滚动视口。
2. **原本已折行的提示符 + 放大**：readline 的旧行号向上移动会吞掉上一行；必须禁止
   本地重画光标行。
3. **折行命令 / 光标在组中间**：park 的贪心分段与实际 ConPTY 分段可能相差一列（宽字符、
   `cols+1` 光标）；放到 fixture 里覆盖。
4. **CJK/emoji 宽字符**：xterm 与 ConPTY 的宽度表、行尾留白策略可能不同；逐字符比对，
   不能只比较总文本。
5. **alt buffer（vim/less/top）**：不做本地重排；依赖应用重画。确认 `buildCursorGroupResizePlan`
   的 `type !== 'normal'` 早退仍然保留，且 DECAWM 裁剪不作用在 alt buffer。
6. **光标下方还有内容**（分页输出、TUI 局部刷新）：park 只检查组下方空行，未检查更下方；
   新策略下不再 park，但仍需验证“上方行重排导致下方内容位移”是否与对端一致。
7. **提示符组跨越视口顶部**（长命令进入 scrollback）：park 返回 null；`reflowCursorLine`
   也只处理可见区。需要确认截断只发生在 scrollback，不污染当前屏幕。
8. **行列同时变化**：当前先立即应用 rows、再防抖 cols；ConPTY 可能先发一次与 rows 相关的
   重绘。加 rows-only / rows+cols 组合 fixture。
9. **最大化/还原 + 防抖竞争**：`refit(true)` 与尾部防抖可能产生两次连续 resize；确认
   DECAWM 守卫成对恢复，不叠加。
10. **标签切换 / 隐藏面板**：卸载前 `flushPendingResize` 会直接 `terminal.resize()`，绕过
    park/守卫；新策略下需确认它也只对 `local-reflow` 生效，且不留下 DECAWM=off。
11. **快照恢复后 resize**：快照的 cursor 与真实 shell cursor 可能不同；恢复期间 `directWriteDepth`
    会延迟 resize，恢复完成后计划可能基于快照尾部；`shell-repaint` 下风险较低，仍需用例。
12. **字体/缩放改变 cols**：走同一路径；readline 重复提示符同样会出现，必须由模式判定覆盖。
13. **Telnet / serial**：后端 resize 是 no-op；前端重排会与远端脱节，建议只改视口尺寸，
    不重排光标行，或明确记录为不支持。
14. **自定义 shell**：包装脚本（`cmd /c ...`、`powershell -NoProfile`）按 basename 可能误判；
    需要会话级覆盖。
15. **`cursorRow.length` 与 `terminal.cols` 不一致**：旧 park 用 `length` 判断“变宽”，历史上
    的 resize 会让 `length > cols`；新策略删除该逻辑后问题消失，但 fixture 仍应覆盖连续缩放。
16. **DECAWM 状态泄漏**：dispose、重连、切换主题/字体导致 Terminal 重建时必须恢复；否则
    用户之后的长行不再折行。

## 7. 实施顺序与验收

| 阶段           | 内容                                                      | 验收                                                         |
| -------------- | --------------------------------------------------------- | ------------------------------------------------------------ |
| P0（0.5–1 天） | 会话模式判定 + 仅 cmd 走 park；SSH/Unix/PS 停止 park      | Linux 重复提示符与吞行消失；现有 Windows 顶部 cmd 用例不回归 |
| P1a（1–2 天）  | xterm 6 + addons 升级，`reflowCursorLine` 接入，删除 park | 全量前端检查通过；顶部/底部 cmd fixture 文本与光标正确       |
| P1b（0.5 天）  | DECAWM 裁剪守卫                                           | 底部提示符不再出现幽灵行/光标落到空行；连续缩放往返稳定      |
| P1c（1 天）    | readline/ConPTY 回放测试 + 手动矩阵                       | 第 5 节 1–6 条全部通过                                       |
| P2             | 会话级覆盖、诊断日志、fixture 生成器、Telnet/serial 复核  | 自定义 shell 可人工纠正；现场问题可用日志定位                |

回滚策略：

- 模式判定与守卫都加设置项/构建期开关；若 xterm 6 升级出现问题，可回退到 5.5 + P0
  （只修 SSH/Unix，Windows 底部问题保留并记录）。
- DECAWM 裁剪若在现场造成裁剪异常，可单独关闭该守卫，退回 `reflowCursorLine` 单用；
  此时底部提示符仍可能错位，但不影响 readline 会话。

## 8. 关键结论（一句话）

**“是否由终端本地重排光标行”必须由对端 shell 是否会在 SIGWINCH 后自己重画提示符决定；
cmd/conhost 与 PowerShell/PSReadLine 都需要本地重排（后者只重画输入行），readline/zle/fish
这类会重画提示符的绝不能本地重排。** 现有实现按“这一行会不会
被截断”判断，方向本身就是错的；xterm 6 的 `reflowCursorLine` 提供了正确的原语，但还要
补上 ConPTY 行尾补空格在最后一行触发滚动的裁剪，才能覆盖底部提示符。

## 9. 实施记录

最终实现（不再使用 cursor parking）：

- **策略分流**：`src/lib/terminalResizePolicy.ts` 把会话解析为 `local-reflow` /
  `shell-repaint`。本地 cmd / PowerShell / pwsh（或 ConPTY 默认 shell）本地重排；
  SSH / Telnet / Serial / bash / zsh / fish / WSL / Git Bash / 自定义 shell 交给对端重画。
  `XtermCanvas` 用该值设置 `reflowCursorLine`，SSH 等会话保持 xterm 的 stock
  “跳过光标组 + 截断”行为。
- **删除 park**：`terminalCursorReflow.ts`、`terminalResizePrompt.test.ts`、
  `terminalCursorReflow.test.ts` 已删除；`applyResize` 不再写 `CUP` 或恢复光标。
- **DECAWM 裁剪**：`src/lib/terminalResizeWrapGuard.ts` 在 `local-reflow` 会话 resize 后
  临时关闭自动折行，首个输出批次解析后恢复（150ms 超时兜底）；备用缓冲、应用原本关闭
  DECAWM、dispose 都不写 `?7h`。
- **依赖**：`@xterm/xterm` / `@xterm/headless` 升级到 6.0，`addon-fit` 0.11、
  `addon-webgl` 0.19；其余 addon 保持当前版本。
- **测试**：`terminalResizePolicy.test.ts`（判定表）、`terminalResizeReplay.test.ts`
  （真实 ConPTY 顶部/底部字节流 + readline 缩小/放大回放）、
  `terminalResizeWrapGuard.test.ts`（arm/release/超时/dispose）。
- **提交**：`1a7e80a`（策略分流，P0）、`55abc4d`（xterm 6 + 裁剪守卫，P1）。

验证结果：`npm run check` 全绿（444 passed / 1 skipped），`npm run build` 通过，
`cargo fmt --check` 通过。回放用例覆盖 100→12→100 的 cmd 顶部/底部提示符、缩放后输入
哨兵字符、readline 缩小不重复、放大不吞上一行。

已知边界（后续 P2）：

- 远端 Windows cmd（SSH 到 cmd）目前按 `shell-repaint` 处理，会被截断；需要会话级覆盖。
- 自定义包装脚本按 basename 判定，可能误判；默认 `shell-repaint` 是安全侧。
- DECAWM 守卫在“第一个输出批次”后恢复；如果某个后端把 resize 重绘拆成多个异步批次，
  后续批次仍可能折行。当前随包 ConPTY 的重绘是单次小写入，回放用例覆盖该行为。
- 仅做了 xterm headless + 构建验证，仍需在 Windows 实机对 cmd / PowerShell / Git Bash
  以及 Linux SSH 做一次手工拖拽缩放烟测。
