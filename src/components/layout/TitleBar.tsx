import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Check } from 'lucide-react';
import { cn } from '../../lib/cn';
import { openSettingsWindow } from '../../lib/appWindows';
import { dispatchTerminalAction } from '../../lib/terminalCommands';
import { useWorkspace } from '../../features/workspace/useWorkspace';
import { useQuickConnectLauncher } from '../../features/workspace/useQuickConnectLauncher';
import { closeOtherPanels } from '../../features/workspace/sessionActions';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUIStore } from '../../stores/uiStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useI18n } from '../../i18n';
import { useTheme } from '../../theme/useTheme';
import type { ThemeMode } from '../../theme/ThemeProvider';

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
      {shortcut ? <span className="ml-6 shrink-0 text-tiny opacity-65">{shortcut}</span> : null}
    </button>
  );
}

export default function TitleBar() {
  const { t } = useI18n();
  const [openMenu, setOpenMenu] = useState<number | null>(null);
  const menuBarRef = useRef<HTMLDivElement>(null);
  const menuButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const {
    getApi,
    openSftpPanel,
    openTransferPanel,
    splitSession,
    duplicateSession,
    reconnectSession
  } = useWorkspace();
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
      label: t('menu.file'),
      items: [
        {
          label: t('menu.newLocal'),
          shortcut: shortcuts.newLocal,
          onSelect: () => void openQuickConnect({ kind: 'local' })
        },
        {
          label: t('menu.newSsh'),
          shortcut: shortcuts.newSsh,
          onSelect: () => void openQuickConnect({ kind: 'ssh' })
        },
        { label: t('menu.openSftp'), onSelect: () => openSftpPanel() },
        { label: t('menu.transfers'), onSelect: () => openTransferPanel() },
        { separator: true },
        {
          label: t('menu.closeTab'),
          shortcut: 'Ctrl+Shift+W',
          disabled: !activePanel,
          onSelect: closeCurrentTab
        },
        { label: t('menu.closeOtherTabs'), disabled: !activePanel, onSelect: closeOthers },
        { separator: true },
        {
          label: t('menu.settings'),
          shortcut: shortcuts.openSettings,
          onSelect: () => void openSettingsWindow()
        },
        { separator: true },
        {
          label: t('menu.exit'),
          shortcut: 'Alt+F4',
          onSelect: () => void getCurrentWindow().close()
        }
      ]
    },
    {
      label: t('menu.edit'),
      items: [
        {
          label: t('menu.copy'),
          shortcut: 'Ctrl+Shift+C',
          onSelect: () => dispatchTerminalAction({ type: 'copy' })
        },
        {
          label: t('menu.paste'),
          shortcut: 'Ctrl+Shift+V',
          onSelect: () => dispatchTerminalAction({ type: 'paste' })
        },
        {
          label: t('menu.selectAll'),
          shortcut: 'Ctrl+Shift+A',
          onSelect: () => dispatchTerminalAction({ type: 'select-all' })
        },
        {
          label: t('menu.find'),
          shortcut: 'Ctrl+Shift+F',
          onSelect: () => dispatchTerminalAction({ type: 'find' })
        },
        { separator: true },
        { label: t('menu.clear'), onSelect: () => dispatchTerminalAction({ type: 'clear' }) }
      ]
    },
    {
      label: t('menu.view'),
      items: [
        {
          label: t('menu.zoomIn'),
          shortcut: 'Ctrl+=',
          onSelect: () => dispatchTerminalAction({ type: 'zoom-in' })
        },
        {
          label: t('menu.zoomOut'),
          shortcut: 'Ctrl+-',
          onSelect: () => dispatchTerminalAction({ type: 'zoom-out' })
        },
        {
          label: t('menu.zoomReset'),
          shortcut: 'Ctrl+0',
          onSelect: () => dispatchTerminalAction({ type: 'zoom-reset' })
        },
        { separator: true },
        {
          label: t('menu.toggleSidebar'),
          checked: sidebarVisible,
          onSelect: toggleSidebar
        },
        { separator: true },
        themeItem('light', t('menu.themeLight', { name: lightThemeName })),
        themeItem('dark', t('menu.themeDark', { name: darkThemeName })),
        themeItem('system', t('menu.themeSystem')),
        { separator: true },
        {
          label: t('menu.commandPalette'),
          shortcut: shortcuts.commandPalette,
          onSelect: openCommandPalette
        }
      ]
    },
    {
      label: t('menu.session'),
      items: [
        {
          label: t('menu.splitRight'),
          disabled: !activeSession,
          onSelect: () =>
            activeSession && splitSession(activeSession.id, 'right', getApi()?.activePanel?.id)
        },
        {
          label: t('menu.splitBelow'),
          disabled: !activeSession,
          onSelect: () =>
            activeSession && splitSession(activeSession.id, 'below', getApi()?.activePanel?.id)
        },
        {
          label: t('menu.duplicateSession'),
          disabled: !activeSession,
          onSelect: () =>
            activeSession && duplicateSession(activeSession.id, getApi()?.activePanel?.id)
        },
        { separator: true },
        {
          label: t('menu.reconnect'),
          disabled: !activeSession,
          onSelect: () => activeSession && reconnectSession(activeSession.id)
        },
        {
          label: activeSession?.favorite ? t('menu.unfavorite') : t('menu.favorite'),
          disabled: !activeSession,
          onSelect: () => activeSession && toggleFavorite(activeSession.id)
        },
        { separator: true },
        {
          label: t('menu.editSession'),
          disabled: !activeSession,
          onSelect: () => activeSession && void openQuickConnect({ sessionId: activeSession.id })
        }
      ]
    },
    {
      label: t('menu.help'),
      items: [
        { label: t('menu.knownHosts'), onSelect: () => void openSettingsWindow('security') },
        { label: t('menu.about'), onSelect: () => void openSettingsWindow('about') }
      ]
    }
  ];

  useEffect(() => {
    if (openMenu === null) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuBarRef.current?.contains(target) && !dropdownRef.current?.contains(target)) {
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
        aria-label={t('menu.mainMenu')}
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
          style={{ left: `${menuButtonRefs.current[openMenu!]?.offsetLeft ?? 0}px` }}
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
