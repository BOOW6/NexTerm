import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { ask, message } from '@tauri-apps/plugin-dialog';

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

export async function openModalWindow<T>(
  kind: Exclude<AppWindowKind, 'main' | 'settings'>,
  options: ModalWindowOptions
): Promise<T | null> {
  try {
    const result = await invoke<T | null>('open_modal_window', {
      kind,
      title: options.title,
      width: options.width,
      height: options.height,
      data: options.data
    });
    return result ?? null;
  } catch {
    return null;
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
  await invoke('submit_modal', { id, value });
}

export async function cancelModal(): Promise<void> {
  const id = currentModalId();
  if (!id) {
    return;
  }
  await invoke('cancel_modal', { id });
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

let contextMenuListener: Promise<UnlistenFn> | null = null;
const pendingContextMenus = new Map<string, (index: number | null) => void>();

function ensureContextMenuListener(): Promise<UnlistenFn> {
  if (!contextMenuListener) {
    contextMenuListener = listen<ContextMenuSelection>('nexterm-context-menu', (event) => {
      const resolve = pendingContextMenus.get(event.payload.requestId);
      if (resolve) {
        pendingContextMenus.delete(event.payload.requestId);
        resolve(event.payload.index);
      }
    });
  }
  return contextMenuListener;
}

export async function showNativeContextMenu(
  items: NativeContextMenuItem[]
): Promise<number | null> {
  await ensureContextMenuListener();

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
      title: options?.title ?? '确认',
      kind: 'warning',
      okLabel: options?.okLabel ?? '确定',
      cancelLabel: '取消'
    });
  } catch {
    return false;
  }
}

export async function showAboutDialog(): Promise<void> {
  try {
    await message('NexTerm 0.1.0\nTauri 2 + React 18 + Rust', {
      title: '关于 NexTerm',
      kind: 'info'
    });
  } catch {
    /* dialog unavailable */
  }
}
