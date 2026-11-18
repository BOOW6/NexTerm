import { describe, expect, it } from 'vitest';
import { BackendResizeSender, type BackendResizeTarget } from './terminalBackendResize';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(
  sendImpl?: (target: BackendResizeTarget, cols: number, rows: number) => Promise<void>
) {
  let target: BackendResizeTarget | null = { id: 'pty-1', transport: 'local' };
  const sent: Array<{ target: string; cols: number; rows: number }> = [];
  const errors: unknown[] = [];
  const sender = new BackendResizeSender({
    getTarget: () => target,
    send: (next, cols, rows) => {
      sent.push({ target: next.id, cols, rows });
      return sendImpl ? sendImpl(next, cols, rows) : Promise.resolve();
    },
    onError: (_target, _cols, _rows, error) => {
      errors.push(error);
    }
  });
  return {
    sender,
    sent,
    errors,
    setTarget: (next: BackendResizeTarget | null) => {
      target = next;
    }
  };
}

describe('BackendResizeSender', () => {
  it('sends once and dedupes an identical request for the same target', async () => {
    const { sender, sent } = setup();
    await sender.send(100, 30);
    await sender.send(100, 30);
    expect(sent).toEqual([{ target: 'pty-1', cols: 100, rows: 30 }]);
  });

  it('sends the same grid again when the target changed (reconnect)', async () => {
    const { sender, sent, setTarget } = setup();
    await sender.send(100, 30);
    setTarget({ id: 'pty-2', transport: 'local' });
    await sender.send(100, 30);
    expect(sent.map((entry) => entry.target)).toEqual(['pty-1', 'pty-2']);
  });

  it('coalesces a burst to the newest target', async () => {
    const first = deferred();
    let call = 0;
    const { sender, sent } = setup(() => {
      call += 1;
      return call === 1 ? first.promise : Promise.resolve();
    });

    const settled = sender.send(90, 30);
    void sender.send(80, 30);
    void sender.send(70, 30);
    expect(sent).toEqual([{ target: 'pty-1', cols: 90, rows: 30 }]);

    first.resolve();
    await settled;
    expect(sent).toEqual([
      { target: 'pty-1', cols: 90, rows: 30 },
      { target: 'pty-1', cols: 70, rows: 30 }
    ]);
  });

  it('lets a repeated newest intent cancel a pending intermediate target', async () => {
    const first = deferred();
    let call = 0;
    const { sender, sent } = setup(() => {
      call += 1;
      return call === 1 ? first.promise : Promise.resolve();
    });

    const ack = sender.send(100, 30);
    void sender.send(80, 30);
    void sender.send(100, 30);
    first.resolve();
    await ack;
    expect(sent).toEqual([{ target: 'pty-1', cols: 100, rows: 30 }]);
  });

  it('queues a request that arrives before the target exists', async () => {
    const { sender, sent, setTarget } = setup();
    setTarget(null);
    await sender.send(120, 40);
    expect(sent).toEqual([]);

    setTarget({ id: 'pty-3', transport: 'local' });
    sender.flushQueued(80, 24);
    await sender.whenIdle();
    expect(sent).toEqual([{ target: 'pty-3', cols: 120, rows: 40 }]);
  });

  it('syncs the live grid when nothing was queued', async () => {
    const { sender, sent, setTarget } = setup();
    setTarget(null);
    setTarget({ id: 'pty-1', transport: 'local' });
    sender.flushQueued(132, 43);
    await sender.whenIdle();
    expect(sent).toEqual([{ target: 'pty-1', cols: 132, rows: 43 }]);
  });

  it('resolves send() only after the IPC acknowledged the grid', async () => {
    const ack = deferred();
    const { sender } = setup(() => ack.promise);
    let resolved = false;
    const done = sender.send(100, 30).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    ack.resolve();
    await done;
    expect(resolved).toBe(true);
  });

  it('keeps draining after an IPC failure', async () => {
    const first = deferred();
    const second = deferred();
    let call = 0;
    const { sender, sent, errors } = setup(() => {
      call += 1;
      return call === 1 ? first.promise : second.promise;
    });

    void sender.send(90, 30);
    void sender.send(80, 30);
    first.reject(new Error('closed'));
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(1);
    expect(sent).toHaveLength(2);
    second.resolve();
    await sender.whenIdle();
  });

  it('re-sends an identical grid after the previous IPC failed', async () => {
    let call = 0;
    const { sender, sent } = setup(() => {
      call += 1;
      return call === 1 ? Promise.reject(new Error('closed')) : Promise.resolve();
    });
    await sender.send(100, 30);
    await sender.send(100, 30);
    expect(sent).toHaveLength(2);
  });

  it('reset releases waiters and forgets the queued request', async () => {
    const ack = deferred();
    const { sender, sent } = setup(() => ack.promise);
    void sender.send(100, 30);
    const idle = sender.whenIdle();
    sender.reset();
    await idle;
    await sender.whenIdle();
    expect(sent).toHaveLength(1);
  });
});
