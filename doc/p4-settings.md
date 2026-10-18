# P4：设置与打磨（进行中）

> 状态：设置面板核心能力已完成，剩余国际化、可访问性增强与连接体验打磨。

## 1. 已完成

### 1.1 设置面板

- 入口：顶栏「设置」图标、命令面板「打开设置」。
- 分组：外观 / 终端 / SSH 默认值 / 快捷键 / 已知主机 / 关于。
- 支持一键「恢复默认」，并同步重置主题为「跟随系统」。

### 1.2 外观

- 明亮 / 暗黑 / 跟随系统，驱动 `ThemeProvider` 与 `<html data-theme>`。
- 设置持久化到 `nexterm.settings.v1`。

### 1.3 终端外观

- 字体预设（Consolas / JetBrains Mono / Cascadia Code / 系统等宽）。
- 字号 10–20px。
- 光标样式：方块 / 下划线 / 竖线；光标闪烁开关。
- 回滚行数 1000–100000。
- 行高 0.8–1.6。
- 设置变化会实时应用到已打开的终端（重新 fit）。

### 1.4 SSH 默认值

- 默认认证方式（密码 / 私钥）。
- 默认端口。
- 默认用户名。
- 新建会话时自动带入 QuickConnect。

### 1.5 快捷键

- 可配置动作：打开命令面板、新建本地终端、新建 SSH 会话、打开设置。
- 快捷键输入框直接捕获组合键，要求包含 Ctrl / Alt / Meta。
- 全局快捷键由 `useGlobalShortcuts` 统一分发；命令面板不再硬编码 Ctrl+K。
- 默认值：
  - 命令面板 `Ctrl+K`
  - 新建本地终端 `Ctrl+T`
  - 新建 SSH 会话 `Ctrl+Shift+N`
  - 打开设置 `Ctrl+,`

### 1.6 安全与基础设施

- known_hosts 列表与删除（与 P3 的主机密钥校验联动）。
- `prefers-reduced-motion` 下自动关闭动画与过渡。
- `settingsStore` 使用 Zustand persist，并提供向后兼容的 `merge`。

## 2. 计划中

1. **终端配色方案**：独立于 UI 主题的终端主题预设（如经典深蓝、Solarized、浅色）。
2. **国际化**：抽取文案，中英文切换。
3. **可访问性增强**：对话框焦点陷阱、Toast `aria-live`、键盘可达性检查、对比度校验。
4. **传输设置**：并发数、冲突策略、默认下载目录。
5. **连接体验**：断线重连横幅、自动重连退避、连接状态通知。
6. **配置管理**：设置导入/导出、重置、迁移。
7. **SSH 高级默认值**：连接超时、KeepAlive、代理。
8. **引导与空状态**：首次使用引导、错误恢复建议。

## 3. 架构约定

- 设置值统一放 `src/stores/settingsStore.ts`，持久化键名 `nexterm.settings.v1`。
- 主题模式由 `ThemeProvider` 管理，UI 通过 `useTheme()` 读写，不在设置面板重复存储。
- 安全相关数据（known_hosts）由 Rust 后端持久化，前端只通过命令读写。
- 快捷键解析/匹配在 `src/lib/shortcuts.ts`，全局分发在 `src/hooks/useGlobalShortcuts.ts`。
- 终端外观在 `XtermCanvas` 创建时读取，并监听设置变化实时更新。
- 新增设置项时：先加 store 字段 → 在设置面板加控件 → 在使用处读取，避免散落的 localStorage 键。
