import { useEffect } from 'react';
import { swallowListenError } from '../lib/eventListener';
import { tStatic } from '../i18n';
import { toast } from '../components/ui/toastStore';
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

        const outcome = await openModalWindow<string>('sftp-conflict', {
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
          // Teardown raced with an open dialog: cancel this request too, or
          // the transfer waits on a hook that is already unmounted.
          void respondSftpConflict(payload.request_id, 'cancel', false).catch(() => undefined);
          break;
        }
        if (!outcome.ok) {
          // A dialog that never opened would otherwise leave the transfer
          // waiting on an answer nobody can give: cancel it, visibly.
          toast({
            title: tStatic('conflict.dialogOpenFailed'),
            description: outcome.message,
            variant: 'error'
          });
        }

        // A failed/unanswered dialog cancels the transfer instead of leaving
        // the backend task waiting forever.
        let action: 'overwrite' | 'skip' | 'rename' | 'cancel' = 'cancel';
        let applyToAll = false;
        const response = outcome.ok ? outcome.value : null;
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
      .catch(swallowListenError);

    return () => {
      cancelled = true;
      unlisten?.();
      // Requests queued but never dialogued still have a backend task
      // waiting on them: cancel each one so it does not sit in the queue.
      for (const leftover of queue.splice(0)) {
        void respondSftpConflict(leftover.request_id, 'cancel', false).catch(() => undefined);
      }
    };
  }, []);
}
