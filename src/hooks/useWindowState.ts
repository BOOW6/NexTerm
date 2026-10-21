import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi';

interface SavedWindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

export function useWindowState(storageKey = 'nexterm.window.main.v1'): void {
  useEffect(() => {
    let disposed = false;
    let disposers: Array<() => void> = [];
    let timer: number | null = null;
    let ready = false;

    const appWindow = getCurrentWindow();

    const persist = async () => {
      if (disposed || !ready) {
        return;
      }
      try {
        if (await appWindow.isMaximized()) {
          const saved = window.localStorage.getItem(storageKey);
          if (saved) {
            const parsed = JSON.parse(saved) as SavedWindowState;
            window.localStorage.setItem(storageKey, JSON.stringify({ ...parsed, maximized: true }));
          }
          return;
        }

        const [position, size] = await Promise.all([
          appWindow.outerPosition(),
          appWindow.innerSize()
        ]);
        const state: SavedWindowState = {
          x: position.x,
          y: position.y,
          width: size.width,
          height: size.height,
          maximized: false
        };
        window.localStorage.setItem(storageKey, JSON.stringify(state));
      } catch {
        /* window APIs unavailable */
      }
    };

    const schedulePersist = () => {
      if (!ready) {
        return;
      }
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(() => void persist(), 350);
    };

    const restore = async () => {
      try {
        const saved = window.localStorage.getItem(storageKey);
        if (saved) {
          const state = JSON.parse(saved) as SavedWindowState;
          if (state.width >= 640 && state.height >= 400) {
            await appWindow.setSize(new PhysicalSize(state.width, state.height));
            await appWindow.setPosition(new PhysicalPosition(state.x, state.y));
          }
          if (state.maximized) {
            await appWindow.maximize();
          }
        }
      } catch {
        /* ignore invalid saved state */
      } finally {
        ready = true;
      }
    };

    void restore();

    void appWindow.onResized(schedulePersist).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        disposers.push(unlisten);
      }
    });
    void appWindow.onMoved(schedulePersist).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        disposers.push(unlisten);
      }
    });

    return () => {
      disposed = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      disposers.forEach((dispose) => dispose());
      disposers = [];
    };
  }, [storageKey]);
}
