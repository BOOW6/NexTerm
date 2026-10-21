# P3：SSH 与 SFTP（第三阶段）

> 状态：第三阶段完成（交互终端 + 主机密钥校验 + 密钥认证 + SFTP 浏览/传输/文件操作）
> 依赖：`russh 0.63.3`、`russh-sftp 3.0.1`、`tauri-plugin-dialog 2.x`

## 1. 已完成内容

### 1.1 后端

- **`close_pty_session(id)`**：从 PTY 会话表中移除并 `kill()` 子进程，修复关闭标签后 PTY 泄漏。前端在 `XtermCanvas` 卸载时调用。
- **SSH 连接管理**（`src-tauri/src/ssh/mod.rs`，`russh`）：
  - **密码认证**与**私钥认证**（`russh::keys::load_secret_key` + 可选 passphrase + RSA hash 协商）。
  - 申请 PTY + 交互式 shell。
  - 读取任务把 `ChannelMsg::Data` / `ExtendedData` 通过事件推送：
    - `ssh-output-{id}`
    - `ssh-closed-{id}`
  - 写入、窗口尺寸调整、断开连接。
- **主机密钥校验（TOFU）**：
  - 首次连接发出 `ssh-host-key` 事件，携带 `request_id / host / port / fingerprint / algorithm`，等待前端确认（120 秒超时）。
  - 已记录且匹配 → 直接通过；已记录但不匹配 → 发出 `ssh-host-key-mismatch` 并拒绝连接。
  - 用户确认后写入本地 `known_hosts.json`（应用配置目录），后续自动校验。
- **SFTP**：
  - 目录读取、上传、下载（后台任务 + 进度事件）。
  - 新建目录、重命名、删除文件/目录。
  - 每次操作复用现有 SSH 连接，打开独立 sftp 子系统频道。
- **命令注册**（`src-tauri/src/commands/mod.rs`）：
  - `close_pty_session`
  - `ssh_connect(host, port, username, authMethod, password, privateKeyPath, passphrase, cols, rows) -> id`
  - `ssh_write` / `ssh_resize` / `ssh_disconnect`
  - `ssh_host_key_response(requestId, accept)`
  - `known_hosts_list` / `known_hosts_remove(host)`
  - `sftp_list` / `sftp_download` / `sftp_upload`
  - `sftp_remove` / `sftp_rename` / `sftp_mkdir`

### 1.2 前端

- **`useTauriSsh.ts`**：封装 SSH 连接、认证参数、主机密钥响应、known_hosts 管理、SFTP 浏览/传输/文件操作与事件订阅。
- **`credentialStore`**：密码、passphrase、授权标记仅保存在内存，退出应用后重新输入。
- **`connectionStore`**：按会话记录当前 SSH 连接 id 与状态，供 SFTP 面板使用。
- **`useSshHostKeyEvents` + `HostKeyWindow`**：
  - 首次连接弹出指纹确认窗口（信任并连接 / 取消连接）。
  - 密钥不匹配时弹出高危提示，并中止连接。
- **`XtermCanvas`**：支持 `local | ssh`；认证方式、私钥路径、passphrase 变化会触发重连。
- **`SshConnectForm`**：密码模式要求输入密码；密钥模式显示私钥路径与可选 passphrase。
- **`TerminalTab`**：「重新认证」清除内存凭据并回到认证表单；字号跟随设置。
- **`QuickConnectWindow`**：支持密码 / 私钥两种认证方式、私钥文件选择器、passphrase。
- **`SFTPPanel`**：
  - 目录列表、双击进入、上级目录、刷新、权限/大小/时间。
  - 上传（多选）、下载（保存对话框）、新建文件夹、重命名、删除（二次确认）、复制路径。
  - 传输完成后自动刷新目录。
- **传输队列**：`transferStore` + `TransferPanel`，显示进度、速度、成功/失败、清理已完成。
- **入口**：顶栏「SFTP」、命令面板「打开 SFTP 面板 / 打开传输队列」。

## 2. 安全说明（重要）

- **主机密钥已校验**：首次连接需人工确认指纹，后续连接自动比对；不匹配会直接中止。
- **known_hosts 为本项目自有 JSON 格式**：保存在应用配置目录的 `known_hosts.json`，并支持 OpenSSH `known_hosts` 格式导入/导出（导入跳过 hashed host，导出可选 hashed host）。
- **密码 / passphrase 仅内存保存**：关闭应用即丢失。
- **支持密码、私钥与 SSH Agent 认证**：Agent 通过 `SSH_AUTH_SOCK`（Windows 为 OpenSSH named pipe / Pageant）读取身份；暂不支持加载 OpenSSH 证书文件。
- **本地路径来自系统对话框**：上传/下载路径由 `tauri-plugin-dialog` 提供，避免前端伪造任意本地路径。

## 3. 已知限制与后续工作

1. **OpenSSH known_hosts 兼容**：已支持导入/导出；导入 hashed host 条目仍需人工处理。
2. **SSH 证书**：Agent 已支持证书身份；仍需支持从文件加载 OpenSSH 证书与 CA 校验。
3. **传输增强**：已支持递归、断点续传、暂停/继续、取消、重试与冲突策略；待加入并发数限制与带宽限速。
4. **SFTP 独立会话**：当前 SFTP 面板跟随活动 SSH 连接，并在连接内复用一条 SFTP 子系统通道。
5. **连接复用与多面板**：同一会话分屏仍会建立多个 SSH 连接；后续可按会话复用连接。
6. **断线重连策略**：当前需手动重连；后续加入自动重连与退避。
7. **端口转发**：已支持本地/远程/动态 SOCKS5；规则当前仅保存在内存中，重启后需重建。
8. **输入校验**：DNS、IPv6、端口范围等。

## 4. 验证记录

- `cargo check`：通过。
- `npx tsc --noEmit` + `npm run build`：通过。
- `npm run tauri build`：通过，产物：
  - `src-tauri/target/release/nexterm.exe`
  - `.../bundle/msi/NexTerm_0.1.0_x64_en-US.msi`（6.07 MiB）
  - `.../bundle/nsis/NexTerm_0.1.0_x64-setup.exe`（4.24 MiB）
- CDP 前端流程验证：
  - 无凭据 SSH 会话显示认证表单；
  - 设置面板可切换主题、调整终端字号（持久化）、展示 known_hosts；
  - 快速连接支持切换「密码 / 私钥」并显示私钥与口令字段；
  - SFTP 面板显示新建文件夹、上传、传输队列入口；
  - 无未捕获异常。
- 说明：真实 SSH 连接 / 指纹确认 / 传输需在 Tauri 应用内连接实际服务器验证。
