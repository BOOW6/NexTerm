import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResizeWrapGuard, WRAP_GUARD_TIMEOUT_MS } from './terminalResizeWrapGuard';

describe('ResizeWrapGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('disables autowrap while armed and restores it on release', () => {
    const write = vi.fn();
    const guard = new ResizeWrapGuard(write);

    expect(guard.arm(true)).toBe(true);
    expect(guard.isArmed).toBe(true);
    expect(write).toHaveBeenCalledWith('\x1b[?7l');

    guard.release();
    expect(guard.isArmed).toBe(false);
    expect(write).toHaveBeenLastCalledWith('\x1b[?7h');
  });

  it('does nothing when the application had autowrap disabled', () => {
    const write = vi.fn();
    const guard = new ResizeWrapGuard(write);

    expect(guard.arm(false)).toBe(false);
    expect(write).not.toHaveBeenCalled();
    guard.release();
    expect(write).not.toHaveBeenCalled();
  });

  it('arms only once and ignores duplicate releases', () => {
    const write = vi.fn();
    const guard = new ResizeWrapGuard(write);

    guard.arm(true);
    guard.arm(true);
    guard.release();
    guard.release();

    expect(write.mock.calls).toEqual([['\x1b[?7l'], ['\x1b[?7h']]);
  });

  it('restores autowrap when no output batch arrives', () => {
    const write = vi.fn();
    const guard = new ResizeWrapGuard(write);

    guard.arm(true);
    vi.advanceTimersByTime(WRAP_GUARD_TIMEOUT_MS);

    expect(guard.isArmed).toBe(false);
    expect(write.mock.calls).toEqual([['\x1b[?7l'], ['\x1b[?7h']]);
  });

  it('does not write on dispose', () => {
    const write = vi.fn();
    const guard = new ResizeWrapGuard(write);

    guard.arm(true);
    guard.dispose();

    expect(guard.isArmed).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(WRAP_GUARD_TIMEOUT_MS);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
