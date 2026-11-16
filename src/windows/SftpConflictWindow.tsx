import { useEffect, useState } from 'react';
import { Button } from '../components/ui/button';
import { cancelModal, getModalPayload, submitModal } from '../lib/appWindows';
import { formatBytes } from '../lib/format';
import { useI18n } from '../i18n';
import type { SftpConflictAction } from '../hooks/useTauriSsh';

export interface SftpConflictWindowPayload {
  direction: string;
  name: string;
  source_size: number;
  source_mtime: number;
  target_size: number;
  target_mtime: number;
}

function formatTime(mtime: number): string {
  if (!mtime) {
    return '-';
  }
  return new Date(mtime * 1000).toLocaleString();
}

export default function SftpConflictWindow() {
  const { t } = useI18n();
  const [payload, setPayload] = useState<SftpConflictWindowPayload | null>(null);
  const [applyToAll, setApplyToAll] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getModalPayload<SftpConflictWindowPayload>().then((data) => {
      if (!cancelled && data) {
        setPayload(data);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const respond = async (action: SftpConflictAction) => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await submitModal(JSON.stringify({ action, applyToAll }));
    } catch {
      setBusy(false);
    }
  };

  const upload = payload?.direction !== 'download';
  const sourceLabel = upload ? t('conflict.label.source') : t('conflict.label.sourceRemote');
  const targetLabel = upload ? t('conflict.label.targetRemote') : t('conflict.label.targetLocal');

  return (
    <div className="app-dialog-window flex h-full flex-col bg-background text-foreground">
      <div className="flex-1 px-5 py-4">
        <p className="text-sm font-medium">{t('conflict.existsToast')}</p>
        <p className="mt-1 truncate text-meta text-muted" title={payload?.name}>
          {payload?.name ?? '-'}
        </p>

        <div className="mt-3 rounded-sm border border-border text-meta">
          <div className="flex border-b border-border bg-background-alt">
            <span className="w-24 shrink-0 px-2 py-1.5" />
            <span className="flex-1 px-2 py-1.5 text-muted">{t('conflict.header.size')}</span>
            <span className="flex-1 px-2 py-1.5 text-muted">{t('conflict.header.mtime')}</span>
          </div>
          <div className="flex border-b border-border">
            <span className="w-24 shrink-0 px-2 py-1.5 text-muted">{sourceLabel}</span>
            <span className="flex-1 px-2 py-1.5 tabular-nums">
              {formatBytes(payload?.source_size ?? 0)}
            </span>
            <span className="flex-1 px-2 py-1.5 tabular-nums">
              {formatTime(payload?.source_mtime ?? 0)}
            </span>
          </div>
          <div className="flex">
            <span className="w-24 shrink-0 px-2 py-1.5 text-muted">{targetLabel}</span>
            <span className="flex-1 px-2 py-1.5 tabular-nums">
              {formatBytes(payload?.target_size ?? 0)}
            </span>
            <span className="flex-1 px-2 py-1.5 tabular-nums">
              {formatTime(payload?.target_mtime ?? 0)}
            </span>
          </div>
        </div>

        <label className="mt-3 flex cursor-pointer items-center gap-2 text-meta text-muted">
          <input
            type="checkbox"
            className="h-3.5 w-3.5"
            checked={applyToAll}
            onChange={(event) => setApplyToAll(event.target.checked)}
          />
          {t('conflict.applyToAll')}
        </label>
      </div>

      <div className="app-dialog-footer flex items-center justify-between gap-2 border-t border-border bg-background-alt px-5 py-3">
        <Button variant="ghost" disabled={busy} onClick={() => void cancelModal()}>
          {t('conflict.action.cancelTransfer')}
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="ghost" disabled={busy} onClick={() => void respond('rename')}>
            {t('conflict.action.rename')}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => void respond('skip')}>
            {t('conflict.action.skip')}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void respond('overwrite')}>
            {t('conflict.action.overwrite')}
          </Button>
        </div>
      </div>
    </div>
  );
}
