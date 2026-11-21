import { useCallback, useEffect, useRef, useState } from 'react';
import { swallowListenError } from '../../lib/eventListener';
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
import { currentSshId, useConnectionStore } from '../../stores/connectionStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { Button } from '../ui/button';
import { Input, Label } from '../ui/input';
import { Select } from '../ui/select';
import { toast } from '../ui/toastStore';
import { useI18n } from '../../i18n';
import { localizeBackendError } from '../../lib/backendErrors';

const KIND_LABEL: Record<PortForwardKind, string> = {
  local: 'forward.kind.local',
  remote: 'forward.kind.remote',
  dynamic: 'forward.kind.dynamic'
};

const KIND_HINT: Record<PortForwardKind, string> = {
  local: 'forward.hint.local',
  remote: 'forward.hint.remote',
  dynamic: 'forward.hint.dynamic'
};

export default function PortForwardPanel({ params, api }: IDockviewPanelProps) {
  const { t } = useI18n();
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId);
  const sessions = useSessionStore((state) => state.sessions);
  const initialSessionId =
    (params as { sessionId?: string } | undefined)?.sessionId ?? activeSessionId ?? undefined;

  const [boundSessionId, setBoundSessionId] = useState<string | undefined>(initialSessionId);
  // Distinguishes an explicit "选择会话" (unbind) from the initial unbound
  // state so the auto-bind effect does not immediately re-bind.
  const userUnboundRef = useRef(false);
  const remoteSessions = sessions.filter((item) => item.kind !== 'local');
  const session = sessions.find((item) => item.id === boundSessionId);
  const sessionTitle = session?.title;
  const connection = useConnectionStore((state) =>
    boundSessionId ? state.connections[boundSessionId] : undefined
  );
  const sshId = currentSshId(connection);

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
      .catch(swallowListenError);

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [refresh]);

  useEffect(() => {
    if (boundSessionId && !sessions.some((item) => item.id === boundSessionId)) {
      userUnboundRef.current = false;
      setBoundSessionId(undefined);
    } else if (!boundSessionId && activeSessionId && !userUnboundRef.current) {
      setBoundSessionId(activeSessionId);
    }
  }, [activeSessionId, boundSessionId, sessions]);

  useEffect(() => {
    void api.setTitle(
      sessionTitle ? `${t('forward.windowTitle')} · ${sessionTitle}` : t('forward.windowTitle')
    );
  }, [api, sessionTitle, t]);

  // A bound-but-disconnected session shows its own (empty) list; only an
  // explicitly unbound panel shows every session's forwards.
  const visibleForwards = boundSessionId
    ? sshId
      ? forwards.filter((forward) => forward.ssh_id === sshId)
      : []
    : forwards;

  const handleStart = async () => {
    if (!sshId) {
      toast({ title: t('forward.toast.needSession'), variant: 'error' });
      return;
    }

    const bind = Number(bindPort);
    const target = Number(targetPort);
    if (!Number.isInteger(bind) || bind < 0 || bind > 65535) {
      toast({ title: t('forward.toast.invalidBindPort'), variant: 'error' });
      return;
    }
    if (kind !== 'dynamic' && (!targetHost.trim() || !Number.isInteger(target) || target <= 0)) {
      toast({ title: t('forward.toast.invalidTarget'), variant: 'error' });
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
        title: t('forward.toast.started', { kind: t(KIND_LABEL[kind]) }),
        description: `${info.bind_host}:${info.bind_port}`,
        variant: 'success'
      });
    } catch (reason) {
      toast({
        title: t('forward.toast.startFailed'),
        description: localizeBackendError(String(reason)),
        variant: 'error'
      });
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async (id: string) => {
    try {
      await stopPortForward(id);
      await refresh();
      toast({ title: t('forward.toast.stopped'), variant: 'success' });
    } catch (reason) {
      toast({
        title: t('forward.toast.stopFailed'),
        description: localizeBackendError(String(reason)),
        variant: 'error'
      });
    }
  };

  const isDynamic = kind === 'dynamic';

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border px-1">
        <Select
          aria-label={t('forward.tool.sessionSelect')}
          value={boundSessionId ?? ''}
          onChange={(event) => {
            userUnboundRef.current = event.target.value === '';
            setBoundSessionId(event.target.value || undefined);
          }}
          size="sm"
          width={144}
          className="shrink-0"
        >
          <option value="">{t('forward.tool.chooseSession')}</option>
          {remoteSessions.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </Select>
        <span className="min-w-0 flex-1 truncate text-meta text-muted">
          {sshId
            ? t('forward.status.ready', { count: visibleForwards.length })
            : session
              ? t('forward.status.noConnection')
              : t('forward.status.pickSession')}
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t('forward.tool.refresh')}
          onClick={() => void refresh()}
        >
          <RefreshCw className="h-3 w-3" />
        </Button>
      </div>

      <div className="border-b border-border bg-background-alt p-2">
        <div className="grid grid-cols-[104px_1fr_76px] gap-2">
          <div>
            <Label htmlFor="forward-kind">{t('forward.label.kind')}</Label>
            <Select
              id="forward-kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as PortForwardKind)}
              size="sm"
            >
              <option value="local">{t(KIND_LABEL.local)}</option>
              <option value="remote">{t(KIND_LABEL.remote)}</option>
              <option value="dynamic">{t(KIND_LABEL.dynamic)}</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="forward-bind-host">
              {kind === 'remote' ? t('forward.label.remoteBindHost') : t('forward.label.bindHost')}
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
            <Label htmlFor="forward-bind-port">{t('forward.label.port')}</Label>
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
            <Label htmlFor="forward-target-host">{t('forward.label.targetHost')}</Label>
            <Input
              id="forward-target-host"
              size="sm"
              value={targetHost}
              disabled={isDynamic}
              onChange={(event) => setTargetHost(event.target.value)}
              placeholder={isDynamic ? t('forward.placeholder.socksTarget') : '127.0.0.1'}
            />
          </div>
          <div>
            <Label htmlFor="forward-target-port">{t('forward.label.targetPort')}</Label>
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
              {t('forward.action.start')}
            </Button>
          </div>
        </div>

        <p className="mt-1.5 text-tiny text-muted">{t(KIND_HINT[kind])}</p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {visibleForwards.length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-3 py-8 text-center">
            <Network className="h-5 w-5 text-muted" />
            <p className="text-meta text-muted">{t('forward.empty.title')}</p>
            <p className="text-tiny text-muted-foreground">{t('forward.empty.hint')}</p>
          </div>
        ) : (
          visibleForwards.map((forward) => (
            <div
              key={forward.id}
              className="flex items-center gap-2 border-b border-border-muted/60 px-2 py-1.5"
            >
              <span className="w-16 shrink-0 rounded-sm border border-border bg-background-alt px-1 py-0.5 text-center text-tiny text-muted">
                {t(KIND_LABEL[forward.kind])}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-meta text-foreground">
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
                title={t('forward.action.stop')}
                aria-label={t('forward.action.stop')}
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
