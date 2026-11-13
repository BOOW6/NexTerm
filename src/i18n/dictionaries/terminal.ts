import type { Dictionary } from './types';

// Terminal surface: XtermCanvas notices/errors, SSH connect form leftovers.
export const ZH: Dictionary = {
  'terminal.sshReconnectExhausted': 'SSH 自动重连已达上限，已停止重试',
  'terminal.reconnectCountdown': '{reason}，{seconds} 秒后进行第 {attempt}/5 次重连',
  'terminal.missingHost': '缺少主机或用户名',
  'terminal.missingPassword': '缺少密码',
  'terminal.missingKeyFile': '缺少私钥文件',
  'terminal.missingKeyOrCert': '缺少私钥或证书文件',
  'terminal.jumpMissingUsername': '缺少跳板会话用户名',
  'terminal.jumpMissingPassword': '跳板会话缺少密码，请先连接一次该会话以保存凭据',
  'terminal.jumpMissingKeyFile': '跳板会话缺少私钥文件',
  'terminal.jumpMissingKeyOrCert': '跳板会话缺少私钥或证书文件',
  'terminal.sshDisconnected': 'SSH 连接已断开',
  'terminal.sshClosedByServer': 'SSH 连接已被服务器关闭',
  'terminal.sshConnectFailed': 'SSH 连接失败：{message}',
  'terminal.sshConnectFailedReason': 'SSH 连接失败',
  'terminal.localShellExited': '本地 Shell 已退出',
  'terminal.ptyCreateFailed': '无法创建 PTY 会话：{message}',
  'terminal.missingHostAddress': '缺少主机地址',
  'terminal.telnetDisconnected': 'Telnet 连接已断开',
  'terminal.telnetConnectFailed': '无法建立 Telnet 连接：{message}',
  'terminal.reconnectNotice': '正在重连',
  'terminal.scrollbackRestored': '已恢复上次会话的滚动缓冲'
};

export const EN: Dictionary = {
  'terminal.sshReconnectExhausted': 'SSH auto-reconnect limit reached; retries stopped',
  'terminal.reconnectCountdown': '{reason}; reconnecting (attempt {attempt}/5) in {seconds}s',
  'terminal.missingHost': 'Missing host or username',
  'terminal.missingPassword': 'Missing password',
  'terminal.missingKeyFile': 'Missing private key file',
  'terminal.missingKeyOrCert': 'Missing private key or certificate file',
  'terminal.jumpMissingUsername': 'Missing jump host username',
  'terminal.jumpMissingPassword':
    'Jump host is missing a password; connect to that session once to save its credentials',
  'terminal.jumpMissingKeyFile': 'Jump host is missing a private key file',
  'terminal.jumpMissingKeyOrCert': 'Jump host is missing a private key or certificate file',
  'terminal.sshDisconnected': 'SSH disconnected',
  'terminal.sshClosedByServer': 'SSH connection closed by server',
  'terminal.sshConnectFailed': 'SSH connection failed: {message}',
  'terminal.sshConnectFailedReason': 'SSH connection failed',
  'terminal.localShellExited': 'Local shell exited',
  'terminal.ptyCreateFailed': 'Failed to create PTY session: {message}',
  'terminal.missingHostAddress': 'Missing host address',
  'terminal.telnetDisconnected': 'Telnet disconnected',
  'terminal.telnetConnectFailed': 'Failed to establish Telnet connection: {message}',
  'terminal.reconnectNotice': 'Reconnecting',
  'terminal.scrollbackRestored': 'Restored scrollback from the previous session'
};
