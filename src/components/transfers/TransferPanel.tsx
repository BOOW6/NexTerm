import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Pause,
  Play,
  RotateCw,
  Trash2,
  X,
  XCircle
} from 'lucide-react';
import { cancelSftpTransfer, pauseSftpTransfer } from '../../hooks/useTauriSsh';
import { retryTransfer } from '../../lib/sftpTransfer';
import {
  INTERRUPTED_MESSAGE_KEY,
  useTransferStore,
  type TransferItem,
  type TransferStatus
} from '../../stores/transferStore';
import { Button } from '../ui/button';
import { Tooltip } from '../ui/tooltip';
import { toast } from '../ui/toastStore';
import { cn } from '../../lib/cn';
import { formatBytes, formatSpeed } from '../../lib/format';
import { useI18n } from '../../i18n';

const statusText: Record<TransferStatus, string> = {
  running: 'transfer.status.running',
  paused: 'transfer.status.paused',
  done: 'transfer.status.done',
  error: 'transfer.status.error',
  cancelled: 'transfer.status.cancelled',
  interrupted: 'transfer.status.interrupted'
};

export default function TransferPanel() {
  const { t } = useI18n();
  const transfers = useTransferStore((state) => state.transfers);
  const clearFinished = useTransferStore((state) => state.clearFinished);
  const remove = useTransferStore((state) => state.remove);
  const setPaused = useTransferStore((state) => state.setPaused);

  const removeItem = async (item: TransferItem) => {
    // Active tasks keep running on the backend: without cancelling first,
    // the next progress event would resurrect the removed entry.
    if (item.status === 'running' || item.status === 'paused' || item.status === 'interrupted') {
      try {
        await cancelSftpTransfer(item.id);
      } catch {
        /* backend entry already gone (e.g. finished transfer) */
      }
    }
    remove(item.id);
  };

  const hasFinished = transfers.some(
    (item) => item.status === 'done' || item.status === 'error' || item.status === 'cancelled'
  );
  const activeCount = transfers.filter(
    (item) => item.status === 'running' || item.status === 'paused'
  ).length;

  const togglePause = async (item: TransferItem) => {
    const paused = !item.paused;
    try {
      await pauseSftpTransfer(item.id, paused);
      setPaused(item.id, paused);
    } catch (reason) {
      toast({
        title: t('transfer.toast.actionFailed'),
        description: String(reason),
        variant: 'error'
      });
    }
  };

  const cancel = async (item: TransferItem) => {
    try {
      await cancelSftpTransfer(item.id);
    } catch (reason) {
      toast({
        title: t('transfer.toast.cancelFailed'),
        description: String(reason),
        variant: 'error'
      });
    }
  };

  const retry = async (item: TransferItem) => {
    try {
      const id = await retryTransfer(item);
      if (id) {
        remove(item.id);
      } else {
        toast({ title: t('transfer.toast.retryMissingParams'), variant: 'error' });
      }
    } catch (reason) {
      toast({
        title: t('transfer.toast.retryFailed'),
        description: String(reason),
        variant: 'error'
      });
    }
  };

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-border px-1">
        <span className="px-1 text-meta text-muted">
          {activeCount > 0 ? t('transfer.summary.activePart', { count: activeCount }) : ''}
          {t('transfer.summary.total', { count: transfers.length })}
        </span>
        <Tooltip label={t('transfer.tool.clearFinished')}>
          <Button size="xs" variant="ghost" disabled={!hasFinished} onClick={clearFinished}>
            <Trash2 className="h-3 w-3" />
            {t('transfer.tool.clear')}
          </Button>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {transfers.length === 0 ? (
          <p className="px-2 py-8 text-center text-meta text-muted">{t('transfer.empty')}</p>
        ) : (
          <div className="space-y-1.5">
            {transfers.map((item) => {
              const percent =
                item.total > 0
                  ? Math.min(100, Math.round((item.transferred / item.total) * 100))
                  : item.status === 'done'
                    ? 100
                    : 0;
              const DirectionIcon = item.direction === 'upload' ? ArrowUp : ArrowDown;
              const StatusIcon =
                item.status === 'done'
                  ? CheckCircle2
                  : item.status === 'interrupted'
                    ? AlertTriangle
                    : item.status === 'error' || item.status === 'cancelled'
                      ? XCircle
                      : item.paused
                        ? Pause
                        : null;
              const canRetry =
                item.status === 'error' ||
                item.status === 'cancelled' ||
                item.status === 'interrupted';

              return (
                <div
                  key={item.id}
                  className="rounded-sm border border-border bg-background-alt p-2"
                >
                  <div className="flex items-center gap-1.5">
                    <DirectionIcon
                      className={cn(
                        'h-3.5 w-3.5 shrink-0',
                        item.direction === 'upload' ? 'text-accent' : 'text-success'
                      )}
                    />
                    <span
                      className="min-w-0 flex-1 truncate text-meta font-medium text-foreground"
                      title={item.name}
                    >
                      {item.name}
                    </span>
                    {StatusIcon ? (
                      <StatusIcon
                        className={cn(
                          'h-3.5 w-3.5 shrink-0',
                          item.status === 'done'
                            ? 'text-success'
                            : item.status === 'interrupted'
                              ? 'text-warning'
                              : item.status === 'cancelled'
                                ? 'text-muted'
                                : 'text-error'
                        )}
                      />
                    ) : null}
                    {item.status === 'running' || item.status === 'paused' ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void togglePause(item)}
                          className="rounded-sm p-0.5 text-muted hover:bg-surface-hover hover:text-foreground"
                          title={
                            item.paused ? t('transfer.action.resume') : t('transfer.action.pause')
                          }
                          aria-label={
                            item.paused
                              ? t('transfer.action.resumeTransfer')
                              : t('transfer.action.pauseTransfer')
                          }
                        >
                          {item.paused ? (
                            <Play className="h-3 w-3" />
                          ) : (
                            <Pause className="h-3 w-3" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => void cancel(item)}
                          className="rounded-sm p-0.5 text-muted hover:bg-surface-hover hover:text-error"
                          title={t('transfer.action.cancel')}
                          aria-label={t('transfer.action.cancelTransfer')}
                        >
                          <XCircle className="h-3 w-3" />
                        </button>
                      </>
                    ) : null}
                    {canRetry ? (
                      <button
                        type="button"
                        onClick={() => void retry(item)}
                        className="rounded-sm p-0.5 text-muted hover:bg-surface-hover hover:text-foreground"
                        title={t('transfer.action.retry')}
                        aria-label={t('transfer.action.retryTransfer')}
                      >
                        <RotateCw className="h-3 w-3" />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void removeItem(item)}
                      className="rounded-sm p-0.5 text-muted hover:bg-surface-hover hover:text-foreground"
                      aria-label={t('transfer.action.remove')}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>

                  <div className="mt-1 h-1.5 overflow-hidden rounded-sm bg-border-muted">
                    <div
                      className={cn(
                        'h-full transition-all',
                        item.status === 'error'
                          ? 'bg-error'
                          : item.status === 'cancelled'
                            ? 'bg-muted'
                            : item.status === 'interrupted' || item.paused
                              ? 'bg-warning'
                              : 'bg-accent'
                      )}
                      style={{ width: `${percent}%` }}
                    />
                  </div>

                  <div className="mt-1 flex items-center justify-between gap-2 text-tiny text-muted">
                    <span className="tabular-nums">
                      {formatBytes(item.transferred)} / {item.total ? formatBytes(item.total) : '-'}
                      {item.filesTotal > 1
                        ? t('transfer.summary.files', {
                            done: item.filesDone,
                            total: item.filesTotal
                          })
                        : ''}
                    </span>
                    <span className="truncate">
                      {t(statusText[item.status])}
                      {item.status === 'running' && item.speed > 0
                        ? ` · ${formatSpeed(item.speed)}`
                        : ''}
                    </span>
                  </div>

                  {item.error ? (
                    <p className="mt-1 truncate text-tiny text-error" title={item.error}>
                      {item.error === INTERRUPTED_MESSAGE_KEY
                        ? t('transfer.interruptedReason')
                        : item.error}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
