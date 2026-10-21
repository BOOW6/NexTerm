import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTransferStore, type TransferRequest } from './transferStore';

const request: TransferRequest = {
  sshId: 'ssh-1',
  localPath: 'C:/tmp/file.txt',
  remotePath: '/home/user/file.txt',
  recursive: false,
  resume: true,
  conflict: 'overwrite'
};

const progress = (overrides: Record<string, unknown> = {}) => ({
  transfer_id: 't1',
  direction: 'upload',
  name: 'file.txt',
  transferred: 100,
  total: 1000,
  files_done: 0,
  files_total: 1,
  ...overrides
});

const done = (overrides: Record<string, unknown> = {}) => ({
  transfer_id: 't1',
  direction: 'upload',
  name: 'file.txt',
  success: true,
  cancelled: false,
  error: null,
  transferred: 1000,
  total: 1000,
  files_done: 1,
  files_total: 1,
  ...overrides
});

beforeEach(() => {
  useTransferStore.setState({ transfers: [] });
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('begin', () => {
  it('creates a running transfer with the retry request', () => {
    useTransferStore.getState().begin({
      id: 't1',
      name: 'file.txt',
      direction: 'upload',
      request
    });

    const [item] = useTransferStore.getState().transfers;
    expect(item).toMatchObject({
      id: 't1',
      name: 'file.txt',
      direction: 'upload',
      status: 'running',
      transferred: 0,
      request
    });
  });

  it('attaches the request when progress arrived first', () => {
    useTransferStore.getState().applyProgress(progress());
    useTransferStore.getState().begin({
      id: 't1',
      name: 'file.txt',
      direction: 'upload',
      request
    });

    expect(useTransferStore.getState().transfers).toHaveLength(1);
    expect(useTransferStore.getState().transfers[0].request).toEqual(request);
  });
});

describe('applyProgress', () => {
  it('creates a transfer on the first progress event', () => {
    useTransferStore.getState().applyProgress(progress({ files_done: 2, files_total: 5 }));

    const [item] = useTransferStore.getState().transfers;
    expect(item).toMatchObject({
      id: 't1',
      name: 'file.txt',
      direction: 'upload',
      status: 'running',
      transferred: 100,
      total: 1000,
      filesDone: 2,
      filesTotal: 5,
      speed: 0
    });
    expect(item.startedAt).toBe(item.updatedAt);
  });

  it('updates an existing transfer and computes speed from the delta', () => {
    useTransferStore.getState().applyProgress(progress());

    vi.advanceTimersByTime(1000);
    useTransferStore.getState().applyProgress(progress({ transferred: 300, files_done: 1 }));

    const [item] = useTransferStore.getState().transfers;
    expect(useTransferStore.getState().transfers).toHaveLength(1);
    expect(item.transferred).toBe(300);
    expect(item.filesDone).toBe(1);
    expect(item.speed).toBe(200);
  });

  it('keeps the previous speed when progress moves backwards', () => {
    useTransferStore.getState().applyProgress(progress());
    vi.advanceTimersByTime(1000);
    useTransferStore.getState().applyProgress(progress({ transferred: 300 }));
    vi.advanceTimersByTime(1000);
    useTransferStore.getState().applyProgress(progress({ transferred: 200 }));

    const [item] = useTransferStore.getState().transfers;
    expect(item.speed).toBe(200);
    expect(item.transferred).toBe(200);
  });

  it('does not resume a paused transfer when progress arrives', () => {
    useTransferStore.getState().applyProgress(progress());
    useTransferStore.getState().setPaused('t1', true);

    useTransferStore.getState().applyProgress(progress({ transferred: 200 }));

    const [item] = useTransferStore.getState().transfers;
    expect(item.status).toBe('paused');
    expect(item.paused).toBe(true);
  });

  it('treats any direction other than upload as download', () => {
    useTransferStore.getState().applyProgress(progress({ direction: 'download' }));
    expect(useTransferStore.getState().transfers[0].direction).toBe('download');

    useTransferStore.getState().applyProgress(progress({ transfer_id: 't2', direction: 'x' }));
    expect(useTransferStore.getState().transfers[0].direction).toBe('download');
  });
});

describe('finish', () => {
  it('marks an existing transfer as done and keeps the retry request', () => {
    useTransferStore.getState().begin({
      id: 't1',
      name: 'file.txt',
      direction: 'upload',
      request
    });
    vi.advanceTimersByTime(1000);

    useTransferStore.getState().finish(done());

    const [item] = useTransferStore.getState().transfers;
    expect(item.status).toBe('done');
    expect(item.transferred).toBe(1000);
    expect(item.speed).toBe(0);
    expect(item.startedAt).toBe(Date.parse('2026-01-01T00:00:00Z'));
    expect(item.request).toEqual(request);
  });

  it('records failures with an error message', () => {
    useTransferStore.getState().finish(
      done({
        transfer_id: 't9',
        direction: 'download',
        success: false,
        error: 'permission denied'
      })
    );

    const [item] = useTransferStore.getState().transfers;
    expect(item.status).toBe('error');
    expect(item.error).toBe('permission denied');
  });

  it('marks cancelled transfers separately from failures', () => {
    useTransferStore.getState().applyProgress(progress());
    useTransferStore
      .getState()
      .finish(
        done({ success: false, cancelled: true, error: 'transfer cancelled', transferred: 400 })
      );

    const [item] = useTransferStore.getState().transfers;
    expect(item.status).toBe('cancelled');
    expect(item.transferred).toBe(400);
  });

  it('prepends completions that never reported progress', () => {
    useTransferStore.getState().finish(done({ transfer_id: 'a', name: 'a.txt' }));
    useTransferStore.getState().finish(done({ transfer_id: 'b', name: 'b.txt' }));

    expect(useTransferStore.getState().transfers.map((item) => item.id)).toEqual(['b', 'a']);
  });
});

describe('setPaused', () => {
  it('pauses and resumes active transfers', () => {
    useTransferStore.getState().applyProgress(progress());

    useTransferStore.getState().setPaused('t1', true);
    expect(useTransferStore.getState().transfers[0]).toMatchObject({
      status: 'paused',
      paused: true
    });

    useTransferStore.getState().setPaused('t1', false);
    expect(useTransferStore.getState().transfers[0]).toMatchObject({
      status: 'running',
      paused: false
    });
  });

  it('ignores finished transfers', () => {
    useTransferStore.getState().finish(done());
    useTransferStore.getState().setPaused('t1', true);

    expect(useTransferStore.getState().transfers[0].status).toBe('done');
  });
});

describe('clearFinished and remove', () => {
  it('keeps running and paused transfers when clearing', () => {
    useTransferStore.getState().applyProgress(progress({ transfer_id: 'running' }));
    useTransferStore.getState().applyProgress(progress({ transfer_id: 'paused' }));
    useTransferStore.getState().setPaused('paused', true);
    useTransferStore.getState().finish(done({ transfer_id: 'done' }));

    useTransferStore.getState().clearFinished();

    expect(
      useTransferStore
        .getState()
        .transfers.map((item) => item.id)
        .sort()
    ).toEqual(['paused', 'running']);
  });

  it('removes a transfer by id', () => {
    useTransferStore.getState().applyProgress(progress());
    useTransferStore.getState().remove('t1');
    expect(useTransferStore.getState().transfers).toHaveLength(0);
  });
});
