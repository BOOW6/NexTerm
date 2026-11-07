## 环境准备

所有平台都需要：

- **Node.js 18+**（建议 20 LTS 及以上）与 npm。
- **Rust 稳定版工具链**（通过 [rustup](https://rustup.rs/) 安装，包含 `cargo`）：
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  ```
  Windows 用户也可从 <https://rustup.rs/> 下载安装器。

此外，`russh` 默认使用 `aws-lc-rs` 加密后端，其底层 `aws-lc-sys` 是一个需要本地编译的 C 库：

- 需要一个 **C 编译器**（MSVC / clang / gcc）。
- 需要 **CMake**。
- 在 **x86_64 的 Windows 与 Linux** 上还需要 **NASM**。

各平台还需 Tauri 2.0 的系统依赖，见下文。

### Windows

1. **Microsoft C++ Build Tools**：安装「使用 C++ 的桌面开发」工作负载（提供 MSVC 工具链）。
   - 或安装完整 Visual Studio 2022 并勾选 C++ 桌面开发。
2. **WebView2 运行时**：Windows 11 / 已更新的 Windows 10 通常已内置；若缺失可从微软官网安装 Evergreen Runtime。
3. **NASM 与 CMake**（编译 `aws-lc-sys` 所需）：
   建议使用 NASM zip release build，将解压目录加入 `PATH`。
4. 打开**新的**终端，确认工具链可见：
   ```powershell
   node -v; npm -v; rustc --version; cargo --version; nasm -v
   ```

> 若无法或不希望安装 NASM，可改用 `russh` 的 `ring` 加密后端（见「常见问题」）。

### macOS

1. 安装 Xcode 命令行工具（提供 clang 与 Make）：
   ```bash
   xcode-select --install
   ```
2. 安装 CMake（以及可能需要的 NASM）：
   ```bash
   brew install cmake nasm
   ```
3. 系统自带 WebKit，无需额外安装。

### Linux（以 Debian / Ubuntu 为例）

安装 Tauri 2.0 与编译 `aws-lc-sys` 所需的系统依赖：

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl wget file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  cmake nasm
```

（Arch 系可用 `webkit2gtk-4.1`、`base-devel`、`cmake`、`nasm` 等；Fedora 用 `webkit2gtk4.1-devel`、`openssl-devel`、`libappindicator-gtk3-devel`、`librsvg2-devel`、`cmake`、`nasm`。）

## 本地构建

### 1. 克隆并安装前端依赖

```bash
git clone git@github.com:BOOW6/NexTerm.git
cd NexTerm
npm install
```

### 2. 应用图标

仓库已内置应用图标，无需首次构建时额外生成：

- 源文件：`src-tauri/app-icon.svg`（矢量源）与 `src-tauri/app-icon.png`（位图源）
- 生成产物：`src-tauri/icons/`，由 Tauri CLI 生成并纳入版本控制
- `src-tauri/tauri.conf.json` 的 `bundle.icon` 直接引用这些生成文件

如需替换图标，更新源文件后执行：

```bash
npm run tauri icon src-tauri/app-icon.svg
```

该命令会重新生成 `src-tauri/icons/` 下各平台所需的图标。提交时请同时包含源文件与生成产物，确保 CI 和打包环境无需额外步骤。

### 3. 开发模式运行

```bash
npm run tauri dev
```

该命令会依次执行 `beforeDevCommand`（启动 Vite 开发服务器，端口 `1420`）并编译运行 Rust 后端。

### 4. 构建生产版本

```bash
npm run tauri build
```

构建流程：`npm run build`（`tsc` 类型检查 + `vite build` 产出到 `dist/`）→ 编译 Rust release → 打包安装程序。

产物位置：

- 可执行文件：`src-tauri/target/release/nexterm`（Windows 为 `nexterm.exe`）
- 安装包（视平台而定）：
  - Windows：`src-tauri/target/release/bundle/msi/*.msi`、`.../bundle/nsis/*-setup.exe`
  - macOS：`src-tauri/target/release/bundle/dmg/*.dmg`、`.../macos/*.app`
  - Linux：`src-tauri/target/release/bundle/deb/*.deb`、`.../appimage/*.AppImage`

> 只构建可执行文件、跳过打包安装程序：`npm run tauri build -- --no-bundle`

### 5. 构建验证

```bash
npx tsc --noEmit
```

```bash
cd src-tauri
cargo check
```

## IPC 接口一览

### 本地 PTY

```ts
ptyPlatformInfo(): Promise<{ backend, buildNumber }>
createPtySession(id, cols, rows, logPath?): Promise<string>
writePty(id, data): Promise<void>
resizePty(id, cols, rows): Promise<void>
closePtySession(id): Promise<void>
setSessionLog(id, logPath): Promise<void>
```

输出事件：`pty-output-{id}`。`ptyPlatformInfo` 返回 ConPTY 后端与 Windows build number，用于配置 xterm 的 `windowsPty` 兼容选项。`logPath` 指定会话日志文件（追加写，null 关闭）；`setSessionLog` 对活动会话（SSH、本地 PTY 或 Telnet）即时切换。

### Telnet

```ts
connectTelnet({ id, host, port, logPath? }): Promise<string>
writeTelnet(id, data): Promise<void>
resizeTelnet(id, cols, rows): Promise<void>   // 未协商窗口尺寸，no-op
disconnectTelnet(id): Promise<void>
```

输出事件：`telnet-output-{id}`、`telnet-closed-{id}`。实现为最小 RFC 854 NVT（`src-tauri/src/telnet/mod.rs`）：拒绝所有选项协商，登录在终端内完成。

### SSH / SFTP

```ts
sshConnect({
  id, host, port, username, authMethod,   // password | key | certificate | agent
  password, privateKeyPath, certPath, passphrase,
  jump,                                   // 跳板机（ProxyJump）：由另一会话解析出的连接参数
  logPath, cols, rows
}): Promise<string>
sshWrite(id, data): Promise<void>
sshResize(id, cols, rows): Promise<void>
sshDisconnect(id): Promise<void>
respondHostKey(requestId, accept): Promise<void>
knownHostsList(): Promise<KnownHost[]>
knownHostsRemove(host): Promise<void>
sftpList(id, path): Promise<SftpEntry[]>
sftpUpload(id, localPath, remotePath): Promise<string>
sftpDownload(id, remotePath, localPath): Promise<string>
sftpRemove(id, path, isDir): Promise<void>
sftpRename(id, from, to): Promise<void>
sftpMkdir(id, path): Promise<void>
```

事件：

- 主机密钥确认：`ssh-host-key`
- 主机密钥不匹配：`ssh-host-key-mismatch`
- SSH 输出：`ssh-output-{id}`、`ssh-closed-{id}`
- 传输进度：`sftp-progress`
- 传输完成：`sftp-transfer-done`

> 安全相关说明见 [`p3-ssh-sftp.md`](p3-ssh-sftp.md)。known_hosts 保存在应用配置目录的 `known_hosts.json`，为本项目自有格式，暂不与 OpenSSH 互通。

SSH 连接默认每 30 秒发送一次保活探测，连续 3 次无响应后断开；前端在「设置 > SSH」中可开启断线自动重连（1s / 2s / 4s / 8s / 16s 退避，最多 5 次）。

### 凭据保险库 / 文件导入

```ts
vaultStatus(): Promise<{ initialized, unlocked, entry_count }>
vaultInitialize(masterPassword): Promise<VaultStatus>
vaultUnlock(masterPassword): Promise<boolean>
vaultLock(): Promise<void>
vaultSet(name, secret): Promise<void>
vaultGet(name): Promise<string | null>
vaultDelete(name): Promise<void>
vaultClear(): Promise<void>
vaultChangePassword(oldPassword, newPassword): Promise<VaultStatus>
vaultReset(): Promise<void>
readTextFile(path): Promise<string>
writeTextFile(path, contents): Promise<void>
```

保险库文件为应用配置目录下的 `credentials.vault.json`，使用 Argon2id 派生密钥与 AES-256-GCM 加密；应用重启后默认锁定。会话导入解析在 `src/lib/sessionImport.ts` 中完成（SSH config / MobaXterm / PuTTY / NexTerm JSON），文件读写通过 `read_text_file` / `write_text_file`。

## 自动更新（updater）

应用接入 `tauri-plugin-updater`（tauri.conf.json 的 `plugins.updater` 配置公钥与更新源，capability 含 `updater:default`）。设置 > 关于 的「检查更新」会请求更新源；没有已发布的签名更新时提示失败属预期。

发布一个新版本的流程：

1. **签名私钥**：已生成于 `~/.tauri/nexterm-updater.key`（不在仓库内，务必备份；丢失则已发布的更新无法继续签名）。公钥随包内置在 `tauri.conf.json`。
2. **构建签名产物**：发布构建时开启 updater 产物并签名——
   ```bash
   # bash
   export TAURI_SIGNING_PRIVATE_KEY_PATH="$HOME/.tauri/nexterm-updater.key"
   npx tauri build --config '{"bundle":{"createUpdaterArtifacts":true}}'
   ```
   产物为安装包 + `.sig` 签名。
3. **发布**：在 GitHub Release 上传安装包与 `.sig`，并上传 `latest.json`（`version`、`pub_date`、`platforms.<target>` 的 `signature` 与 `url` 指向安装包资产）。
4. 更新源默认指向 `https://github.com/BOOW6/NexTerm/releases/latest/download/latest.json`，仓库迁移时同步修改 `tauri.conf.json`。

## Windows ConPTY

Windows 构建会通过 `conpty-assets` 随包携带 Microsoft ConPTY（x64）。应用启动时会将其中的 `conpty.dll` / `OpenConsole.exe` 解压到应用本地数据目录，并在创建第一个 PTY 之前加载。

这样 `portable-pty` 会优先使用随包 ConPTY，而不是系统 ConPTY。新版 ConPTY 支持 `PSEUDOCONSOLE_RESIZE_QUIRK`，窗口缩放时不再重印整屏；xterm.js 负责自己的缓冲区 reflow，从而避免垂直缩放时的行重影。许可证、来源与 SHA-256 见 [`src-tauri/THIRD_PARTY_NOTICES.md`](../src-tauri/THIRD_PARTY_NOTICES.md)。

## 常见问题

### `aws-lc-sys` 编译失败 / 找不到 NASM

报错形如 `NASM command not found! Build cannot continue.`：说明缺少 NASM。按上文安装 NASM 并确保其在 `PATH` 中，然后**重新打开终端**再构建。

如果仍希望彻底避免 NASM，可让 `russh` 改用 `ring` 后端。编辑 `src-tauri/Cargo.toml`：

```toml
russh = { version = "0.63.1", default-features = false, features = ["ring", "flate2", "rsa"] }
```

随后执行 `cargo update -p russh`（在 `src-tauri/` 目录下）并重新构建。

### 不要启用 React StrictMode

StrictMode 的开发期双调用会为每个终端创建两个 PTY 会话（`create_pty_session` 副作用不幂等）。`src/main.tsx` 已刻意不使用 StrictMode。
