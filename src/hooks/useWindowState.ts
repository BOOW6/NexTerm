import { useEffect } from 'react';
import { availableMonitors, getCurrentWindow, primaryMonitor } from '@tauri-apps/api/window';
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

    /**
     * Restore the saved origin, but never leave the window on a monitor that
     * no longer exists (a disconnected external display): fall back to the
     * primary monitor's work area.
     */
    const restorePosition = async (position: PhysicalPosition, size: PhysicalSize) => {
      try {
        const monitors = await availableMonitors();
        const onScreen = monitors.some((monitor) => {
          const area = monitor.workArea ?? { position: monitor.position, size: monitor.size };
          return (
            position.x < area.position.x + area.size.width &&
            position.x + size.width > area.position.x &&
            position.y < area.position.y + area.size.height &&
            position.y + size.height > area.position.y
          );
        });
        if (onScreen || monitors.length === 0) {
          await appWindow.setPosition(position);
          return;
        }

        const primary = (await primaryMonitor()) ?? monitors[0];
        const area = primary.workArea ?? { position: primary.position, size: primary.size };
        const x = area.position.x + Math.max(0, Math.round((area.size.width - size.width) / 2));
        const y = area.position.y + Math.max(0, Math.round((area.size.height - size.height) / 2));
        await appWindow.setPosition(new PhysicalPosition(x, y));
      } catch {
        // Monitor APIs unavailable (permission/backend): keep the saved spot.
        await appWindow.setPosition(position).catch(() => undefined);
      }
    };

    const restore = async () => {
      try {
        const saved = window.localStorage.getItem(storageKey);
        if (saved) {
          const state = JSON.parse(saved) as SavedWindowState;
          if (state.width >= 640 && state.height >= 400) {
            const size = new PhysicalSize(state.width, state.height);
            await appWindow.setSize(size);
            await restorePosition(new PhysicalPosition(state.x, state.y), size);
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
