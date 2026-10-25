# NexTerm 功能逻辑问题审计（2026-10-24）

> 本清单基于 2026-10-24 当前工作区（含未提交改动）的全量代码审计产出：7 个区域（Rust PTY/命令层、SSH/SFTP、凭据保险库、前端终端层、前端状态与数据层、独立窗口与 i18n、布局与面板）并行深读，共去重后 **48 条**（P0×2、P1×14、P2×32；P1-14 为修复批次一期间补录的漏编项，与 P0-1 同族）。其中最严重的 5 条已人工对照源码复核确认。
>
> **✅ 截至 2026-10-26，全部 48 条已修复完毕（见「修复记录」），本清单转为存档。**

严重度定义：
- **P0**：数据丢失 / 不可逆损坏 / 安全问题。
- **P1**：常见使用场景下的功能错误。
- **P2**：边缘场景错误或体验级逻辑缺陷。

---

## 修复记录

- **2026-10-26 · 批次六 + 七 + 补漏（P2-2/P2-4）——审计清单 48 条全部清零**：
  - **批次六（面板与导入体验）**：
    - **P1-8**：新增 `findTerminalPanelForSession`（按 `panel-` 前缀识别终端面板），`openSessionPanel` 的 existing 分支只命中终端面板——SFTP/转发面板不再劫持"打开会话"；`findPanelsForSession` 保留全量语义供会话删除级联使用。
    - **P1-13**：SSH config 导入时 `Host *` 块的字段（hostname/user/port/identityfile）成为后续具体主机的默认值；导入的用户名再回退 `settings.defaultUsername`——无 User 行的配置导入后可直接连接。
    - **P2-18**：DockLayout 增加 `beforeunload` 同步 flush，防抖窗口内（250ms）的最后一次布局变更在退出前落盘。
    - **P2-21**：编辑会话显式清空用户名现在生效（空串 → undefined），与 keyPath 行为一致；省略字段仍保留旧值。测试更新为新语义。
    - **P2-22**：PuTTY HostName 中的 `user@host` 按最后一个 `@` 拆分并回填用户名。
    - **P2-27**：快速连接提交时校验端口 1–65535，表单内报错而非持久化坏值。
    - **P2-29**：转发面板绑定会话未连接时显示空列表，只有显式解绑的全局面板才显示全部转发。
    - **P2-30**：命令面板「关闭当前标签页」改为只关闭活动面板（与 TitleBar 一致），不再连坐关闭会话的 SFTP/转发面板。
    - **P2-31**：SFTP/转发面板用 `userUnboundRef` 区分"用户主动解绑"与"初始未绑定"，解绑不再被自动回绑。
    - **P2-32**：SFTP 删除前检查 transferStore 中指向该路径（含目录前缀）的 running/paused 任务并阻止，防止删除传输中文件导致"写入已断链 inode 仍报成功"。
  - **批次七（其余 UI 细节）**：
    - **P2-10**：模态窗口的 `on_window_event`（Destroyed → resolve）移到 `build()` 成功后立即注册，消除"秒关窗口 → promise 永久挂起 + ModalManager 泄漏"的窗口期。
    - **P2-11**：设置窗口 build 竞态的落败方改为聚焦已有窗口，不再向调用方返回无意义报错。
    - **P2-13**：新增 `unfreezeWaiters`——resize 冻结期的断线/重连通知等待解冻后再写，排队中的旧输出先行送达，通知不再出现在更早历史之前。
    - **P2-14**：SSH 自动重连成功后仅当本面板属于当前活动会话才 `focus()`，后台分屏不再抢键盘焦点。
    - **P2-15**：会话连接中点击「清除认证」被阻止并提示（i18n 新增 `terminal.clearAuthBlocked`），不再切换渲染分支导致终端卸载、SSH 会话被杀。
    - **P2-16**：alt buffer 状态收尾时不再只跳过保存，而是同时 `clearTerminalSnapshot` 作废旧快照——下次打开不会恢复出与本次会话无关的陈旧历史。
    - **P2-17**：字体读取失败不再写入缓存，同一字体后续渲染会重试，瞬时失败不再永久禁用连字。
    - **P2-23**：`settingsSnapshot()` 移入 settingsStore 导出；ThemeProvider.cycle 切换主题后广播 `nexterm-settings-applied`；设置窗口监听该事件并按"与 lastKnown 的字段级 diff"合并进 draft——主窗口的修改即时同步，本地未保存编辑不被整份回滚。
    - **P2-24**：设置窗口「取消」与窗口 X 均受未保存修改守卫（draft 对比 lastKnown 或 removedHosts 非空时经 confirmAction 确认；CloseRequested 拦截后清 dirty 标志重新 close，无需额外 capability）。
    - **P2-28**：PromptWindow 回车提交增加 `!event.nativeEvent.isComposing`，中文输入法选词不再误提交主密码弹窗。
  - **补漏（审计中未被分入任何批次的两条）**：
    - **P2-2**：递归传输遇到符号链接：指向文件的链接按目标内容传输（远端用 `sftp.metadata` 跟随、本地用 `Path::metadata`），指向目录的链接（防环）与悬挂链接跳过——不再把所有链接一律静默丢弃。
    - **P2-4**：远程转发表改用 `(绑定地址, 端口)` 复合键（`RemoteForwardMap`），回调按 `(connected_address, port)` 精确匹配、单条目时回退端口匹配（兼容上报地址形式不同的服务器）——同端口多绑定地址不再路由错乱。
  - **勘误**：批次三记录中"P1-12/P2-20 已随传输功能轮修复"与代码不符（当时仅写了修复记录未改代码），本轮已补齐实现并勾选——passphrase 留空沿用旧值（防保险库口令被空串覆盖）、会话改回 local 时清除凭据。
  - 校验：cargo fmt / clippy / test（40 通过）；npm run check（typecheck + lint 仅存 4 条既有警告 + 104 测试）全部通过。

- **2026-10-26 · 批次五（主机密钥与 known_hosts）已完成**：
  - **P1-4（连接占位 + 可取消的握手）**：`SshManager` 新增 `connecting` 预留表（`ConnectHandle`：oneshot 取消通道 + `cancelled` 标志），`connect()` 全程持有 `ConnectReservation`（Drop 保证所有 `?` 早退路径都释放占位）——同 id 重复连接被拒绝（"SSH 会话正在连接中"）；`ssh_disconnect` 命中预留表时直接取消尝试。取消在两处生效：`check_server_key` 的指纹等待改为三路 select（用户应答 / 断开取消 / 120s 超时）；注册会话前再检查一次 `cancelled` 标志，堵住"断开发生在认证阶段"的窗口。前端 XtermCanvas 跟踪 in-flight 尝试的 `pendingConnectId`，面板关闭时对未完成的握手显式调用 `ssh_disconnect`——"指纹确认期间关标签 → 迟到点信任 → 产生无人监管的已认证僵尸会话"的路径彻底消除。
  - **P2-6（超时反馈）**：指纹确认 120s 超时后后端广播 `ssh-host-key-timeout` 事件（含 request_id/host/port）；HostKeyWindow 监听到自己的 request 超时后调用 `cancelModal()` 自动关窗（迟到的"信任"不再被静默丢弃），主窗口 useSshHostKeyEvents 弹 warning toast 告知连接已取消。
  - **P2-3（known_hosts 原子写 + 损坏保留）**：persist 改为 tmp+rename 原子替换，写中崩溃不再留下截断文件；启动加载遇解析失败时把损坏文件改名为 `known_hosts.json.corrupt` 保留现场并告警，不再 `unwrap_or_default()` 无声清零全部 TOFU 记录。
  - **P2-5（裸 IPv6 导入）**：`openssh_host_to_label` 对含多个冒号的无方括号主机按 IPv6 处理（整段为主机、端口 22），`::1 ssh-ed25519 …` 不再被解析成错误标签 `:::1`；导出方向 `openssh_host_field` 本就把 IPv6 加方括号，导入-导出-连接三方的标签现已闭环一致。
  - 校验：cargo fmt / clippy / test（40 通过，新增损坏文件保留与 IPv6 导入 2 个测试）；npm run check（typecheck + lint 仅存 4 条既有警告 + 104 测试）全部通过。

- **2026-10-25 · 批次四（输出正确性与响应性）已完成**：
  - **P1-2（UTF-8 跨块截断）**：新增共享模块 `src-tauri/src/text_stream.rs`（`Utf8StreamDecoder`）——跨块保留不完整的多字节尾部（至多 3 字节）、合法前缀照常输出、真正非法字节替换为 U+FFFD（与 `from_utf8_lossy` 行为一致），并有逐字节切分 CJK 流、无效字节、不完整尾部驻留等 5 个单测。PTY 读线程与 SSH 读循环均已接入；SSH 侧 stdout/stderr 各用独立解码器，避免 stderr 包打断 stdout 仍未完成的多字节序列。`cat` 大段中文不再烧入永久乱码。
  - **P1-3（阻塞命令挪出主线程）**：`write_pty` 改为 async 命令 + `spawn_blocking`——子进程停止消费 stdin 而用户粘贴大段文本时，管道写满只会阻塞 blocking 线程池的一个 worker，不再冻结整个应用（事件循环、全部 IPC、窗口消息）；`read_text_file`/`write_text_file` 改用 `tokio::fs`。`ssh_write` 此前已是 async；vault 命令已在批次三完成。剩余同步命令（resize_pty/close_pty_session 等）均为快速操作，维持现状。
  - **P2-19（TerminalPreview 每键重建）**：预览终端挂载 effect 依赖收窄为 `[visible, fontLigatures]`（连字开关需要新渲染器，重挂载保留）；`fontFeatureSettings` 变化由新增的独立 effect 处理——仅 dispose/重建 `NativeLigaturesAddon`，终端实例与 WebGL 上下文不动。连字 addon 改由 `ligaturesRef` 统一持有，挂载 effect 与重载 effect 共享，避免双份 dispose。
  - 校验：cargo fmt / clippy / test（38 通过，含 text_stream 5 个新测试）；npm run check（typecheck + lint 仅存 4 条既有警告 + 104 测试）全部通过。

- **2026-10-25 · 批次三（保险库健壮性）已完成**：
  - **P1-6（KDF 参数持久化 + 错误分类）**：`VaultFile` 新增 `kdf_params`（m_cost/t_cost/p_cost，serde default 兼容旧文件——旧文件缺字段时按 Argon2 默认参数派生，行为与历史完全一致，下次 persist 自动补写完成静默迁移）；unlock 增加 `kdf` 算法名校验（非 argon2id 报明确错误）。参数随文件持久化后，依赖升级不再导致旧库"解密失败 → 被误报为主密码错误 → 诱导重置"。
  - **P2-7（persist 失败回滚）**：`set`/`delete`/`clear` 保存变更前快照，persist 失败即回滚内存，内存与磁盘不再分歧；`change_password` 失败回滚 salt/key；`initialize` 失败恢复原状态。新增测试用"占用 .tmp 路径的目录"强制 persist 失败，验证四条路径的回滚与磁盘完好。
  - **P2-8（拒绝降级 temp）**：`VaultManager.path` 改为 `Option<PathBuf>`；`app_config_dir` 不可用时保险库所有操作返回明确错误（"无法确定应用配置目录"），不再静默写入会被系统清理的临时目录。
  - **P2-9（async 化 + io 互斥）**：vault_initialize/unlock/lock/set/delete/clear/change_password/reset 全部改为 async Tauri 命令；Argon2 派生经 `spawn_blocking` 移出主线程（解锁/创建/改密码不再冻结 UI 数百毫秒）；新增 `io: AsyncMutex` 显式串行化全部磁盘操作——替代过去"同步命令在主线程串行执行"的隐式前提，消除并发 async 命令下的丢失更新窗口。`vault_status`/`vault_get`（纯内存读）保持同步。
  - **P2-25（清空顺序）**：`handleVaultClear`/`handleVaultReset` 改为先逐会话 `forgetSessionCredentials`（保险库仍在解锁态，vault_delete 真正生效且内存同步清理），再 `clearVault`/`resetVault` 兜底全量清空——原先"先 lock 后逐会话 delete 全部静默失败"的路径消除。
  - **P2-26（后端广播事件）**：`nexterm-vault-unlocked/-locked/-cleared` 事件改由后端命令在状态变化成功后 `AppHandle::emit`（unlock 成功、initialize、change_password → unlocked；lock → locked；clear/reset → cleared），前端 SettingsWindow 删除全部手动 emit——主窗口在连接表单解锁保险库后，设置窗口及其它窗口通过 useVaultEvents 即时同步，不再出现陈旧的"未初始化/已锁定"状态。
  - 备注：P1-3（write_pty 阻塞主线程）中涉及 vault 的部分已随本轮解决，PTY 写入部分仍留待批次四。
  - 校验：cargo fmt / clippy / test（33 通过，新增 KDF 兼容、persist 回滚、路径不可用 3 个测试）；npm run check（typecheck + lint 仅存 4 条既有警告 + 104 测试）全部通过。

- **2026-10-25 · 批次二（断线生命周期一致性）已完成**：
  - **P1-1（后端死亡清理）**：读循环退出（连接自行断开）时，除 `ssh-closed` 事件外复用新抽出的 `stop_session_forwards` 停掉该连接的全部端口转发（abort 任务 + 尽力远端取消）并 emit `port-forwards-changed`，同时从 sessions map 移除死连接——本地监听器不再泄漏、端口立即释放、僵尸转发不再不可见；显式 disconnect 路径改为复用同一函数。sessions/forwards map 改为 Arc 包装以支持从 spawn 任务访问。
  - **P1-7（重连链中断）**：XtermCanvas 以会话级 `everEstablished` 标志取代"本次尝试的 established 局部变量"作为重连判据——排定的重试自身失败（网络仍未恢复）不再中断退避链；从未连上的会话（认证/主机密钥失败）仍立即报错不循环。
  - **P2-12（connectionStore 单槽）**：`ConnectionEntry.sshId` → `sshIds: string[]`（分屏每面板各持一条后端连接），新增 `currentSshId()` 选择器（取最新存活连接）；`removeConnection` 按 sshId 精确移除，列表清空才删条目。消费方（SFTPPanel / PortForwardPanel / sftpTransfer / XtermCanvas catch 路径）全部适配；SSH catch 中误伤其他面板连接的裸 `removeConnection(sessionId)` 改为按本次尝试 id 移除。
  - **P1-9（状态卡"已连接"）**：连接断开回调与终端面板卸载路径改为条件性重置——仅当该会话在 connectionStore 中已无存活连接时才 `setStatus('idle')`，同会话其他分屏仍连接时状态保持正确。
  - **P1-10（删除传输复活）**：TransferPanel 移除 running/paused/interrupted 条目时先调用后端取消再移除，进度事件不再复活已删除任务。
  - **设计决策**：后端死亡清理后**不**自动重建该会话的端口转发（避免与用户手动重建产生端口冲突；转发配置与后端会话绑定，自动重建留作后续增强）。挂起在暂停检查点上的旧传输任务不主动取消（连接死亡后无害，随应用退出回收）。
  - 校验：cargo fmt / clippy / test（30 通过）；npm run check（typecheck + lint 仅存 4 条既有警告 + 104 测试，含新增 connectionStore 用例）全部通过。

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

- [x] **P1-1 SSH 连接意外断开后后端零清理：死会话残留、端口转发监听器永久存活、僵尸转发不可见** — `src-tauri/src/ssh/mod.rs:561-578`
  - 场景：读循环退出只 `emit("ssh-closed-{id}")`，`sessions`/`forwards` 两个 map 均不清理；前端 closed 回调不调用 `disconnectSsh`（全仓 grep 确认），且已把 `backendId` 置空，之后 `ssh_disconnect` 永远不会被调用。后果：(a) `-L`/`-D` 的 TcpListener 继续接受连接并向死通道转发（全部失败）；(b) 重连后重建同端口转发时报「地址已被占用」；(c) 转发面板按当前 ssh_id 过滤，僵尸转发不可见也无法停止；(d) 死 `SshConnection` 永久泄漏。
  - 建议：在连接死亡路径（读循环结束处）执行与 `disconnect` 相同的 forwards 清理与会话移除，并 emit `port-forwards-changed`；需与前端重连逻辑（P1-7）联动设计「重连后是否自动重建转发」。
- [x] **P1-2 终端输出按块做 `from_utf8_lossy`，多字节字符跨块被截断成 U+FFFD 乱码** — `src-tauri/src/pty/mod.rs:107`、`src-tauri/src/ssh/mod.rs:564-569`
  - 场景：`cat`/`ls` 大段中文或 emoji，读取边界（PTY 32KiB、SSH 通道包 ~32KiB，均非 3 的倍数）落在多字节序列中间，两半各自变成替换符，滚动缓冲留下永久乱码。
  - 建议：读侧维护跨块字节残留缓冲，只按 UTF-8 边界切分后再 emit（或改二进制事件、前端解码）。
- [x] **P1-3 `write_pty` 为同步命令，在 UI 主线程执行可能无限阻塞的管道写** — `src-tauri/src/commands/mod.rs:55`、`src-tauri/src/pty/mod.rs:142`
  - 场景：已核实 tauri 2.12 + wry 0.57 中非 async 命令在主线程执行。子进程不消费 stdin（程序挂起）而用户粘贴大段文本时，`write_all` 阻塞 → 整个应用（事件循环、所有 IPC、窗口消息）冻结。`vault_unlock`（主线程跑 Argon2id，见 P2-9）、`read_text_file`（8MiB）同理。
  - 建议：PTY/IO/保险库类命令声明为 `async`（或 `#[tauri::command(async)]`），阻塞写挪到 `spawn_blocking`；注意 Tauri 2 中 async 命令默认在独立线程池执行，需确认 state 访问安全。
- [x] **P1-4 主机密钥确认等待期间会话 id 未占位，可产生无人监管的「已认证僵尸 SSH 会话」** — `src-tauri/src/ssh/mod.rs:466-473, 291-297, 580-591`
  - 场景：首次连接新主机 → `connect` 阻塞等待指纹确认（最长 120s），此时 id 未进 `sessions` map（仅 `contains_key` 检查）；用户点重连或关标签 → `disconnectSsh` 查不到 id 而空操作；之后用户仍点击还开着的确认窗「接受」→ 连接完成认证、`sessions.insert` 成功，成为无人监听、靠 keepalive 永久存活的僵尸会话（远端挂着已登录 shell）。并发同 id connect 还会互相覆盖 map 条目、交错输出。
  - 建议：连接开始即登记 pending 占位；收到同 id 新连接或显式断开时取消挂起的 host-key oneshot 并中止连接。
- [x] **P1-5 保险库原子写缺少 fsync，崩溃/断电可产生空或截断的 vault.json** — `src-tauri/src/vault.rs:235-240`
  - 场景：`std::fs::write` 到 `.tmp` 后未 `sync_all` 即 rename；断电时 rename 元数据可能先于数据落盘，得到 0 字节或残缺 JSON。残缺文件若能通过 JSON 解析但密文损坏，GCM 校验失败被上报为「主密码错误」（见 P1-6），诱导用户重置保险库，凭据全部丢失。
  - 建议：`File::create` + `write_all` + `sync_all` 再 rename；Unix 上 rename 后对父目录 fsync。
- [x] **P1-6 保险库 KDF 参数未持久化且从不校验，解密失败一律吞成 `Ok(false)`（"主密码错误"），任何参数漂移都会诱导用户重置** — `src-tauri/src/vault.rs:46, 104-122, 266-272`
  - 场景：文件只记 `kdf: "argon2id"` 字符串，unlock 只检查 `version`；密钥用 `Argon2::default()`（参数随 crate 版本走）。升级依赖或调整 `derive_key` 后所有旧保险库派生不同密钥 → GCM 校验失败 → 返回 `Ok(false)` → 前端提示「主密码错误」，重试无效后走 reset，数据全毁且无迁移路径。
  - 建议：把 m_cost/t_cost/p_cost/算法写入 VaultFile 并按存储参数派生（未知参数报明确错误）；将「文件损坏/参数不匹配」与「密码错误」区分为不同错误。

### 前端

- [x] **P1-7 SSH 自动重连链在第 1 次重试失败后永久中断** — `src/components/terminal/XtermCanvas.tsx:639, 763`（已复核）
  - 场景：已建立过的连接断开 → `scheduleReconnect` 排定第 1 次重试 → 到点重连时网络仍未恢复，`connectSsh` 抛错进 catch → `established` 是**本次尝试的局部变量**（恒为 false）→ `scheduleReconnect` 不再被调用，第 2~5 次退避重试永不发生，状态停在 error 只能手动重连。且 `established` 置 true 后到 try 结束全为同步无抛出代码，catch 路径实际从不触发重连。
  - 建议：catch 中改用会话级标志（`connectedAt > 0` 或独立 `everEstablished`）判断是否继续 `scheduleReconnect`。
- [x] **P1-8 `findPanelForSession` 不区分面板组件类型，SFTP/转发面板会「劫持」打开会话操作** — `src/features/workspace/sessionActions.ts:22-31, 44-52`（已复核）
  - 场景：为会话 X 打开过 SFTP 面板后关闭其终端标签 → 侧栏/命令面板点击会话 X → existing 分支命中 SFTP 面板，仅 `setActive()` 后返回，终端永远打不开。快速连接编辑后的 `openSession`（`useQuickConnectLauncher.ts:88,123`）同样受影响。
  - 建议：`findPanelForSession` 增加 terminal 组件过滤（`params.componentName` 或面板 id 前缀），仅 terminal 面板可命中 existing 分支。
- [x] **P1-9 终端面板关闭但同会话 SFTP/转发面板仍在时，会话状态永久停留「已连接」** — `src/components/layout/DockLayout.tsx:156-164`
  - 场景：SSH 已连接 → 打开其 SFTP 面板 → 关闭终端标签。XtermCanvas 卸载路径只 `disconnectSsh` + `removeConnection`，不 `setStatus('idle')`；`onDidRemovePanel` 的 `stillOpen` 检查命中 SFTP 面板而跳过重置 → 侧栏圆点与 StatusBar 持续显示已连接。
  - 建议：在 XtermCanvas 卸载清理中同步 `setStatus(sessionId,'idle')`，或 `stillOpen` 判定仅计入 terminal 组件面板。
- [x] **P1-10 删除「进行中」传输任务不取消后端传输，下一条进度事件使任务复活** — `src/components/transfers/TransferPanel.tsx:182-189`、`src/stores/transferStore.ts:108-127`
  - 场景：传输进行中点行尾 X 只过滤 store；后端继续跑，下一条 `sftp-progress` 到达时 `applyProgress` 找不到 id，走 `index === -1` 分支重新插入列表 —— 任务幽灵重现，带宽持续占用。
  - 建议：running/paused 状态禁止移除（或先自动 `cancelSftpTransfer` 再移除）。
- [x] **P1-11 传输「重试」复用已失效的 sshId，断线自动重连后重试必然失败** — `src/lib/sftpTransfer.ts:46-61`
  - 场景：传输因 SSH 断线失败 → 自动重连成功（每次连接生成新 UUID 作为后端 ssh id）→ 点重试仍用 `item.request.sshId` 旧 id → 后端 `connection(&ssh_id)` 查不到报错。最常见场景下重试按钮永久不可用。
  - 建议：`TransferRequest` 同时保存 sessionId，重试时经 connectionStore 解析当前 sshId（无连接则提示先重连）。
- [x] **P1-12 编辑私钥会话时口令留空会被空串静默覆写（内存 + 保险库）** — `src/features/workspace/useQuickConnectLauncher.ts:76-78`（已复核）
  - 场景：编辑使用加密私钥的 SSH 会话（只改名称/分组），「私钥口令」表单初始为空（`QuickConnectWindow.tsx:68`），保存时 password 有「留空沿用」守卫（`:73`），passphrase 没有 → 空串覆写内存凭据并经 `rememberSessionCredentials` 写入保险库；hydrate 时因 `session.id in passphrases` 也不再回填。下次连接解密私钥失败，且保险库中的正确口令已被覆盖（数据丢失）。
  - 建议：与 password 一致，仅 `result.passphrase` 非空时才 `setPassphrase` / 跳过空值持久化。
- [x] **P1-13 SSH config 导入不继承 `Host *` 通配块，无 User 行的会话导入后无法连接** — `src/lib/sessionImport.ts:71-96`
  - 场景：常见配置 `Host *` + `IdentityFile` 被整体丢弃（flush 中 alias 找不到即丢弃）；无 `User` 行时 username 为空，且导入路径不回退 `settings.defaultUsername` → 连接时抛「缺少主机或用户名」，SshConnectForm 无用户名输入框，只能逐个编辑补齐。
  - 建议：flush 时先收集通配块字段作为后续 Host 的默认值；导入时 username 回退 `defaultUsername`。
- [x] **P1-14 下载续传只看 `.part` 长度不校验来源，跨文件/跨版本续传产出损坏文件**（审计后补录，与 P0-1 同族，两个审计代理均报过）— `src-tauri/src/ssh/mod.rs:1547-1555`
  - 场景：下载远程文件 A 到 `P` 中断留下 `P.part`；之后把另一个远程文件 B（或服务器上已更新的同名文件）下载到同一本地路径，resume 默认开启 → 只要 part 长度 ≤ B 大小就从该偏移续传并追加到旧 `.part`，最终 rename 成 P，内容为 A 前缀 + B 后缀的混合体，报成功。
  - 建议：`.part` 旁持久化来源路径 + 远端 size/mtime 指纹，不匹配则丢弃重下。（已于批次一修复，见修复记录）

---

## P2（32 条）

### Rust 后端（SSH/SFTP、保险库、窗口）

- [x] **P2-1 conflict=skip 会把「上次取消上传留下的残缺远端文件」当成已完成** — `src-tauri/src/ssh/mod.rs:1497-1501`。上传无远端 `.part`，取消后目标路径直接留半个文件；skip 重传时 `try_exists` 为真即跳过并计入已传输，UI 报全部成功。随 P0-1 一并解决。
- [x] **P2-2 递归传输静默丢弃符号链接（含目录链接），无任何提示** — `src-tauri/src/ssh/mod.rs:1306-1314, 1340-1347`。readdir 的 SYMLINK 类型既不入栈也不入文件表；本地 WalkDir 同样跳过。传输「成功」但内容缺失；SFTP 浏览器也无法进入链接目录。建议读目标类型或至少计数并在完成事件中提示 skipped。
- [x] **P2-3 known_hosts 非原子写入 + 解析失败整体清零** — `src-tauri/src/ssh/mod.rs:140-146, 194-202`。写中崩溃/断电 → 文件截断 → `serde_json::from_slice` 失败被 `unwrap_or_default()` 吞掉 → 全部 TOFU 记录丢失，所有主机重新走首次确认（给 MITM 开窗）。建议 tmp+rename 原子替换；解析失败时保留旧文件并告警。
- [x] **P2-4 远程转发按端口（忽略绑定地址）分发，同端口多绑定地址时路由错乱** — `src-tauri/src/ssh/mod.rs:322`。`127.0.0.1:8080→A` 与 `192.168.x.x:8080→B` 可共存于 sshd，但回调只用 `connected_port` 查表，后注册者覆盖语义。建议以 `(connected_address, connected_port)` 为键。
- [x] **P2-5 OpenSSH known_hosts 导入对裸 IPv6 主机（标准 22 端口写法 `::1 ssh-ed25519 ...`）解析出错误标签** — `src-tauri/src/ssh/mod.rs:1975-1979`。`rsplit_once(':')` 把 `::1` 拆成 host=`::`、port=1，导入条目无法匹配真实连接，TOFU 会重复弹确认。建议含多个 `:` 的无方括号主机整段按 host 处理（端口 22）。
- [x] **P2-6 主机密钥确认 120s 超时后弹窗仍存活，迟到的「信任」被静默丢弃** — `src-tauri/src/ssh/mod.rs:291-297`。去线下核对指纹超 2 分钟很常见；超时后 pending 已移除，用户点「信任并连接」变 no-op，指纹未写入，界面无任何提示。建议超时后向前端发事件关闭弹窗并提示，或弹窗显示剩余时间。
- [x] **P2-7 保险库 persist 失败后内存与磁盘分歧，后续 unlock/change_password 重载磁盘会静默丢弃内存变更** — `src-tauri/src/vault.rs:143-146, 155-160, 126-130`。`set` 先改内存再写盘，persist 失败返回 Err 但内存已含新条目；之后 unlock/改密码从磁盘重载覆盖内存，条目无声消失。`delete` 反向同理。建议 persist 失败回滚内存（或先写盘再提交）。
- [x] **P2-8 `app_config_dir` 获取失败时保险库静默回退到系统临时目录** — `src-tauri/src/lib.rs:63-70`。/tmp 下的凭据库会被临时文件清理策略无声删除，且用户无从得知路径。建议回退时拒绝初始化保险库并报明确错误。
- [x] **P2-9 vault 命令同步执行：Argon2（~19MiB 内存困难运算）在主线程跑，解锁/创建/改密码冻结 UI 数百毫秒；且正确性依赖「同步命令主线程串行」这一隐式前提** — `src-tauri/src/vault.rs:119-130, 177-188`。任一 vault 命令改成 async 即产生丢失更新窗口。随 P1-3 一并处理（async + spawn_blocking + 取锁时校验状态）。
- [x] **P2-10 `open_modal_window` 在 `build()` 之后才注册窗口事件，快速关闭导致 promise 永久挂起 + ModalManager 条目泄漏** — `src-tauri/src/windows.rs:212-236`。build 与 `on_window_event` 之间还有两个同步调用；其间用户点 X → `Destroyed` 无人监听 → `receiver.await` 永不返回（快速连接/主机密钥对话框挂死）。建议 build 后立即注册事件，或加超时兜底 resolve(None)。
- [x] **P2-11 `open_settings_window` 的「检查已存在再创建」非原子，并发双开时一个调用方收到无意义报错** — `src-tauri/src/windows.rs:243-270`。连按 Ctrl+, 两个调用都通过 None 检查，后建者因 label 重复返回 Err。建议 Mutex 包裹检查+创建，或捕获「label 已存在」后改为聚焦既有窗口。

### 前端：终端与布局

- [x] **P2-12 同会话分屏多连接时 connectionStore 单槽覆盖，关闭较新分屏后 SFTP/转发面板误报未连接** — `src/stores/connectionStore.ts:19-22`。分屏各建独立 SSH 连接但 store 按 sessionId 只存一条；关闭较新面板按 sshId 匹配删除条目，旧连接仍存活却读不到。建议保存 sshId 集合或删除时回退到仍存活的旧 sshId。
- [x] **P2-13 resize 冻结窗口内的断线/重连通知绕过写队列直写 xterm，旧输出事后补写导致乱序** — `src/components/terminal/XtermCanvas.tsx:397, 538-547`。`writeFrozen` 期间 `flushPendingWrites` 直接返回，随后 `writeScrollbackNotice` 直写 → 解冻后旧输出才写入，「[SSH 连接已断开]」出现在更早历史之前，违反 FIFO 约束。建议冻结时通知先等解冻（或冻结前先 issue 队列）。
- [x] **P2-14 非激活分屏的 SSH 自动重连成功后 `instance.focus()` 抢走键盘焦点** — `src/components/terminal/XtermCanvas.tsx:753`。后台定时器驱动的重连成功即无条件 focus。建议仅该面板处于激活状态时才 focus。
- [x] **P2-15 连接状态下点击「清除认证」会卸载 XtermCanvas，杀掉活动 SSH 会话** — `src/components/terminal/TerminalTab.tsx:128-132, 306`。`clearCredentials` → needsAuth 翻 true → 渲染分支切到 SshConnectForm → 主 effect 清理断开 SSH、销毁终端实例。按钮语义「清除认证」却附带断连丢屏。建议仅在会话空闲时卸载，或改为标记需重认证。
- [x] **P2-16 会话收尾时处于 alt buffer 则不保存快照也不作废旧快照，下次打开恢复出上一次关闭的陈旧内容** — `src/components/terminal/XtermCanvas.tsx:1001-1003, 1061`。vim/htop 中关标签 → 跳过写入但 localStorage 留着更早的旧快照 → 下次提示「已恢复上次会话的滚动缓冲」但内容与本次无关。建议 alt buffer 跳过时同时 `clearTerminalSnapshot(sessionId)`。
- [x] **P2-17 系统字体读取失败被永久缓存为 null，会话内不再重试** — `src/theme/nativeLigaturesAddon.ts:59-63`。模块级缓存把瞬时失败固化为「无连字」，需重启应用恢复。建议失败结果不进缓存或加短 TTL。
- [x] **P2-18 布局持久化 250ms 防抖且无退出/删除前的 flush** — `src/components/layout/DockLayout.tsx:106-112`。删除会话或布局改动后 250ms 内退出 → localStorage 布局仍指向已删会话，下次启动出现僵尸占位面板或丢失最后一次布局。建议 `beforeunload`/`CloseRequested` 与 removeSession 前同步 flush。
- [x] **P2-19 TerminalPreview 的 Font Feature Settings 每敲一个字符整体重建预览终端（含 WebGL 上下文）** — `src/windows/settings/TerminalPreview.tsx:198`。重挂载依赖含 `fontFeatureSettings`，每键 dispose + 新建 Terminal + 重载插件。建议依赖收窄到 `[visible, fontLigatures]`，`fontFeatureSettings` 变化仅重载连字 addon。

### 前端：会话数据与导入

- [x] **P2-20 编辑会话把类型改回 local 时不清凭据，改回 SSH 后用旧密码静默重连** — `src/features/workspace/useQuickConnectLauncher.ts:66-71`。`isRemote=false` 跳过 `forgetSessionCredentials`；再改回 SSH 时 needsAuth=false 直接用旧凭据连接。建议 `previousKind !== 'local' && !isRemote` 时也清除。
- [x] **P2-21 编辑会话清空「用户名」保存后不生效（空串回退旧值），与 keyPath 可清空的行为不一致** — `src/stores/sessionStore.ts:78-79`。建议与 keyPath 一致：`patch.username !== undefined ? patch.username.trim() || undefined : session.username`。
- [x] **P2-22 PuTTY 导入不拆分 HostName 中的 `user@host`** — `src/lib/sessionImport.ts:220-222`。PuTTY 注册表原样存 `root@10.0.0.1`，导入后 host 带 `@`、username 为空，连接必然失败。建议按最后一个 `@` 拆分并回填 username。

### 前端：窗口与设置

- [x] **P2-23 设置窗口打开期间主窗口的设置变更（如命令面板切主题）会被「应用」用过期 draft 静默回滚** — `src/windows/SettingsWindow.tsx:227, 597`。draft 为挂载时一次性快照；主窗口 `ThemeProvider.cycle` 直写 store 不发 `nexterm-settings-applied`。known_hosts 列表同样只在挂载时加载一次。建议主窗口设置变更也广播事件，设置窗口监听合并进 draft。
- [x] **P2-24 设置窗口「取消」/关闭直接丢弃全部未保存修改（含 pending 的 known_hosts 删除），无确认** — `src/windows/SettingsWindow.tsx:1370-1372`。建议 draft 有差异或 removedHosts 非空时经 `confirmAction` 确认。
- [x] **P2-25 「清空保险库」流程先 lock 再逐会话 delete，全部 `vault_delete` 必然失败并被吞** — `src/windows/SettingsWindow.tsx:479-482`。当前仅因 `clearVault` 已清空全部条目才无实害，但属静默故障模式。建议去掉 lock 后的逐会话 delete（或调换顺序）。
- [x] **P2-26 主窗口（SshConnectForm）解锁保险库不广播事件，设置窗口状态陈旧可导致误操作** — `src/components/terminal/SshConnectForm.tsx:96`、`src/stores/vaultStore.ts:42`。设置窗口开着时显示「创建保险库/解锁」而实际状态已变，点击报错。同类：`vault_lock/set/delete` 后端均不 emit，跨窗口同步依赖调用方手动 emit 的脆弱约定。建议把 unlocked/locked/cleared 事件移到后端命令内 `AppHandle::emit`，删除前端手动同步。
- [x] **P2-27 快速连接端口无 1–65535 校验，非法值持久化后连接时报晦涩的 IPC 反序列化错误** — `src/windows/QuickConnectWindow.tsx:126`（输入框仅过滤非数字，`185`）。`ssh_connect` 的 `port: u16` 对 99999 直接 serde 失败。建议提交前校验并在表单内报错。
- [x] **P2-28 PromptWindow 的 Enter 提交未排除输入法组合态，中文 IME 下确认候选词会误提交主密码弹窗** — `src/windows/PromptWindow.tsx:57-62`。全仓无 `isComposing` 处理。建议提交条件加 `!event.nativeEvent.isComposing`。

### 前端：功能面板

- [x] **P2-29 端口转发面板绑定的会话未连接时，列表回退为显示全部会话的转发规则（跨会话数据泄漏且可误停）** — `src/components/forward/PortForwardPanel.tsx:96`。`sshId ? filter : forwards`，与上方「尚未建立 SSH 连接」文案矛盾。建议绑定会话未连接时显示空列表。
- [x] **P2-30 命令面板「关闭当前标签页」实际关闭该会话的全部面板（含 SFTP/转发），与 TitleBar 行为不一致** — `src/components/command/CommandPalette.tsx:206-213` → `closeSessionPanels`。建议改为 `getApi()?.activePanel?.api.close()` 或改名「关闭会话所有面板」。
- [x] **P2-31 SFTP/转发面板的自动绑定 effect 使「选择会话」（解绑）无法生效，立即被回绑** — `src/components/sftp/SFTPPanel.tsx:107-113`（`PortForwardPanel.tsx:84-90` 同）。建议用显式解绑哨兵区分「用户主动解绑」与「初始未绑定」。
- [x] **P2-32 删除正在传输的文件/目录无任何防护** — `src/components/sftp/SFTPPanel.tsx:360-384`。Linux 上 unlink 后上传句柄仍有效，继续写入已断链 inode 并报「成功」，数据实际丢失；删目录与递归传输竞争产生半成品。建议删除前按路径匹配 transferStore 中 running/paused 任务并阻止。

---

## 建议修复批次（下一轮会话执行顺序参考）

1. ~~**数据安全（P0）**：P0-1（连同 P2-1 统一重做上传续传：远端 `.part` + rename + 指纹）、P0-2（连同 P1-5 补 fsync）。~~ ✅ 已完成（2026-10-24，含补录的 P1-14，详见「修复记录」）。
2. ~~**断线生命周期一致性**：P1-1（后端死亡清理）× P1-7（前端重连链）× P2-12（connectionStore 多连接）× P1-9（状态残留）× P1-11（重试 sshId）× P1-10（删除复活）。~~ ✅ 已完成（2026-10-25；转发不自动重建的设计决策见修复记录）。
3. ~~**保险库健壮性**：P1-6（KDF 参数持久化 + 错误分类，注意向后兼容旧 vault 文件）、P2-7、P2-8、P2-9、P2-25、P2-26、P1-12、P2-20。~~ ✅ 已完成（2026-10-25；P1-12/P2-20 已随传输功能轮修复）。
4. ~~**输出正确性与响应性**：P1-2（UTF-8 增量解码）、P1-3（async 化，注意连带 vault）、P2-19。~~ ✅ 已完成（2026-10-25）。
5. ~~**主机密钥与 known_hosts**：P1-4（连接占位）、P2-6（超时反馈）、P2-3（原子写）、P2-5（IPv6 导入）。~~ ✅ 已完成（2026-10-26）。
6. ~~**面板与导入体验**：P1-8、P1-13、P2-21、P2-22、P2-18、P2-30、P2-31、P2-29、P2-32、P2-27。~~ ✅ 已完成（2026-10-26）。
7. ~~**其余 UI 细节**：P2-10、P2-11、P2-13、P2-14、P2-15、P2-16、P2-17、P2-23、P2-24、P2-28。~~ ✅ 已完成（2026-10-26）。补漏的 P2-2（符号链接）与 P2-4（远程转发按键）亦同轮完成。

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
