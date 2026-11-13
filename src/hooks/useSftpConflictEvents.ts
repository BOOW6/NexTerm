import { useEffect } from 'react';
import { tStatic } from '../i18n';
import { listenSftpConflict, respondSftpConflict, type SftpConflictPayload } from './useTauriSsh';
import { openModalWindow } from '../lib/appWindows';

/**
 * Shows the conflict dialog (a native modal window) for every `sftp-conflict`
 * event, one at a time, and forwards the user's decision to the backend.
 * Mounted once in the main window next to the other transfer event hooks.
 */
export function useSftpConflictEvents(): void {
  useEffect(() => {
    let cancelled = false;
    const queue: SftpConflictPayload[] = [];
    let processing = false;
    let unlisten: (() => void) | undefined;

    const drain = async () => {
      if (processing) {
        return;
      }
      processing = true;
      while (queue.length > 0 && !cancelled) {
        const payload = queue.shift();
        if (!payload) {
          break;
        }

        const response = await openModalWindow<string>('sftp-conflict', {
          title: tStatic('conflict.existsToast'),
          width: 440,
          height: 320,
          data: {
            direction: payload.direction,
            name: payload.name,
            source_size: payload.source_size,
            source_mtime: payload.source_mtime,
            target_size: payload.target_size,
            target_mtime: payload.target_mtime
          }
        });
        if (cancelled) {
          break;
        }

        // A failed/unanswered dialog cancels the transfer instead of leaving
        // the backend task waiting forever.
        let action: 'overwrite' | 'skip' | 'rename' | 'cancel' = 'cancel';
        let applyToAll = false;
        if (response) {
          try {
            const parsed = JSON.parse(response) as { action?: string; applyToAll?: boolean };
            if (
              parsed.action === 'overwrite' ||
              parsed.action === 'skip' ||
              parsed.action === 'rename' ||
              parsed.action === 'cancel'
            ) {
              action = parsed.action;
            }
            applyToAll = Boolean(parsed.applyToAll);
          } catch {
            /* keep cancel */
          }
        }

        try {
          await respondSftpConflict(payload.request_id, action, applyToAll);
        } catch {
          /* backend pending entry already gone; nothing to answer */
        }
      }
      processing = false;
    };

    listenSftpConflict((payload) => {
      queue.push(payload);
      void drain();
    })
      .then((dispose) => {
        if (cancelled) {
          dispose();
        } else {
          unlisten = dispose;
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
