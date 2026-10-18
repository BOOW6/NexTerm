import { ArrowDown, ArrowUp, CheckCircle2, Trash2, X, XCircle } from 'lucide-react';
import { useTransferStore, type TransferStatus } from '../../stores/transferStore';
import { Button } from '../ui/button';
import { Tooltip } from '../ui/tooltip';
import { cn } from '../../lib/cn';
import { formatBytes, formatSpeed } from '../../lib/format';

const statusText: Record<TransferStatus, string> = {
  running: '进行中',
  done: '已完成',
  error: '失败'
};

export default function TransferPanel() {
  const transfers = useTransferStore((state) => state.transfers);
  const clearFinished = useTransferStore((state) => state.clearFinished);
  const remove = useTransferStore((state) => state.remove);

  const hasFinished = transfers.some((item) => item.status !== 'running');

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-border px-1">
        <span className="px-1 text-[11px] text-muted">{transfers.length} 个任务</span>
        <Tooltip label="清理已完成">
          <Button
            size="sm"
            variant="ghost"
            className="h-5 px-1.5 text-[10px]"
            disabled={!hasFinished}
            onClick={clearFinished}
          >
            <Trash2 className="h-3 w-3" />
            清理
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
                item.status === 'done' ? CheckCircle2 : item.status === 'error' ? XCircle : null;

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
                          item.status === 'done' ? 'text-success' : 'text-error'
                        )}
                      />
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
                        item.status === 'error' ? 'bg-error' : 'bg-accent'
                      )}
                      style={{ width: `${percent}%` }}
                    />
                  </div>

                  <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted">
                    <span className="tabular-nums">
                      {formatBytes(item.transferred)} /{' '}
                      {item.total ? formatBytes(item.total) : '—'}
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
