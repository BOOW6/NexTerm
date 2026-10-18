import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowUpDown,
  Columns2,
  CornerDownLeft,
  FolderTree,
  Plus,
  RotateCw,
  Rows2,
  Search,
  Settings,
  Star,
  SunMoon,
  X,
  Zap,
  type LucideIcon
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { useWorkspace } from '../../features/workspace/WorkspaceContext';
import { useSessionStore } from '../../stores/sessionStore';
import { useUIStore } from '../../stores/uiStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useTheme } from '../../theme/ThemeProvider';
import { openSettingsWindow } from '../../lib/appWindows';
import { useQuickConnectLauncher } from '../../features/workspace/useQuickConnectLauncher';
import { SESSION_KIND_LABEL, sessionSubtitle } from '../../types/session';
import { SESSION_KIND_ICON } from '../../lib/sessionVisuals';

interface CommandItem {
  id: string;
  group: '会话' | '命令';
  label: string;
  hint?: string;
  keywords?: string;
  icon: LucideIcon;
  run: () => void;
}

function CommandWindow({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
      <div
        className="absolute inset-0 animate-fade-in bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative z-10 w-full max-w-lg animate-zoom-in overflow-hidden rounded-md border border-border-strong bg-surface shadow-popup">
        {children}
      </div>
    </div>,
    document.body
  );
}

export default function CommandPalette() {
  const open = useUIStore((state) => state.commandPaletteOpen);
  const closeCommandPalette = useUIStore((state) => state.closeCommandPalette);
  const openQuickConnect = useQuickConnectLauncher();

  const sessions = useSessionStore((state) => state.sessions);
  const toggleFavorite = useSessionStore((state) => state.toggleFavorite);
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId);
  const { resolved, cycle } = useTheme();
  const {
    openSession,
    closeSessionPanel,
    reconnectSession,
    splitSession,
    duplicateSession,
    openSftpPanel,
    openTransferPanel,
    getApi
  } = useWorkspace();

  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);

  const activeSession = sessions.find((session) => session.id === activeSessionId);

  const items = useMemo<CommandItem[]>(() => {
    const sessionItems: CommandItem[] = sessions.map((session) => ({
      id: `session-${session.id}`,
      group: '会话',
      label: session.title,
      hint: `${SESSION_KIND_LABEL[session.kind]} · ${sessionSubtitle(session)}`,
      keywords: `${session.group} ${session.host ?? ''} ${session.username ?? ''}`,
      icon: SESSION_KIND_ICON[session.kind],
      run: () => openSession(session.id)
    }));

    const commandItems: CommandItem[] = [
      {
        id: 'new-local',
        group: '命令',
        label: '新建本地终端',
        icon: Plus,
        keywords: 'local terminal 本地 终端 新建',
        run: () => void openQuickConnect({ kind: 'local' })
      },
      {
        id: 'new-ssh',
        group: '命令',
        label: '新建 SSH 会话',
        icon: Zap,
        keywords: 'ssh remote 远程 新建',
        run: () => void openQuickConnect({ kind: 'ssh' })
      },
      {
        id: 'new-sftp',
        group: '命令',
        label: '新建 SFTP 会话',
        icon: FolderTree,
        keywords: 'sftp 文件 新建',
        run: () => void openQuickConnect({ kind: 'sftp' })
      },
      {
        id: 'open-sftp',
        group: '命令',
        label: '打开 SFTP 面板',
        icon: FolderTree,
        keywords: 'sftp 文件 browser 面板',
        run: () => openSftpPanel()
      },
      {
        id: 'open-transfers',
        group: '命令',
        label: '打开传输队列',
        icon: ArrowUpDown,
        keywords: 'transfer upload download 传输 队列 上传 下载',
        run: () => openTransferPanel()
      },
      {
        id: 'open-settings',
        group: '命令',
        label: '打开设置',
        icon: Settings,
        keywords: 'settings 设置 主题 字体 known hosts 已知主机',
        run: () => void openSettingsWindow()
      },
      {
        id: 'toggle-theme',
        group: '命令',
        label: `切换主题（当前：${resolved === 'dark' ? '暗黑' : '明亮'}）`,
        icon: SunMoon,
        keywords: 'theme 主题 明亮 暗黑 dark light',
        run: () => cycle()
      }
    ];

    if (activeSession) {
      const activePanelId = () => getApi()?.activePanel?.id;

      commandItems.push(
        {
          id: 'split-right',
          group: '命令',
          label: '向右分屏当前会话',
          icon: Columns2,
          keywords: 'split 分屏 右',
          run: () => splitSession(activeSession.id, 'right', activePanelId())
        },
        {
          id: 'split-below',
          group: '命令',
          label: '向下分屏当前会话',
          icon: Rows2,
          keywords: 'split 分屏 下',
          run: () => splitSession(activeSession.id, 'below', activePanelId())
        },
        {
          id: 'duplicate',
          group: '命令',
          label: '复制当前会话',
          icon: Columns2,
          keywords: 'duplicate copy 复制',
          run: () => duplicateSession(activeSession.id, activePanelId())
        },
        {
          id: 'reconnect',
          group: '命令',
          label: '重连当前会话',
          icon: RotateCw,
          keywords: 'reconnect 重连',
          run: () => reconnectSession(activeSession.id)
        },
        {
          id: 'favorite',
          group: '命令',
          label: activeSession.favorite ? '取消收藏当前会话' : '收藏当前会话',
          icon: Star,
          keywords: 'favorite star 收藏',
          run: () => toggleFavorite(activeSession.id)
        },
        {
          id: 'close',
          group: '命令',
          label: '关闭当前标签页',
          icon: X,
          keywords: 'close 关闭',
          run: () => closeSessionPanel(activeSession.id)
        }
      );
    }

    return [...sessionItems, ...commandItems];
  }, [
    sessions,
    activeSession,
    resolved,
    cycle,
    openSession,
    splitSession,
    duplicateSession,
    reconnectSession,
    toggleFavorite,
    closeSessionPanel,
    openSftpPanel,
    openTransferPanel,
    openQuickConnect,
    getApi
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
      const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(timer);
    }
  }, [open]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  if (!open) {
    return null;
  }

  const execute = (item: CommandItem) => {
    closeCommandPalette();
    item.run();
  };

  return (
    <CommandWindow onClose={closeCommandPalette}>
      <div className="flex items-center justify-between border-b border-border bg-panel-title px-2 py-1">
        <span className="text-xs font-semibold text-foreground">命令面板</span>
        <button
          type="button"
          onClick={closeCommandPalette}
          className="rounded-sm p-0.5 text-muted hover:bg-surface-hover hover:text-foreground"
          aria-label="关闭命令面板"
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
              setSelected((current) => Math.min(filtered.length - 1, current + 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setSelected((current) => Math.max(0, current - 1));
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
          placeholder="搜索会话或命令..."
          aria-label="搜索会话或命令"
          className="h-8 w-full bg-transparent pl-8 pr-3 text-xs text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>

      <div className="max-h-80 overflow-y-auto p-1">
        {filtered.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11px] text-muted">没有匹配结果</p>
        ) : (
          filtered.map((item, index) => {
            const Icon = item.icon;
            const showGroup = index === 0 || filtered[index - 1].group !== item.group;
            return (
              <div key={item.id}>
                {showGroup ? (
                  <div className="px-2 pb-0.5 pt-1 text-[10px] font-semibold text-muted-foreground">
                    {item.group}
                  </div>
                ) : null}
                <button
                  type="button"
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
                        'shrink-0 text-[10px]',
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

      <div className="flex items-center justify-end gap-2 border-t border-border bg-background-alt px-2 py-1 text-[10px] text-muted">
        <span className="inline-flex items-center gap-1">
          <CornerDownLeft className="h-3 w-3" /> 执行
        </span>
        <span>↑↓ 选择</span>
        <span>Esc 关闭</span>
      </div>
    </CommandWindow>
  );
}
