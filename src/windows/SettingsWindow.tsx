import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { emit, listen } from '@tauri-apps/api/event';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { check as checkForAppUpdate } from '@tauri-apps/plugin-updater';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  FolderOpen,
  Keyboard,
  Moon,
  Palette,
  Pencil,
  Server,
  Shield,
  SquareTerminal,
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
import { Toaster } from '../components/ui/toast';
import { toast } from '../components/ui/toastStore';
import { tStatic, useI18n } from '../i18n';
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
import { useSnippetStore, type Snippet } from '../stores/snippetStore';
import { useMacroStore } from '../stores/macroStore';
import {
  exportKnownHosts,
  importKnownHosts,
  listKnownHosts,
  removeKnownHost,
  type KnownHost
} from '../hooks/useTauriSsh';
import type { SessionAuthMethod } from '../types/session';

type SettingsTab =
  'appearance' | 'terminal' | 'snippets' | 'ssh' | 'shortcuts' | 'security' | 'about';

const TABS: Array<{ id: SettingsTab; labelKey: string; icon: LucideIcon }> = [
  { id: 'appearance', labelKey: 'settings.tab.appearance', icon: Palette },
  { id: 'terminal', labelKey: 'settings.tab.terminal', icon: TerminalSquare },
  { id: 'snippets', labelKey: 'settings.tab.snippets', icon: SquareTerminal },
  { id: 'ssh', labelKey: 'settings.tab.ssh', icon: Server },
  { id: 'shortcuts', labelKey: 'settings.tab.shortcuts', icon: Keyboard },
  { id: 'security', labelKey: 'settings.tab.security', icon: Shield },
  { id: 'about', labelKey: 'settings.tab.about', icon: Info }
];

const UI_FONT_PRESETS = [
  {
    labelKey: 'settings.fonts.ui.systemUi',
    value: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif'
  },
  {
    labelKey: 'settings.fonts.ui.segoeYahei',
    value: '"Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif'
  },
  {
    labelKey: 'settings.fonts.ui.notoSansSc',
    value: '"Noto Sans SC", "Noto Sans", "Microsoft YaHei", sans-serif'
  },
  {
    labelKey: 'settings.fonts.ui.firaCode',
    value: '"Fira Code", "Segoe UI", "Microsoft YaHei", sans-serif'
  },
  {
    labelKey: 'settings.fonts.ui.cascadiaCode',
    value: '"Cascadia Code", "Segoe UI", "Microsoft YaHei", sans-serif'
  },
  {
    labelKey: 'settings.fonts.ui.jetbrainsMono',
    value: '"JetBrains Mono", "Segoe UI", "Microsoft YaHei", sans-serif'
  },
  {
    labelKey: 'settings.fonts.ui.pingFang',
    value: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'
  },
  {
    labelKey: 'settings.fonts.ui.classicWeb',
    value:
      "'Microsoft YaHei', '微软雅黑', Tahoma, Arial, 'PingFang SC', 'Hiragino Sans GB', sans-serif"
  }
];

const TERMINAL_FONT_PRESETS = [
  {
    labelKey: 'settings.fonts.terminal.consolas',
    value: 'Consolas, "Courier New", "Sarasa Mono SC", monospace'
  },
  {
    labelKey: 'settings.fonts.terminal.jetbrainsMono',
    value: '"JetBrains Mono", Consolas, monospace'
  },
  {
    labelKey: 'settings.fonts.terminal.cascadiaCode',
    value: '"Cascadia Code", Consolas, monospace'
  },
  { labelKey: 'settings.fonts.terminal.firaCode', value: '"Fira Code", Consolas, monospace' },
  {
    labelKey: 'settings.fonts.terminal.notoSansMono',
    value: '"Noto Sans Mono", Consolas, monospace'
  },
  {
    labelKey: 'settings.fonts.terminal.systemMono',
    value: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  }
];

const SHORTCUT_LABEL_KEYS: Record<ShortcutAction, string> = {
  commandPalette: 'settings.shortcuts.action.commandPalette',
  newLocal: 'settings.shortcuts.action.newLocal',
  newSsh: 'settings.shortcuts.action.newSsh',
  openSettings: 'settings.shortcuts.action.openSettings'
};

const THEME_OPTIONS: Array<{ mode: ThemeMode; labelKey: string; descriptionKey: string }> = [
  {
    mode: 'light',
    labelKey: 'theme.mode.light',
    descriptionKey: 'settings.appearance.mode.lightDesc'
  },
  {
    mode: 'dark',
    labelKey: 'theme.mode.dark',
    descriptionKey: 'settings.appearance.mode.darkDesc'
  },
  {
    mode: 'system',
    labelKey: 'theme.mode.system',
    descriptionKey: 'settings.appearance.mode.systemDesc'
  }
];

const DARK_TERMINAL_SCHEMES = TERMINAL_COLOR_SCHEMES.filter((scheme) => scheme.variant === 'dark');
const LIGHT_TERMINAL_SCHEMES = TERMINAL_COLOR_SCHEMES.filter(
  (scheme) => scheme.variant === 'light'
);

function buildFontOptions(
  presets: Array<{ labelKey: string; value: string }>,
  families: SystemFontFamily[],
  target: FontFamilyTarget,
  translate: (key: string) => string
): Array<{ label: string; value: string }> {
  const options = presets.map((preset) => ({
    label: translate(preset.labelKey),
    value: preset.value
  }));
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
  const { t } = useI18n();
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

  const snippets = useSnippetStore((state) => state.snippets);
  const macros = useMacroStore((state) => state.macros);
  const removeMacro = useMacroStore((state) => state.remove);

  const handleMacroDelete = async (id: string, name: string) => {
    const ok = await confirmAction(t('settings.macros.deleteConfirm', { name }), {
      title: t('settings.macros.deleteTitle'),
      okLabel: t('settings.macros.deleteTitle')
    });
    if (ok) {
      removeMacro(id);
      toast({ title: t('settings.macros.deletedToast', { name }), variant: 'success' });
    }
  };
  const addSnippet = useSnippetStore((state) => state.addSnippet);
  const updateSnippet = useSnippetStore((state) => state.updateSnippet);
  const removeSnippet = useSnippetStore((state) => state.removeSnippet);
  const [snippetName, setSnippetName] = useState('');
  const [snippetCommand, setSnippetCommand] = useState('');
  const [editingSnippetId, setEditingSnippetId] = useState<string | null>(null);

  const [updateState, setUpdateState] = useState<'idle' | 'checking' | 'latest' | 'available'>(
    'idle'
  );
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const checkForUpdates = async () => {
    if (updateState === 'checking') {
      return;
    }
    setUpdateState('checking');
    setUpdateError(null);
    try {
      // The updater stays silent until a release with a signed latest.json is
      // published at the configured endpoint; failures surface here verbatim.
      const update = await checkForAppUpdate();
      if (update) {
        setUpdateVersion(update.version);
        setUpdateState('available');
      } else {
        setUpdateState('latest');
      }
    } catch (reason) {
      setUpdateError(String(reason));
      setUpdateState('idle');
    }
  };

  const resetSnippetForm = () => {
    setEditingSnippetId(null);
    setSnippetName('');
    setSnippetCommand('');
  };

  const startSnippetEdit = (snippet: Snippet) => {
    setEditingSnippetId(snippet.id);
    setSnippetName(snippet.name);
    setSnippetCommand(snippet.command);
  };

  const submitSnippet = () => {
    const editing = editingSnippetId;
    if (!snippetCommand.trim()) {
      return;
    }
    if (editing) {
      updateSnippet(editing, { name: snippetName, command: snippetCommand });
      toast({ title: t('settings.snippets.updatedToast'), variant: 'success' });
    } else {
      addSnippet({ name: snippetName, command: snippetCommand });
      toast({ title: t('settings.snippets.addedToast'), variant: 'success' });
    }
    resetSnippetForm();
  };

  const deleteSnippet = (id: string) => {
    removeSnippet(id);
    if (editingSnippetId === id) {
      resetSnippetForm();
    }
  };

  useEffect(() => {
    void loadSystemFonts();
  }, [loadSystemFonts]);

  const monospaceFonts = useMemo(
    () => systemFonts.filter((family) => family.monospaced),
    [systemFonts]
  );
  const uiFontOptions = useMemo(
    () => buildFontOptions(UI_FONT_PRESETS, systemFonts, 'ui', t),
    [systemFonts, t]
  );
  const terminalFontOptions = useMemo(
    () => buildFontOptions(TERMINAL_FONT_PRESETS, monospaceFonts, 'terminal', t),
    [monospaceFonts, t]
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
    const password = await promptSecret(
      t('settings.security.vault.setupPrompt'),
      t('settings.security.vault.next')
    );
    if (!password) {
      return;
    }
    const confirm = await promptSecret(
      t('settings.security.vault.reenterPrompt'),
      t('settings.security.vault.createConfirm')
    );
    if (!confirm) {
      return;
    }
    if (password !== confirm) {
      toast({ title: t('settings.security.vault.masterMismatch'), variant: 'error' });
      return;
    }
    setVaultBusy(true);
    try {
      setVaultStatus(await initializeVault(password));
      toast({ title: t('settings.security.vault.createdToast'), variant: 'success' });
    } catch (reason) {
      toast({
        title: t('settings.security.vault.createFailedToast'),
        description: String(reason),
        variant: 'error'
      });
    } finally {
      setVaultBusy(false);
    }
  };

  const handleVaultUnlock = async () => {
    if (vaultBusy) {
      return;
    }
    const password = await promptSecret(
      t('settings.security.vault.unlockPrompt'),
      t('settings.security.vault.unlock')
    );
    if (!password) {
      return;
    }
    setVaultBusy(true);
    try {
      const ok = await unlockVault(password);
      if (!ok) {
        toast({ title: t('settings.security.vault.wrongMasterToast'), variant: 'error' });
        return;
      }
      await refreshVaultStatus();
      toast({ title: t('settings.security.vault.unlockedToast'), variant: 'success' });
    } catch (reason) {
      toast({
        title: t('settings.security.vault.unlockFailedToast'),
        description: String(reason),
        variant: 'error'
      });
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
      toast({ title: t('settings.security.vault.lockedToast'), variant: 'success' });
    } catch (reason) {
      toast({
        title: t('settings.security.vault.lockFailedToast'),
        description: String(reason),
        variant: 'error'
      });
    } finally {
      setVaultBusy(false);
    }
  };

  const handleVaultChangePassword = async () => {
    if (vaultBusy) {
      return;
    }
    const oldPassword = await promptSecret(
      t('settings.security.vault.currentPrompt'),
      t('settings.security.vault.next')
    );
    if (!oldPassword) {
      return;
    }
    const newPassword = await promptSecret(
      t('settings.security.vault.newPrompt'),
      t('settings.security.vault.next')
    );
    if (!newPassword) {
      return;
    }
    const confirm = await promptSecret(
      t('settings.security.vault.reenterNewPrompt'),
      t('settings.security.vault.changeConfirm')
    );
    if (!confirm) {
      return;
    }
    if (newPassword !== confirm) {
      toast({ title: t('settings.security.vault.newMasterMismatch'), variant: 'error' });
      return;
    }
    setVaultBusy(true);
    try {
      setVaultStatus(await changeVaultPassword(oldPassword, newPassword));
      toast({ title: t('settings.security.vault.changedToast'), variant: 'success' });
    } catch (reason) {
      toast({
        title: t('settings.security.vault.changeFailedToast'),
        description: String(reason),
        variant: 'error'
      });
    } finally {
      setVaultBusy(false);
    }
  };

  const handleVaultClear = async () => {
    if (vaultBusy) {
      return;
    }
    const ok = await confirmAction(t('settings.security.vault.clearConfirm'), {
      title: t('settings.security.vault.clearTitle'),
      okLabel: t('settings.security.vault.clearOk')
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
      toast({ title: t('settings.security.vault.clearedToast'), variant: 'success' });
    } catch (reason) {
      toast({
        title: t('settings.security.vault.clearFailedToast'),
        description: String(reason),
        variant: 'error'
      });
    } finally {
      setVaultBusy(false);
    }
  };

  const handleVaultReset = async () => {
    if (vaultBusy) {
      return;
    }
    const ok = await confirmAction(t('settings.security.vault.resetConfirm'), {
      title: t('settings.security.vault.resetTitle'),
      okLabel: t('settings.security.vault.resetOk')
    });
    if (!ok) {
      return;
    }
    // The backend requires the current master password before destroying
    // every stored credential (same bar as clearing an unlocked vault).
    const masterPassword = await promptSecret(
      t('settings.security.vault.resetPrompt'),
      t('settings.security.vault.resetConfirmLabel')
    );
    if (masterPassword === null || masterPassword.length === 0) {
      return;
    }
    setVaultBusy(true);
    try {
      const sessions = useSessionStore.getState().sessions;
      await Promise.all(sessions.map((session) => forgetSessionCredentials(session.id)));
      await resetVault(masterPassword);
      setVaultStatus(await getVaultStatus());
      toast({ title: t('settings.security.vault.resetToast'), variant: 'success' });
    } catch (reason) {
      toast({
        title: t('settings.security.vault.resetFailedToast'),
        description: String(reason),
        variant: 'error'
      });
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

  const browseLogDir = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: t('settings.terminal.logDirPick')
      });
      if (typeof selected === 'string') {
        update('sessionLogDir', selected);
      }
    } catch {
      /* dialog unavailable */
    }
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
        title: t('settings.security.knownHosts.importDialogTitle')
      });
      if (typeof selected !== 'string') {
        return;
      }

      const result = await importKnownHosts(selected);
      setKnownHosts(await listKnownHosts());
      setRemovedHosts([]);
      toast({
        title: t('settings.security.knownHosts.importedToast', { count: result.imported }),
        description:
          result.skipped > 0 || result.invalid > 0
            ? t('settings.security.knownHosts.importSkippedToast', {
                skipped: result.skipped,
                invalid: result.invalid
              })
            : undefined,
        variant: result.imported > 0 ? 'success' : 'default'
      });
    } catch (reason) {
      toast({
        title: t('settings.security.knownHosts.importFailedToast'),
        description: String(reason),
        variant: 'error'
      });
    }
  };

  const handleExportHosts = async () => {
    try {
      const target = await saveDialog({
        defaultPath: 'known_hosts',
        title: t('settings.security.knownHosts.exportDialogTitle')
      });
      if (!target) {
        return;
      }

      const result = await exportKnownHosts(target, hashHosts);
      toast({
        title: t('settings.security.knownHosts.exportedToast', { count: result.exported }),
        description:
          result.skipped > 0
            ? t('settings.security.knownHosts.exportSkippedToast', { count: result.skipped })
            : undefined,
        variant: result.exported > 0 ? 'success' : 'default'
      });
    } catch (reason) {
      toast({
        title: t('settings.security.knownHosts.exportFailedToast'),
        description: String(reason),
        variant: 'error'
      });
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
        toast({
          title: t('settings.security.knownHosts.removePartialFailedToast'),
          variant: 'error'
        });
      }

      // Everything the draft held (settings + host deletions) is now applied;
      // only a later edit may re-arm the unsaved-changes guard.
      unsavedRef.current = false;
      setSavedAt(Date.now());
      return true;
    } catch (reason) {
      toast({
        title: t('settings.footer.applyFailedToast'),
        description: String(reason),
        variant: 'error'
      });
      return false;
    } finally {
      setApplying(false);
    }
  };

  const resetDefaults = async () => {
    const ok = await confirmAction(t('settings.reset.confirm'), {
      title: t('settings.reset.title'),
      okLabel: t('settings.reset.ok')
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
      // tStatic instead of the render-scoped t: this dialog also fires from
      // the onCloseRequested effect, which captures the first-render closure.
      return await confirmAction(tStatic('settings.discard.confirm'), {
        title: tStatic('settings.discard.title'),
        okLabel: tStatic('settings.discard.ok')
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
    const ok = await confirmAction(t('settings.security.knownHosts.removeConfirmText', { host }), {
      title: t('settings.security.knownHosts.removeConfirmTitle'),
      okLabel: t('settings.security.knownHosts.removeOk')
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
            <Label htmlFor="language">{t('settings.appearance.language')}</Label>
            <Select
              id="language"
              value={draft.language}
              onChange={(event) => update('language', event.target.value as LanguageSetting)}
            >
              <option value="system">{t('settings.appearance.language.system')}</option>
              <option value="zh-CN">{t('settings.appearance.language.zh')}</option>
              <option value="en-US">English</option>
            </Select>
            <p className="mt-1 text-[10px] text-muted-foreground">
              {t('settings.appearance.language.partialNote')}
            </p>
          </div>

          <div>
            <label className="flex items-center gap-2 text-[11px] text-muted">
              <input
                type="checkbox"
                className="app-checkbox h-3.5 w-3.5 accent-accent"
                checked={draft.closeToTray}
                onChange={(event) => update('closeToTray', event.target.checked)}
              />
              {t('settings.appearance.closeToTray')}
            </label>
            <p className="mt-1 text-[10px] text-muted-foreground">
              {t('settings.appearance.closeToTrayHint')}
            </p>
          </div>

          <div>
            <Label htmlFor="global-show-hotkey">{t('settings.appearance.globalShowHotkey')}</Label>
            <Input
              id="global-show-hotkey"
              value={draft.globalShowHotkey}
              onChange={(event) => update('globalShowHotkey', event.target.value)}
              placeholder="Ctrl+Shift+Space"
              autoComplete="off"
            />
            <p className="mt-1 text-[10px] text-muted-foreground">
              {t('settings.appearance.globalShowHotkeyHint')}
            </p>
          </div>
        </div>

        <div className="rounded-sm border border-border bg-surface p-3">
          <div className="grid gap-3 md:grid-cols-[minmax(0,240px)_1fr]">
            <div>
              <Label htmlFor="theme-mode">{t('settings.appearance.themeMode')}</Label>
              <Select
                id="theme-mode"
                value={draft.themeMode}
                onChange={(event) => update('themeMode', event.target.value as ThemeMode)}
              >
                {THEME_OPTIONS.map((option) => (
                  <option key={option.mode} value={option.mode}>
                    {t(option.labelKey)}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-[10px] text-muted-foreground">
                {activeMode ? t(activeMode.descriptionKey) : undefined}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-sm border border-border bg-background-alt p-2">
                <div className="flex items-center gap-1.5 text-[10px] text-muted">
                  <Moon className="h-3 w-3" />
                  {t('settings.appearance.darkThemeLabel')}
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
                  {t('settings.appearance.lightThemeLabel')}
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
            <h3 className="text-xs font-semibold text-foreground">
              {t('settings.appearance.themesTitle')}
            </h3>
            <span className="text-[10px] text-muted-foreground">
              {t('settings.appearance.familyHint')}
            </span>
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
                    <div className="text-[10px] text-muted">{t(family.descriptionKey)}</div>
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
                      {t('theme.mode.dark')}
                    </Button>
                    <Button
                      size="xs"
                      variant={lightSelected ? 'primary' : 'secondary'}
                      onClick={() => update('lightTheme', lightTheme.id)}
                    >
                      <Sun className="h-3 w-3" />
                      {t('theme.mode.light')}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-sm border border-border bg-surface p-3">
          <h3 className="mb-2 text-xs font-semibold text-foreground">
            {t('settings.fonts.uiTitle')}
          </h3>
          <div className="grid items-end gap-3 md:grid-cols-[1fr_auto]">
            <div>
              <Label htmlFor="ui-font">Font Family</Label>
              <EditableSelect
                id="ui-font"
                value={draft.uiFontFamily}
                options={uiFontOptions}
                onChange={(value) => update('uiFontFamily', value)}
                ariaLabel={t('settings.fonts.uiTitle')}
              />
              <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className="truncate">
                  {systemFontsLoading
                    ? t('settings.fonts.loading')
                    : systemFontsError
                      ? t('settings.fonts.loadFailed', { error: systemFontsError })
                      : t('settings.fonts.uiLoaded', { count: systemFonts.length })}
                </span>
                <button
                  type="button"
                  disabled={systemFontsLoading}
                  onClick={() => void refreshSystemFonts()}
                  className="shrink-0 underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
                >
                  {t('settings.fonts.refresh')}
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
            {t('settings.fonts.ligaturesHint')}
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
              {t('settings.fonts.featuresHint')}
            </p>
          </div>
          <div className="mt-2 flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {t('settings.fonts.ligatureSample')}
            </span>
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

        <p className="text-[10px] text-muted-foreground">{t('settings.appearance.applyHint')}</p>
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
            ariaLabel={t('settings.fonts.terminalAria')}
          />
          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span className="truncate">
              {systemFontsLoading
                ? t('settings.fonts.loading')
                : systemFontsError
                  ? t('settings.fonts.loadFailed', { error: systemFontsError })
                  : t('settings.fonts.monoAvailable', { count: monospaceFonts.length })}
            </span>
            <button
              type="button"
              disabled={systemFontsLoading}
              onClick={() => void refreshSystemFonts()}
              className="shrink-0 underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
            >
              {t('settings.fonts.refresh')}
            </button>
          </div>
        </div>
        <div>
          <Label htmlFor="terminal-color-scheme">{t('settings.terminal.colorScheme')}</Label>
          <Select
            id="terminal-color-scheme"
            value={draft.terminalColorScheme}
            onChange={(event) => update('terminalColorScheme', event.target.value)}
          >
            <option value="theme">{t('settings.terminal.schemeFollowTheme')}</option>
            <optgroup label={t('settings.terminal.schemeGroupDark')}>
              {DARK_TERMINAL_SCHEMES.map((scheme) => (
                <option key={scheme.id} value={scheme.id}>
                  {scheme.name}
                </option>
              ))}
            </optgroup>
            <optgroup label={t('settings.terminal.schemeGroupLight')}>
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
          <Label>{t('settings.terminal.fontSize')}</Label>
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
          <Label htmlFor="terminal-cursor">{t('settings.terminal.cursorStyle')}</Label>
          <Select
            id="terminal-cursor"
            value={draft.terminalCursorStyle}
            onChange={(event) =>
              update('terminalCursorStyle', event.target.value as TerminalCursorStyle)
            }
          >
            <option value="block">{t('settings.terminal.cursor.block')}</option>
            <option value="underline">{t('settings.terminal.cursor.underline')}</option>
            <option value="bar">{t('settings.terminal.cursor.bar')}</option>
          </Select>
        </div>

        <div>
          <Label htmlFor="terminal-scrollback">{t('settings.terminal.scrollback')}</Label>
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
          <Label htmlFor="terminal-line-height">{t('settings.terminal.lineHeight')}</Label>
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
          {t('settings.terminal.cursorBlink')}
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
          {t('settings.terminal.copyOnSelect')}
        </label>
        <label className="flex items-center gap-2 text-[11px] text-muted">
          <input
            type="checkbox"
            className="app-checkbox h-3.5 w-3.5 accent-accent"
            checked={draft.terminalRestoreScrollback}
            onChange={(event) => update('terminalRestoreScrollback', event.target.checked)}
          />
          {t('settings.terminal.restoreScrollback')}
        </label>
      </div>
      <p className="-mt-1 text-[10px] text-muted-foreground">
        {t('settings.terminal.ligaturesNote')}
      </p>

      <div className="space-y-2 rounded-sm border border-border bg-surface p-3">
        <label className="flex items-center gap-2 text-[11px] text-muted">
          <input
            type="checkbox"
            className="app-checkbox h-3.5 w-3.5 accent-accent"
            checked={draft.sessionLogEnabled}
            onChange={(event) => update('sessionLogEnabled', event.target.checked)}
          />
          {t('settings.terminal.sessionLog')}
        </label>
        <div className="flex items-stretch gap-1">
          <Input
            value={draft.sessionLogDir}
            onChange={(event) => update('sessionLogDir', event.target.value)}
            placeholder={t('settings.terminal.logDirPlaceholder')}
            className="flex-1"
            aria-label={t('settings.terminal.logDirAria')}
          />
          <Button
            size="icon"
            variant="secondary"
            aria-label={t('settings.terminal.logDirPick')}
            title={t('settings.terminal.logDirPick')}
            onClick={() => void browseLogDir()}
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">{t('settings.terminal.logNote')}</p>
      </div>

      <div>
        <Label htmlFor="terminal-font-feature-settings">Font Feature Settings</Label>
        <Input
          id="terminal-font-feature-settings"
          value={draft.terminalFontFeatureSettings}
          onChange={(event) => update('terminalFontFeatureSettings', event.target.value)}
          placeholder={'"calt" on'}
        />
        <p className="mt-1 text-[10px] text-muted-foreground">
          {t('settings.terminal.featuresHint')}
        </p>
      </div>

      <div>
        <p className="mb-1 text-[10px] text-muted">{t('settings.terminal.preview')}</p>
        <Suspense
          fallback={
            <div className="flex h-40 items-center justify-center rounded-sm border border-border bg-background-alt text-[11px] text-muted">
              {t('settings.terminal.previewLoading')}
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
        <Label htmlFor="default-auth">{t('settings.ssh.defaultAuth')}</Label>
        <Select
          id="default-auth"
          value={draft.defaultAuthMethod}
          onChange={(event) => update('defaultAuthMethod', event.target.value as SessionAuthMethod)}
        >
          <option value="password">{t('settings.ssh.auth.password')}</option>
          <option value="key">{t('settings.ssh.auth.key')}</option>
          <option value="certificate">{t('settings.ssh.auth.certificate')}</option>
          <option value="agent">SSH Agent</option>
        </Select>
      </div>
      <div>
        <Label htmlFor="default-port">{t('settings.ssh.defaultPort')}</Label>
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
        <Label htmlFor="default-username">{t('settings.ssh.defaultUsername')}</Label>
        <Input
          id="default-username"
          value={draft.defaultUsername}
          onChange={(event) => update('defaultUsername', event.target.value)}
          placeholder={t('settings.ssh.usernamePlaceholder')}
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
          {t('settings.ssh.autoReconnect')}
        </label>
        <p className="text-[10px] text-muted-foreground">{t('settings.ssh.keepaliveNote')}</p>
      </div>
    </section>
  );

  const renderShortcuts = () => (
    <section>
      <div className="space-y-2">
        {(Object.keys(SHORTCUT_LABEL_KEYS) as ShortcutAction[]).map((action) => (
          <div key={action} className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-muted">{t(SHORTCUT_LABEL_KEYS[action])}</span>
            <ShortcutInput
              value={draft.shortcuts[action]}
              onChange={(value) => updateShortcut(action, value)}
            />
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10px] text-muted-foreground">{t('settings.shortcuts.hint')}</p>
    </section>
  );

  const renderSecurity = () => {
    const vaultInitialized = Boolean(vaultStatus?.initialized);
    const vaultUnlocked = Boolean(vaultStatus?.unlocked);
    return (
      <section className="space-y-5">
        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-foreground">
              {t('settings.security.vault.title')}
            </h3>
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
              {vaultInitialized
                ? vaultUnlocked
                  ? t('settings.security.vault.unlocked')
                  : t('settings.security.vault.locked')
                : t('settings.security.vault.missing')}
            </span>
          </div>
          <p className="text-[10px] text-muted-foreground">
            {t('settings.security.vault.description')}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {!vaultInitialized ? (
              <Button
                size="xs"
                variant="primary"
                disabled={vaultBusy}
                onClick={() => void handleVaultSetup()}
              >
                {t('settings.security.vault.setupMaster')}
              </Button>
            ) : vaultUnlocked ? (
              <>
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={vaultBusy}
                  onClick={() => void handleVaultLock()}
                >
                  {t('settings.security.vault.lock')}
                </Button>
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={vaultBusy}
                  onClick={() => void handleVaultChangePassword()}
                >
                  {t('settings.security.vault.changeMaster')}
                </Button>
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={vaultBusy}
                  onClick={() => void handleVaultClear()}
                >
                  {t('settings.security.vault.clearCredentials')}
                </Button>
              </>
            ) : (
              <Button
                size="xs"
                variant="primary"
                disabled={vaultBusy}
                onClick={() => void handleVaultUnlock()}
              >
                {t('settings.security.vault.unlock')}
              </Button>
            )}
            {vaultInitialized ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={vaultBusy}
                onClick={() => void handleVaultReset()}
              >
                {t('settings.security.vault.reset')}
              </Button>
            ) : null}
            {vaultUnlocked ? (
              <span className="text-[10px] text-muted">
                {t('settings.security.vault.entryCount', {
                  count: vaultStatus?.entry_count ?? 0
                })}
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
            {t('settings.security.rememberCredentials')}
          </label>
        </div>

        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-foreground">
              {t('settings.security.knownHosts.title')}
            </h3>
            <div className="flex items-center gap-1.5">
              <label className="flex items-center gap-1 text-[10px] text-muted">
                <input
                  type="checkbox"
                  checked={hashHosts}
                  onChange={(event) => setHashHosts(event.target.checked)}
                />
                {t('settings.security.knownHosts.hashHostnames')}
              </label>
              <Button size="xs" variant="secondary" onClick={() => void handleImportHosts()}>
                {t('settings.security.knownHosts.import')}
              </Button>
              <Button size="xs" variant="secondary" onClick={() => void handleExportHosts()}>
                {t('settings.security.knownHosts.export')}
              </Button>
            </div>
          </div>
          {loadingHosts ? (
            <p className="text-[11px] text-muted">{t('settings.security.knownHosts.loading')}</p>
          ) : hostsError ? (
            <p className="selectable text-[11px] text-error">{hostsError}</p>
          ) : visibleHosts.length === 0 ? (
            <p className="text-[11px] text-muted">{t('settings.security.knownHosts.empty')}</p>
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
                    aria-label={t('settings.security.knownHosts.removeAria')}
                    title={t('settings.security.knownHosts.removeAria')}
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
              {t('settings.security.knownHosts.pendingRemoval', { count: removedHosts.length })}
            </p>
          ) : null}
          <p className="mt-2 text-[10px] text-muted-foreground">
            {t('settings.security.knownHosts.removeHint')}
          </p>
        </div>
      </section>
    );
  };

  const renderAbout = () => (
    <section className="space-y-3">
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-foreground">NexTerm 0.1.0</h3>
        <p className="text-[11px] text-muted">Tauri 2 + React 18 + Rust</p>
        <p className="text-[11px] text-muted">
          {t('settings.about.shortcuts', {
            palette: DEFAULT_SETTINGS.shortcuts.commandPalette,
            settings: DEFAULT_SETTINGS.shortcuts.openSettings
          })}
        </p>
      </div>

      <div className="space-y-2 rounded-sm border border-border bg-surface p-3">
        <div className="flex items-center gap-2">
          <p className="flex-1 text-[11px] text-muted">{t('settings.about.updateHint')}</p>
          <Button
            size="sm"
            variant="secondary"
            disabled={updateState === 'checking'}
            onClick={() => void checkForUpdates()}
          >
            {updateState === 'checking'
              ? t('settings.about.checking')
              : t('settings.about.checkUpdate')}
          </Button>
        </div>
        {updateState === 'latest' ? (
          <p className="text-[10px] text-muted-foreground">{t('settings.about.upToDate')}</p>
        ) : null}
        {updateState === 'available' ? (
          <div className="flex items-center gap-2">
            <p className="flex-1 text-[10px] text-muted-foreground">
              {t('settings.about.newVersionFound', { version: updateVersion ?? '' })}
            </p>
            <Button
              size="xs"
              variant="secondary"
              onClick={() =>
                void openUrl('https://github.com/BOOW6/NexTerm/releases/latest').catch(
                  () => undefined
                )
              }
            >
              {t('settings.about.openReleases')}
            </Button>
          </div>
        ) : null}
        {updateError ? (
          <p className="text-[10px] text-error">
            {t('settings.about.updateFailed', { error: updateError })}
          </p>
        ) : null}
      </div>
    </section>
  );

  const renderSnippets = () => (
    <section className="space-y-3">
      <p className="text-[11px] text-muted">
        {t('settings.snippets.hint', { palette: DEFAULT_SETTINGS.shortcuts.commandPalette })}
      </p>

      <div className="space-y-2 rounded-sm border border-border bg-surface p-3">
        <div className="grid grid-cols-[10rem_1fr] gap-2">
          <Input
            value={snippetName}
            onChange={(event) => setSnippetName(event.target.value)}
            placeholder={t('settings.snippets.namePlaceholder')}
            aria-label={t('settings.snippets.nameAria')}
          />
          <Input
            value={snippetCommand}
            onChange={(event) => setSnippetCommand(event.target.value)}
            placeholder={t('settings.snippets.commandPlaceholder')}
            aria-label={t('settings.snippets.commandAria')}
            className="font-mono"
          />
        </div>
        <div className="flex justify-end gap-2">
          {editingSnippetId ? (
            <Button variant="ghost" onClick={resetSnippetForm}>
              {t('settings.snippets.cancelEdit')}
            </Button>
          ) : null}
          <Button variant="primary" disabled={!snippetCommand.trim()} onClick={submitSnippet}>
            {editingSnippetId ? t('settings.snippets.save') : t('settings.snippets.add')}
          </Button>
        </div>
      </div>

      {snippets.length === 0 ? (
        <p className="px-2 py-6 text-center text-[11px] text-muted">
          {t('settings.snippets.empty')}
        </p>
      ) : (
        <ul className="space-y-1">
          {snippets.map((snippet) => (
            <li
              key={snippet.id}
              className="flex items-center gap-2 rounded-sm border border-border bg-surface px-2 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-foreground">{snippet.name}</p>
                <p className="truncate font-mono text-[10px] text-muted">{snippet.command}</p>
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('settings.snippets.editAria', { name: snippet.name })}
                title={t('settings.snippets.editTitle')}
                onClick={() => startSnippetEdit(snippet)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('settings.snippets.deleteAria', { name: snippet.name })}
                title={t('settings.snippets.deleteTitle')}
                onClick={() => deleteSnippet(snippet.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 border-t border-border pt-3">
        <h3 className="text-xs font-semibold text-foreground">{t('settings.macros.title')}</h3>
        <p className="mt-1 text-[10px] text-muted">
          {t('settings.macros.hint', { palette: DEFAULT_SETTINGS.shortcuts.commandPalette })}
        </p>
        {macros.length === 0 ? (
          <p className="px-2 py-4 text-center text-[11px] text-muted">
            {t('settings.macros.empty')}
          </p>
        ) : (
          <ul className="mt-2 space-y-1">
            {macros.map((macro) => (
              <li
                key={macro.id}
                className="flex items-center gap-2 rounded-sm border border-border bg-surface px-2 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-foreground">{macro.name}</p>
                  <p className="text-[10px] text-muted">
                    {t('settings.macros.count', { count: macro.steps.length })}
                  </p>
                </div>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('settings.macros.deleteAria', { name: macro.name })}
                  title={t('settings.macros.deleteTitle')}
                  onClick={() => void handleMacroDelete(macro.id, macro.name)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );

  const content = {
    appearance: renderAppearance,
    terminal: renderTerminal,
    snippets: renderSnippets,
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
              {t(item.labelKey)}
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
          {t('settings.footer.resetDefaults')}
        </Button>
        <span className="mr-1 text-[10px] text-muted">
          {savedAt ? t('settings.footer.saved') : t('settings.footer.unsavedHint')}
        </span>
        <Button variant="ghost" onClick={() => void requestClose()}>
          {t('settings.footer.cancel')}
        </Button>
        <Button variant="secondary" disabled={applying} onClick={() => void apply()}>
          {t('settings.footer.apply')}
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
          {t('settings.footer.ok')}
        </Button>
      </div>
      <Toaster />
    </div>
  );
}
