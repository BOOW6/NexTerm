import { beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadSftp, uploadSftp } from '../hooks/useTauriSsh';
import { useConnectionStore } from '../stores/connectionStore';
import { useTransferStore } from '../stores/transferStore';
import { retryTransfer, resumeInterruptedTransfers, startSftpTransfer } from './sftpTransfer';
import { tStatic } from '../i18n';

vi.mock('../hooks/useTauriSsh', () => ({
  uploadSftp: vi.fn(),
  downloadSftp: vi.fn()
}));

const upload = vi.mocked(uploadSftp);
const download = vi.mocked(downloadSftp);

const setConnection = (sessionId: string, sshId: string | null) => {
  useConnectionStore.setState((state) => {
    const connections = { ...state.connections };
    if (sshId) {
      connections[sessionId] = { sshIds: [sshId], status: 'connected' };
    } else {
      delete connections[sessionId];
    }
    return { connections };
  });
};

beforeEach(() => {
  useTransferStore.setState({ transfers: [] });
  setConnection('sess-1', 'ssh-1');
  upload.mockReset();
  download.mockReset();
  upload.mockResolvedValue('transfer-1');
  download.mockResolvedValue('transfer-2');
});

describe('startSftpTransfer', () => {
  it('resolves the current sshId from the bound session and registers a retryable transfer', async () => {
    const id = await startSftpTransfer({
      sessionId: 'sess-1',
      direction: 'upload',
      name: 'archive',
      localPath: 'C:/tmp/archive',
      remotePath: '/home/user/archive',
      recursive: true,
      conflict: 'rename'
    });

    expect(id).toBe('transfer-1');
    expect(upload).toHaveBeenCalledWith('ssh-1', 'C:/tmp/archive', '/home/user/archive', {
      recursive: true,
      resume: true,
      conflict: 'rename'
    });

    const item = useTransferStore.getState().transfers[0];
    expect(item.request).toEqual({
      sessionId: 'sess-1',
      localPath: 'C:/tmp/archive',
      remotePath: '/home/user/archive',
      recursive: true,
      resume: true,
      conflict: 'rename'
    });
  });

  it('rejects when the session has no active SSH connection', async () => {
    setConnection('sess-1', null);

    await expect(
      startSftpTransfer({
        sessionId: 'sess-1',
        direction: 'download',
        name: 'file.txt',
        localPath: 'C:/tmp/file.txt',
        remotePath: '/home/user/file.txt'
      })
    ).rejects.toThrow(tStatic('sftpTransfer.notConnected'));
    expect(download).not.toHaveBeenCalled();
  });
});

describe('retryTransfer', () => {
  it('replays the request through the session id and drops the old entry', async () => {
    download.mockResolvedValueOnce('transfer-2').mockResolvedValueOnce('transfer-3');

    await startSftpTransfer({
      sessionId: 'sess-1',
      direction: 'download',
      name: 'file.txt',
      localPath: 'C:/tmp/file.txt',
      remotePath: '/home/user/file.txt',
      conflict: 'skip'
    });

    // Simulate a reconnect: the backend sshId changed for this session.
    setConnection('sess-1', 'ssh-2');
    const item = useTransferStore.getState().transfers[0];
    const id = await retryTransfer(item);

    expect(id).toBe('transfer-3');
    expect(download).toHaveBeenLastCalledWith('ssh-2', '/home/user/file.txt', 'C:/tmp/file.txt', {
      recursive: false,
      resume: true,
      conflict: 'skip'
    });
    expect(useTransferStore.getState().transfers).toHaveLength(1);
  });

  it('throws when the session is not connected', async () => {
    download.mockResolvedValueOnce('transfer-2');

    await startSftpTransfer({
      sessionId: 'sess-1',
      direction: 'download',
      name: 'file.txt',
      localPath: 'C:/tmp/file.txt',
      remotePath: '/home/user/file.txt'
    });
    setConnection('sess-1', null);
    const item = useTransferStore.getState().transfers[0];

    await expect(retryTransfer(item)).rejects.toThrow(
      tStatic('sftpTransfer.disconnectedRetryPending')
    );
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('returns null when the request is missing', async () => {
    useTransferStore.getState().finish({
      transfer_id: 'orphan',
      direction: 'upload',
      name: 'orphan.txt',
      success: false,
      cancelled: false,
      disconnected: false,
      error: 'failed',
      transferred: 0,
      total: 0,
      files_done: 0,
      files_total: 0
    });

    const item = useTransferStore.getState().transfers[0];
    expect(await retryTransfer(item)).toBeNull();
    expect(upload).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });
});

describe('resumeInterruptedTransfers', () => {
  it('restarts interrupted transfers of the session and removes the stale entries', async () => {
    download.mockResolvedValueOnce('transfer-2').mockResolvedValueOnce('transfer-3');

    await startSftpTransfer({
      sessionId: 'sess-1',
      direction: 'download',
      name: 'file.txt',
      localPath: 'C:/tmp/file.txt',
      remotePath: '/home/user/file.txt',
      resume: true
    });
    useTransferStore.getState().markSessionDisconnected('sess-1');
    expect(useTransferStore.getState().transfers[0].status).toBe('interrupted');

    setConnection('sess-1', 'ssh-2');
    const resumed = await resumeInterruptedTransfers('sess-1');

    expect(resumed).toBe(1);
    expect(download).toHaveBeenLastCalledWith('ssh-2', '/home/user/file.txt', 'C:/tmp/file.txt', {
      recursive: false,
      resume: true,
      conflict: 'overwrite'
    });
    expect(useTransferStore.getState().transfers).toHaveLength(1);
    expect(useTransferStore.getState().transfers[0].status).toBe('running');
  });

  it('keeps the interrupted entry when the session is still offline', async () => {
    download.mockResolvedValueOnce('transfer-2');

    await startSftpTransfer({
      sessionId: 'sess-1',
      direction: 'download',
      name: 'file.txt',
      localPath: 'C:/tmp/file.txt',
      remotePath: '/home/user/file.txt'
    });
    useTransferStore.getState().markSessionDisconnected('sess-1');
    setConnection('sess-1', null);

    const resumed = await resumeInterruptedTransfers('sess-1');

    expect(resumed).toBe(0);
    expect(useTransferStore.getState().transfers[0].status).toBe('interrupted');
  });
});
