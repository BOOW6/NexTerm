import { useCallback } from 'react';
import { useSettingsStore, type LanguageSetting } from '../stores/settingsStore';

export type Locale = 'zh-CN' | 'en-US';

type Dictionary = Record<string, string>;
type TranslationParams = Record<string, string | number>;

const ZH: Dictionary = {
  'app.workspaceTitle': 'NexTerm 工作区',
  'app.workspaceHint': '从左侧会话列表选择会话，或新建一个本地终端 / SSH 连接。',
  'app.newSession': '新建会话',
  'sidebar.title': '会话管理器',
  'sidebar.newSession': '新建会话',
  'sidebar.quickConnect': '快速连接',
  'sidebar.search': '搜索会话...',
  'sidebar.empty': '还没有任何会话',
  'sidebar.noMatch': '没有匹配的会话',
  'sidebar.favorites': '收藏',
  'sidebar.total': '共 {count} 个会话',
  'sidebar.import': '导入 SSH 配置',
  'sidebar.importMoba': '导入 MobaXterm 会话',
  'sidebar.importPutty': '导入 PuTTY 会话',
  'sidebar.importBackup': '导入 NexTerm 备份',
  'sidebar.export': '导出会话备份',
  'sidebar.importMenu': '导入或导出会话',
  'sidebar.importPick': '选择要导入的文件',
  'sidebar.importNone': '没有找到可导入的会话',
  'sidebar.imported': '已导入 {count} 个会话',
  'sidebar.importedSkipped': '跳过 {count} 个重复会话',
  'sidebar.importFailed': '导入失败',
  'sidebar.exported': '会话备份已导出',
  'sidebar.exportFailed': '导出失败',
  'sidebar.deleteTitle': '删除会话',
  'sidebar.deleteConfirm': '确定删除「{name}」吗？',
  'sidebar.deleted': '已删除「{name}」',
  'session.open': '打开',
  'session.edit': '编辑',
  'session.favorite': '收藏',
  'session.unfavorite': '取消收藏',
  'session.delete': '删除',
  'session.more': '{name} 的更多操作',
  'terminal.find': '查找',
  'terminal.clear': '清屏',
  'terminal.copy': '复制选中',
  'terminal.fontDown': '减小字号',
  'terminal.fontUp': '放大字号',
  'terminal.reconnect': '重连',
  'terminal.clearAuth': '清除认证',
  'terminal.clearAuthBlocked': '会话连接中，请先断开再清除认证',
  'terminal.copied': '已复制选中内容',
  'terminal.nothingSelected': '没有选中内容',
  'terminal.clipboardFailed': '无法读取剪贴板',
  'terminal.searchPlaceholder': '查找...',
  'terminal.prevMatch': '上一个',
  'terminal.nextMatch': '下一个',
  'terminal.closeSearch': '关闭查找',
  'terminal.copyAction': '复制',
  'terminal.paste': '粘贴',
  'terminal.selectAll': '全选',
  'terminal.reconnectToast': '正在重连会话…',
  'terminal.missing': '会话不存在',
  'terminal.missingHint': '该会话可能已被删除。',
  'ssh.login': 'SSH 登录',
  'ssh.keyLogin': 'SSH 密钥认证',
  'ssh.agentLogin': 'SSH Agent 认证',
  'ssh.password': '密码',
  'ssh.passwordPlaceholder': '输入登录密码',
  'ssh.passphrase': '私钥口令（可选）',
  'ssh.passphrasePlaceholder': '加密私钥需要填写',
  'ssh.keyPath': '私钥',
  'ssh.noKey': '未选择私钥',
  'ssh.agentHint': '将使用系统 SSH Agent 中已加载的密钥完成认证。',
  'ssh.agentHint2': '请确保 Agent 正在运行且包含目标主机的密钥。',
  'ssh.agentManaged': '密钥由系统 SSH Agent 管理，NexTerm 不会读取私钥内容。',
  'ssh.memoryOnly': '凭据仅保存在内存中，退出应用后需重新输入。',
  'ssh.edit': '编辑连接',
  'ssh.connect': '连接',
  'ssh.enterPassword': '请输入密码',
  'ssh.pickKey': '请先在「编辑连接」中选择私钥文件',
  'ssh.vaultLocked': '凭据保险库已锁定，解锁后可自动填充保存的密码。',
  'ssh.vaultUnlocked': '凭据已解锁，连接信息会加密保存到凭据保险库。',
  'ssh.vaultSetup': '已启用「记住凭据」，请先在设置 > 安全中设置保险库主密码。',
  'ssh.unlock': '解锁',
  'ssh.memoryOnlyToast': '凭据仅保存在内存中',
  'ssh.vaultLockedToast': '凭据保险库已锁定，请在设置中解锁后保存。',
  'ssh.vaultSetupToast': '请先在设置 > 安全中设置保险库主密码。',
  'ssh.vaultUnlockTitle': '解锁凭据保险库',
  'ssh.vaultMasterPassword': '主密码',
  'ssh.vaultMasterPlaceholder': '输入保险库主密码',
  'ssh.vaultUnlock': '解锁',
  'ssh.vaultUnlockedToast': '保险库已解锁',
  'ssh.vaultUnlockedDesc': '已载入保存的凭据。',
  'ssh.wrongMasterPassword': '主密码错误'
};

const EN: Dictionary = {
  'app.workspaceTitle': 'NexTerm Workspace',
  'app.workspaceHint': 'Pick a session on the left, or create a local terminal / SSH connection.',
  'app.newSession': 'New session',
  'sidebar.title': 'Sessions',
  'sidebar.newSession': 'New session',
  'sidebar.quickConnect': 'Quick connect',
  'sidebar.search': 'Search sessions...',
  'sidebar.empty': 'No sessions yet',
  'sidebar.noMatch': 'No matching sessions',
  'sidebar.favorites': 'Favorites',
  'sidebar.total': '{count} sessions',
  'sidebar.import': 'Import SSH config',
  'sidebar.importMoba': 'Import MobaXterm sessions',
  'sidebar.importPutty': 'Import PuTTY sessions',
  'sidebar.importBackup': 'Import NexTerm backup',
  'sidebar.export': 'Export session backup',
  'sidebar.importMenu': 'Import or export sessions',
  'sidebar.importPick': 'Choose a file to import',
  'sidebar.importNone': 'No sessions found in that file',
  'sidebar.imported': 'Imported {count} sessions',
  'sidebar.importedSkipped': 'Skipped {count} duplicates',
  'sidebar.importFailed': 'Import failed',
  'sidebar.exported': 'Session backup exported',
  'sidebar.exportFailed': 'Export failed',
  'sidebar.deleteTitle': 'Delete session',
  'sidebar.deleteConfirm': 'Delete "{name}"?',
  'sidebar.deleted': 'Deleted "{name}"',
  'session.open': 'Open',
  'session.edit': 'Edit',
  'session.favorite': 'Favorite',
  'session.unfavorite': 'Remove favorite',
  'session.delete': 'Delete',
  'session.more': 'More actions for {name}',
  'terminal.find': 'Find',
  'terminal.clear': 'Clear',
  'terminal.copy': 'Copy selection',
  'terminal.fontDown': 'Decrease font size',
  'terminal.fontUp': 'Increase font size',
  'terminal.reconnect': 'Reconnect',
  'terminal.clearAuth': 'Clear credentials',
  'terminal.clearAuthBlocked': 'Session is connected — disconnect before clearing credentials',
  'terminal.copied': 'Copied selection',
  'terminal.nothingSelected': 'Nothing selected',
  'terminal.clipboardFailed': 'Could not read the clipboard',
  'terminal.searchPlaceholder': 'Find...',
  'terminal.prevMatch': 'Previous',
  'terminal.nextMatch': 'Next',
  'terminal.closeSearch': 'Close find',
  'terminal.copyAction': 'Copy',
  'terminal.paste': 'Paste',
  'terminal.selectAll': 'Select all',
  'terminal.reconnectToast': 'Reconnecting session...',
  'terminal.missing': 'Session not found',
  'terminal.missingHint': 'This session may have been deleted.',
  'ssh.login': 'SSH login',
  'ssh.keyLogin': 'SSH key authentication',
  'ssh.agentLogin': 'SSH Agent authentication',
  'ssh.password': 'Password',
  'ssh.passwordPlaceholder': 'Enter your password',
  'ssh.passphrase': 'Key passphrase (optional)',
  'ssh.passphrasePlaceholder': 'Required for encrypted keys',
  'ssh.keyPath': 'Private key',
  'ssh.noKey': 'No key selected',
  'ssh.agentHint': 'The system SSH Agent will authenticate with its loaded keys.',
  'ssh.agentHint2': 'Make sure the agent is running and holds the target key.',
  'ssh.agentManaged': 'Keys are managed by the SSH Agent; NexTerm never reads them.',
  'ssh.memoryOnly': 'Credentials are kept in memory only and must be re-entered after restart.',
  'ssh.edit': 'Edit connection',
  'ssh.connect': 'Connect',
  'ssh.enterPassword': 'Enter a password',
  'ssh.pickKey': 'Choose a private key in "Edit connection" first',
  'ssh.vaultLocked': 'The credential vault is locked. Unlock it to fill saved passwords.',
  'ssh.vaultUnlocked': 'Vault unlocked. Connection secrets are encrypted at rest.',
  'ssh.vaultSetup':
    'Remember credentials is on. Set a vault master password in Settings > Security.',
  'ssh.unlock': 'Unlock',
  'ssh.memoryOnlyToast': 'Credentials kept in memory only',
  'ssh.vaultLockedToast': 'Unlock the vault in Settings to save this credential.',
  'ssh.vaultSetupToast': 'Set a vault master password in Settings > Security first.',
  'ssh.vaultUnlockTitle': 'Unlock credential vault',
  'ssh.vaultMasterPassword': 'Master password',
  'ssh.vaultMasterPlaceholder': 'Enter the vault master password',
  'ssh.vaultUnlock': 'Unlock',
  'ssh.vaultUnlockedToast': 'Vault unlocked',
  'ssh.vaultUnlockedDesc': 'Saved credentials have been loaded.',
  'ssh.wrongMasterPassword': 'Incorrect master password'
};

const DICTIONARIES: Record<Locale, Dictionary> = {
  'zh-CN': ZH,
  'en-US': EN
};

export function resolveLocale(setting: LanguageSetting): Locale {
  if (setting === 'zh-CN' || setting === 'en-US') {
    return setting;
  }
  const language = typeof navigator === 'undefined' ? 'zh-CN' : navigator.language || 'zh-CN';
  return language.toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN';
}

export function translate(locale: Locale, key: string, params?: TranslationParams): string {
  let value = DICTIONARIES[locale][key] ?? ZH[key] ?? key;
  if (params) {
    for (const [name, replacement] of Object.entries(params)) {
      value = value.split(`{${name}}`).join(String(replacement));
    }
  }
  return value;
}

export interface I18n {
  locale: Locale;
  t: (key: string, params?: TranslationParams) => string;
}

export function useI18n(): I18n {
  const language = useSettingsStore((state) => state.language);
  const locale = resolveLocale(language);
  const t = useCallback(
    (key: string, params?: TranslationParams) => translate(locale, key, params),
    [locale]
  );
  return { locale, t };
}
