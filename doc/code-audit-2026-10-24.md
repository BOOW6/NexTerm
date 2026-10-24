# NexTerm 功能逻辑问题审计（2026-10-24）

> 本清单基于当前工作区（含未提交改动）的全量代码审计产出：7 个区域（Rust PTY/命令层、SSH/SFTP、凭据保险库、前端终端层、前端状态与数据层、独立窗口与 i18n、布局与面板）并行深读，共去重后 **48 条**（P0×2、P1×14、P2×32；P1-14 为修复批次一期间补录的漏编项，与 P0-1 同族）。其中最严重的 5 条已人工对照源码复核确认。行号对应当日工作区状态，后续提交后可能漂移。
>
> 用途：**下一轮会话统一修复的工作清单**。每条含触发场景与修复建议；文末附建议修复批次与「已确认无问题区域」（避免重复排查）。修复完成后请勾选对应复选框。

严重度定义：
- **P0**：数据丢失 / 不可逆损坏 / 安全问题。
- **P1**：常见使用场景下的功能错误。
- **P2**：边缘场景错误或体验级逻辑缺陷。

---

## 修复记录

- **2026-10-25 · 传输功能增强（提前消化批次二中的 P1-11）**：
  - **智能冲突策略（对标 FileZilla）**：`ConflictPolicy` 新增 `ask`（逐文件询问，模态窗口展示源/目标大小与 mtime，支持"应用到全部"，默认超时 10 分钟按跳过处理）与 `newer`（源文件较新或大小不同才覆盖）。事件 `sftp-conflict` + 应答命令 `sftp_conflict_response`；SFTP 面板冲突策略选择器默认值改为"询问"（已有 localStorage 值保持不变）。新增窗口 `SftpConflictWindow`（`sftp-conflict` kind）。
  - **传输任务绑定会话 + 断线自动续传**：`TransferRequest` 以 `sessionId` 取代 `sshId`，sshId 在每次启动/重试时经 `connectionStore` 现场解析（修复 P1-11）；后端 `SftpTransferDonePayload` 新增 `disconnected` 标记（经 russh `Handle::is_closed()` 判定）；前端新增 `interrupted` 状态与 `markSessionDisconnected`/`resumeInterruptedTransfers`，XtermCanvas 在 SSH 连接建立后自动续传该会话被中断的传输（从 `.part` 指纹校验处继续）。TransferPanel 展示"已中断 · 等待重连续传"并允许手动重试。
  - 校验：cargo fmt/clippy/test（30 通过，含 3 条新增）与 `npm run check`（typecheck + lint + 96 测试，含 sftpTransfer/transferStore 新增用例）全部通过。

- **2026-10-24 · 批次一（数据安全）已完成**：
  - **P0-1 + P2-1 + P1-14（断点续传重做）**：上传改为远端 `<file>.nexterm-part` + 侧车 `<file>.nexterm-part.meta`（size+mtime 指纹，指纹不匹配或本地无 mtime 一律重传），完成后 `finalize_remote_upload` rename 到位（OpenSSH 拒绝覆盖 rename 时走「备份 → 交换 → 清理，失败即恢复」），冲突策略只作用于完整文件（skip 不再被残留半截文件欺骗）。下载 `.part` 增加 `.part.meta` 来源校验（远端路径 + size + mtime）。新增单测 `upload_resume_requires_matching_provenance` / `download_resume_requires_matching_source`。
  - **P0-2 + P1-5（保险库 persist）**：移除「先删旧文件再重试 rename」回退分支（rename 失败直接报错，旧文件完好保留）；临时文件 write_all + sync_all 后再 rename，Unix 上对父目录补充 fsync。
  - 校验：`cargo fmt`、`cargo clippy --all-targets -- -D warnings`、`cargo test`（27 通过，含 2 条新增）全部通过；前端未改动。

---

## P0（2 条）

- [x] **P0-1 上传「断点续传」凌驾于冲突策略之上，静默损坏或跳过远端文件** — `src-tauri/src/ssh/mod.rs:1640-1666`
  - 场景：前端所有上传都不传 `resume`（serde 默认 `resume=true`，见 `src/lib/sftpTransfer.ts` 默认值），conflict 默认 overwrite。向同一路径重传一个**修改过**的文件：远端尺寸==本地尺寸 → 直接 `return Ok(())` 报成功（远端仍是旧文件）；远端尺寸<本地尺寸 → 以 `remote_size` 为偏移续写且**不加 TRUNCATE**（`mod.rs:1663-1666`），远端 = 旧内容前缀 + 新内容后缀的拼接文件，报成功。只有新文件更短时才真正重写。
  - 根因：上传没有下载那样的 `.part` 机制，用「远端现有文件大小」冒充续传偏移，无任何内容一致性校验。
  - 建议：上传改为先写远端 `.part`、完成后 rename（与下载对称，同时修复 P2-1）；`.part` 中记录本地文件 size/指纹，不匹配则重传；`conflict=overwrite` 时禁用按 remote_size 续传。

- [x] **P0-2 保险库 persist 的 rename 失败回退分支会先删除旧保险库文件，把可恢复错误变成不可逆数据丢失** — `src-tauri/src/vault.rs:237-239`
  - 场景：Windows 上杀软/备份软件短暂持有 `credentials.vault.json` 句柄导致首次 rename 失败（`std::fs::rename` 在 Windows 本就带 `MOVEFILE_REPLACE_EXISTING`，走到回退即为异常环境）→ 代码先 `remove_file(&self.path)` 删掉原件再赌第二次 rename；若第二次仍失败或进程恰在 delete 与 rename 之间崩溃，整个凭据库从磁盘消失，重启后显示「未初始化」，用户重建后旧凭据全部丢失。
  - 建议：删除回退分支，rename 失败直接返回错误（保留旧文件与 .tmp）；配合 P1-5 补 fsync。

---

## P1（14 条）

### Rust 后端

- [ ] **P1-1 SSH 连接意外断开后后端零清理：死会话残留、端口转发监听器永久存活、僵尸转发不可见** — `src-tauri/src/ssh/mod.rs:561-578`
  - 场景：读循环退出只 `emit("ssh-closed-{id}")`，`sessions`/`forwards` 两个 map 均不清理；前端 closed 回调不调用 `disconnectSsh`（全仓 grep 确认），且已把 `backendId` 置空，之后 `ssh_disconnect` 永远不会被调用。后果：(a) `-L`/`-D` 的 TcpListener 继续接受连接并向死通道转发（全部失败）；(b) 重连后重建同端口转发时报「地址已被占用」；(c) 转发面板按当前 ssh_id 过滤，僵尸转发不可见也无法停止；(d) 死 `SshConnection` 永久泄漏。
  - 建议：在连接死亡路径（读循环结束处）执行与 `disconnect` 相同的 forwards 清理与会话移除，并 emit `port-forwards-changed`；需与前端重连逻辑（P1-7）联动设计「重连后是否自动重建转发」。
- [ ] **P1-2 终端输出按块做 `from_utf8_lossy`，多字节字符跨块被截断成 U+FFFD 乱码** — `src-tauri/src/pty/mod.rs:107`、`src-tauri/src/ssh/mod.rs:564-569`
  - 场景：`cat`/`ls` 大段中文或 emoji，读取边界（PTY 32KiB、SSH 通道包 ~32KiB，均非 3 的倍数）落在多字节序列中间，两半各自变成替换符，滚动缓冲留下永久乱码。
  - 建议：读侧维护跨块字节残留缓冲，只按 UTF-8 边界切分后再 emit（或改二进制事件、前端解码）。
- [ ] **P1-3 `write_pty` 为同步命令，在 UI 主线程执行可能无限阻塞的管道写** — `src-tauri/src/commands/mod.rs:55`、`src-tauri/src/pty/mod.rs:142`
  - 场景：已核实 tauri 2.12 + wry 0.57 中非 async 命令在主线程执行。子进程不消费 stdin（程序挂起）而用户粘贴大段文本时，`write_all` 阻塞 → 整个应用（事件循环、所有 IPC、窗口消息）冻结。`vault_unlock`（主线程跑 Argon2id，见 P2-9）、`read_text_file`（8MiB）同理。
  - 建议：PTY/IO/保险库类命令声明为 `async`（或 `#[tauri::command(async)]`），阻塞写挪到 `spawn_blocking`；注意 Tauri 2 中 async 命令默认在独立线程池执行，需确认 state 访问安全。
- [ ] **P1-4 主机密钥确认等待期间会话 id 未占位，可产生无人监管的「已认证僵尸 SSH 会话」** — `src-tauri/src/ssh/mod.rs:466-473, 291-297, 580-591`
  - 场景：首次连接新主机 → `connect` 阻塞等待指纹确认（最长 120s），此时 id 未进 `sessions` map（仅 `contains_key` 检查）；用户点重连或关标签 → `disconnectSsh` 查不到 id 而空操作；之后用户仍点击还开着的确认窗「接受」→ 连接完成认证、`sessions.insert` 成功，成为无人监听、靠 keepalive 永久存活的僵尸会话（远端挂着已登录 shell）。并发同 id connect 还会互相覆盖 map 条目、交错输出。
  - 建议：连接开始即登记 pending 占位；收到同 id 新连接或显式断开时取消挂起的 host-key oneshot 并中止连接。
- [x] **P1-5 保险库原子写缺少 fsync，崩溃/断电可产生空或截断的 vault.json** — `src-tauri/src/vault.rs:235-240`
  - 场景：`std::fs::write` 到 `.tmp` 后未 `sync_all` 即 rename；断电时 rename 元数据可能先于数据落盘，得到 0 字节或残缺 JSON。残缺文件若能通过 JSON 解析但密文损坏，GCM 校验失败被上报为「主密码错误」（见 P1-6），诱导用户重置保险库，凭据全部丢失。
  - 建议：`File::create` + `write_all` + `sync_all` 再 rename；Unix 上 rename 后对父目录 fsync。
- [ ] **P1-6 保险库 KDF 参数未持久化且从不校验，解密失败一律吞成 `Ok(false)`（"主密码错误"），任何参数漂移都会诱导用户重置** — `src-tauri/src/vault.rs:46, 104-122, 266-272`
  - 场景：文件只记 `kdf: "argon2id"` 字符串，unlock 只检查 `version`；密钥用 `Argon2::default()`（参数随 crate 版本走）。升级依赖或调整 `derive_key` 后所有旧保险库派生不同密钥 → GCM 校验失败 → 返回 `Ok(false)` → 前端提示「主密码错误」，重试无效后走 reset，数据全毁且无迁移路径。
  - 建议：把 m_cost/t_cost/p_cost/算法写入 VaultFile 并按存储参数派生（未知参数报明确错误）；将「文件损坏/参数不匹配」与「密码错误」区分为不同错误。

### 前端

- [ ] **P1-7 SSH 自动重连链在第 1 次重试失败后永久中断** — `src/components/terminal/XtermCanvas.tsx:639, 763`（已复核）
  - 场景：已建立过的连接断开 → `scheduleReconnect` 排定第 1 次重试 → 到点重连时网络仍未恢复，`connectSsh` 抛错进 catch → `established` 是**本次尝试的局部变量**（恒为 false）→ `scheduleReconnect` 不再被调用，第 2~5 次退避重试永不发生，状态停在 error 只能手动重连。且 `established` 置 true 后到 try 结束全为同步无抛出代码，catch 路径实际从不触发重连。
  - 建议：catch 中改用会话级标志（`connectedAt > 0` 或独立 `everEstablished`）判断是否继续 `scheduleReconnect`。
- [ ] **P1-8 `findPanelForSession` 不区分面板组件类型，SFTP/转发面板会「劫持」打开会话操作** — `src/features/workspace/sessionActions.ts:22-31, 44-52`（已复核）
  - 场景：为会话 X 打开过 SFTP 面板后关闭其终端标签 → 侧栏/命令面板点击会话 X → existing 分支命中 SFTP 面板，仅 `setActive()` 后返回，终端永远打不开。快速连接编辑后的 `openSession`（`useQuickConnectLauncher.ts:88,123`）同样受影响。
  - 建议：`findPanelForSession` 增加 terminal 组件过滤（`params.componentName` 或面板 id 前缀），仅 terminal 面板可命中 existing 分支。
- [ ] **P1-9 终端面板关闭但同会话 SFTP/转发面板仍在时，会话状态永久停留「已连接」** — `src/components/layout/DockLayout.tsx:156-164`
  - 场景：SSH 已连接 → 打开其 SFTP 面板 → 关闭终端标签。XtermCanvas 卸载路径只 `disconnectSsh` + `removeConnection`，不 `setStatus('idle')`；`onDidRemovePanel` 的 `stillOpen` 检查命中 SFTP 面板而跳过重置 → 侧栏圆点与 StatusBar 持续显示已连接。
  - 建议：在 XtermCanvas 卸载清理中同步 `setStatus(sessionId,'idle')`，或 `stillOpen` 判定仅计入 terminal 组件面板。
- [ ] **P1-10 删除「进行中」传输任务不取消后端传输，下一条进度事件使任务复活** — `src/components/transfers/TransferPanel.tsx:182-189`、`src/stores/transferStore.ts:108-127`
  - 场景：传输进行中点行尾 X 只过滤 store；后端继续跑，下一条 `sftp-progress` 到达时 `applyProgress` 找不到 id，走 `index === -1` 分支重新插入列表 —— 任务幽灵重现，带宽持续占用。
  - 建议：running/paused 状态禁止移除（或先自动 `cancelSftpTransfer` 再移除）。
- [x] **P1-11 传输「重试」复用已失效的 sshId，断线自动重连后重试必然失败** — `src/lib/sftpTransfer.ts:46-61`
  - 场景：传输因 SSH 断线失败 → 自动重连成功（每次连接生成新 UUID 作为后端 ssh id）→ 点重试仍用 `item.request.sshId` 旧 id → 后端 `connection(&ssh_id)` 查不到报错。最常见场景下重试按钮永久不可用。
  - 建议：`TransferRequest` 同时保存 sessionId，重试时经 connectionStore 解析当前 sshId（无连接则提示先重连）。
- [ ] **P1-12 编辑私钥会话时口令留空会被空串静默覆写（内存 + 保险库）** — `src/features/workspace/useQuickConnectLauncher.ts:76-78`（已复核）
  - 场景：编辑使用加密私钥的 SSH 会话（只改名称/分组），「私钥口令」表单初始为空（`QuickConnectWindow.tsx:68`），保存时 password 有「留空沿用」守卫（`:73`），passphrase 没有 → 空串覆写内存凭据并经 `rememberSessionCredentials` 写入保险库；hydrate 时因 `session.id in passphrases` 也不再回填。下次连接解密私钥失败，且保险库中的正确口令已被覆盖（数据丢失）。
  - 建议：与 password 一致，仅 `result.passphrase` 非空时才 `setPassphrase` / 跳过空值持久化。
- [ ] **P1-13 SSH config 导入不继承 `Host *` 通配块，无 User 行的会话导入后无法连接** — `src/lib/sessionImport.ts:71-96`
  - 场景：常见配置 `Host *` + `IdentityFile` 被整体丢弃（flush 中 alias 找不到即丢弃）；无 `User` 行时 username 为空，且导入路径不回退 `settings.defaultUsername` → 连接时抛「缺少主机或用户名」，SshConnectForm 无用户名输入框，只能逐个编辑补齐。
  - 建议：flush 时先收集通配块字段作为后续 Host 的默认值；导入时 username 回退 `defaultUsername`。
- [x] **P1-14 下载续传只看 `.part` 长度不校验来源，跨文件/跨版本续传产出损坏文件**（审计后补录，与 P0-1 同族，两个审计代理均报过）— `src-tauri/src/ssh/mod.rs:1547-1555`
  - 场景：下载远程文件 A 到 `P` 中断留下 `P.part`；之后把另一个远程文件 B（或服务器上已更新的同名文件）下载到同一本地路径，resume 默认开启 → 只要 part 长度 ≤ B 大小就从该偏移续传并追加到旧 `.part`，最终 rename 成 P，内容为 A 前缀 + B 后缀的混合体，报成功。
  - 建议：`.part` 旁持久化来源路径 + 远端 size/mtime 指纹，不匹配则丢弃重下。（已于批次一修复，见修复记录）

---

## P2（32 条）

### Rust 后端（SSH/SFTP、保险库、窗口）

- [x] **P2-1 conflict=skip 会把「上次取消上传留下的残缺远端文件」当成已完成** — `src-tauri/src/ssh/mod.rs:1497-1501`。上传无远端 `.part`，取消后目标路径直接留半个文件；skip 重传时 `try_exists` 为真即跳过并计入已传输，UI 报全部成功。随 P0-1 一并解决。
- [ ] **P2-2 递归传输静默丢弃符号链接（含目录链接），无任何提示** — `src-tauri/src/ssh/mod.rs:1306-1314, 1340-1347`。readdir 的 SYMLINK 类型既不入栈也不入文件表；本地 WalkDir 同样跳过。传输「成功」但内容缺失；SFTP 浏览器也无法进入链接目录。建议读目标类型或至少计数并在完成事件中提示 skipped。
- [ ] **P2-3 known_hosts 非原子写入 + 解析失败整体清零** — `src-tauri/src/ssh/mod.rs:140-146, 194-202`。写中崩溃/断电 → 文件截断 → `serde_json::from_slice` 失败被 `unwrap_or_default()` 吞掉 → 全部 TOFU 记录丢失，所有主机重新走首次确认（给 MITM 开窗）。建议 tmp+rename 原子替换；解析失败时保留旧文件并告警。
- [ ] **P2-4 远程转发按端口（忽略绑定地址）分发，同端口多绑定地址时路由错乱** — `src-tauri/src/ssh/mod.rs:322`。`127.0.0.1:8080→A` 与 `192.168.x.x:8080→B` 可共存于 sshd，但回调只用 `connected_port` 查表，后注册者覆盖语义。建议以 `(connected_address, connected_port)` 为键。
- [ ] **P2-5 OpenSSH known_hosts 导入对裸 IPv6 主机（标准 22 端口写法 `::1 ssh-ed25519 ...`）解析出错误标签** — `src-tauri/src/ssh/mod.rs:1975-1979`。`rsplit_once(':')` 把 `::1` 拆成 host=`::`、port=1，导入条目无法匹配真实连接，TOFU 会重复弹确认。建议含多个 `:` 的无方括号主机整段按 host 处理（端口 22）。
- [ ] **P2-6 主机密钥确认 120s 超时后弹窗仍存活，迟到的「信任」被静默丢弃** — `src-tauri/src/ssh/mod.rs:291-297`。去线下核对指纹超 2 分钟很常见；超时后 pending 已移除，用户点「信任并连接」变 no-op，指纹未写入，界面无任何提示。建议超时后向前端发事件关闭弹窗并提示，或弹窗显示剩余时间。
- [ ] **P2-7 保险库 persist 失败后内存与磁盘分歧，后续 unlock/change_password 重载磁盘会静默丢弃内存变更** — `src-tauri/src/vault.rs:143-146, 155-160, 126-130`。`set` 先改内存再写盘，persist 失败返回 Err 但内存已含新条目；之后 unlock/改密码从磁盘重载覆盖内存，条目无声消失。`delete` 反向同理。建议 persist 失败回滚内存（或先写盘再提交）。
- [ ] **P2-8 `app_config_dir` 获取失败时保险库静默回退到系统临时目录** — `src-tauri/src/lib.rs:63-70`。/tmp 下的凭据库会被临时文件清理策略无声删除，且用户无从得知路径。建议回退时拒绝初始化保险库并报明确错误。
- [ ] **P2-9 vault 命令同步执行：Argon2（~19MiB 内存困难运算）在主线程跑，解锁/创建/改密码冻结 UI 数百毫秒；且正确性依赖「同步命令主线程串行」这一隐式前提** — `src-tauri/src/vault.rs:119-130, 177-188`。任一 vault 命令改成 async 即产生丢失更新窗口。随 P1-3 一并处理（async + spawn_blocking + 取锁时校验状态）。
- [ ] **P2-10 `open_modal_window` 在 `build()` 之后才注册窗口事件，快速关闭导致 promise 永久挂起 + ModalManager 条目泄漏** — `src-tauri/src/windows.rs:212-236`。build 与 `on_window_event` 之间还有两个同步调用；其间用户点 X → `Destroyed` 无人监听 → `receiver.await` 永不返回（快速连接/主机密钥对话框挂死）。建议 build 后立即注册事件，或加超时兜底 resolve(None)。
- [ ] **P2-11 `open_settings_window` 的「检查已存在再创建」非原子，并发双开时一个调用方收到无意义报错** — `src-tauri/src/windows.rs:243-270`。连按 Ctrl+, 两个调用都通过 None 检查，后建者因 label 重复返回 Err。建议 Mutex 包裹检查+创建，或捕获「label 已存在」后改为聚焦既有窗口。

### 前端：终端与布局

- [ ] **P2-12 同会话分屏多连接时 connectionStore 单槽覆盖，关闭较新分屏后 SFTP/转发面板误报未连接** — `src/stores/connectionStore.ts:19-22`。分屏各建独立 SSH 连接但 store 按 sessionId 只存一条；关闭较新面板按 sshId 匹配删除条目，旧连接仍存活却读不到。建议保存 sshId 集合或删除时回退到仍存活的旧 sshId。
- [ ] **P2-13 resize 冻结窗口内的断线/重连通知绕过写队列直写 xterm，旧输出事后补写导致乱序** — `src/components/terminal/XtermCanvas.tsx:397, 538-547`。`writeFrozen` 期间 `flushPendingWrites` 直接返回，随后 `writeScrollbackNotice` 直写 → 解冻后旧输出才写入，「[SSH 连接已断开]」出现在更早历史之前，违反 FIFO 约束。建议冻结时通知先等解冻（或冻结前先 issue 队列）。
- [ ] **P2-14 非激活分屏的 SSH 自动重连成功后 `instance.focus()` 抢走键盘焦点** — `src/components/terminal/XtermCanvas.tsx:753`。后台定时器驱动的重连成功即无条件 focus。建议仅该面板处于激活状态时才 focus。
- [ ] **P2-15 连接状态下点击「清除认证」会卸载 XtermCanvas，杀掉活动 SSH 会话** — `src/components/terminal/TerminalTab.tsx:128-132, 306`。`clearCredentials` → needsAuth 翻 true → 渲染分支切到 SshConnectForm → 主 effect 清理断开 SSH、销毁终端实例。按钮语义「清除认证」却附带断连丢屏。建议仅在会话空闲时卸载，或改为标记需重认证。
- [ ] **P2-16 会话收尾时处于 alt buffer 则不保存快照也不作废旧快照，下次打开恢复出上一次关闭的陈旧内容** — `src/components/terminal/XtermCanvas.tsx:1001-1003, 1061`。vim/htop 中关标签 → 跳过写入但 localStorage 留着更早的旧快照 → 下次提示「已恢复上次会话的滚动缓冲」但内容与本次无关。建议 alt buffer 跳过时同时 `clearTerminalSnapshot(sessionId)`。
- [ ] **P2-17 系统字体读取失败被永久缓存为 null，会话内不再重试** — `src/theme/nativeLigaturesAddon.ts:59-63`。模块级缓存把瞬时失败固化为「无连字」，需重启应用恢复。建议失败结果不进缓存或加短 TTL。
- [ ] **P2-18 布局持久化 250ms 防抖且无退出/删除前的 flush** — `src/components/layout/DockLayout.tsx:106-112`。删除会话或布局改动后 250ms 内退出 → localStorage 布局仍指向已删会话，下次启动出现僵尸占位面板或丢失最后一次布局。建议 `beforeunload`/`CloseRequested` 与 removeSession 前同步 flush。
- [ ] **P2-19 TerminalPreview 的 Font Feature Settings 每敲一个字符整体重建预览终端（含 WebGL 上下文）** — `src/windows/settings/TerminalPreview.tsx:198`。重挂载依赖含 `fontFeatureSettings`，每键 dispose + 新建 Terminal + 重载插件。建议依赖收窄到 `[visible, fontLigatures]`，`fontFeatureSettings` 变化仅重载连字 addon。

### 前端：会话数据与导入

- [ ] **P2-20 编辑会话把类型改回 local 时不清凭据，改回 SSH 后用旧密码静默重连** — `src/features/workspace/useQuickConnectLauncher.ts:66-71`。`isRemote=false` 跳过 `forgetSessionCredentials`；再改回 SSH 时 needsAuth=false 直接用旧凭据连接。建议 `previousKind !== 'local' && !isRemote` 时也清除。
- [ ] **P2-21 编辑会话清空「用户名」保存后不生效（空串回退旧值），与 keyPath 可清空的行为不一致** — `src/stores/sessionStore.ts:78-79`。建议与 keyPath 一致：`patch.username !== undefined ? patch.username.trim() || undefined : session.username`。
- [ ] **P2-22 PuTTY 导入不拆分 HostName 中的 `user@host`** — `src/lib/sessionImport.ts:220-222`。PuTTY 注册表原样存 `root@10.0.0.1`，导入后 host 带 `@`、username 为空，连接必然失败。建议按最后一个 `@` 拆分并回填 username。

### 前端：窗口与设置

- [ ] **P2-23 设置窗口打开期间主窗口的设置变更（如命令面板切主题）会被「应用」用过期 draft 静默回滚** — `src/windows/SettingsWindow.tsx:227, 597`。draft 为挂载时一次性快照；主窗口 `ThemeProvider.cycle` 直写 store 不发 `nexterm-settings-applied`。known_hosts 列表同样只在挂载时加载一次。建议主窗口设置变更也广播事件，设置窗口监听合并进 draft。
- [ ] **P2-24 设置窗口「取消」/关闭直接丢弃全部未保存修改（含 pending 的 known_hosts 删除），无确认** — `src/windows/SettingsWindow.tsx:1370-1372`。建议 draft 有差异或 removedHosts 非空时经 `confirmAction` 确认。
- [ ] **P2-25 「清空保险库」流程先 lock 再逐会话 delete，全部 `vault_delete` 必然失败并被吞** — `src/windows/SettingsWindow.tsx:479-482`。当前仅因 `clearVault` 已清空全部条目才无实害，但属静默故障模式。建议去掉 lock 后的逐会话 delete（或调换顺序）。
- [ ] **P2-26 主窗口（SshConnectForm）解锁保险库不广播事件，设置窗口状态陈旧可导致误操作** — `src/components/terminal/SshConnectForm.tsx:96`、`src/stores/vaultStore.ts:42`。设置窗口开着时显示「创建保险库/解锁」而实际状态已变，点击报错。同类：`vault_lock/set/delete` 后端均不 emit，跨窗口同步依赖调用方手动 emit 的脆弱约定。建议把 unlocked/locked/cleared 事件移到后端命令内 `AppHandle::emit`，删除前端手动同步。
- [ ] **P2-27 快速连接端口无 1–65535 校验，非法值持久化后连接时报晦涩的 IPC 反序列化错误** — `src/windows/QuickConnectWindow.tsx:126`（输入框仅过滤非数字，`185`）。`ssh_connect` 的 `port: u16` 对 99999 直接 serde 失败。建议提交前校验并在表单内报错。
- [ ] **P2-28 PromptWindow 的 Enter 提交未排除输入法组合态，中文 IME 下确认候选词会误提交主密码弹窗** — `src/windows/PromptWindow.tsx:57-62`。全仓无 `isComposing` 处理。建议提交条件加 `!event.nativeEvent.isComposing`。

### 前端：功能面板

- [ ] **P2-29 端口转发面板绑定的会话未连接时，列表回退为显示全部会话的转发规则（跨会话数据泄漏且可误停）** — `src/components/forward/PortForwardPanel.tsx:96`。`sshId ? filter : forwards`，与上方「尚未建立 SSH 连接」文案矛盾。建议绑定会话未连接时显示空列表。
- [ ] **P2-30 命令面板「关闭当前标签页」实际关闭该会话的全部面板（含 SFTP/转发），与 TitleBar 行为不一致** — `src/components/command/CommandPalette.tsx:206-213` → `closeSessionPanels`。建议改为 `getApi()?.activePanel?.api.close()` 或改名「关闭会话所有面板」。
- [ ] **P2-31 SFTP/转发面板的自动绑定 effect 使「选择会话」（解绑）无法生效，立即被回绑** — `src/components/sftp/SFTPPanel.tsx:107-113`（`PortForwardPanel.tsx:84-90` 同）。建议用显式解绑哨兵区分「用户主动解绑」与「初始未绑定」。
- [ ] **P2-32 删除正在传输的文件/目录无任何防护** — `src/components/sftp/SFTPPanel.tsx:360-384`。Linux 上 unlink 后上传句柄仍有效，继续写入已断链 inode 并报「成功」，数据实际丢失；删目录与递归传输竞争产生半成品。建议删除前按路径匹配 transferStore 中 running/paused 任务并阻止。

---

## 建议修复批次（下一轮会话执行顺序参考）

1. ~~**数据安全（P0）**：P0-1（连同 P2-1 统一重做上传续传：远端 `.part` + rename + 指纹）、P0-2（连同 P1-5 补 fsync）。~~ ✅ 已完成（2026-10-24，含补录的 P1-14，详见「修复记录」）。
2. **断线生命周期一致性（相互关联，建议一起设计）**：P1-1（后端死亡清理）× P1-7（前端重连链）× P2-12（connectionStore 多连接）× P1-9（状态残留）× ~~P1-11（重试 sshId，已于 2026-10-25 随传输会话绑定功能修复）~~ × P1-10（删除复活）。注意设计决策：后端死亡清理后，重连成功是否自动重建该会话的转发（当前转发挂在后端会话上）。
3. **保险库健壮性**：P1-6（KDF 参数持久化 + 错误分类，注意向后兼容旧 vault 文件）、P2-7、P2-8、P2-9、P2-25、P2-26、P1-12、P2-20。
4. **输出正确性与响应性**：P1-2（UTF-8 增量解码）、P1-3（async 化，注意连带 vault）、P2-19。
5. **主机密钥与 known_hosts**：P1-4（连接占位）、P2-6（超时反馈）、P2-3（原子写）、P2-5（IPv6 导入）。
6. **面板与导入体验**：P1-8、P1-13、P2-21、P2-22、P2-18、P2-30、P2-31、P2-29、P2-32、P2-27。
7. **其余 UI 细节**：P2-10、P2-11、P2-13、P2-14、P2-15、P2-16、P2-17、P2-23、P2-24、P2-28。

每批完成后运行：`npm run check`（typecheck + lint + test:run）与 `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`。

---

## 已确认无问题的区域（本轮已排查，勿重复）

- **锁使用**：ssh/mod.rs、pty/mod.rs 所有 `std::sync::Mutex` 守卫均在 `.await` 前释放（语句级临时值/显式块），无跨 await 持有；SFTP 缓存正确使用 `tokio::sync::Mutex`；无两级锁嵌套或加锁顺序问题。
- **TOFU 主路径**：known 命中 → mismatch → pending oneshot → 120s fail-closed；`resolve_host_key` 对未知/迟到 request_id 安全 no-op（有测试固化）。known_hosts 导入/导出格式与测试一致（仅 P2-5 的裸 IPv6 边界）。
- **PTY 生命周期**：close 后 Arc drop 关闭 master，读线程正常退出并 emit，无残留线程或重复事件；resize 对已关闭 id 返回 Ok 是有注释的有意设计。
- **前端写队列 FIFO**：enqueue → 16ms 批量 → issueWrite 严格保序；隐藏标签积压 4MB 上限旁路；卸载清空队列发生在非 resize 期（例外见 P2-13）。XtermCanvas 卸载清理覆盖全部 unlisten/addon/timer/注册表注销（例外见各 P2 条目）。
- **resize 序列化**：三层目标合并、垂直立即/水平 300ms 防抖/离散突变绕过、同尺寸不发送、卸载 flush 送达后端，逐路径推演无前后端尺寸脱节。
- **保险库密码学原语**：nonce 每次随机（OsRng，12B）、无 AAD 两侧一致、盐每次随机并随密文持久化、base64 定长校验、明文不落日志/事件、磁盘只有密文（有测试断言）。
- **transferStore 状态机**：progress 先于 begin、paused 不被迟到 progress 复活、finish→begin 保持 done，均有测试覆盖。
- **i18n**：ZH/EN 各 84 key 脚本比对对齐，`t()` 引用全部存在，插值参数匹配。
- **appWindows ↔ windows.rs 契约**：label/URL/事件/oneshot 幂等 resolve 均一致（仅 P2-10 的注册时序问题）。
- **原生右键菜单 index 映射**：Rust 端与三处前端 actions 数组顺序一致，分隔符不占序号。
- **会话删除级联**：关全部面板 → 断连 → 清凭据/快照 → 重置 activeSessionId，顺序正确。
- **潜在风险备忘**（当前不可达，改代码时留意）：`settingsStore.applySettings` 若被传入残缺 snapshot 会在 `terminalFontFamily.trim()` 抛错（现所有调用方传完整快照）；vault 命令的线程安全依赖「同步命令主线程串行」前提（P2-9）；布局恢复对已删会话有占位兜底，但死占位面板会随布局被反复持久化。
