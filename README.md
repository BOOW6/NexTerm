# NexTerm

NexTerm 是一个基于 **Tauri 2.0** 构建的、生产就绪的跨平台**终端与远程管理应用**，目标定位为现代开源版的 MobaXterm。它将本地 PTY 终端、SSH 远程连接与文件管理（SFTP）能力整合进一个可自由拖拽、分屏、多标签的工作台中。

> 当前仓库处于基础设施 + SSH/SFTP 第三阶段 + P4 设置打磨：本地 PTY、会话管理、多标签/分屏、命令面板、Web 2.0 主题系统已经可用；SSH 支持密码/私钥认证、主机密钥校验与交互终端，SFTP 支持目录浏览、上传/下载、传输队列与文件操作；设置面板已基本完成。

## 功能特性

- **本地终端**：基于 `portable-pty` + xterm.js，支持多标签、分屏与隐藏标签保活。
- **SSH**：密码 / 私钥认证、主机密钥 TOFU 校验、交互式终端、断线手动重连。
- **SFTP**：目录浏览、上传/下载、传输队列、新建文件夹、重命名、删除。
- **工作区**：Dockview 多面板、可持久化布局、自定义标签页与右键菜单。
- **效率**：会话管理器、快速连接、`Ctrl+K` 命令面板、可配置快捷键。
- **外观**：Web 2.0 经典后台风格，支持明亮 / 暗黑 / 跟随系统；终端字体、字号、光标、回滚、行高可调。

## 构建与运行

环境准备、构建步骤、IPC 接口与常见问题统一维护在 [`doc/build.md`](doc/build.md)。

## 安全说明

- **主机密钥校验**：首次连接需确认 SHA256 指纹，后续自动比对；不匹配会中止连接。
- **凭据仅内存保存**：密码与私钥 passphrase 不写入磁盘，重启应用后需重新输入。
- **known_hosts**：保存在应用配置目录的 `known_hosts.json`，为本项目自有格式，暂不与 OpenSSH 的 `~/.ssh/known_hosts` 互通。
- **SFTP 范围**：支持浏览与上传/下载/新建/重命名/删除，暂不支持权限修改与递归传输。

详细说明见 [`doc/p3-ssh-sftp.md`](doc/p3-ssh-sftp.md)。

## 文档

- [`AGENTS.md`](AGENTS.md) —— 项目上下文、技术栈、目录结构、开发约定与路线图
- [`doc/build.md`](doc/build.md) —— 环境准备、构建、IPC 接口与常见问题
- [`doc/ui-style-web2.md`](doc/ui-style-web2.md) —— Web 2.0 UI 风格规范
- [`doc/p3-ssh-sftp.md`](doc/p3-ssh-sftp.md) —— SSH / SFTP 阶段说明与安全注意事项
- [`doc/p4-settings.md`](doc/p4-settings.md) —— 设置与打磨进度
