import { beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadSftp, uploadSftp } from '../hooks/useTauriSsh';
import { useTransferStore } from '../stores/transferStore';
import { retryTransfer, startSftpTransfer } from './sftpTransfer';

vi.mock('../hooks/useTauriSsh', () => ({
  uploadSftp: vi.fn(),
  downloadSftp: vi.fn()
}));

const upload = vi.mocked(uploadSftp);
const download = vi.mocked(downloadSftp);

beforeEach(() => {
  useTransferStore.setState({ transfers: [] });
  upload.mockReset();
  download.mockReset();
  upload.mockResolvedValue('transfer-1');
  download.mockResolvedValue('transfer-2');
});

describe('startSftpTransfer', () => {
  it('invokes upload with options and registers a retryable transfer', async () => {
    const id = await startSftpTransfer({
      sshId: 'ssh-1',
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
      sshId: 'ssh-1',
      localPath: 'C:/tmp/archive',
      remotePath: '/home/user/archive',
      recursive: true,
      resume: true,
      conflict: 'rename'
    });
  });

  it('defaults to overwrite and non-recursive transfers', async () => {
    await startSftpTransfer({
      sshId: 'ssh-1',
      direction: 'download',
      name: 'file.txt',
      localPath: 'C:/tmp/file.txt',
      remotePath: '/home/user/file.txt'
    });

    expect(download).toHaveBeenCalledWith('ssh-1', '/home/user/file.txt', 'C:/tmp/file.txt', {
      recursive: false,
      resume: true,
      conflict: 'overwrite'
    });
  });
});

describe('retryTransfer', () => {
  it('replays the stored request with the same direction', async () => {
    download.mockResolvedValueOnce('transfer-2').mockResolvedValueOnce('transfer-3');

    await startSftpTransfer({
      sshId: 'ssh-1',
      direction: 'download',
      name: 'file.txt',
      localPath: 'C:/tmp/file.txt',
      remotePath: '/home/user/file.txt',
      conflict: 'skip'
    });

    const item = useTransferStore.getState().transfers[0];
    const id = await retryTransfer(item);

    expect(id).toBe('transfer-3');
    expect(download).toHaveBeenLastCalledWith('ssh-1', '/home/user/file.txt', 'C:/tmp/file.txt', {
      recursive: false,
      resume: true,
      conflict: 'skip'
    });
    expect(useTransferStore.getState().transfers).toHaveLength(2);
  });

  it('returns null when the request is missing', async () => {
    useTransferStore.getState().finish({
      transfer_id: 'orphan',
      direction: 'upload',
      name: 'orphan.txt',
      success: false,
      cancelled: false,
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
