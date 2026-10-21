import {
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
  useTransferStore,
  type TransferItem,
  type TransferStatus
} from '../../stores/transferStore';
import { Button } from '../ui/button';
import { Tooltip } from '../ui/tooltip';
import { toast } from '../ui/toast';
import { cn } from '../../lib/cn';
import { formatBytes, formatSpeed } from '../../lib/format';

const statusText: Record<TransferStatus, string> = {
  running: '传输中',
  paused: '已暂停',
  done: '已完成',
  error: '失败',
  cancelled: '已取消'
};

export default function TransferPanel() {
  const transfers = useTransferStore((state) => state.transfers);
  const clearFinished = useTransferStore((state) => state.clearFinished);
  const remove = useTransferStore((state) => state.remove);
  const setPaused = useTransferStore((state) => state.setPaused);

  const hasFinished = transfers.some(
    (item) => item.status !== 'running' && item.status !== 'paused'
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
      toast({ title: '操作失败', description: String(reason), variant: 'error' });
    }
  };

  const cancel = async (item: TransferItem) => {
    try {
      await cancelSftpTransfer(item.id);
    } catch (reason) {
      toast({ title: '取消失败', description: String(reason), variant: 'error' });
    }
  };

  const retry = async (item: TransferItem) => {
    try {
      const id = await retryTransfer(item);
      if (id) {
        remove(item.id);
      } else {
        toast({ title: '无法重试：缺少传输参数', variant: 'error' });
      }
    } catch (reason) {
      toast({ title: '重试失败', description: String(reason), variant: 'error' });
    }
  };

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-border px-1">
        <span className="px-1 text-[11px] text-muted">
          {activeCount > 0 ? `${activeCount} 个进行中 / ` : ''}
          {transfers.length} 个任务
        </span>
        <Tooltip label="清除已完成任务">
          <Button size="xs" variant="ghost" disabled={!hasFinished} onClick={clearFinished}>
            <Trash2 className="h-3 w-3" />
            清除
          </Button>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {transfers.length === 0 ? (
          <p className="px-2 py-8 text-center text-[11px] text-muted">暂无传输任务</p>
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
                  : item.status === 'error' || item.status === 'cancelled'
                    ? XCircle
                    : item.paused
                      ? Pause
                      : null;
              const canRetry = item.status === 'error' || item.status === 'cancelled';

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
                      className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground"
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
                          title={item.paused ? '继续' : '暂停'}
                          aria-label={item.paused ? '继续传输' : '暂停传输'}
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
                          title="取消"
                          aria-label="取消传输"
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
                        title="重试"
                        aria-label="重试传输"
                      >
                        <RotateCw className="h-3 w-3" />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => remove(item.id)}
                      className="rounded-sm p-0.5 text-muted hover:bg-surface-hover hover:text-foreground"
                      aria-label="移除任务"
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
                            : item.paused
                              ? 'bg-warning'
                              : 'bg-accent'
                      )}
                      style={{ width: `${percent}%` }}
                    />
                  </div>

                  <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted">
                    <span className="tabular-nums">
                      {formatBytes(item.transferred)} / {item.total ? formatBytes(item.total) : '-'}
                      {item.filesTotal > 1 ? ` · ${item.filesDone}/${item.filesTotal} 个文件` : ''}
                    </span>
                    <span className="truncate">
                      {statusText[item.status]}
                      {item.status === 'running' && item.speed > 0
                        ? ` · ${formatSpeed(item.speed)}`
                        : ''}
                    </span>
                  </div>

                  {item.error ? (
                    <p className="mt-1 truncate text-[10px] text-error" title={item.error}>
                      {item.error}
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
