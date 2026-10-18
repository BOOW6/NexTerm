import { useEffect, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import {
  ArrowUpDown,
  ChevronUp,
  File,
  Folder,
  FolderPlus,
  RefreshCw,
  Upload
} from 'lucide-react';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { writeText as writeClipboardText } from '@tauri-apps/plugin-clipboard-manager';
import {
  downloadSftp,
  listSftp,
  listenSftpTransferDone,
  mkdirSftp,
  removeSftp,
  renameSftp,
  uploadSftp,
  type SftpEntry
} from '../../hooks/useTauriSsh';
import { useConnectionStore } from '../../stores/connectionStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useWorkspace } from '../../features/workspace/WorkspaceContext';
import { Button } from '../ui/button';
import { Select } from '../ui/select';
import { Tooltip } from '../ui/tooltip';
import { toast } from '../ui/toast';
import { cn } from '../../lib/cn';
import { formatBytes } from '../../lib/format';
import {
  confirmAction,
  openModalWindow,
  showNativeContextMenu
} from '../../lib/appWindows';
import type { PromptPayload } from '../../windows/PromptWindow';

function formatTime(mtime: number): string {
  if (!mtime) {
    return '—';
  }
  return new Date(mtime * 1000).toLocaleString('zh-CN', { hour12: false });
}

function formatPermissions(permissions: number | null): string {
  if (permissions === null || permissions === undefined) {
    return '—';
  }
  return (permissions & 0o777).toString(8).padStart(3, '0');
}

function joinRemote(path: string, name: string): string {
  return path.endsWith('/') ? `${path}${name}` : `${path}/${name}`;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? 'file';
}

export default function SFTPPanel({ params, api }: IDockviewPanelProps) {
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId);
  const sessions = useSessionStore((state) => state.sessions);
  const initialSessionId =
    (params as { sessionId?: string } | undefined)?.sessionId ?? activeSessionId ?? undefined;
  const [boundSessionId, setBoundSessionId] = useState<string | undefined>(initialSessionId);

  const session = sessions.find((item) => item.id === boundSessionId);
  const connection = useConnectionStore((state) =>
    boundSessionId ? state.connections[boundSessionId] : undefined
  );
  const { openTransferPanel } = useWorkspace();

  const sshId = connection?.status === 'connected' ? connection.sshId : undefined;
  const remoteSessions = sessions.filter((item) => item.kind !== 'local');

  const [path, setPath] = useState('/');
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    setPath('/');
  }, [boundSessionId]);

  useEffect(() => {
    if (boundSessionId && !sessions.some((item) => item.id === boundSessionId)) {
      setBoundSessionId(undefined);
    } else if (!boundSessionId && activeSessionId) {
      setBoundSessionId(activeSessionId);
    }
  }, [activeSessionId, boundSessionId, sessions]);

  useEffect(() => {
    void api.setTitle(session ? `SFTP · ${session.title}` : 'SFTP');
  }, [api, session?.title]);

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
    if (!sshId) {
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
        await uploadSftp(sshId, localPath, joinRemote(path, baseName(localPath)));
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

  const handleDownload = async (entry: SftpEntry) => {
    if (!sshId) {
      return;
    }

    try {
      const target = await saveDialog({
        defaultPath: entry.name,
        title: '保存文件'
      });
      if (!target) {
        return;
      }

      await downloadSftp(sshId, entry.path, target);
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
      initialValue: mode === 'rename' ? entry?.name ?? '' : '',
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
      actions.push({ label: '进入目录', run: () => openEntry(entry) });
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
            size="icon"
            variant="ghost"
            className="h-5 w-5"
            aria-label="上级目录"
            disabled={!canBrowse || path === '/'}
            onClick={goUp}
          >
            <ChevronUp className="h-3 w-3" />
          </Button>
        </Tooltip>
        <Tooltip label="刷新">
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5"
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
          onChange={(event) => setBoundSessionId(event.target.value || undefined)}
          className="h-5 w-32 shrink-0 text-[11px]"
        >
          <option value="">选择会话</option>
          {remoteSessions.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </Select>
        <span
          className="selectable min-w-0 flex-1 truncate font-mono text-[11px] text-muted"
          title={path}
        >
          {canBrowse ? path : '—'}
        </span>
        <Tooltip label="新建文件夹">
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5"
            aria-label="新建文件夹"
            disabled={!canBrowse}
            onClick={() => void promptName('mkdir')}
          >
            <FolderPlus className="h-3 w-3" />
          </Button>
        </Tooltip>
        <Tooltip label="上传文件">
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5"
            aria-label="上传文件"
            disabled={!canBrowse}
            onClick={() => void handleUpload()}
          >
            <Upload className="h-3 w-3" />
          </Button>
        </Tooltip>
        <Tooltip label="传输队列">
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5"
            aria-label="传输队列"
            onClick={openTransferPanel}
          >
            <ArrowUpDown className="h-3 w-3" />
          </Button>
        </Tooltip>
      </div>

      <div className="grid shrink-0 grid-cols-[1fr_62px_104px_42px] border-b border-border bg-table-header px-2 py-1 text-[11px] font-semibold text-foreground">
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
              onDoubleClick={() =>
                entry.is_dir ? openEntry(entry) : void handleDownload(entry)
              }
              onContextMenu={(event) => {
                event.preventDefault();
                openMenu(entry);
              }}
              title={
                entry.is_dir
                  ? '双击进入目录，右键更多操作'
                  : '双击下载，右键更多操作'
              }
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
                {entry.is_dir ? '—' : formatBytes(entry.size)}
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
