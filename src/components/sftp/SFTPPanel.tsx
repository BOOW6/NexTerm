import { swallowListenError } from '../../lib/eventListener';
import { isSshBackedSession } from '../../lib/sessionVisuals';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { openPath } from '@tauri-apps/plugin-opener';
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
  remoteEditOpen,
  remoteEditStop,
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
import { useSettingsStore } from '../../stores/settingsStore';
import { useTransferStore } from '../../stores/transferStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useWorkspace } from '../../features/workspace/useWorkspace';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import { Select } from '../ui/select';
import { Tooltip } from '../ui/tooltip';
import { toast } from '../ui/toastStore';
import { cn } from '../../lib/cn';
import { formatBytes } from '../../lib/format';
import { confirmAction, promptText, showNativeContextMenu } from '../../lib/appWindows';
import { localizeBackendError } from '../../lib/backendErrors';
import { joinRemotePath, remoteBaseName, remoteParentPath } from '../../lib/remotePath';

function formatTime(mtime: number, locale: string): string {
  if (!mtime) {
    return '-';
  }
  return new Date(mtime * 1000).toLocaleString(locale, { hour12: false });
}

function formatPermissions(permissions: number | null): string {
  if (permissions === null || permissions === undefined) {
    return '-';
  }
  return (permissions & 0o777).toString(8).padStart(3, '0');
}

export default function SFTPPanel({ params, api }: IDockviewPanelProps) {
  const { t, locale } = useI18n();
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
  // SFTP rides an SSH subsystem: only SSH/SFTP sessions can ever provide one.
  const remoteSessions = sessions.filter((item) => isSshBackedSession(item.kind));

  const [path, setPath] = useState('/');
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  // Shared setting: several panels of one session must agree on the policy.
  const conflict = useSettingsStore((state) => state.sftpConflictPolicy);
  const setConflict = (policy: SftpConflictPolicy) =>
    useSettingsStore.getState().setSftpConflictPolicy(policy);
  const panelRef = useRef<HTMLDivElement>(null);
  const [dropActive, setDropActive] = useState(false);
  const dragRemoteRef = useRef<string | null>(null);
  const [dragOverDir, setDragOverDir] = useState<string | null>(null);

  useEffect(() => {
    // One-time migration: the policy used to live in a panel-local
    // localStorage key; pull it into the shared settings store and drop it.
    try {
      const legacy = window.localStorage.getItem('nexterm.sftp.conflict.v1');
      if (legacy) {
        window.localStorage.removeItem('nexterm.sftp.conflict.v1');
        const store = useSettingsStore.getState();
        if (store.sftpConflictPolicy === 'ask' && legacy !== 'ask') {
          store.setSftpConflictPolicy(legacy as SftpConflictPolicy);
        }
      }
    } catch {
      /* storage unavailable */
    }
  }, []);

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
          setError(localizeBackendError(String(reason)));
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
      .catch(swallowListenError);

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  const goUp = () => {
    if (path === '/') {
      return;
    }
    setPath(remoteParentPath(path));
  };

  const openEntry = (entry: SftpEntry) => {
    if (entry.is_dir) {
      setPath(entry.path.startsWith('/') ? entry.path : joinRemotePath(path, entry.name));
    }
  };

  // Upload paths dropped from the OS onto the panel. `recursive: true` is
  // passed unconditionally: the backend walks a dropped folder and uploads
  // a dropped file as-is.
  const handleExternalDrop = useCallback(
    async (paths: string[]) => {
      if (!sshId || !boundSessionId || paths.length === 0) {
        return;
      }
      try {
        for (const localPath of paths) {
          await startSftpTransfer({
            sessionId: boundSessionId,
            direction: 'upload',
            name: remoteBaseName(localPath),
            localPath,
            remotePath: joinRemotePath(path, remoteBaseName(localPath)),
            recursive: true,
            conflict
          });
        }
        toast({
          title: t('sftp.drop.addedToast', { count: paths.length }),
          variant: 'success'
        });
        openTransferPanel();
      } catch (reason) {
        toast({
          title: t('sftp.upload.failedToast'),
          description: localizeBackendError(String(reason)),
          variant: 'error'
        });
      }
    },
    [sshId, boundSessionId, path, conflict, t, openTransferPanel]
  );

  // Move a remote entry into a directory row via an in-panel drag.
  const moveEntry = useCallback(
    async (sourcePath: string, targetDir: string) => {
      if (!sshId) {
        return;
      }
      const name = sourcePath.split('/').filter(Boolean).pop();
      if (!name) {
        return;
      }
      const target = joinRemotePath(targetDir, name);
      if (target === sourcePath) {
        return;
      }
      try {
        await renameSftp(sshId, sourcePath, target);
        toast({ title: t('sftp.drop.movedToast', { name }), variant: 'success' });
        setReloadToken((value) => value + 1);
      } catch (reason) {
        toast({
          title: t('sftp.drop.moveFailedToast'),
          description: localizeBackendError(String(reason)),
          variant: 'error'
        });
      }
    },
    [sshId, t]
  );

  // Tauri drag-drop events are window-global; hit-test the panel rect so
  // only drops landing on this panel upload into its current directory.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === 'leave') {
          setDropActive(false);
          return;
        }
        const rect = panelRef.current?.getBoundingClientRect();
        if (!rect) {
          return;
        }
        // The event position is in physical pixels; convert to CSS pixels.
        const scale = window.devicePixelRatio || 1;
        const x = event.payload.position.x / scale;
        const y = event.payload.position.y / scale;
        const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
        if (event.payload.type === 'drop') {
          setDropActive(false);
          if (inside) {
            void handleExternalDrop(event.payload.paths);
          }
          return;
        }
        setDropActive(inside);
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
    };
  }, [handleExternalDrop]);

  const handleUpload = async () => {
    if (!sshId || !boundSessionId) {
      return;
    }

    try {
      const selected = await openDialog({
        multiple: true,
        title: t('sftp.dialog.pickUploadFiles')
      });
      if (!selected) {
        return;
      }

      const paths = Array.isArray(selected) ? selected : [selected];
      for (const localPath of paths) {
        await startSftpTransfer({
          sessionId: boundSessionId,
          direction: 'upload',
          name: remoteBaseName(localPath),
          localPath,
          remotePath: joinRemotePath(path, remoteBaseName(localPath)),
          conflict
        });
      }

      toast({
        title: t('sftp.upload.addedManyToast', { count: paths.length }),
        variant: 'success'
      });
      openTransferPanel();
    } catch (reason) {
      toast({
        title: t('sftp.upload.failedToast'),
        description: localizeBackendError(String(reason)),
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
        title: t('sftp.dialog.pickUploadFolder')
      });
      if (typeof selected !== 'string') {
        return;
      }

      const name = remoteBaseName(selected);
      await startSftpTransfer({
        sessionId: boundSessionId,
        direction: 'upload',
        name,
        localPath: selected,
        remotePath: joinRemotePath(path, name),
        recursive: true,
        conflict
      });

      toast({ title: t('sftp.upload.addedFolderToast', { name }), variant: 'success' });
      openTransferPanel();
    } catch (reason) {
      toast({
        title: t('sftp.upload.failedToast'),
        description: localizeBackendError(String(reason)),
        variant: 'error'
      });
    }
  };

  // Download the file to a scratch copy and open it in the local editor;
  // the backend watcher syncs saves back automatically.
  const activeRemoteEdits = useRef(new Set<{ sshId: string; remotePath: string }>());

  const stopRemoteEditWatch = (sshIdForEdit: string, remotePath: string): void => {
    for (const entryKey of activeRemoteEdits.current) {
      if (entryKey.sshId === sshIdForEdit && entryKey.remotePath === remotePath) {
        activeRemoteEdits.current.delete(entryKey);
        break;
      }
    }
    void remoteEditStop(sshIdForEdit, remotePath).catch(() => undefined);
  };

  const handleRemoteEdit = async (entry: SftpEntry) => {
    if (!sshId) {
      return;
    }
    try {
      const session = await remoteEditOpen(sshId, entry.path);
      activeRemoteEdits.current.add({ sshId, remotePath: entry.path });
      try {
        await openPath(session.tempPath);
      } catch (reason) {
        // The editor never launched, so stop the watcher instead of polling a
        // scratch file nobody will ever save.
        stopRemoteEditWatch(sshId, entry.path);
        throw reason;
      }
      toast({ title: t('sftp.edit.openedToast', { name: entry.name }), variant: 'success' });
    } catch (reason) {
      toast({
        title: t('sftp.edit.failedToast'),
        description: localizeBackendError(String(reason)),
        variant: 'error'
      });
    }
  };

  // Closing the panel ends the editing session: watchers must not keep
  // polling scratch copies for a pane that is gone.
  useEffect(() => {
    const edits = activeRemoteEdits;
    return () => {
      for (const openEdit of edits.current) {
        void remoteEditStop(openEdit.sshId, openEdit.remotePath).catch(() => undefined);
      }
      edits.current.clear();
    };
  }, []);

  const handleDownload = async (entry: SftpEntry) => {
    if (!sshId || !boundSessionId) {
      return;
    }

    try {
      if (entry.is_dir) {
        const directory = await openDialog({
          multiple: false,
          directory: true,
          title: t('sftp.dialog.pickDownloadDir')
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
          title: t('sftp.dialog.saveFile')
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

      toast({ title: t('sftp.download.addedToast'), variant: 'success' });
      openTransferPanel();
    } catch (reason) {
      toast({
        title: t('sftp.download.failedToast'),
        description: localizeBackendError(String(reason)),
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
      await mkdirSftp(sshId, joinRemotePath(path, name));
      refresh();
      toast({ title: t('sftp.folder.createdToast', { name }), variant: 'success' });
    } catch (reason) {
      toast({
        title: t('sftp.folder.createFailedToast'),
        description: localizeBackendError(String(reason)),
        variant: 'error'
      });
    }
  };

  const handleRename = async (entry: SftpEntry, name: string) => {
    if (!sshId) {
      return;
    }

    try {
      await renameSftp(sshId, entry.path, joinRemotePath(path, name));
      refresh();
      toast({ title: t('sftp.rename.successToast'), variant: 'success' });
    } catch (reason) {
      toast({
        title: t('sftp.rename.failedToast'),
        description: localizeBackendError(String(reason)),
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
        title: t('sftp.delete.activeTransferToast'),
        description: t('sftp.delete.activeTransferToastDesc'),
        variant: 'error'
      });
      return;
    }

    const ok = await confirmAction(t('sftp.delete.confirm', { name: entry.name }), {
      title: t('sftp.delete.confirmTitle'),
      okLabel: t('sftp.delete.okLabel')
    });
    if (!ok) {
      return;
    }

    try {
      await removeSftp(sshId, entry.path, entry.is_dir);
      refresh();
      toast({ title: t('sftp.delete.successToast'), variant: 'success' });
    } catch (reason) {
      toast({
        title: t('sftp.delete.failedToast'),
        description: localizeBackendError(String(reason)),
        variant: 'error'
      });
    }
  };

  const promptName = async (mode: 'mkdir' | 'rename', entry?: SftpEntry) => {
    const value = await promptText(
      mode === 'rename' ? t('sftp.rename.promptLabel') : t('sftp.folder.promptLabel'),
      mode === 'rename' ? t('sftp.rename.confirmLabel') : t('sftp.folder.confirmLabel'),
      {
        title: mode === 'rename' ? t('sftp.rename.promptTitle') : t('sftp.folder.promptTitle'),
        initialValue: mode === 'rename' ? (entry?.name ?? '') : '',
        width: 440,
        height: 230
      }
    );
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
        { label: t('sftp.menu.enter'), run: () => openEntry(entry) },
        { label: t('sftp.menu.downloadFolder'), run: () => void handleDownload(entry) }
      );
    } else {
      actions.push({ label: t('sftp.menu.edit'), run: () => void handleRemoteEdit(entry) });
      actions.push({ label: t('sftp.menu.download'), run: () => void handleDownload(entry) });
    }

    actions.push(
      { label: t('sftp.menu.rename'), run: () => void promptName('rename', entry) },
      {
        label: t('sftp.menu.delete'),
        separatorBefore: true,
        run: () => void handleDelete(entry)
      },
      {
        label: t('sftp.menu.copyPath'),
        separatorBefore: true,
        run: () => {
          // The success toast must wait for the write: clipboard access can
          // fail (permissions, non-Tauri context) and "copied" would be a lie.
          void writeClipboardText(entry.path).then(
            () => toast({ title: t('sftp.menu.copiedToast') }),
            () => toast({ title: t('sftp.menu.copyFailedToast'), variant: 'error' })
          );
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

  // Roving tabindex for the file rows: one tab stop for the whole list,
  // arrow keys move the highlighted row.
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [rovingPath, setRovingPath] = useState<string | null>(null);
  useEffect(() => {
    setRovingPath(null);
  }, [path]);

  const focusRow = (index: number) => {
    const clamped = Math.max(0, Math.min(entries.length - 1, index));
    const element = rowRefs.current[clamped];
    if (element) {
      setRovingPath(entries[clamped]?.path ?? null);
      element.focus();
    }
  };

  const handleRowKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    entry: SftpEntry,
    index: number
  ) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusRow(index + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusRow(index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusRow(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusRow(entries.length - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (entry.is_dir) {
        openEntry(entry);
      } else {
        void handleDownload(entry);
      }
    } else if (event.key === 'F2') {
      event.preventDefault();
      void promptName('rename', entry);
    } else if (event.key === 'Delete') {
      event.preventDefault();
      void handleDelete(entry);
    }
  };

  return (
    <div ref={panelRef} className="relative flex h-full flex-col bg-surface">
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border px-1">
        <Tooltip label={t('sftp.tool.goUp')}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('sftp.tool.goUp')}
            disabled={!canBrowse || path === '/'}
            onClick={goUp}
          >
            <ChevronUp className="h-3 w-3" />
          </Button>
        </Tooltip>
        <Tooltip label={t('sftp.tool.refresh')}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('sftp.tool.refresh')}
            disabled={!canBrowse}
            onClick={() => setReloadToken((value) => value + 1)}
          >
            <RefreshCw className="h-3 w-3" />
          </Button>
        </Tooltip>
        <Select
          aria-label={t('sftp.tool.sessionSelect')}
          value={boundSessionId ?? ''}
          onChange={(event) => {
            userUnboundRef.current = event.target.value === '';
            setBoundSessionId(event.target.value || undefined);
          }}
          size="sm"
          width={128}
          className="shrink-0"
        >
          <option value="">{t('sftp.tool.chooseSession')}</option>
          {remoteSessions.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </Select>
        <Select
          aria-label={t('sftp.tool.conflictSelect')}
          title={t('sftp.tool.conflictHint')}
          value={conflict}
          onChange={(event) => setConflict(event.target.value as SftpConflictPolicy)}
          size="sm"
          width={110}
          className="shrink-0"
        >
          <option value="ask">{t('sftp.conflict.ask')}</option>
          <option value="overwrite">{t('sftp.conflict.overwrite')}</option>
          <option value="skip">{t('sftp.conflict.skip')}</option>
          <option value="rename">{t('sftp.conflict.rename')}</option>
          <option value="newer">{t('sftp.conflict.newer')}</option>
        </Select>
        <span
          className="selectable min-w-0 flex-1 truncate font-mono text-meta text-muted"
          title={path}
        >
          {canBrowse ? path : '-'}
        </span>
        <Tooltip label={t('sftp.tool.mkdir')}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('sftp.tool.mkdir')}
            disabled={!canBrowse}
            onClick={() => void promptName('mkdir')}
          >
            <FolderPlus className="h-3 w-3" />
          </Button>
        </Tooltip>
        <Tooltip label={t('sftp.tool.uploadFile')}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('sftp.tool.uploadFile')}
            disabled={!canBrowse}
            onClick={() => void handleUpload()}
          >
            <Upload className="h-3 w-3" />
          </Button>
        </Tooltip>
        <Tooltip label={t('sftp.tool.uploadFolder')}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('sftp.tool.uploadFolder')}
            disabled={!canBrowse}
            onClick={() => void handleUploadFolder()}
          >
            <FolderUp className="h-3 w-3" />
          </Button>
        </Tooltip>
        <Tooltip label={t('sftp.tool.transfers')}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('sftp.tool.transfers')}
            onClick={openTransferPanel}
          >
            <ArrowUpDown className="h-3 w-3" />
          </Button>
        </Tooltip>
      </div>

      <div className="app-table-header grid shrink-0 grid-cols-[1fr_62px_104px_42px] border-b border-border bg-table-header px-2 py-1 text-meta font-emphasis text-foreground">
        <span>{t('sftp.header.name')}</span>
        <span className="text-right">{t('sftp.header.size')}</span>
        <span className="text-right">{t('sftp.header.mtime')}</span>
        <span className="text-right">{t('sftp.header.perms')}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!session ? (
          <p className="px-3 py-6 text-center text-meta text-muted">
            {t('sftp.state.pickSession')}
          </p>
        ) : session.kind === 'local' ? (
          <p className="px-3 py-6 text-center text-meta text-muted">
            {t('sftp.state.localNoSftp')}
          </p>
        ) : session.kind === 'telnet' || session.kind === 'serial' ? (
          <p className="px-3 py-6 text-center text-meta text-muted">
            {t('sftp.state.noSftpSupport')}
          </p>
        ) : !sshId ? (
          <p className="px-3 py-6 text-center text-meta text-muted">
            {connection?.status === 'connecting'
              ? t('sftp.state.connecting')
              : t('sftp.state.notConnected')}
          </p>
        ) : loading ? (
          <p className="px-3 py-6 text-center text-meta text-muted">{t('sftp.state.loading')}</p>
        ) : error ? (
          <p className="px-3 py-6 text-center text-meta text-error">{error}</p>
        ) : entries.length === 0 ? (
          <p className="px-3 py-6 text-center text-meta text-muted">{t('sftp.state.empty')}</p>
        ) : (
          entries.map((entry, index) => (
            <div
              key={entry.path}
              ref={(element) => {
                rowRefs.current[index] = element;
              }}
              tabIndex={(rovingPath === null ? index === 0 : rovingPath === entry.path) ? 0 : -1}
              onFocus={() => setRovingPath(entry.path)}
              onKeyDown={(event) => handleRowKeyDown(event, entry, index)}
              data-native-context-menu
              draggable
              onDragStart={(event) => {
                dragRemoteRef.current = entry.path;
                event.dataTransfer.setData('application/x-nexterm-remote', entry.path);
                event.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => {
                dragRemoteRef.current = null;
                setDragOverDir(null);
              }}
              onDragOver={
                entry.is_dir
                  ? (event) => {
                      if (!dragRemoteRef.current) {
                        return;
                      }
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                      setDragOverDir(entry.path);
                    }
                  : undefined
              }
              onDragLeave={
                entry.is_dir
                  ? () => setDragOverDir((current) => (current === entry.path ? null : current))
                  : undefined
              }
              onDrop={
                entry.is_dir
                  ? (event) => {
                      event.preventDefault();
                      const source =
                        dragRemoteRef.current ??
                        event.dataTransfer.getData('application/x-nexterm-remote');
                      dragRemoteRef.current = null;
                      setDragOverDir(null);
                      if (source && source !== entry.path) {
                        void moveEntry(source, entry.path);
                      }
                    }
                  : undefined
              }
              onDoubleClick={() => (entry.is_dir ? openEntry(entry) : void handleDownload(entry))}
              onContextMenu={(event) => {
                event.preventDefault();
                openMenu(entry);
              }}
              title={entry.is_dir ? t('sftp.row.dirHint') : t('sftp.row.fileHint')}
              className={cn(
                'grid h-7 grid-cols-[1fr_62px_104px_42px] items-center border-b border-border-muted/60 px-2 text-meta',
                'hover:bg-row-hover',
                'focus-visible:outline-none focus-visible:bg-row-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent',
                entry.is_dir && 'cursor-pointer',
                dragOverDir === entry.path && 'bg-accent/15 ring-1 ring-inset ring-accent'
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
              <span className="text-right tabular-nums text-muted">
                {formatTime(entry.mtime, locale)}
              </span>
              <span className="text-right font-mono text-muted">
                {formatPermissions(entry.permissions)}
              </span>
            </div>
          ))
        )}
      </div>

      {dropActive ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-accent bg-accent/5 text-xs font-medium text-accent">
          {t('sftp.drop.overlay')}
        </div>
      ) : null}

      <div className="flex items-center justify-between border-t border-border bg-background-alt px-2 py-1 text-tiny text-muted">
        <span>
          {canBrowse
            ? t('sftp.footer.count', { count: entries.length })
            : t('sftp.footer.waitingSsh')}
        </span>
        <span>{t('sftp.footer.hint')}</span>
      </div>
    </div>
  );
}
