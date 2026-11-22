import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ask, message } from '@tauri-apps/plugin-dialog';
import { tStatic } from '../i18n';
import { localizeBackendError } from './backendErrors';
import { appVersion } from './appInfo';
import { toast } from '../components/ui/toastStore';

export type AppWindowKind =
  'main' | 'settings' | 'quick-connect' | 'host-key' | 'prompt' | 'sftp-conflict';

export interface ModalWindowOptions {
  title: string;
  width: number;
  height: number;
  data: unknown;
}

export function currentWindowKind(): AppWindowKind {
  const value = new URLSearchParams(window.location.search).get('window');
  if (
    value === 'settings' ||
    value === 'quick-connect' ||
    value === 'host-key' ||
    value === 'prompt' ||
    value === 'sftp-conflict'
  ) {
    return value;
  }
  return 'main';
}

export function currentModalId(): string | null {
  return new URLSearchParams(window.location.search).get('id');
}

/** Outcome of opening a modal window. The backend resolves a cancelled or
 * closed dialog to `Ok(null)`, so `value === null` reliably means "the user
 * dismissed it"; a rejected invoke is a window-creation failure the caller
 * should surface instead of treating it as a dismissal. */
export type ModalOutcome<T> =
  { ok: true; value: T | null } | { ok: false; reason: 'error'; message: string };

export async function openModalWindow<T>(
  kind: Exclude<AppWindowKind, 'main' | 'settings'>,
  options: ModalWindowOptions
): Promise<ModalOutcome<T>> {
  try {
    const result = await invoke<T | null>('open_modal_window', {
      kind,
      title: options.title,
      width: options.width,
      height: options.height,
      data: options.data
    });
    return { ok: true, value: result ?? null };
  } catch (error) {
    return {
      ok: false,
      reason: 'error',
      message: localizeBackendError(typeof error === 'string' ? error : String(error))
    };
  }
}

export async function getModalPayload<T>(): Promise<T | null> {
  const id = currentModalId();
  if (!id) {
    return null;
  }
  try {
    return await invoke<T>('get_modal_payload', { id });
  } catch {
    return null;
  }
}

export async function submitModal(value: unknown): Promise<void> {
  const id = currentModalId();
  if (!id) {
    return;
  }
  try {
    await invoke('submit_modal', { id, value });
  } catch {
    // The backend already dropped this modal (timeout/cancel): a stale window
    // with dead buttons is worse than closing it, so dismiss instead of retry.
    await dismissStaleModal();
  }
}

export async function cancelModal(): Promise<void> {
  const id = currentModalId();
  if (!id) {
    return;
  }
  try {
    await invoke('cancel_modal', { id });
  } catch {
    await dismissStaleModal();
  }
}

async function dismissStaleModal(): Promise<void> {
  try {
    await getCurrentWindow().close();
  } catch {
    /* window already gone */
  }
}

export async function openSettingsWindow(tab?: string): Promise<void> {
  try {
    await invoke('open_settings_window', { tab: tab ?? null });
  } catch {
    /* window creation unavailable */
  }
}

export interface NativeContextMenuItem {
  label: string;
  enabled?: boolean;
  separatorBefore?: boolean;
}

interface ContextMenuSelection {
  requestId: string;
  index: number;
}

let contextMenuListener: Promise<UnlistenFn | null> | null = null;
const pendingContextMenus = new Map<string, (index: number | null) => void>();

function ensureContextMenuListener(): Promise<UnlistenFn | null> {
  if (!contextMenuListener) {
    const created = listen<ContextMenuSelection>('nexterm-context-menu', (event) => {
      const resolve = pendingContextMenus.get(event.payload.requestId);
      if (resolve) {
        pendingContextMenus.delete(event.payload.requestId);
        resolve(event.payload.index);
      }
    });
    const cached = created.catch(() => {
      // A rejected listen must not poison the cache: drop it so the next call retries.
      if (contextMenuListener === cached) {
        contextMenuListener = null;
      }
      return null;
    });
    contextMenuListener = cached;
  }
  return contextMenuListener;
}

export async function showNativeContextMenu(
  items: NativeContextMenuItem[]
): Promise<number | null> {
  if (!(await ensureContextMenuListener())) {
    return null;
  }

  const requestId = crypto.randomUUID();
  const selection = new Promise<number | null>((resolve) => {
    const timer = window.setTimeout(() => {
      pendingContextMenus.delete(requestId);
      resolve(null);
    }, 60_000);

    pendingContextMenus.set(requestId, (index) => {
      window.clearTimeout(timer);
      resolve(index);
    });
  });

  try {
    await invoke('show_context_menu', {
      requestId,
      items: items.map((item) => ({
        label: item.label,
        enabled: item.enabled ?? true,
        separatorBefore: item.separatorBefore ?? false
      }))
    });
  } catch {
    pendingContextMenus.delete(requestId);
    return null;
  }

  return selection;
}

export async function showInputContextMenu(): Promise<void> {
  await ensureContextMenuListener();
  try {
    await invoke('show_input_context_menu');
  } catch {
    /* menu unavailable */
  }
}

export async function confirmAction(
  text: string,
  options?: { title?: string; okLabel?: string }
): Promise<boolean> {
  try {
    return await ask(text, {
      title: options?.title ?? tStatic('appWindow.confirmTitle'),
      kind: 'warning',
      okLabel: options?.okLabel ?? tStatic('appWindow.ok'),
      cancelLabel: tStatic('appWindow.cancel')
    });
  } catch {
    return false;
  }
}

export async function showAboutDialog(): Promise<void> {
  try {
    const version = await appVersion();
    await message(`NexTerm ${version}\nTauri 2 + React 18 + Rust`, {
      title: tStatic('appWindow.aboutTitle'),
      kind: 'info'
    });
  } catch {
    /* dialog unavailable */
  }
}

/** Generic single-input prompt. Centralizes the window-open error handling:
 * a failed window would otherwise silently skip the caller's action (rename,
 * mkdir, vault unlock) with no feedback at all. */
export async function promptText(
  label: string,
  confirmLabel: string,
  options?: {
    title?: string;
    initialValue?: string;
    placeholder?: string;
    password?: boolean;
    width?: number;
    height?: number;
  }
): Promise<string | null> {
  const outcome = await openModalWindow<string>('prompt', {
    title: options?.title ?? label,
    width: options?.width ?? 420,
    height: options?.height ?? 200,
    data: {
      title: label,
      label,
      initialValue: options?.initialValue ?? '',
      placeholder: options?.placeholder ?? label,
      confirmLabel,
      password: options?.password ?? false
    }
  });
  if (!outcome.ok) {
    toast({
      title: tStatic('appWindow.promptOpenFailed'),
      description: outcome.message,
      variant: 'error'
    });
    return null;
  }
  return outcome.value;
}
