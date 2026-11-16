import { useEffect, useState } from 'react';
import { ShieldAlert, ShieldQuestion } from 'lucide-react';
import { Button } from '../components/ui/button';
import { cancelModal, getModalPayload, submitModal } from '../lib/appWindows';
import { useI18n } from '../i18n';
import { listenHostKeyTimeout } from '../hooks/useTauriSsh';
import type { HostKeyMismatchPayload, HostKeyPromptPayload } from '../hooks/useTauriSsh';

type HostKeyPayload =
  | { mode: 'prompt'; prompt: HostKeyPromptPayload }
  | { mode: 'mismatch'; mismatch: HostKeyMismatchPayload };

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-2 text-meta">
      <span className="w-16 shrink-0 text-muted">{label}</span>
      <span className="selectable min-w-0 break-all font-mono text-foreground">{value}</span>
    </div>
  );
}

export default function HostKeyWindow() {
  const { t } = useI18n();
  const [payload, setPayload] = useState<HostKeyPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getModalPayload<HostKeyPayload>().then((data) => {
      if (!cancelled) {
        setPayload(data);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The backend gives up on the fingerprint after 120s and broadcasts the
  // timeout; close this dialog so a late "trust" click can't be silently
  // dropped while the window lingers.
  useEffect(() => {
    if (payload?.mode !== 'prompt') {
      return;
    }
    const requestId = payload.prompt.request_id;
    let disposed = false;
    let dispose: (() => void) | undefined;

    listenHostKeyTimeout((event) => {
      if (event.request_id === requestId) {
        void cancelModal();
      }
    })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          dispose = unlisten;
        }
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      dispose?.();
    };
  }, [payload]);

  if (!payload) {
    return <div className="h-full bg-background" />;
  }

  if (payload.mode === 'mismatch') {
    return (
      <div className="app-dialog-window flex h-full flex-col bg-background text-foreground">
        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <div className="flex items-center gap-2 rounded-sm border border-error/40 bg-error/10 px-2.5 py-2">
            <ShieldAlert className="h-4 w-4 shrink-0 text-error" />
            <span className="text-meta text-error">{t('hostKey.mismatch.warning')}</span>
          </div>
          <Field label={t('hostKey.field.host')} value={payload.mismatch.host} />
          <div className="rounded-sm border border-border bg-background-alt p-2">
            <p className="mb-1 text-tiny text-muted">{t('hostKey.mismatch.savedFingerprint')}</p>
            <p className="selectable break-all font-mono text-meta text-foreground">
              {payload.mismatch.expected}
            </p>
          </div>
          <div className="rounded-sm border border-border bg-background-alt p-2">
            <p className="mb-1 text-tiny text-muted">{t('hostKey.mismatch.currentFingerprint')}</p>
            <p className="selectable break-all font-mono text-meta text-foreground">
              {payload.mismatch.actual}
            </p>
          </div>
          <p className="text-tiny text-muted-foreground">{t('hostKey.mismatch.hint')}</p>
        </div>
        <div className="app-dialog-footer flex justify-end border-t border-border bg-background-alt px-5 py-3">
          <Button variant="secondary" onClick={() => void cancelModal()}>
            {t('hostKey.action.close')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-dialog-window flex h-full flex-col bg-background text-foreground">
      <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
        <div className="flex items-center gap-2 rounded-sm border border-border bg-background-alt px-2.5 py-2">
          <ShieldQuestion className="h-4 w-4 shrink-0 text-warning" />
          <span className="text-meta text-muted">{t('hostKey.prompt.verifyHint')}</span>
        </div>
        <Field
          label={t('hostKey.field.host')}
          value={`${payload.prompt.host}:${payload.prompt.port}`}
        />
        <Field label={t('hostKey.field.algorithm')} value={payload.prompt.algorithm} />
        <div className="rounded-sm border border-border bg-background-alt p-2">
          <p className="mb-1 text-tiny text-muted">{t('hostKey.prompt.fingerprintLabel')}</p>
          <p className="selectable break-all font-mono text-meta text-foreground">
            {payload.prompt.fingerprint}
          </p>
        </div>
        <p className="text-tiny text-muted-foreground">{t('hostKey.prompt.trustHint')}</p>
      </div>
      <div className="app-dialog-footer flex items-center justify-end gap-2 border-t border-border bg-background-alt px-5 py-3">
        <Button variant="ghost" onClick={() => void submitModal(false)}>
          {t('hostKey.action.cancel')}
        </Button>
        <Button variant="primary" onClick={() => void submitModal(true)}>
          {t('hostKey.action.trust')}
        </Button>
      </div>
    </div>
  );
}
