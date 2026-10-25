import { useEffect, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import {
  ArrowUpDown,
  File,
  Folder,
  FolderPlus,
  FolderUp,
  ChevronUp,
  RefreshCw,
  Upload
} from 'lucide-react';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { writeText as writeClipboardText } from '@tauri-apps/plugin-clipboard-manager';
import {
  listSftp,
  listenSftpTransferDone,
  mkdirSftp,
  removeSftp,
  renameSftp,
  type SftpConflictPolicy,
  type SftpEntry
} from '../../hooks/useTauriSsh';
import { startSftpTransfer } from '../../lib/sftpTransfer';
import { currentSshId, useConnectionStore } from '../../stores/connectionStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useTransferStore } from '../../stores/transferStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useWorkspace } from '../../features/workspace/WorkspaceContext';
import { Button } from '../ui/button';
import { Select } from '../ui/select';
import { Tooltip } from '../ui/tooltip';
import { toast } from '../ui/toast';
import { cn } from '../../lib/cn';
import { formatBytes } from '../../lib/format';
import { confirmAction, openModalWindow, showNativeContextMenu } from '../../lib/appWindows';
import type { PromptPayload } from '../../windows/PromptWindow';

function formatTime(mtime: number): string {
  if (!mtime) {
    return '-';
  }
  return new Date(mtime * 1000).toLocaleString('zh-CN', { hour12: false });
}

function formatPermissions(permissions: number | null): string {
  if (permissions === null || permissions === undefined) {
    return '-';
  }
  return (permissions & 0o777).toString(8).padStart(3, '0');
}

function joinRemote(path: string, name: string): string {
  return path.endsWith('/') ? `${path}${name}` : `${path}/${name}`;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? 'file';
}

const CONFLICT_KEY = 'nexterm.sftp.conflict.v1';

function readConflict(): SftpConflictPolicy {
  try {
    const value = window.localStorage.getItem(CONFLICT_KEY);
    if (
      value === 'ask' ||
      value === 'overwrite' ||
      value === 'skip' ||
      value === 'rename' ||
      value === 'newer'
    ) {
      return value;
    }
    return 'ask';
  } catch {
    return 'ask';
  }
}

export default function SFTPPanel({ params, api }: IDockviewPanelProps) {
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId);
  const sessions = useSessionStore((state) => state.sessions);
  const initialSessionId =
    (params as { sessionId?: string } | undefined)?.sessionId ?? activeSessionId ?? undefined;
  const [boundSessionId, setBoundSessionId] = useState<string | undefined>(initialSessionId);
  // Distinguishes an explicit "选择会话" (unbind) from the initial unbound
  // state so the auto-bind effect does not immediately re-bind.
  const userUnboundRef = useRef(false);

  const session = sessions.find((item) => item.id === boundSessionId);
  const connection = useConnectionStore((state) =>
    boundSessionId ? state.connections[boundSessionId] : undefined
  );
  const { openTransferPanel } = useWorkspace();

  const sshId = currentSshId(connection);
  const sessionTitle = session?.title;
  const remoteSessions = sessions.filter((item) => item.kind !== 'local');

  const [path, setPath] = useState('/');
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [conflict, setConflict] = useState<SftpConflictPolicy>(readConflict);

  useEffect(() => {
    try {
      window.localStorage.setItem(CONFLICT_KEY, conflict);
    } catch {
      /* storage unavailable */
    }
  }, [conflict]);

  useEffect(() => {
    setPath('/');
  }, [boundSessionId]);

  useEffect(() => {
    if (boundSessionId && !sessions.some((item) => item.id === boundSessionId)) {
      userUnboundRef.current = false;
      setBoundSessionId(undefined);
    } else if (!boundSessionId && activeSessionId && !userUnboundRef.current) {
      setBoundSessionId(activeSessionId);
    }
  }, [activeSessionId, boundSessionId, sessions]);

  useEffect(() => {
    void api.setTitle(sessionTitle ? `SFTP · ${sessionTitle}` : 'SFTP');
  }, [api, sessionTitle]);

  useEffect(() => {
    if (!sshId) {
      setEntries([]);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    listSftp(sshId, path)
      .then((result) => {
        if (!cancelled) {
          setEntries(result);
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setEntries([]);
          setError(String(reason));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sshId, path, reloadToken]);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;

    listenSftpTransferDone(() => {
      setReloadToken((value) => value + 1);
    })
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
  }, []);

  const goUp = () => {
    if (path === '/') {
      return;
    }
    const parent = path.replace(/\/+$/, '').split('/').slice(0, -1).join('/');
    setPath(parent || '/');
  };

  const openEntry = (entry: SftpEntry) => {
    if (entry.is_dir) {
      setPath(entry.path.startsWith('/') ? entry.path : `${path}/${entry.name}`);
    }
  };

  const handleUpload = async () => {
    if (!sshId || !boundSessionId) {
      return;
    }

    try {
      const selected = await openDialog({
        multiple: true,
        title: '选择要上传的文件'
      });
      if (!selected) {
        return;
      }

      const paths = Array.isArray(selected) ? selected : [selected];
      for (const localPath of paths) {
        await startSftpTransfer({
          sessionId: boundSessionId,
          direction: 'upload',
          name: baseName(localPath),
          localPath,
          remotePath: joinRemote(path, baseName(localPath)),
          conflict
        });
      }

      toast({
        title: `已加入 ${paths.length} 个上传任务`,
        variant: 'success'
      });
      openTransferPanel();
    } catch (reason) {
      toast({
        title: '上传失败',
        description: String(reason),
        variant: 'error'
      });
    }
  };

  const handleUploadFolder = async () => {
    if (!sshId || !boundSessionId) {
      return;
    }

    try {
      const selected = await openDialog({
        multiple: false,
        directory: true,
        title: '选择要上传的文件夹'
      });
      if (typeof selected !== 'string') {
        return;
      }

      const name = baseName(selected);
      await startSftpTransfer({
        sessionId: boundSessionId,
        direction: 'upload',
        name,
        localPath: selected,
        remotePath: joinRemote(path, name),
        recursive: true,
        conflict
      });

      toast({ title: `已加入文件夹「${name}」上传任务`, variant: 'success' });
      openTransferPanel();
    } catch (reason) {
      toast({
        title: '上传失败',
        description: String(reason),
        variant: 'error'
      });
    }
  };

  const handleDownload = async (entry: SftpEntry) => {
    if (!sshId || !boundSessionId) {
      return;
    }

    try {
      if (entry.is_dir) {
        const directory = await openDialog({
          multiple: false,
          directory: true,
          title: '选择下载目录'
        });
        if (typeof directory !== 'string') {
          return;
        }

        await startSftpTransfer({
          sessionId: boundSessionId,
          direction: 'download',
          name: entry.name,
          localPath: `${directory}/${entry.name}`,
          remotePath: entry.path,
          recursive: true,
          conflict
        });
      } else {
        const target = await saveDialog({
          defaultPath: entry.name,
          title: '保存文件'
        });
        if (!target) {
          return;
        }

        await startSftpTransfer({
          sessionId: boundSessionId,
          direction: 'download',
          name: entry.name,
          localPath: target,
          remotePath: entry.path,
          conflict
        });
      }

      toast({ title: '已加入下载任务', variant: 'success' });
      openTransferPanel();
    } catch (reason) {
      toast({
        title: '下载失败',
        description: String(reason),
        variant: 'error'
      });
    }
  };

  const refresh = () => setReloadToken((value) => value + 1);

  const handleCreateFolder = async (name: string) => {
    if (!sshId) {
      return;
    }

    try {
      await mkdirSftp(sshId, joinRemote(path, name));
      refresh();
      toast({ title: `已创建文件夹「${name}」`, variant: 'success' });
    } catch (reason) {
      toast({
        title: '创建文件夹失败',
        description: String(reason),
        variant: 'error'
      });
    }
  };

  const handleRename = async (entry: SftpEntry, name: string) => {
    if (!sshId) {
      return;
    }

    try {
      await renameSftp(sshId, entry.path, joinRemote(path, name));
      refresh();
      toast({ title: '已重命名', variant: 'success' });
    } catch (reason) {
      toast({
        title: '重命名失败',
        description: String(reason),
        variant: 'error'
      });
    }
  };

  const handleDelete = async (entry: SftpEntry) => {
    if (!sshId) {
      return;
    }

    // Deleting a path that is still being written (upload target) or read
    // (download source) silently loses data: on Linux the transfer keeps
    // writing to the unlinked inode and reports success.
    const activeTransfer = useTransferStore.getState().transfers.find((item) => {
      const request = item.request;
      if (!request) {
        return false;
      }
      return (
        (item.status === 'running' || item.status === 'paused') &&
        request.sessionId === boundSessionId &&
        (request.remotePath === entry.path || request.remotePath.startsWith(`${entry.path}/`))
      );
    });
    if (activeTransfer) {
      toast({
        title: '该路径有传输任务进行中',
        description: '请先在传输队列取消相关任务，再删除该文件。',
        variant: 'error'
      });
      return;
    }

    const ok = await confirmAction(`确定删除「${entry.name}」吗？此操作不可撤销。`, {
      title: '删除确认',
      okLabel: '删除'
    });
    if (!ok) {
      return;
    }

    try {
      await removeSftp(sshId, entry.path, entry.is_dir);
      refresh();
      toast({ title: '已删除', variant: 'success' });
    } catch (reason) {
      toast({
        title: '删除失败',
        description: String(reason),
        variant: 'error'
      });
    }
  };

  const promptName = async (mode: 'mkdir' | 'rename', entry?: SftpEntry) => {
    const payload: PromptPayload = {
      title: mode === 'rename' ? '重命名' : '新建文件夹',
      label: mode === 'rename' ? '新名称' : '文件夹名称',
      initialValue: mode === 'rename' ? (entry?.name ?? '') : '',
      confirmLabel: mode === 'rename' ? '重命名' : '创建'
    };
    const value = await openModalWindow<string>('prompt', {
      title: payload.title,
      width: 440,
      height: 230,
      data: payload
    });
    if (!value) {
      return;
    }
    if (mode === 'rename' && entry) {
      await handleRename(entry, value);
    } else {
      await handleCreateFolder(value);
    }
  };

  const openMenu = (entry: SftpEntry) => {
    const actions: Array<{
      label: string;
      separatorBefore?: boolean;
      run?: () => void;
    }> = [];

    if (entry.is_dir) {
      actions.push(
        { label: '进入目录', run: () => openEntry(entry) },
        { label: '下载文件夹', run: () => void handleDownload(entry) }
      );
    } else {
      actions.push({ label: '下载', run: () => void handleDownload(entry) });
    }

    actions.push(
      { label: '重命名', run: () => void promptName('rename', entry) },
      {
        label: '删除',
        separatorBefore: true,
        run: () => void handleDelete(entry)
      },
      {
        label: '复制远程路径',
        separatorBefore: true,
        run: () => {
          void writeClipboardText(entry.path);
          toast({ title: '已复制路径' });
        }
      }
    );

    void showNativeContextMenu(
      actions.map((item) => ({
        label: item.label,
        separatorBefore: item.separatorBefore
      }))
    ).then((index) => {
      if (index !== null) {
        actions[index]?.run?.();
      }
    });
  };

  const canBrowse = Boolean(sshId);

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border px-1">
        <Tooltip label="上级目录">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="上级目录"
            disabled={!canBrowse || path === '/'}
            onClick={goUp}
          >
            <ChevronUp className="h-3 w-3" />
          </Button>
        </Tooltip>
        <Tooltip label="刷新">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="刷新"
            disabled={!canBrowse}
            onClick={() => setReloadToken((value) => value + 1)}
          >
            <RefreshCw className="h-3 w-3" />
          </Button>
        </Tooltip>
        <Select
          aria-label="SFTP 会话"
          value={boundSessionId ?? ''}
          onChange={(event) => {
            userUnboundRef.current = event.target.value === '';
            setBoundSessionId(event.target.value || undefined);
          }}
          size="sm"
          width={128}
          className="shrink-0"
        >
          <option value="">选择会话</option>
          {remoteSessions.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </Select>
        <Select
          aria-label="冲突处理"
          title="目标已存在时的处理方式"
          value={conflict}
          onChange={(event) => setConflict(event.target.value as SftpConflictPolicy)}
          size="sm"
          width={110}
          className="shrink-0"
        >
          <option value="ask">询问</option>
          <option value="overwrite">覆盖</option>
          <option value="skip">跳过</option>
          <option value="rename">重命名</option>
          <option value="newer">较新才覆盖</option>
        </Select>
        <span
          className="selectable min-w-0 flex-1 truncate font-mono text-[11px] text-muted"
          title={path}
        >
          {canBrowse ? path : '-'}
        </span>
        <Tooltip label="新建文件夹">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="新建文件夹"
            disabled={!canBrowse}
            onClick={() => void promptName('mkdir')}
          >
            <FolderPlus className="h-3 w-3" />
          </Button>
        </Tooltip>
        <Tooltip label="上传文件">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="上传文件"
            disabled={!canBrowse}
            onClick={() => void handleUpload()}
          >
            <Upload className="h-3 w-3" />
          </Button>
        </Tooltip>
        <Tooltip label="上传文件夹">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="上传文件夹"
            disabled={!canBrowse}
            onClick={() => void handleUploadFolder()}
          >
            <FolderUp className="h-3 w-3" />
          </Button>
        </Tooltip>
        <Tooltip label="传输队列">
          <Button size="icon-sm" variant="ghost" aria-label="传输队列" onClick={openTransferPanel}>
            <ArrowUpDown className="h-3 w-3" />
          </Button>
        </Tooltip>
      </div>

      <div className="app-table-header grid shrink-0 grid-cols-[1fr_62px_104px_42px] border-b border-border bg-table-header px-2 py-1 text-[11px] font-semibold text-foreground">
        <span>名称</span>
        <span className="text-right">大小</span>
        <span className="text-right">修改时间</span>
        <span className="text-right">权限</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!session ? (
          <p className="px-3 py-6 text-center text-[11px] text-muted">请先在左侧选择一个会话</p>
        ) : session.kind === 'local' ? (
          <p className="px-3 py-6 text-center text-[11px] text-muted">
            本地会话没有 SFTP，请选择 SSH / SFTP 会话
          </p>
        ) : !sshId ? (
          <p className="px-3 py-6 text-center text-[11px] text-muted">
            {connection?.status === 'connecting'
              ? '正在建立 SSH 连接…'
              : 'SSH 尚未连接，请先连接该会话'}
          </p>
        ) : loading ? (
          <p className="px-3 py-6 text-center text-[11px] text-muted">正在加载目录…</p>
        ) : error ? (
          <p className="px-3 py-6 text-center text-[11px] text-error">{error}</p>
        ) : entries.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11px] text-muted">空目录</p>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.path}
              data-native-context-menu
              onDoubleClick={() => (entry.is_dir ? openEntry(entry) : void handleDownload(entry))}
              onContextMenu={(event) => {
                event.preventDefault();
                openMenu(entry);
              }}
              title={entry.is_dir ? '双击进入目录，右键更多操作' : '双击下载，右键更多操作'}
              className={cn(
                'grid h-7 grid-cols-[1fr_62px_104px_42px] items-center border-b border-border-muted/60 px-2 text-[11px]',
                'hover:bg-row-hover',
                entry.is_dir && 'cursor-pointer'
              )}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {entry.is_dir ? (
                  <Folder className="h-3.5 w-3.5 shrink-0 text-accent" />
                ) : (
                  <File className="h-3.5 w-3.5 shrink-0 text-muted" />
                )}
                <span className="truncate text-foreground">{entry.name}</span>
              </span>
              <span className="text-right tabular-nums text-muted">
                {entry.is_dir ? '-' : formatBytes(entry.size)}
              </span>
              <span className="text-right tabular-nums text-muted">{formatTime(entry.mtime)}</span>
              <span className="text-right font-mono text-muted">
                {formatPermissions(entry.permissions)}
              </span>
            </div>
          ))
        )}
      </div>

      <div className="flex items-center justify-between border-t border-border bg-background-alt px-2 py-1 text-[10px] text-muted">
        <span>{canBrowse ? `${entries.length} 项` : '等待 SSH 连接'}</span>
        <span>双击目录进入 · 右键更多操作</span>
      </div>
    </div>
  );
}
