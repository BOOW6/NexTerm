/**
 * Opt-in resize diagnostics. Enable with
 * `localStorage.setItem('nexterm.debug.resize', '1')` in the webview and
 * reload. The flag is cached after the first read; it is a debugging aid, not
 * a user setting.
 */
const STORAGE_KEY = 'nexterm.debug.resize';

let cached: boolean | null = null;

export function resizeDebugEnabled(): boolean {
  if (cached === null) {
    try {
      cached = window.localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      cached = false;
    }
  }
  return cached;
}

export function logResizeDebug(label: string, data?: Record<string, unknown>): void {
  if (!resizeDebugEnabled()) {
    return;
  }
  console.debug(`[terminal-resize] ${label}`, data ?? {});
}
