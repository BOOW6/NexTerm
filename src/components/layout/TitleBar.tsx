import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Check } from 'lucide-react';
import { cn } from '../../lib/cn';
import {
  openSettingsWindow,
  showAboutDialog
} from '../../lib/appWindows';
import { dispatchTerminalAction } from '../../lib/terminalCommands';
import { useWorkspace } from '../../features/workspace/WorkspaceContext';
import { useQuickConnectLauncher } from '../../features/workspace/useQuickConnectLauncher';
import { closeOtherPanels } from '../../features/workspace/sessionActions';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUIStore } from '../../stores/uiStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useTheme, type ThemeMode } from '../../theme/ThemeProvider';

type MenuEntry =
  | { separator: true }
  | {
      separator?: false;
      label: string;
      shortcut?: string;
      disabled?: boolean;
      checked?: boolean;
      danger?: boolean;
      onSelect: () => void;
    };

interface MenuDefinition {
  label: string;
  items: MenuEntry[];
}

const isMac =
  typeof navigator !== 'undefined' &&
  /Mac/i.test(navigator.userAgent) &&
  !/iPhone|iPad/i.test(navigator.userAgent);

function MenuSeparator() {
  return <div className="my-1 h-px bg-border" role="separator" />;
}

function MenuRow({
  label,
  shortcut,
  disabled,
  checked,
  danger,
  onSelect
}: Exclude<MenuEntry, { separator: true }>) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-xs outline-none',
        'disabled:pointer-events-none disabled:opacity-40',
        danger
          ? 'text-error hover:bg-error hover:text-white focus:bg-error focus:text-white'
          : 'text-foreground hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground'
      )}
    >
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        {checked ? <Check className="h-3.5 w-3.5" /> : null}
      </span>
      <span className="flex-1 whitespace-nowrap">{label}</span>
      {shortcut ? (
        <span className="ml-6 shrink-0 text-[10px] opacity-65">{shortcut}</span>
      ) : null}
    </button>
  );
}

export default function TitleBar() {
  const [openMenu, setOpenMenu] = useState<number | null>(null);
  const menuBarRef = useRef<HTMLDivElement>(null);
  const menuButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const { getApi, openSftpPanel, openTransferPanel, splitSession, duplicateSession, reconnectSession } =
    useWorkspace();
  const openQuickConnect = useQuickConnectLauncher();

  const sessions = useSessionStore((state) => state.sessions);
  const toggleFavorite = useSessionStore((state) => state.toggleFavorite);
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId);
  const sidebarVisible = useWorkspaceStore((state) => state.sidebarVisible);
  const toggleSidebar = useWorkspaceStore((state) => state.toggleSidebar);
  const openCommandPalette = useUIStore((state) => state.openCommandPalette);
  const shortcuts = useSettingsStore((state) => state.shortcuts);
  const { mode, setMode, lightThemeName, darkThemeName } = useTheme();

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const activePanel = getApi()?.activePanel;

  const closeCurrentTab = () => getApi()?.activePanel?.api.close();
  const closeOthers = () => {
    const api = getApi();
    if (api?.activePanel) {
      closeOtherPanels(api, api.activePanel.id);
    }
  };

  const themeItem = (value: ThemeMode, label: string): MenuEntry => ({
    label,
    checked: mode === value,
    onSelect: () => setMode(value)
  });

  const menus: MenuDefinition[] = [
    {
      label: '文件',
      items: [
        {
          label: '新建本地终端',
          shortcut: shortcuts.newLocal,
          onSelect: () => void openQuickConnect({ kind: 'local' })
        },
        {
          label: '新建 SSH 会话',
          shortcut: shortcuts.newSsh,
          onSelect: () => void openQuickConnect({ kind: 'ssh' })
        },
        { label: '打开 SFTP 面板', onSelect: () => openSftpPanel() },
        { label: '传输队列', onSelect: () => openTransferPanel() },
        { separator: true },
        { label: '关闭标签页', shortcut: 'Ctrl+Shift+W', disabled: !activePanel, onSelect: closeCurrentTab },
        { label: '关闭其他标签页', disabled: !activePanel, onSelect: closeOthers },
        { separator: true },
        {
          label: '设置',
          shortcut: shortcuts.openSettings,
          onSelect: () => void openSettingsWindow()
        },
        { separator: true },
        {
          label: '退出 NexTerm',
          shortcut: 'Alt+F4',
          onSelect: () => void getCurrentWindow().close()
        }
      ]
    },
    {
      label: '编辑',
      items: [
        { label: '复制', shortcut: 'Ctrl+Shift+C', onSelect: () => dispatchTerminalAction('copy') },
        { label: '粘贴', shortcut: 'Ctrl+Shift+V', onSelect: () => dispatchTerminalAction('paste') },
        {
          label: '全选',
          shortcut: 'Ctrl+Shift+A',
          onSelect: () => dispatchTerminalAction('select-all')
        },
        { label: '查找', shortcut: 'Ctrl+Shift+F', onSelect: () => dispatchTerminalAction('find') },
        { separator: true },
        { label: '清屏', onSelect: () => dispatchTerminalAction('clear') }
      ]
    },
    {
      label: '视图',
      items: [
        {
          label: '放大字号',
          shortcut: 'Ctrl+=',
          onSelect: () => dispatchTerminalAction('zoom-in')
        },
        {
          label: '缩小字号',
          shortcut: 'Ctrl+-',
          onSelect: () => dispatchTerminalAction('zoom-out')
        },
        {
          label: '重置字号',
          shortcut: 'Ctrl+0',
          onSelect: () => dispatchTerminalAction('zoom-reset')
        },
        { separator: true },
        {
          label: '显示侧栏',
          checked: sidebarVisible,
          onSelect: toggleSidebar
        },
        { separator: true },
        themeItem('light', `亮色主题 · ${lightThemeName}`),
        themeItem('dark', `暗色主题 · ${darkThemeName}`),
        themeItem('system', '跟随系统'),
        { separator: true },
        {
          label: '命令面板',
          shortcut: shortcuts.commandPalette,
          onSelect: openCommandPalette
        }
      ]
    },
    {
      label: '会话',
      items: [
        {
          label: '向右分屏',
          disabled: !activeSession,
          onSelect: () =>
            activeSession && splitSession(activeSession.id, 'right', getApi()?.activePanel?.id)
        },
        {
          label: '向下分屏',
          disabled: !activeSession,
          onSelect: () =>
            activeSession && splitSession(activeSession.id, 'below', getApi()?.activePanel?.id)
        },
        {
          label: '复制会话',
          disabled: !activeSession,
          onSelect: () =>
            activeSession && duplicateSession(activeSession.id, getApi()?.activePanel?.id)
        },
        { separator: true },
        {
          label: '重连',
          disabled: !activeSession,
          onSelect: () => activeSession && reconnectSession(activeSession.id)
        },
        {
          label: activeSession?.favorite ? '取消收藏' : '收藏',
          disabled: !activeSession,
          onSelect: () => activeSession && toggleFavorite(activeSession.id)
        },
        { separator: true },
        {
          label: '编辑当前会话',
          disabled: !activeSession,
          onSelect: () => activeSession && void openQuickConnect({ sessionId: activeSession.id })
        }
      ]
    },
    {
      label: '帮助',
      items: [
        { label: '已知主机…', onSelect: () => void openSettingsWindow('security') },
        { label: '关于 NexTerm', onSelect: () => void showAboutDialog() }
      ]
    }
  ];

  useEffect(() => {
    if (openMenu === null) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !menuBarRef.current?.contains(target) &&
        !dropdownRef.current?.contains(target)
      ) {
        setOpenMenu(null);
      }
    };
    const onBlur = () => setOpenMenu(null);

    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('blur', onBlur);
    };
  }, [openMenu]);

  useEffect(() => {
    if (openMenu !== null) {
      const timer = window.setTimeout(() => {
        dropdownRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
      }, 0);
      return () => window.clearTimeout(timer);
    }
  }, [openMenu]);

  const focusMenuButton = (index: number) => {
    setOpenMenu(index);
    window.setTimeout(() => menuButtonRefs.current[index]?.focus(), 0);
  };

  const handleMenuBarKeyDown = (event: KeyboardEvent) => {
    if (openMenu === null) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      menuButtonRefs.current[openMenu]?.focus();
      setOpenMenu(null);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusMenuButton((openMenu - 1 + menus.length) % menus.length);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusMenuButton((openMenu + 1) % menus.length);
    }
  };

  const handleDropdownKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      dropdownRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []
    );
    const current = items.indexOf(document.activeElement as HTMLButtonElement);

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(current + 1) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(current - 1 + items.length) % items.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (openMenu !== null) {
        menuButtonRefs.current[openMenu]?.focus();
      }
      setOpenMenu(null);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const next =
        event.key === 'ArrowLeft'
          ? (openMenu! - 1 + menus.length) % menus.length
          : (openMenu! + 1) % menus.length;
      focusMenuButton(next);
    }
  };

  const renderMenu = (menu: MenuDefinition, index: number): ReactNode => (
    <button
      key={menu.label}
      ref={(element) => {
        menuButtonRefs.current[index] = element;
      }}
      type="button"
      aria-haspopup="menu"
      aria-expanded={openMenu === index}
      onMouseEnter={() => {
        if (openMenu !== null) {
          setOpenMenu(index);
        }
      }}
      onClick={() => setOpenMenu((current) => (current === index ? null : index))}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          setOpenMenu(index);
        }
      }}
      className={cn(
        'flex h-full items-center rounded-sm px-2.5 text-xs transition-colors',
        openMenu === index
          ? 'bg-surface-active text-foreground'
          : 'text-foreground/85 hover:bg-surface-hover hover:text-foreground'
      )}
    >
      {menu.label}
    </button>
  );

  const activeMenu = openMenu === null ? null : menus[openMenu];

  return (
    <header
      data-tauri-drag-region
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).dataset.tauriDragRegion !== undefined) {
          void getCurrentWindow().toggleMaximize();
        }
      }}
      className={cn(
        'app-actionbar relative z-40 flex h-8 shrink-0 items-center border-b border-border bg-surface-header text-foreground',
        isMac ? 'pl-20' : 'pl-1 pr-[138px]'
      )}
    >
      <div
        ref={menuBarRef}
        role="menubar"
        aria-label="主菜单"
        onKeyDown={handleMenuBarKeyDown}
        className="flex h-full items-center gap-0.5"
      >
        {menus.map(renderMenu)}
      </div>

      <div data-tauri-drag-region className="h-full min-w-4 flex-1" />

      {activeMenu ? (
        <div
          ref={dropdownRef}
          role="menu"
          aria-label={activeMenu.label}
          onKeyDown={handleDropdownKeyDown}
          className="app-popup absolute left-0 top-full z-50 max-h-[70vh] w-64 animate-zoom-in overflow-y-auto rounded-b-sm border border-border-strong bg-surface-elevated p-0.5 shadow-popup"
          style={{ left: `${(menuButtonRefs.current[openMenu!]?.offsetLeft ?? 0)}px` }}
        >
          {activeMenu.items.map((item, itemIndex) =>
            item.separator ? (
              <MenuSeparator key={`separator-${itemIndex}`} />
            ) : (
              <MenuRow
                key={`${item.label}-${itemIndex}`}
                {...item}
                onSelect={() => {
                  setOpenMenu(null);
                  item.onSelect();
                }}
              />
            )
          )}
        </div>
      ) : null}

    </header>
  );
}
