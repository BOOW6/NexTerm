import { useEffect } from 'react';
import { matchesShortcut } from '../lib/shortcuts';
import { openSettingsWindow } from '../lib/appWindows';
import { dispatchTerminalAction } from '../lib/terminalCommands';
import { useSettingsStore } from '../stores/settingsStore';
import { useUIStore } from '../stores/uiStore';
import { useWorkspace } from '../features/workspace/WorkspaceContext';
import { useQuickConnectLauncher } from '../features/workspace/useQuickConnectLauncher';

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return Boolean(
    target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')
  );
}

function isTerminalTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('.xterm'));
}

export function useGlobalShortcuts(): void {
  const { getApi } = useWorkspace();
  const openQuickConnect = useQuickConnectLauncher();

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const inTerminal = isTerminalTarget(event.target);
      if (!inTerminal && isEditableTarget(event.target)) {
        return;
      }

      const ui = useUIStore.getState();
      if (ui.commandPaletteOpen) {
        return;
      }

      const shortcuts = useSettingsStore.getState().shortcuts;

      if (!inTerminal) {
        if (matchesShortcut(event, shortcuts.commandPalette)) {
          event.preventDefault();
          ui.openCommandPalette();
          return;
        }
        if (matchesShortcut(event, shortcuts.openSettings)) {
          event.preventDefault();
          void openSettingsWindow();
          return;
        }
        if (matchesShortcut(event, shortcuts.newLocal)) {
          event.preventDefault();
          void openQuickConnect({ kind: 'local' });
          return;
        }
        if (matchesShortcut(event, shortcuts.newSsh)) {
          event.preventDefault();
          void openQuickConnect({ kind: 'ssh' });
          return;
        }
      }

      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'w') {
        event.preventDefault();
        getApi()?.activePanel?.api.close();
        return;
      }

      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        dispatchTerminalAction({ type: 'copy' });
        return;
      }

      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        dispatchTerminalAction({ type: 'paste' });
        return;
      }

      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        dispatchTerminalAction({ type: 'select-all' });
        return;
      }

      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        dispatchTerminalAction({ type: 'find' });
        return;
      }

      if (
        event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key === '=' || event.key === '+')
      ) {
        event.preventDefault();
        dispatchTerminalAction({ type: 'zoom-in' });
        return;
      }

      if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key === '-') {
        event.preventDefault();
        dispatchTerminalAction({ type: 'zoom-out' });
        return;
      }

      if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key === '0') {
        event.preventDefault();
        dispatchTerminalAction({ type: 'zoom-reset' });
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [getApi, openQuickConnect]);
}
