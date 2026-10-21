import { useCallback, useEffect, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { Network, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  listPortForwards,
  listenPortForwardsChanged,
  startPortForward,
  stopPortForward,
  type PortForwardInfo,
  type PortForwardKind
} from '../../hooks/useTauriSsh';
import { useConnectionStore } from '../../stores/connectionStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { Button } from '../ui/button';
import { Input, Label } from '../ui/input';
import { Select } from '../ui/select';
import { toast } from '../ui/toast';

const KIND_LABEL: Record<PortForwardKind, string> = {
  local: '本地转发',
  remote: '远程转发',
  dynamic: '动态 SOCKS5'
};

const KIND_HINT: Record<PortForwardKind, string> = {
  local: '将本机端口转发到 SSH 服务器可访问的目标地址。',
  remote: '在服务器上监听端口，转发回本机可访问的目标地址。',
  dynamic: '在本机启动 SOCKS5 代理，经 SSH 服务器访问任意目标。'
};

export default function PortForwardPanel({ params, api }: IDockviewPanelProps) {
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId);
  const sessions = useSessionStore((state) => state.sessions);
  const initialSessionId =
    (params as { sessionId?: string } | undefined)?.sessionId ?? activeSessionId ?? undefined;

  const [boundSessionId, setBoundSessionId] = useState<string | undefined>(initialSessionId);
  const remoteSessions = sessions.filter((item) => item.kind !== 'local');
  const session = sessions.find((item) => item.id === boundSessionId);
  const sessionTitle = session?.title;
  const connection = useConnectionStore((state) =>
    boundSessionId ? state.connections[boundSessionId] : undefined
  );
  const sshId = connection?.status === 'connected' ? connection.sshId : undefined;

  const [forwards, setForwards] = useState<PortForwardInfo[]>([]);
  const [kind, setKind] = useState<PortForwardKind>('local');
  const [bindHost, setBindHost] = useState('127.0.0.1');
  const [bindPort, setBindPort] = useState('8080');
  const [targetHost, setTargetHost] = useState('127.0.0.1');
  const [targetPort, setTargetPort] = useState('80');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setForwards(await listPortForwards());
    } catch {
      /* backend unavailable */
    }
  }, []);

  useEffect(() => {
    void refresh();
    let cancelled = false;
    let dispose: (() => void) | undefined;

    listenPortForwardsChanged(() => void refresh())
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
        } else {
          dispose = unlisten;
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [refresh]);

  useEffect(() => {
    if (boundSessionId && !sessions.some((item) => item.id === boundSessionId)) {
      setBoundSessionId(undefined);
    } else if (!boundSessionId && activeSessionId) {
      setBoundSessionId(activeSessionId);
    }
  }, [activeSessionId, boundSessionId, sessions]);

  useEffect(() => {
    void api.setTitle(sessionTitle ? `端口转发 · ${sessionTitle}` : '端口转发');
  }, [api, sessionTitle]);

  const visibleForwards = sshId ? forwards.filter((forward) => forward.ssh_id === sshId) : forwards;

  const handleStart = async () => {
    if (!sshId) {
      toast({ title: '请先连接一个 SSH 会话', variant: 'error' });
      return;
    }

    const bind = Number(bindPort);
    const target = Number(targetPort);
    if (!Number.isInteger(bind) || bind < 0 || bind > 65535) {
      toast({ title: '监听端口无效', variant: 'error' });
      return;
    }
    if (kind !== 'dynamic' && (!targetHost.trim() || !Number.isInteger(target) || target <= 0)) {
      toast({ title: '目标地址无效', variant: 'error' });
      return;
    }

    setBusy(true);
    try {
      const info = await startPortForward({
        sshId,
        kind,
        bindHost,
        bindPort: bind,
        targetHost: kind === 'dynamic' ? '' : targetHost,
        targetPort: kind === 'dynamic' ? 0 : target
      });
      await refresh();
      toast({
        title: `${KIND_LABEL[kind]}已启动`,
        description: `${info.bind_host}:${info.bind_port}`,
        variant: 'success'
      });
    } catch (reason) {
      toast({ title: '启动端口转发失败', description: String(reason), variant: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async (id: string) => {
    try {
      await stopPortForward(id);
      await refresh();
      toast({ title: '端口转发已停止', variant: 'success' });
    } catch (reason) {
      toast({ title: '停止端口转发失败', description: String(reason), variant: 'error' });
    }
  };

  const isDynamic = kind === 'dynamic';

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border px-1">
        <Select
          aria-label="SSH 会话"
          value={boundSessionId ?? ''}
          onChange={(event) => setBoundSessionId(event.target.value || undefined)}
          size="sm"
          width={144}
          className="shrink-0"
        >
          <option value="">选择会话</option>
          {remoteSessions.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </Select>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted">
          {sshId
            ? `SSH 连接已就绪 · ${visibleForwards.length} 条规则`
            : session
              ? '该会话尚未建立 SSH 连接'
              : '请选择 SSH 会话'}
        </span>
        <Button size="icon-sm" variant="ghost" aria-label="刷新" onClick={() => void refresh()}>
          <RefreshCw className="h-3 w-3" />
        </Button>
      </div>

      <div className="border-b border-border bg-background-alt p-2">
        <div className="grid grid-cols-[104px_1fr_76px] gap-2">
          <div>
            <Label htmlFor="forward-kind">类型</Label>
            <Select
              id="forward-kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as PortForwardKind)}
              size="sm"
            >
              <option value="local">{KIND_LABEL.local}</option>
              <option value="remote">{KIND_LABEL.remote}</option>
              <option value="dynamic">{KIND_LABEL.dynamic}</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="forward-bind-host">
              {kind === 'remote' ? '远程监听地址' : '监听地址'}
            </Label>
            <Input
              id="forward-bind-host"
              size="sm"
              value={bindHost}
              onChange={(event) => setBindHost(event.target.value)}
              placeholder="127.0.0.1"
            />
          </div>
          <div>
            <Label htmlFor="forward-bind-port">端口</Label>
            <Input
              id="forward-bind-port"
              size="sm"
              value={bindPort}
              onChange={(event) => setBindPort(event.target.value.replace(/[^0-9]/g, ''))}
              placeholder="0"
              inputMode="numeric"
            />
          </div>
        </div>

        <div className="mt-2 grid grid-cols-[1fr_76px_84px] gap-2">
          <div>
            <Label htmlFor="forward-target-host">目标地址</Label>
            <Input
              id="forward-target-host"
              size="sm"
              value={targetHost}
              disabled={isDynamic}
              onChange={(event) => setTargetHost(event.target.value)}
              placeholder={isDynamic ? '由 SOCKS5 请求指定' : '127.0.0.1'}
            />
          </div>
          <div>
            <Label htmlFor="forward-target-port">目标端口</Label>
            <Input
              id="forward-target-port"
              size="sm"
              value={targetPort}
              disabled={isDynamic}
              onChange={(event) => setTargetPort(event.target.value.replace(/[^0-9]/g, ''))}
              placeholder={isDynamic ? '-' : '80'}
              inputMode="numeric"
            />
          </div>
          <div className="flex items-end">
            <Button
              size="sm"
              variant="primary"
              className="w-full"
              disabled={busy || !sshId}
              onClick={() => void handleStart()}
            >
              <Plus className="h-3 w-3" />
              启动
            </Button>
          </div>
        </div>

        <p className="mt-1.5 text-[10px] text-muted">{KIND_HINT[kind]}</p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {visibleForwards.length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-3 py-8 text-center">
            <Network className="h-5 w-5 text-muted" />
            <p className="text-[11px] text-muted">暂无端口转发规则</p>
            <p className="text-[10px] text-muted-foreground">填写上方参数后点击「启动」。</p>
          </div>
        ) : (
          visibleForwards.map((forward) => (
            <div
              key={forward.id}
              className="flex items-center gap-2 border-b border-border-muted/60 px-2 py-1.5"
            >
              <span className="w-16 shrink-0 rounded-sm border border-border bg-background-alt px-1 py-0.5 text-center text-[10px] text-muted">
                {KIND_LABEL[forward.kind]}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                {forward.bind_host}:{forward.bind_port}
                <span className="mx-1 text-muted">→</span>
                {forward.kind === 'dynamic'
                  ? 'SOCKS5'
                  : `${forward.target_host}:${forward.target_port}`}
              </span>
              <button
                type="button"
                onClick={() => void handleStop(forward.id)}
                className="rounded-sm p-1 text-muted hover:bg-surface-hover hover:text-error"
                title="停止转发"
                aria-label="停止转发"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
