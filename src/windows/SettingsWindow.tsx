import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { emit, listen } from '@tauri-apps/api/event';
import {
  Keyboard,
  Monitor,
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
import { Input, Label } from '../components/ui/input';
import { Select } from '../components/ui/select';
import { ShortcutInput } from '../components/settings/ShortcutInput';
import { Toaster, toast } from '../components/ui/toast';
import { cn } from '../lib/cn';
import {
  DEFAULT_SETTINGS,
  useSettingsStore,
  type SettingsSnapshot,
  type ShortcutAction,
  type TerminalCursorStyle
} from '../stores/settingsStore';
import { useTheme, type ThemeMode } from '../theme/ThemeProvider';
import { confirmAction } from '../lib/appWindows';
import {
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

const FONT_PRESETS = [
  {
    label: 'Consolas / 等宽回退',
    value: 'Consolas, "Courier New", "Sarasa Mono SC", monospace'
  },
  { label: 'JetBrains Mono', value: '"JetBrains Mono", Consolas, monospace' },
  { label: 'Cascadia Code', value: '"Cascadia Code", Consolas, monospace' },
  { label: '系统等宽', value: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }
];

const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  commandPalette: '打开命令面板',
  newLocal: '新建本地终端',
  newSsh: '新建 SSH 会话',
  openSettings: '打开设置'
};

const THEME_OPTIONS: Array<{ mode: ThemeMode; label: string; icon: LucideIcon }> = [
  { mode: 'light', label: '明亮', icon: Sun },
  { mode: 'dark', label: '暗黑', icon: Moon },
  { mode: 'system', label: '跟随系统', icon: Monitor }
];

const TerminalPreview = lazy(() => import('./settings/TerminalPreview'));

function snapshotOf(): SettingsSnapshot {
  const state = useSettingsStore.getState();
  return {
    terminalFontSize: state.terminalFontSize,
    terminalFontFamily: state.terminalFontFamily,
    terminalCursorStyle: state.terminalCursorStyle,
    terminalCursorBlink: state.terminalCursorBlink,
    terminalScrollback: state.terminalScrollback,
    terminalLineHeight: state.terminalLineHeight,
    defaultAuthMethod: state.defaultAuthMethod,
    defaultPort: state.defaultPort,
    defaultUsername: state.defaultUsername,
    shortcuts: { ...state.shortcuts }
  };
}

function initialTab(): SettingsTab {
  const tab = new URLSearchParams(window.location.search).get('tab');
  return TABS.some((item) => item.id === tab) ? (tab as SettingsTab) : 'appearance';
}

export default function SettingsWindow() {
  const { mode, setMode } = useTheme();
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [previewActivated, setPreviewActivated] = useState(() => initialTab() === 'terminal');
  const [draft, setDraft] = useState<SettingsSnapshot>(() => ({
    ...snapshotOf(),
    shortcuts: { ...useSettingsStore.getState().shortcuts }
  }));
  const [draftTheme, setDraftTheme] = useState<ThemeMode>(mode);
  const [knownHosts, setKnownHosts] = useState<KnownHost[]>([]);
  const [removedHosts, setRemovedHosts] = useState<string[]>([]);
  const [loadingHosts, setLoadingHosts] = useState(false);
  const [hostsError, setHostsError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    // Warm up the lazy preview chunk while the user is on the first tab.
    void import('./settings/TerminalPreview');
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

  const update = <K extends keyof SettingsSnapshot>(key: K, value: SettingsSnapshot[K]) => {
    setSavedAt(null);
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const updateShortcut = (action: ShortcutAction, value: string) => {
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

  const apply = async (): Promise<boolean> => {
    if (applying) {
      return false;
    }
    setApplying(true);
    try {
      useSettingsStore.getState().applySettings(draft);
      setMode(draftTheme);

      const applied = snapshotOf();
      setDraft({ ...applied, shortcuts: { ...applied.shortcuts } });
      await emit('nexterm-settings-applied', { settings: applied, theme: draftTheme });

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
    setSavedAt(null);
    setDraft({ ...DEFAULT_SETTINGS, shortcuts: { ...DEFAULT_SETTINGS.shortcuts } });
    setDraftTheme('system');
  };

  const close = () => {
    void getCurrentWindow().close();
  };

  const handleRemoveHost = async (host: string) => {
    const ok = await confirmAction(`确定删除「${host}」的已知主机记录吗？`, {
      title: '删除已知主机',
      okLabel: '删除'
    });
    if (ok) {
      setRemovedHosts((current) => [...current, host]);
      setSavedAt(null);
    }
  };

  const renderAppearance = () => (
    <section className="space-y-4">
      <div>
        <h3 className="mb-2 text-xs font-semibold text-foreground">主题</h3>
        <div className="grid grid-cols-3 gap-2">
          {THEME_OPTIONS.map((option) => {
            const Icon = option.icon;
            return (
              <button
                key={option.mode}
                type="button"
                onClick={() => {
                  setDraftTheme(option.mode);
                  setSavedAt(null);
                }}
                className={cn(
                  'flex flex-col items-center gap-1.5 rounded-sm border px-2 py-3 text-[11px] transition-colors',
                  draftTheme === option.mode
                    ? 'border-accent bg-accent/10 text-foreground'
                    : 'border-border bg-surface text-muted hover:bg-surface-hover'
                )}
              >
                <Icon className="h-4 w-4" />
                {option.label}
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          主题将在点击「应用」后应用到主窗口。
        </p>
      </div>
    </section>
  );

  const renderTerminal = () => (
    <section className="space-y-3">
      <div>
        <Label htmlFor="terminal-font">字体</Label>
        <Select
          id="terminal-font"
          value={draft.terminalFontFamily}
          onChange={(event) => update('terminalFontFamily', event.target.value)}
        >
          {FONT_PRESETS.map((preset) => (
            <option key={preset.label} value={preset.value}>
              {preset.label}
            </option>
          ))}
        </Select>
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

      <label className="flex items-center gap-2 text-[11px] text-muted">
        <input
          type="checkbox"
          className="h-3.5 w-3.5 accent-accent"
          checked={draft.terminalCursorBlink}
          onChange={(event) => update('terminalCursorBlink', event.target.checked)}
        />
        光标闪烁
      </label>

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
          onChange={(event) =>
            update('defaultAuthMethod', event.target.value as SessionAuthMethod)
          }
        >
          <option value="password">密码</option>
          <option value="key">私钥</option>
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

  const renderSecurity = () => (
    <section>
      <h3 className="mb-2 text-xs font-semibold text-foreground">已知主机（known_hosts）</h3>
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
                size="icon"
                variant="ghost"
                className="h-6 w-6"
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
    </section>
  );

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
      <div className="flex h-10 shrink-0 items-end gap-0.5 border-b border-border bg-surface-header px-2">
        {TABS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
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
        <Button variant="ghost" onClick={close}>
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
