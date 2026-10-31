import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { emit, listen } from '@tauri-apps/api/event';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import {
  Keyboard,
  Moon,
  Palette,
  Server,
  Shield,
  Sun,
  TerminalSquare,
  Trash2,
  Info,
  type LucideIcon
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { EditableSelect } from '../components/ui/editable-select';
import { Input, Label } from '../components/ui/input';
import { Select } from '../components/ui/select';
import { ShortcutInput } from '../components/settings/ShortcutInput';
import { Toaster, toast } from '../components/ui/toast';
import { cn } from '../lib/cn';
import {
  DEFAULT_SETTINGS,
  settingsSnapshot as snapshotOf,
  useSettingsStore,
  type LanguageSetting,
  type SettingsSnapshot,
  type ShortcutAction,
  type TerminalCursorStyle
} from '../stores/settingsStore';
import { THEME_FAMILIES, getTheme, type ThemeDefinition, type ThemeMode } from '../theme/themes';
import { TERMINAL_COLOR_SCHEMES } from '../theme/terminalColorSchemes';
import { confirmAction, openModalWindow } from '../lib/appWindows';
import {
  changeVaultPassword,
  clearVault,
  forgetSessionCredentials,
  getVaultStatus,
  initializeVault,
  lockVault,
  resetVault,
  unlockVault,
  type VaultStatus
} from '../lib/credentialVault';
import { firstFontFamily, fontFamilyStack, type FontFamilyTarget } from '../lib/fontFamily';
import type { SystemFontFamily } from '../lib/systemFonts';
import { useFontCatalogStore } from '../stores/fontCatalogStore';
import { useSessionStore } from '../stores/sessionStore';
import {
  exportKnownHosts,
  importKnownHosts,
  listKnownHosts,
  removeKnownHost,
  type KnownHost
} from '../hooks/useTauriSsh';
import type { SessionAuthMethod } from '../types/session';

type SettingsTab = 'appearance' | 'terminal' | 'ssh' | 'shortcuts' | 'security' | 'about';

const TABS: Array<{ id: SettingsTab; label: string; icon: LucideIcon }> = [
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'terminal', label: '终端', icon: TerminalSquare },
  { id: 'ssh', label: 'SSH', icon: Server },
  { id: 'shortcuts', label: '快捷键', icon: Keyboard },
  { id: 'security', label: '安全', icon: Shield },
  { id: 'about', label: '关于', icon: Info }
];

const UI_FONT_PRESETS = [
  {
    label: '系统界面',
    value: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif'
  },
  {
    label: 'Segoe UI / 微软雅黑',
    value: '"Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif'
  },
  {
    label: 'Noto Sans SC',
    value: '"Noto Sans SC", "Noto Sans", "Microsoft YaHei", sans-serif'
  },
  {
    label: 'Fira Code（连字）',
    value: '"Fira Code", "Segoe UI", "Microsoft YaHei", sans-serif'
  },
  {
    label: 'Cascadia Code（连字）',
    value: '"Cascadia Code", "Segoe UI", "Microsoft YaHei", sans-serif'
  },
  {
    label: 'JetBrains Mono（连字）',
    value: '"JetBrains Mono", "Segoe UI", "Microsoft YaHei", sans-serif'
  },
  {
    label: '苹方 / Hiragino',
    value: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'
  },
  {
    label: '经典 Web',
    value:
      "'Microsoft YaHei', '微软雅黑', Tahoma, Arial, 'PingFang SC', 'Hiragino Sans GB', sans-serif"
  }
];

const TERMINAL_FONT_PRESETS = [
  {
    label: 'Consolas / 等宽回退',
    value: 'Consolas, "Courier New", "Sarasa Mono SC", monospace'
  },
  { label: 'JetBrains Mono', value: '"JetBrains Mono", Consolas, monospace' },
  { label: 'Cascadia Code', value: '"Cascadia Code", Consolas, monospace' },
  { label: 'Fira Code', value: '"Fira Code", Consolas, monospace' },
  { label: 'Noto Sans Mono', value: '"Noto Sans Mono", Consolas, monospace' },
  { label: '系统等宽', value: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }
];

const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  commandPalette: '打开命令面板',
  newLocal: '新建本地终端',
  newSsh: '新建 SSH 会话',
  openSettings: '打开设置'
};

const THEME_OPTIONS: Array<{ mode: ThemeMode; label: string; description: string }> = [
  { mode: 'light', label: '亮色', description: '始终使用亮色主题' },
  { mode: 'dark', label: '暗色', description: '始终使用暗色主题' },
  { mode: 'system', label: '跟随系统', description: '根据系统外观自动切换' }
];

const DARK_TERMINAL_SCHEMES = TERMINAL_COLOR_SCHEMES.filter((scheme) => scheme.variant === 'dark');
const LIGHT_TERMINAL_SCHEMES = TERMINAL_COLOR_SCHEMES.filter(
  (scheme) => scheme.variant === 'light'
);

function buildFontOptions(
  presets: Array<{ label: string; value: string }>,
  families: SystemFontFamily[],
  target: FontFamilyTarget
): Array<{ label: string; value: string }> {
  const options = presets.map((preset) => ({ ...preset }));
  const seen = new Set(presets.map((preset) => firstFontFamily(preset.value).toLowerCase()));

  for (const family of families) {
    const key = family.name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    options.push({
      label: family.name,
      value: fontFamilyStack(family.name, target)
    });
  }

  return options;
}

const TerminalPreview = lazy(() => import('./settings/TerminalPreview'));

function initialTab(): SettingsTab {
  const tab = new URLSearchParams(window.location.search).get('tab');
  return TABS.some((item) => item.id === tab) ? (tab as SettingsTab) : 'appearance';
}

function ThemeSpecimen({ theme, className }: { theme: ThemeDefinition; className?: string }) {
  return (
    <div
      data-theme={theme.id}
      className={cn(
        'pointer-events-none overflow-hidden rounded-sm border border-border bg-background text-foreground shadow-panel',
        className
      )}
    >
      <div className="flex h-4 items-center gap-1 border-b border-border bg-panel-title px-1">
        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
        <span className="h-1 w-6 rounded-sm bg-foreground/30" />
      </div>
      <div className="space-y-1 p-1.5">
        <div className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-success" />
          <span className="h-1 w-2/3 rounded-sm bg-foreground/70" />
        </div>
        <div className="h-1 w-full rounded-sm bg-border-muted" />
        <div className="flex gap-1 pt-0.5">
          <span className="h-2.5 flex-1 rounded-sm border border-accent-strong bg-button-primary" />
          <span className="h-2.5 flex-1 rounded-sm border border-border bg-surface" />
        </div>
      </div>
    </div>
  );
}

export default function SettingsWindow() {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [previewActivated, setPreviewActivated] = useState(() => initialTab() === 'terminal');
  const initialSnapshot = useMemo(() => snapshotOf(), []);
  const [draft, setDraft] = useState<SettingsSnapshot>(initialSnapshot);
  const [knownHosts, setKnownHosts] = useState<KnownHost[]>([]);
  const [removedHosts, setRemovedHosts] = useState<string[]>([]);
  const [loadingHosts, setLoadingHosts] = useState(false);
  const [hostsError, setHostsError] = useState<string | null>(null);
  const [hashHosts, setHashHosts] = useState(false);
  const [applying, setApplying] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  const [vaultBusy, setVaultBusy] = useState(false);
  // What this window last believed the store holds. External changes (e.g. a
  // theme cycle in the main window) are merged into the draft per-field so
  // unsaved local edits survive.
  const lastKnownRef = useRef<SettingsSnapshot>(initialSnapshot);
  // Whether the draft holds user edits that have not been applied yet.
  // Booked explicitly at every edit path and cleared by a successful apply —
  // a draft-vs-store JSON diff cannot be used here because the two sides
  // travel through IPC JSON round-trips, normalize-on-apply clamping and
  // async listener updates, and any of those disagreeing fakes a dirty
  // state right after the user applied.
  const unsavedRef = useRef(false);
  // Set once the user has applied, confirmed discarding, or the draft is
  // verified clean: the next close request must go through without the
  // unsaved-changes guard re-arming itself from an intervening re-render.
  const forceCloseRef = useRef(false);

  const systemFonts = useFontCatalogStore((state) => state.families);
  const systemFontsLoading = useFontCatalogStore((state) => state.loading);
  const systemFontsError = useFontCatalogStore((state) => state.error);
  const loadSystemFonts = useFontCatalogStore((state) => state.load);
  const refreshSystemFonts = useFontCatalogStore((state) => state.refresh);

  useEffect(() => {
    void loadSystemFonts();
  }, [loadSystemFonts]);

  const monospaceFonts = useMemo(
    () => systemFonts.filter((family) => family.monospaced),
    [systemFonts]
  );
  const uiFontOptions = useMemo(
    () => buildFontOptions(UI_FONT_PRESETS, systemFonts, 'ui'),
    [systemFonts]
  );
  const terminalFontOptions = useMemo(
    () => buildFontOptions(TERMINAL_FONT_PRESETS, monospaceFonts, 'terminal'),
    [monospaceFonts]
  );

  useEffect(() => {
    // Warm up the lazy preview chunk while the user is on the first tab.
    void import('./settings/TerminalPreview');
  }, []);

  useEffect(() => {
    // Merge externally applied settings (main-window theme cycle) into the
    // draft, but only the fields that actually changed so unsaved local
    // edits for other settings survive.
    let disposed = false;
    let dispose: (() => void) | undefined;
    void listen<{ settings: SettingsSnapshot }>('nexterm-settings-applied', (event) => {
      const incoming = event.payload.settings;
      const known = lastKnownRef.current;
      const changed: Partial<SettingsSnapshot> = {};
      (Object.keys(incoming) as Array<keyof SettingsSnapshot>).forEach((key) => {
        if (JSON.stringify(known[key]) !== JSON.stringify(incoming[key])) {
          (changed as Record<string, unknown>)[key] = incoming[key];
        }
      });
      lastKnownRef.current = incoming;
      if (Object.keys(changed).length > 0) {
        setDraft((current) => ({ ...current, ...changed }));
      }
    })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          dispose = unlisten;
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      dispose?.();
    };
  }, []);

  useEffect(() => {
    if (!document.fonts) {
      return;
    }
    void document.fonts
      .load(`${draft.terminalFontSize}px ${draft.terminalFontFamily}`)
      .catch(() => undefined);
  }, [draft.terminalFontFamily, draft.terminalFontSize]);

  useEffect(() => {
    const unlisten = listen<string>('nexterm-settings-tab', (event) => {
      if (TABS.some((item) => item.id === event.payload)) {
        if (event.payload === 'terminal') {
          setPreviewActivated(true);
        }
        setTab(event.payload as SettingsTab);
      }
    });
    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadingHosts(true);
    setHostsError(null);
    listKnownHosts()
      .then((list) => {
        if (!cancelled) {
          setKnownHosts(list);
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setHostsError(String(reason));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingHosts(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getVaultStatus()
      .then((status) => {
        if (!cancelled) {
          setVaultStatus(status);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const promptSecret = (label: string, confirmLabel: string): Promise<string | null> =>
    openModalWindow<string>('prompt', {
      title: label,
      width: 420,
      height: 200,
      data: {
        title: label,
        label,
        initialValue: '',
        placeholder: label,
        confirmLabel,
        password: true
      }
    });

  const refreshVaultStatus = async () => {
    const status = await getVaultStatus();
    setVaultStatus(status);
    return status;
  };

  const handleVaultSetup = async () => {
    if (vaultBusy) {
      return;
    }
    const password = await promptSecret('设置保险库主密码（至少 8 个字符）', '下一步');
    if (!password) {
      return;
    }
    const confirm = await promptSecret('再次输入主密码', '创建');
    if (!confirm) {
      return;
    }
    if (password !== confirm) {
      toast({ title: '两次输入的主密码不一致', variant: 'error' });
      return;
    }
    setVaultBusy(true);
    try {
      setVaultStatus(await initializeVault(password));
      toast({ title: '凭据保险库已创建', variant: 'success' });
    } catch (reason) {
      toast({ title: '创建保险库失败', description: String(reason), variant: 'error' });
    } finally {
      setVaultBusy(false);
    }
  };

  const handleVaultUnlock = async () => {
    if (vaultBusy) {
      return;
    }
    const password = await promptSecret('解锁凭据保险库', '解锁');
    if (!password) {
      return;
    }
    setVaultBusy(true);
    try {
      const ok = await unlockVault(password);
      if (!ok) {
        toast({ title: '主密码错误', variant: 'error' });
        return;
      }
      await refreshVaultStatus();
      toast({ title: '凭据保险库已解锁', variant: 'success' });
    } catch (reason) {
      toast({ title: '解锁失败', description: String(reason), variant: 'error' });
    } finally {
      setVaultBusy(false);
    }
  };

  const handleVaultLock = async () => {
    if (vaultBusy) {
      return;
    }
    setVaultBusy(true);
    try {
      await lockVault();
      await refreshVaultStatus();
      toast({ title: '凭据保险库已锁定', variant: 'success' });
    } catch (reason) {
      toast({ title: '锁定失败', description: String(reason), variant: 'error' });
    } finally {
      setVaultBusy(false);
    }
  };

  const handleVaultChangePassword = async () => {
    if (vaultBusy) {
      return;
    }
    const oldPassword = await promptSecret('当前主密码', '下一步');
    if (!oldPassword) {
      return;
    }
    const newPassword = await promptSecret('新主密码（至少 8 个字符）', '下一步');
    if (!newPassword) {
      return;
    }
    const confirm = await promptSecret('再次输入新主密码', '修改');
    if (!confirm) {
      return;
    }
    if (newPassword !== confirm) {
      toast({ title: '两次输入的新主密码不一致', variant: 'error' });
      return;
    }
    setVaultBusy(true);
    try {
      setVaultStatus(await changeVaultPassword(oldPassword, newPassword));
      toast({ title: '主密码已修改', variant: 'success' });
    } catch (reason) {
      toast({ title: '修改主密码失败', description: String(reason), variant: 'error' });
    } finally {
      setVaultBusy(false);
    }
  };

  const handleVaultClear = async () => {
    if (vaultBusy) {
      return;
    }
    const ok = await confirmAction('确定清空保险库中保存的全部凭据吗？此操作不可撤销。', {
      title: '清空凭据保险库',
      okLabel: '清空'
    });
    if (!ok) {
      return;
    }
    setVaultBusy(true);
    try {
      // Forget while the vault is still unlocked: the per-session deletes
      // clear both memory and vault entries, clearVault then wipes anything
      // left over before the vault is locked.
      const sessions = useSessionStore.getState().sessions;
      await Promise.all(sessions.map((session) => forgetSessionCredentials(session.id)));
      await clearVault();
      await lockVault();
      await refreshVaultStatus();
      toast({ title: '保险库凭据已清空', variant: 'success' });
    } catch (reason) {
      toast({ title: '清空保险库失败', description: String(reason), variant: 'error' });
    } finally {
      setVaultBusy(false);
    }
  };

  const handleVaultReset = async () => {
    if (vaultBusy) {
      return;
    }
    const ok = await confirmAction(
      '确定重置凭据保险库吗？已保存的所有密码将被删除，且需要重新设置主密码。',
      { title: '重置凭据保险库', okLabel: '重置' }
    );
    if (!ok) {
      return;
    }
    setVaultBusy(true);
    try {
      const sessions = useSessionStore.getState().sessions;
      await Promise.all(sessions.map((session) => forgetSessionCredentials(session.id)));
      await resetVault();
      setVaultStatus(await getVaultStatus());
      toast({ title: '凭据保险库已重置', variant: 'success' });
    } catch (reason) {
      toast({ title: '重置保险库失败', description: String(reason), variant: 'error' });
    } finally {
      setVaultBusy(false);
    }
  };

  const update = <K extends keyof SettingsSnapshot>(key: K, value: SettingsSnapshot[K]) => {
    unsavedRef.current = true;
    setSavedAt(null);
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const updateShortcut = (action: ShortcutAction, value: string) => {
    unsavedRef.current = true;
    setSavedAt(null);
    setDraft((current) => ({
      ...current,
      shortcuts: { ...current.shortcuts, [action]: value }
    }));
  };

  const selectTab = (next: SettingsTab) => {
    if (next === 'terminal') {
      setPreviewActivated(true);
    }
    setTab(next);
  };

  const visibleHosts = useMemo(
    () => knownHosts.filter((host) => !removedHosts.includes(host.host)),
    [knownHosts, removedHosts]
  );

  const handleImportHosts = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        title: '导入 OpenSSH known_hosts'
      });
      if (typeof selected !== 'string') {
        return;
      }

      const result = await importKnownHosts(selected);
      setKnownHosts(await listKnownHosts());
      setRemovedHosts([]);
      toast({
        title: `已导入 ${result.imported} 条主机记录`,
        description:
          result.skipped > 0 || result.invalid > 0
            ? `跳过 ${result.skipped} 条（哈希/通配符），无效 ${result.invalid} 条`
            : undefined,
        variant: result.imported > 0 ? 'success' : 'default'
      });
    } catch (reason) {
      toast({ title: '导入失败', description: String(reason), variant: 'error' });
    }
  };

  const handleExportHosts = async () => {
    try {
      const target = await saveDialog({
        defaultPath: 'known_hosts',
        title: '导出 OpenSSH known_hosts'
      });
      if (!target) {
        return;
      }

      const result = await exportKnownHosts(target, hashHosts);
      toast({
        title: `已导出 ${result.exported} 条主机记录`,
        description: result.skipped > 0 ? `跳过 ${result.skipped} 条（缺少公钥）` : undefined,
        variant: result.exported > 0 ? 'success' : 'default'
      });
    } catch (reason) {
      toast({ title: '导出失败', description: String(reason), variant: 'error' });
    }
  };

  const apply = async (): Promise<boolean> => {
    if (applying) {
      return false;
    }
    setApplying(true);
    try {
      useSettingsStore.getState().applySettings(draft);

      const applied = snapshotOf();
      // Move the dirty-check baseline synchronously. The window's own
      // `nexterm-settings-applied` listener updates this ref too, but that
      // delivery is an async IPC round-trip and only mutates a ref, so the
      // close guard would otherwise still see the pre-apply snapshot and
      // claim there are unsaved changes right after applying.
      lastKnownRef.current = applied;
      setDraft({ ...applied, shortcuts: { ...applied.shortcuts } });
      await emit('nexterm-settings-applied', { settings: applied });

      const removed: string[] = [];
      for (const host of removedHosts) {
        try {
          await removeKnownHost(host);
          removed.push(host);
        } catch {
          /* keep the record in the list when deletion fails */
        }
      }
      if (removed.length > 0) {
        setKnownHosts((current) => current.filter((host) => !removed.includes(host.host)));
      }
      setRemovedHosts([]);
      if (removed.length < removedHosts.length) {
        toast({ title: '部分已知主机删除失败', variant: 'error' });
      }

      // Everything the draft held (settings + host deletions) is now applied;
      // only a later edit may re-arm the unsaved-changes guard.
      unsavedRef.current = false;
      setSavedAt(Date.now());
      return true;
    } catch (reason) {
      toast({
        title: '应用设置失败',
        description: String(reason),
        variant: 'error'
      });
      return false;
    } finally {
      setApplying(false);
    }
  };

  const resetDefaults = async () => {
    const ok = await confirmAction('确定恢复所有设置为默认值吗？点击「应用」后才会生效。', {
      title: '恢复默认设置',
      okLabel: '恢复'
    });
    if (!ok) {
      return;
    }
    unsavedRef.current = true;
    setSavedAt(null);
    setDraft({ ...DEFAULT_SETTINGS, shortcuts: { ...DEFAULT_SETTINGS.shortcuts } });
  };

  // Guards against stacked native dialogs when the user clicks 取消 or the
  // window X repeatedly while the discard confirmation is still open.
  const discardConfirmBusyRef = useRef(false);
  const confirmDiscard = async (): Promise<boolean> => {
    if (discardConfirmBusyRef.current) {
      return false;
    }
    discardConfirmBusyRef.current = true;
    try {
      return await confirmAction('有未应用的修改，确定放弃并关闭吗？', {
        title: '未保存的修改',
        okLabel: '放弃修改'
      });
    } finally {
      discardConfirmBusyRef.current = false;
    }
  };

  // Every caller has either applied, confirmed discarding, or verified the
  // draft is clean, so the close request must bypass the guard. The wrapper
  // around onCloseRequested completes a non-prevented close request with
  // window.destroy(), which needs `core:window:allow-destroy` in the
  // capability file — without it the close request is silently dropped and
  // the window never closes.
  const close = () => {
    forceCloseRef.current = true;
    void getCurrentWindow().close();
  };

  const requestClose = async () => {
    if (!unsavedRef.current) {
      close();
      return;
    }
    const ok = await confirmDiscard();
    if (ok) {
      close();
    }
  };

  // The window X button must honor the same unsaved-changes guard.
  useEffect(() => {
    const currentWindow = getCurrentWindow();
    let disposed = false;
    const promise = currentWindow.onCloseRequested(async (event) => {
      if (forceCloseRef.current || !unsavedRef.current) {
        return;
      }
      // Always prevent first: skipping preventDefault makes the
      // onCloseRequested wrapper destroy the window immediately.
      event.preventDefault();
      const ok = await confirmDiscard();
      if (ok && !disposed) {
        close();
      }
    });
    return () => {
      disposed = true;
      void promise.then((unlisten) => unlisten());
    };
  }, []);

  const handleRemoveHost = async (host: string) => {
    const ok = await confirmAction(`确定删除「${host}」的已知主机记录吗？`, {
      title: '删除已知主机',
      okLabel: '删除'
    });
    if (ok) {
      unsavedRef.current = true;
      setRemovedHosts((current) => [...current, host]);
      setSavedAt(null);
    }
  };

  const renderAppearance = () => {
    const activeDarkTheme = getTheme(draft.darkTheme);
    const activeLightTheme = getTheme(draft.lightTheme);
    const activeMode = THEME_OPTIONS.find((option) => option.mode === draft.themeMode);

    return (
      <section className="space-y-5">
        <div className="rounded-sm border border-border bg-surface p-3">
          <div className="max-w-xs">
            <Label htmlFor="language">界面语言</Label>
            <Select
              id="language"
              value={draft.language}
              onChange={(event) => update('language', event.target.value as LanguageSetting)}
            >
              <option value="system">跟随系统</option>
              <option value="zh-CN">简体中文</option>
              <option value="en-US">English</option>
            </Select>
            <p className="mt-1 text-[10px] text-muted-foreground">
              核心工作区（会话、终端、连接表单）已支持中英文，设置面板仍在逐步迁移。
            </p>
          </div>
        </div>

        <div className="rounded-sm border border-border bg-surface p-3">
          <div className="grid gap-3 md:grid-cols-[minmax(0,240px)_1fr]">
            <div>
              <Label htmlFor="theme-mode">主题策略</Label>
              <Select
                id="theme-mode"
                value={draft.themeMode}
                onChange={(event) => update('themeMode', event.target.value as ThemeMode)}
              >
                {THEME_OPTIONS.map((option) => (
                  <option key={option.mode} value={option.mode}>
                    {option.label}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-[10px] text-muted-foreground">{activeMode?.description}</p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-sm border border-border bg-background-alt p-2">
                <div className="flex items-center gap-1.5 text-[10px] text-muted">
                  <Moon className="h-3 w-3" />
                  暗色主题
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <ThemeSpecimen theme={activeDarkTheme} className="h-10 w-16" />
                  <span className="min-w-0 truncate text-xs font-semibold text-foreground">
                    {activeDarkTheme.name}
                  </span>
                </div>
              </div>
              <div className="rounded-sm border border-border bg-background-alt p-2">
                <div className="flex items-center gap-1.5 text-[10px] text-muted">
                  <Sun className="h-3 w-3" />
                  亮色主题
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <ThemeSpecimen theme={activeLightTheme} className="h-10 w-16" />
                  <span className="min-w-0 truncate text-xs font-semibold text-foreground">
                    {activeLightTheme.name}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-foreground">主题</h3>
            <span className="text-[10px] text-muted-foreground">按家族选择暗色 / 亮色</span>
          </div>
          <div className="space-y-2">
            {THEME_FAMILIES.map((family) => {
              const darkTheme = getTheme(family.dark);
              const lightTheme = getTheme(family.light);
              const darkSelected = draft.darkTheme === family.dark;
              const lightSelected = draft.lightTheme === family.light;

              return (
                <div
                  key={family.id}
                  className={cn(
                    'flex flex-wrap items-center gap-3 rounded-sm border p-2 transition-colors',
                    darkSelected || lightSelected
                      ? 'border-accent/60 bg-accent/5'
                      : 'border-border bg-surface'
                  )}
                >
                  <div className="flex shrink-0 gap-1">
                    <ThemeSpecimen theme={darkTheme} className="h-14 w-20" />
                    <ThemeSpecimen theme={lightTheme} className="h-14 w-20" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold text-foreground">{family.name}</div>
                    <div className="text-[10px] text-muted">{family.description}</div>
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      {darkTheme.name} / {lightTheme.name}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="xs"
                      variant={darkSelected ? 'primary' : 'secondary'}
                      onClick={() => update('darkTheme', darkTheme.id)}
                    >
                      <Moon className="h-3 w-3" />
                      暗色
                    </Button>
                    <Button
                      size="xs"
                      variant={lightSelected ? 'primary' : 'secondary'}
                      onClick={() => update('lightTheme', lightTheme.id)}
                    >
                      <Sun className="h-3 w-3" />
                      亮色
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-sm border border-border bg-surface p-3">
          <h3 className="mb-2 text-xs font-semibold text-foreground">界面字体</h3>
          <div className="grid items-end gap-3 md:grid-cols-[1fr_auto]">
            <div>
              <Label htmlFor="ui-font">Font Family</Label>
              <EditableSelect
                id="ui-font"
                value={draft.uiFontFamily}
                options={uiFontOptions}
                onChange={(value) => update('uiFontFamily', value)}
                ariaLabel="界面字体"
              />
              <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className="truncate">
                  {systemFontsLoading
                    ? '正在加载系统字体…'
                    : systemFontsError
                      ? `系统字体加载失败：${systemFontsError}`
                      : `已加载 ${systemFonts.length} 个系统字体`}
                </span>
                <button
                  type="button"
                  disabled={systemFontsLoading}
                  onClick={() => void refreshSystemFonts()}
                  className="shrink-0 underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
                >
                  刷新
                </button>
              </div>
            </div>
            <label className="flex items-center gap-2 pb-1 text-[11px] text-muted">
              <input
                type="checkbox"
                className="app-checkbox h-3.5 w-3.5 accent-accent"
                checked={draft.uiFontLigatures}
                onChange={(event) => update('uiFontLigatures', event.target.checked)}
              />
              Font Ligatures
            </label>
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            可直接编辑字体字符串；连字需要字体本身支持（如 Fira Code、Cascadia Code）。
          </p>
          <div className="mt-2">
            <Label htmlFor="ui-font-feature-settings">Font Feature Settings</Label>
            <Input
              id="ui-font-feature-settings"
              value={draft.uiFontFeatureSettings}
              onChange={(event) => update('uiFontFeatureSettings', event.target.value)}
              placeholder={'"liga" 1, "calt" 1'}
            />
            <p className="mt-1 text-[10px] text-muted-foreground">
              仅在 Font Ligatures 开启时生效，可填写如 "ss03" 1 的 OpenType 特性。
            </p>
          </div>
          <div className="mt-2 flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-[10px] text-muted-foreground">连字示例</span>
            <span
              className="selectable truncate text-[11px] text-foreground"
              style={{
                fontFamily: draft.uiFontFamily,
                fontVariantLigatures: draft.uiFontLigatures ? 'normal' : 'none',
                fontFeatureSettings: draft.uiFontLigatures
                  ? draft.uiFontFeatureSettings
                  : '"liga" 0, "calt" 0'
              }}
            >
              {'-> => != === >= <= <> :::'}
            </span>
          </div>
        </div>

        <p className="text-[10px] text-muted-foreground">主题与字体将在点击「应用」后生效。</p>
      </section>
    );
  };

  const renderTerminal = () => (
    <section className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="terminal-font">Font Family</Label>
          <EditableSelect
            id="terminal-font"
            value={draft.terminalFontFamily}
            options={terminalFontOptions}
            onChange={(value) => update('terminalFontFamily', value)}
            ariaLabel="终端字体"
          />
          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span className="truncate">
              {systemFontsLoading
                ? '正在加载系统字体…'
                : systemFontsError
                  ? `系统字体加载失败：${systemFontsError}`
                  : `可用等宽字体 ${monospaceFonts.length} 个`}
            </span>
            <button
              type="button"
              disabled={systemFontsLoading}
              onClick={() => void refreshSystemFonts()}
              className="shrink-0 underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
            >
              刷新
            </button>
          </div>
        </div>
        <div>
          <Label htmlFor="terminal-color-scheme">配色方案</Label>
          <Select
            id="terminal-color-scheme"
            value={draft.terminalColorScheme}
            onChange={(event) => update('terminalColorScheme', event.target.value)}
          >
            <option value="theme">跟随界面主题</option>
            <optgroup label="QTerminal 暗色">
              {DARK_TERMINAL_SCHEMES.map((scheme) => (
                <option key={scheme.id} value={scheme.id}>
                  {scheme.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="QTerminal 亮色">
              {LIGHT_TERMINAL_SCHEMES.map((scheme) => (
                <option key={scheme.id} value={scheme.id}>
                  {scheme.name}
                </option>
              ))}
            </optgroup>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>字号</Label>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => update('terminalFontSize', Math.max(10, draft.terminalFontSize - 1))}
            >
              −
            </Button>
            <span className="w-12 text-center text-xs tabular-nums text-foreground">
              {draft.terminalFontSize}px
            </span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => update('terminalFontSize', Math.min(20, draft.terminalFontSize + 1))}
            >
              +
            </Button>
          </div>
        </div>

        <div>
          <Label htmlFor="terminal-cursor">光标样式</Label>
          <Select
            id="terminal-cursor"
            value={draft.terminalCursorStyle}
            onChange={(event) =>
              update('terminalCursorStyle', event.target.value as TerminalCursorStyle)
            }
          >
            <option value="block">方块</option>
            <option value="underline">下划线</option>
            <option value="bar">竖线</option>
          </Select>
        </div>

        <div>
          <Label htmlFor="terminal-scrollback">回滚行数</Label>
          <Input
            id="terminal-scrollback"
            type="number"
            min={1000}
            max={100000}
            step={1000}
            value={draft.terminalScrollback}
            onChange={(event) => update('terminalScrollback', Number(event.target.value) || 1000)}
          />
        </div>

        <div>
          <Label htmlFor="terminal-line-height">行高</Label>
          <Input
            id="terminal-line-height"
            type="number"
            min={0.8}
            max={1.6}
            step={0.1}
            value={draft.terminalLineHeight}
            onChange={(event) => update('terminalLineHeight', Number(event.target.value) || 1)}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-[11px] text-muted">
          <input
            type="checkbox"
            className="app-checkbox h-3.5 w-3.5 accent-accent"
            checked={draft.terminalCursorBlink}
            onChange={(event) => update('terminalCursorBlink', event.target.checked)}
          />
          光标闪烁
        </label>
        <label className="flex items-center gap-2 text-[11px] text-muted">
          <input
            type="checkbox"
            className="app-checkbox h-3.5 w-3.5 accent-accent"
            checked={draft.terminalFontLigatures}
            onChange={(event) => update('terminalFontLigatures', event.target.checked)}
          />
          Font Ligatures
        </label>
        <label className="flex items-center gap-2 text-[11px] text-muted">
          <input
            type="checkbox"
            className="app-checkbox h-3.5 w-3.5 accent-accent"
            checked={draft.terminalCopyOnSelect}
            onChange={(event) => update('terminalCopyOnSelect', event.target.checked)}
          />
          选中即复制
        </label>
        <label className="flex items-center gap-2 text-[11px] text-muted">
          <input
            type="checkbox"
            className="app-checkbox h-3.5 w-3.5 accent-accent"
            checked={draft.terminalRestoreScrollback}
            onChange={(event) => update('terminalRestoreScrollback', event.target.checked)}
          />
          重启后恢复滚动缓冲
        </label>
      </div>
      <p className="-mt-1 text-[10px] text-muted-foreground">
        连字需要等宽字体支持（如 Fira Code、Cascadia Code），WebGL 渲染下同样生效。
        滚动缓冲快照保存在本地
        localStorage，可能包含敏感输出；如不需要可关闭「重启后恢复滚动缓冲」。
      </p>

      <div>
        <Label htmlFor="terminal-font-feature-settings">Font Feature Settings</Label>
        <Input
          id="terminal-font-feature-settings"
          value={draft.terminalFontFeatureSettings}
          onChange={(event) => update('terminalFontFeatureSettings', event.target.value)}
          placeholder={'"calt" on'}
        />
        <p className="mt-1 text-[10px] text-muted-foreground">
          仅在 Font Ligatures 开启时生效，例如 "calt" off, "ss03"。
        </p>
      </div>

      <div>
        <p className="mb-1 text-[10px] text-muted">预览</p>
        <Suspense
          fallback={
            <div className="flex h-40 items-center justify-center rounded-sm border border-border bg-background-alt text-[11px] text-muted">
              正在加载终端预览…
            </div>
          }
        >
          <TerminalPreview
            visible={tab === 'terminal'}
            fontFamily={draft.terminalFontFamily}
            fontLigatures={draft.terminalFontLigatures}
            fontFeatureSettings={draft.terminalFontFeatureSettings}
            colorScheme={draft.terminalColorScheme}
            fontSize={draft.terminalFontSize}
            lineHeight={draft.terminalLineHeight}
            cursorStyle={draft.terminalCursorStyle}
            cursorBlink={draft.terminalCursorBlink}
            scrollback={draft.terminalScrollback}
          />
        </Suspense>
      </div>
    </section>
  );

  const renderSsh = () => (
    <section className="grid grid-cols-2 gap-3">
      <div>
        <Label htmlFor="default-auth">默认认证方式</Label>
        <Select
          id="default-auth"
          value={draft.defaultAuthMethod}
          onChange={(event) => update('defaultAuthMethod', event.target.value as SessionAuthMethod)}
        >
          <option value="password">密码</option>
          <option value="key">私钥</option>
          <option value="agent">SSH Agent</option>
        </Select>
      </div>
      <div>
        <Label htmlFor="default-port">默认端口</Label>
        <Input
          id="default-port"
          type="number"
          min={1}
          max={65535}
          value={draft.defaultPort}
          onChange={(event) => update('defaultPort', Number(event.target.value) || 22)}
        />
      </div>
      <div className="col-span-2">
        <Label htmlFor="default-username">默认用户名</Label>
        <Input
          id="default-username"
          value={draft.defaultUsername}
          onChange={(event) => update('defaultUsername', event.target.value)}
          placeholder="例如 root"
        />
      </div>
      <div className="col-span-2 space-y-2 rounded-sm border border-border bg-background-alt px-2 py-2">
        <label className="flex items-center gap-2 text-[11px] text-muted">
          <input
            type="checkbox"
            className="app-checkbox h-3.5 w-3.5 accent-accent"
            checked={draft.sshAutoReconnect}
            onChange={(event) => update('sshAutoReconnect', event.target.checked)}
          />
          连接意外断开时自动重连
        </label>
        <p className="text-[10px] text-muted-foreground">
          SSH 每 30 秒发送一次保活探测；断线后按 1s / 2s / 4s / 8s / 16s 退避重试。
        </p>
      </div>
    </section>
  );

  const renderShortcuts = () => (
    <section>
      <div className="space-y-2">
        {(Object.keys(SHORTCUT_LABELS) as ShortcutAction[]).map((action) => (
          <div key={action} className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-muted">{SHORTCUT_LABELS[action]}</span>
            <ShortcutInput
              value={draft.shortcuts[action]}
              onChange={(value) => updateShortcut(action, value)}
            />
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10px] text-muted-foreground">
        点击输入框后按下组合键（需包含 Ctrl / Alt / Meta）。快捷键不会在文本输入框中触发。
      </p>
    </section>
  );

  const renderSecurity = () => {
    const vaultInitialized = Boolean(vaultStatus?.initialized);
    const vaultUnlocked = Boolean(vaultStatus?.unlocked);
    return (
      <section className="space-y-5">
        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-foreground">凭据保险库</h3>
            <span
              className={cn(
                'rounded-sm border px-1.5 py-0.5 text-[10px]',
                vaultUnlocked
                  ? 'border-success/40 text-success'
                  : vaultInitialized
                    ? 'border-warning/40 text-warning'
                    : 'border-border text-muted'
              )}
            >
              {vaultInitialized ? (vaultUnlocked ? '已解锁' : '已锁定') : '未创建'}
            </span>
          </div>
          <p className="text-[10px] text-muted-foreground">
            记住的 SSH 密码与私钥口令使用 Argon2id 派生密钥并通过 AES-256-GCM
            加密，保存在应用配置目录。应用重启后保险库默认锁定。
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {!vaultInitialized ? (
              <Button
                size="xs"
                variant="primary"
                disabled={vaultBusy}
                onClick={() => void handleVaultSetup()}
              >
                设置主密码
              </Button>
            ) : vaultUnlocked ? (
              <>
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={vaultBusy}
                  onClick={() => void handleVaultLock()}
                >
                  锁定
                </Button>
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={vaultBusy}
                  onClick={() => void handleVaultChangePassword()}
                >
                  更改主密码
                </Button>
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={vaultBusy}
                  onClick={() => void handleVaultClear()}
                >
                  清空凭据
                </Button>
              </>
            ) : (
              <Button
                size="xs"
                variant="primary"
                disabled={vaultBusy}
                onClick={() => void handleVaultUnlock()}
              >
                解锁
              </Button>
            )}
            {vaultInitialized ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={vaultBusy}
                onClick={() => void handleVaultReset()}
              >
                重置保险库
              </Button>
            ) : null}
            {vaultUnlocked ? (
              <span className="text-[10px] text-muted">
                已保存 {vaultStatus?.entry_count ?? 0} 条凭据
              </span>
            ) : null}
          </div>
          <label className="mt-3 flex items-center gap-2 text-[11px] text-muted">
            <input
              type="checkbox"
              className="app-checkbox h-3.5 w-3.5 accent-accent"
              checked={draft.sshRememberCredentials}
              onChange={(event) => update('sshRememberCredentials', event.target.checked)}
            />
            记住 SSH 凭据（保险库解锁后自动保存并填充）
          </label>
        </div>

        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-foreground">已知主机（known_hosts）</h3>
            <div className="flex items-center gap-1.5">
              <label className="flex items-center gap-1 text-[10px] text-muted">
                <input
                  type="checkbox"
                  checked={hashHosts}
                  onChange={(event) => setHashHosts(event.target.checked)}
                />
                哈希主机名
              </label>
              <Button size="xs" variant="secondary" onClick={() => void handleImportHosts()}>
                导入
              </Button>
              <Button size="xs" variant="secondary" onClick={() => void handleExportHosts()}>
                导出
              </Button>
            </div>
          </div>
          {loadingHosts ? (
            <p className="text-[11px] text-muted">加载中…</p>
          ) : hostsError ? (
            <p className="selectable text-[11px] text-error">{hostsError}</p>
          ) : visibleHosts.length === 0 ? (
            <p className="text-[11px] text-muted">暂无记录。首次连接主机时会提示确认指纹。</p>
          ) : (
            <div className="max-h-72 overflow-y-auto rounded-sm border border-border">
              {visibleHosts.map((entry) => (
                <div
                  key={entry.host}
                  className="flex items-center gap-2 border-b border-border-muted/60 px-2 py-1.5 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="selectable truncate font-mono text-[11px] text-foreground">
                      {entry.host}
                    </p>
                    <p
                      className="selectable truncate text-[10px] text-muted"
                      title={entry.fingerprint}
                    >
                      {entry.algorithm} · {entry.fingerprint}
                    </p>
                  </div>
                  <Button
                    size="icon-md"
                    variant="ghost"
                    aria-label="删除主机记录"
                    title="删除主机记录"
                    onClick={() => void handleRemoveHost(entry.host)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
          {removedHosts.length > 0 ? (
            <p className="mt-2 text-[10px] text-warning">
              已标记 {removedHosts.length} 条记录，点击「应用」后删除。
            </p>
          ) : null}
          <p className="mt-2 text-[10px] text-muted-foreground">
            删除后，下次连接该主机会重新提示确认指纹。
          </p>
        </div>
      </section>
    );
  };

  const renderAbout = () => (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground">NexTerm 0.1.0</h3>
      <p className="text-[11px] text-muted">Tauri 2 + React 18 + Rust</p>
      <p className="text-[11px] text-muted">
        命令面板 {DEFAULT_SETTINGS.shortcuts.commandPalette} · 设置{' '}
        {DEFAULT_SETTINGS.shortcuts.openSettings}
      </p>
    </section>
  );

  const content = {
    appearance: renderAppearance,
    terminal: renderTerminal,
    ssh: renderSsh,
    shortcuts: renderShortcuts,
    security: renderSecurity,
    about: renderAbout
  }[tab];

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <div className="app-tab-strip flex h-10 shrink-0 items-end gap-0.5 border-b border-border bg-surface-header px-2">
        {TABS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              data-active={tab === item.id}
              onClick={() => selectTab(item.id)}
              className={cn(
                'flex h-9 items-center gap-1.5 rounded-t-sm border border-b-0 px-3 text-[11px] transition-colors',
                tab === item.id
                  ? 'border-border bg-surface font-semibold text-foreground'
                  : 'border-transparent text-muted hover:bg-surface-hover hover:text-foreground'
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {item.label}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {tab === 'terminal' ? null : content()}
        {previewActivated ? (
          <div className={tab === 'terminal' ? '' : 'hidden'}>{renderTerminal()}</div>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-border bg-background-alt px-5 py-3">
        <Button variant="ghost" className="mr-auto" onClick={() => void resetDefaults()}>
          恢复默认
        </Button>
        <span className="mr-1 text-[10px] text-muted">
          {savedAt ? '已应用' : '修改后需点击应用或确定'}
        </span>
        <Button variant="ghost" onClick={() => void requestClose()}>
          取消
        </Button>
        <Button variant="secondary" disabled={applying} onClick={() => void apply()}>
          应用
        </Button>
        <Button
          variant="primary"
          disabled={applying}
          onClick={async () => {
            if (await apply()) {
              close();
            }
          }}
        >
          确定
        </Button>
      </div>
      <Toaster />
    </div>
  );
}
