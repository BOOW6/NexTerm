import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Circle,
  CircleStop,
  Play,
  Radio,
  ArrowUpDown,
  Columns2,
  CornerDownLeft,
  FolderTree,
  Network,
  Plus,
  RotateCw,
  Rows2,
  Search,
  Send,
  Settings,
  SquareTerminal,
  Star,
  SunMoon,
  X,
  Zap,
  type LucideIcon
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { useWorkspace } from '../../features/workspace/useWorkspace';
import { useSessionStore } from '../../stores/sessionStore';
import { useSnippetStore } from '../../stores/snippetStore';
import { useUIStore } from '../../stores/uiStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useTheme } from '../../theme/useTheme';
import { openSettingsWindow } from '../../lib/appWindows';
import { useQuickConnectLauncher } from '../../features/workspace/useQuickConnectLauncher';
import { dispatchTerminalAction } from '../../lib/terminalCommands';
import { toast } from '../ui/toastStore';
import { useBroadcastStore, broadcastCount } from '../../stores/broadcastStore';
import { useMacroStore, useMacroRecorderStore } from '../../stores/macroStore';
import { replayMacro } from '../../lib/terminalWrite';
import { promptText, confirmAction } from '../../lib/appWindows';
import { SESSION_KIND_LABEL_KEY, sessionSubtitle } from '../../types/session';
import { useI18n } from '../../i18n';
import { SESSION_KIND_ICON } from '../../lib/sessionVisuals';

interface CommandItem {
  id: string;
  group: 'sessions' | 'commands' | 'snippets' | 'macros';
  label: string;
  hint?: string;
  keywords?: string;
  icon: LucideIcon;
  run: () => void;
}

const GROUP_LABEL_KEY: Record<CommandItem['group'], string> = {
  sessions: 'palette.group.sessions',
  commands: 'palette.group.commands',
  snippets: 'palette.group.snippets',
  macros: 'palette.group.macros'
};

function CommandWindow({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  // aria-modal alone does not stop Tab from reaching the workspace behind
  // the portal: cycle focus inside the dialog ourselves.
  const dialogRef = useRef<HTMLDivElement>(null);

  const trapFocus = (event: React.KeyboardEvent): void => {
    if (event.key !== 'Tab' || !dialogRef.current) {
      return;
    }
    const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (focusables.length === 0) {
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    const inside = dialogRef.current.contains(active);
    if (event.shiftKey && (!inside || active === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (!inside || active === last)) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
      <div
        className="absolute inset-0 animate-fade-in bg-overlay-scrim"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        onKeyDown={trapFocus}
        className="relative z-10 w-full max-w-lg animate-zoom-in overflow-hidden rounded-md border border-border-strong bg-surface-elevated shadow-popup"
        role="dialog"
        aria-modal="true"
        aria-labelledby="palette-title"
      >
        {children}
      </div>
    </div>,
    document.body
  );
}

export default function CommandPalette() {
  const { t } = useI18n();
  const open = useUIStore((state) => state.commandPaletteOpen);
  const closeCommandPalette = useUIStore((state) => state.closeCommandPalette);
  const openQuickConnect = useQuickConnectLauncher();

  const sessions = useSessionStore((state) => state.sessions);
  const toggleFavorite = useSessionStore((state) => state.toggleFavorite);
  const snippets = useSnippetStore((state) => state.snippets);
  const macros = useMacroStore((state) => state.macros);
  const recording = useMacroRecorderStore((state) => state.recording);
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId);
  const { themeLabel, cycle } = useTheme();
  const {
    openSession,
    reconnectSession,
    splitSession,
    duplicateSession,
    openSftpPanel,
    openPortForwardPanel,
    openTransferPanel,
    getApi
  } = useWorkspace();

  const inputRef = useRef<HTMLInputElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);

  const activeSession = sessions.find((session) => session.id === activeSessionId);

  const runSnippet = useCallback(
    async (snippet: {
      id: string;
      name: string;
      command: string;
      confirm?: boolean;
    }): Promise<void> => {
      // {{variable}} placeholders are prompted in order of first appearance.
      const variables = [...new Set(snippet.command.match(/\{\{([^{}]+)\}\}/g) ?? [])].map(
        (token) => token.slice(2, -2).trim()
      );
      const values = new Map<string, string>();
      for (const variable of variables) {
        const value = await promptText(
          t('palette.snippet.varPrompt', { name: variable }),
          t('palette.snippet.varOk')
        );
        if (value === null) {
          return;
        }
        values.set(variable, value);
      }
      let text = snippet.command;
      for (const [variable, value] of values) {
        text = text.split('{{' + variable + '}}').join(value);
      }
      if (snippet.confirm) {
        const ok = await confirmAction(text, {
          title: t('palette.snippet.confirmTitle', { name: snippet.name }),
          okLabel: t('palette.snippet.confirmOk')
        });
        if (!ok) {
          return;
        }
      }
      dispatchTerminalAction({ type: 'send-text', text, execute: true });
    },
    [t]
  );

  const items = useMemo<CommandItem[]>(() => {
    const sessionItems: CommandItem[] = sessions.map((session) => ({
      id: `session-${session.id}`,
      group: 'sessions',
      label: session.title,
      hint: `${t(SESSION_KIND_LABEL_KEY[session.kind])} - ${sessionSubtitle(session, t)}`,
      keywords: `${session.group} ${session.host ?? ''} ${session.username ?? ''}`,
      icon: SESSION_KIND_ICON[session.kind],
      run: () => openSession(session.id)
    }));

    const commandItems: CommandItem[] = [
      {
        id: 'new-local',
        group: 'commands',
        label: t('palette.newLocal'),
        icon: Plus,
        keywords: 'local terminal 本地 终端 新建',
        run: () => void openQuickConnect({ kind: 'local' })
      },
      {
        id: 'new-ssh',
        group: 'commands',
        label: t('palette.newSsh'),
        icon: Zap,
        keywords: 'ssh remote 远程 新建',
        run: () => void openQuickConnect({ kind: 'ssh' })
      },
      {
        id: 'new-sftp',
        group: 'commands',
        label: t('palette.newSftp'),
        icon: FolderTree,
        keywords: 'sftp 文件 新建',
        run: () => void openQuickConnect({ kind: 'sftp' })
      },
      {
        id: 'open-sftp',
        group: 'commands',
        label: t('palette.openSftp'),
        icon: FolderTree,
        keywords: 'sftp 文件 browser 面板',
        run: () => openSftpPanel()
      },
      {
        id: 'open-transfers',
        group: 'commands',
        label: t('palette.openTransfers'),
        icon: ArrowUpDown,
        keywords: 'transfer upload download 传输 队列 上传 下载',
        run: () => openTransferPanel()
      },
      {
        id: 'open-forwards',
        group: 'commands',
        label: t('palette.openForwards'),
        icon: Network,
        keywords: 'forward tunnel proxy socks 端口 转发 隧道',
        run: () => openPortForwardPanel()
      },
      {
        id: 'open-settings',
        group: 'commands',
        label: t('palette.openSettings'),
        icon: Settings,
        keywords: 'settings 设置 主题 字体 known hosts 已知主机',
        run: () => void openSettingsWindow()
      },
      {
        id: 'toggle-theme',
        group: 'commands',
        label: t('palette.toggleTheme', { current: themeLabel }),
        icon: SunMoon,
        keywords: 'theme 主题 Day Dim Aqua Holo 亮色 暗色 跟随系统 dark light',
        run: () => cycle()
      },
      {
        id: 'manage-snippets',
        group: 'commands',
        label: t('palette.manageSnippets'),
        icon: SquareTerminal,
        keywords: 'snippet 片段 命令 管理',
        run: () => void openSettingsWindow('snippets')
      }
    ];

    if (activeSession) {
      const activePanelId = () => getApi()?.activePanel?.id;

      commandItems.push(
        {
          id: 'split-right',
          group: 'commands',
          label: t('palette.splitRight'),
          icon: Columns2,
          keywords: 'split 分屏 右',
          run: () => splitSession(activeSession.id, 'right', activePanelId())
        },
        {
          id: 'split-below',
          group: 'commands',
          label: t('palette.splitBelow'),
          icon: Rows2,
          keywords: 'split 分屏 下',
          run: () => splitSession(activeSession.id, 'below', activePanelId())
        },
        {
          id: 'duplicate',
          group: 'commands',
          label: t('palette.duplicate'),
          icon: Columns2,
          keywords: 'duplicate copy 复制',
          run: () => duplicateSession(activeSession.id, activePanelId())
        },
        {
          id: 'reconnect',
          group: 'commands',
          label: t('palette.reconnect'),
          icon: RotateCw,
          keywords: 'reconnect 重连',
          run: () => reconnectSession(activeSession.id)
        },
        {
          id: 'broadcast',
          group: 'commands',
          label: useBroadcastStore.getState().ids.includes(activeSession.id)
            ? t('tab.broadcastLeave')
            : t('tab.broadcastJoin'),
          icon: Radio,
          keywords: 'broadcast input 广播 输入 同步 多开',
          run: () => {
            const joined = useBroadcastStore.getState().toggle(activeSession.id);
            const count = broadcastCount();
            toast({
              title: joined ? t('broadcast.joinToast', { count }) : t('broadcast.leaveToast'),
              variant: 'success'
            });
          }
        },
        {
          id: 'favorite',
          group: 'commands',
          label: activeSession.favorite
            ? t('palette.unfavoriteCurrent')
            : t('palette.favoriteCurrent'),
          icon: Star,
          keywords: 'favorite star 收藏',
          run: () => toggleFavorite(activeSession.id)
        },
        {
          id: 'macro-record',
          group: 'commands',
          label: recording ? t('palette.macro.stop') : t('palette.macro.start'),
          icon: recording ? CircleStop : Circle,
          keywords: 'macro record 录制 宏',
          run: () => {
            const recorder = useMacroRecorderStore.getState();
            if (recorder.recording) {
              const steps = recorder.stop();
              if (steps.length === 0) {
                toast({ title: t('macro.emptyToast'), variant: 'warning' });
                return;
              }
              void promptText(t('macro.namePrompt'), t('macro.saveLabel')).then((name) => {
                if (name === null) {
                  toast({ title: t('macro.discardedToast'), variant: 'warning' });
                  return;
                }
                useMacroStore.getState().save(name, steps);
                toast({ title: t('macro.savedToast', { name }), variant: 'success' });
              });
            } else {
              recorder.start();
              toast({ title: t('macro.startedToast'), variant: 'success' });
            }
          }
        },
        {
          id: 'close',
          group: 'commands',
          label: t('palette.closeCurrentTab'),
          icon: X,
          keywords: 'close 关闭',
          // Close only the active panel (matching the title bar), not every
          // panel of the session — a session may have SFTP/forward panels
          // with live transfers attached.
          run: () => getApi()?.activePanel?.api.close()
        }
      );

      // Broadcast input has no serial writer, so the toggle would silently do
      // nothing for a serial session.
      if (activeSession.kind === 'serial') {
        const broadcastIndex = commandItems.findIndex((item) => item.id === 'broadcast');
        if (broadcastIndex !== -1) {
          commandItems.splice(broadcastIndex, 1);
        }
      }
    }

    const snippetItems: CommandItem[] = snippets.map((snippet) => ({
      id: `snippet-${snippet.id}`,
      group: 'snippets',
      label: snippet.name,
      hint: snippet.command.split('\n')[0],
      keywords: snippet.command,
      icon: Send,
      run: () => {
        const activePanelId = getApi()?.activePanel?.id;
        if (!activePanelId || !activePanelId.startsWith('panel-')) {
          toast({ title: t('palette.noActiveTerminal'), variant: 'warning' });
          return;
        }
        void runSnippet(snippet);
      }
    }));

    const macroItems: CommandItem[] = macros.map((macro) => ({
      id: `macro-${macro.id}`,
      group: 'macros' as const,
      label: macro.name,
      hint: t('macro.hint', { count: macro.steps.length }),
      keywords: 'macro replay 宏 回放',
      icon: Play,
      run: () => {
        const activePanelId = getApi()?.activePanel?.id;
        if (!activePanelId || !activePanelId.startsWith('panel-')) {
          toast({ title: t('palette.noActiveTerminal'), variant: 'warning' });
          return;
        }
        void replayMacro(activeSessionId ?? '', macro.steps);
      }
    }));

    return [...sessionItems, ...commandItems, ...snippetItems, ...macroItems];
  }, [
    sessions,
    snippets,
    macros,
    recording,
    activeSessionId,
    runSnippet,
    activeSession,
    themeLabel,
    cycle,
    openSession,
    splitSession,
    duplicateSession,
    reconnectSession,
    toggleFavorite,
    openSftpPanel,
    openPortForwardPanel,
    openTransferPanel,
    openQuickConnect,
    getApi,
    t
  ]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) {
      return items;
    }
    return items.filter((item) =>
      `${item.label} ${item.hint ?? ''} ${item.keywords ?? ''}`.toLowerCase().includes(keyword)
    );
  }, [items, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(0);
      previouslyFocusedRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => {
        window.clearTimeout(timer);
        // Returning focus only on close; this cleanup also runs on unmount,
        // when the app window itself is going away.
        const previous = previouslyFocusedRef.current;
        previouslyFocusedRef.current = null;
        if (previous?.isConnected) {
          previous.focus();
        }
      };
    }
  }, [open]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  // Keyboard navigation must keep the highlighted row on screen; the list is
  // taller than its max-h container.
  useEffect(() => {
    if (filtered.length === 0) {
      return;
    }
    itemRefs.current[selected]?.scrollIntoView({ block: 'nearest' });
  }, [selected, filtered]);

  if (!open) {
    return null;
  }

  const execute = (item: CommandItem) => {
    closeCommandPalette();
    item.run();
  };

  return (
    <CommandWindow onClose={closeCommandPalette}>
      <div className="app-dialog-header flex items-center justify-between border-b border-border bg-panel-title px-2 py-1">
        <span id="palette-title" className="app-dialog-title text-xs font-emphasis text-foreground">
          {t('palette.title')}
        </span>
        <button
          type="button"
          onClick={closeCommandPalette}
          className="rounded-sm p-0.5 text-muted hover:bg-surface-hover hover:text-foreground"
          aria-label={t('palette.close')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="relative border-b border-border">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              if (filtered.length > 0) {
                setSelected((current) => Math.min(filtered.length - 1, current + 1));
              }
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setSelected((current) => Math.max(0, current - 1));
            } else if (event.key === 'Home') {
              event.preventDefault();
              setSelected(0);
            } else if (event.key === 'End') {
              event.preventDefault();
              if (filtered.length > 0) {
                setSelected(filtered.length - 1);
              }
            } else if (event.key === 'Enter') {
              event.preventDefault();
              const item = filtered[selected];
              if (item) {
                execute(item);
              }
            } else if (event.key === 'Escape') {
              closeCommandPalette();
            }
          }}
          placeholder={t('palette.searchPlaceholder')}
          aria-label={t('palette.searchLabel')}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-listbox"
          aria-autocomplete="list"
          aria-activedescendant={filtered.length > 0 ? `palette-option-${selected}` : undefined}
          className="h-8 w-full bg-transparent pl-8 pr-3 text-xs text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>

      <div
        id="palette-listbox"
        role="listbox"
        aria-label={t('palette.searchLabel')}
        className="max-h-80 overflow-y-auto p-1"
      >
        {filtered.length === 0 ? (
          <p className="px-2 py-6 text-center text-meta text-muted">{t('palette.noResults')}</p>
        ) : (
          filtered.map((item, index) => {
            const Icon = item.icon;
            const showGroup = index === 0 || filtered[index - 1].group !== item.group;
            return (
              <div key={item.id} role="presentation">
                {showGroup ? (
                  <div
                    role="presentation"
                    className="px-2 pb-0.5 pt-1 text-tiny font-emphasis text-muted-foreground"
                  >
                    {t(GROUP_LABEL_KEY[item.group])}
                  </div>
                ) : null}
                <button
                  ref={(element) => {
                    itemRefs.current[index] = element;
                  }}
                  type="button"
                  id={`palette-option-${index}`}
                  role="option"
                  aria-selected={index === selected}
                  tabIndex={-1}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => execute(item)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-xs',
                    index === selected
                      ? 'bg-accent text-accent-foreground'
                      : 'text-foreground hover:bg-surface-hover'
                  )}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint ? (
                    <span
                      className={cn(
                        'shrink-0 text-tiny',
                        index === selected ? 'opacity-80' : 'text-muted'
                      )}
                    >
                      {item.hint}
                    </span>
                  ) : null}
                </button>
              </div>
            );
          })
        )}
      </div>

      <div className="app-dialog-footer flex items-center justify-end gap-2 border-t border-border bg-background-alt px-2 py-1 text-tiny text-muted">
        <span className="inline-flex items-center gap-1">
          <CornerDownLeft className="h-3 w-3" /> {t('palette.run')}
        </span>
        <span>{t('palette.navigate')}</span>
        <span>{t('palette.closeHint')}</span>
      </div>
    </CommandWindow>
  );
}
