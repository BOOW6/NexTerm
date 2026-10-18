import { useEffect } from 'react';
import { showInputContextMenu } from '../lib/appWindows';

export function useContextMenuPolicy(): void {
  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      const target = event.target;

      if (target instanceof Element && target.closest('[data-native-context-menu]')) {
        return;
      }

      event.preventDefault();

      if (
        target instanceof Element &&
        target.closest(
          'input, textarea, select, [contenteditable="true"], .selectable'
        )
      ) {
        void showInputContextMenu();
      }
    };

    document.addEventListener('contextmenu', onContextMenu);
    return () => document.removeEventListener('contextmenu', onContextMenu);
  }, []);
}
