import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../stores/sessionStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import type { Session } from '../types/session';
import { useWindowTitle } from './useWindowTitle';

const { setTitle } = vi.hoisted(() => ({
  setTitle: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setTitle })
}));

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    kind: 'local',
    title: 'Demo',
    group: 'Sessions',
    favorite: false,
    status: 'idle',
    createdAt: 0,
    lastUsed: 0,
    ...overrides
  };
}

beforeEach(() => {
  setTitle.mockClear();
  useSessionStore.setState({ sessions: [] });
  useWorkspaceStore.setState({ activeSessionId: null });
});

describe('useWindowTitle', () => {
  it('uses the bare app name when no session is active', async () => {
    renderHook(() => useWindowTitle());

    await waitFor(() => expect(setTitle).toHaveBeenCalledWith('NexTerm'));
  });

  it('includes the active session title', async () => {
    useSessionStore.setState({ sessions: [session()] });
    useWorkspaceStore.setState({ activeSessionId: 's1' });

    renderHook(() => useWindowTitle());

    await waitFor(() => expect(setTitle).toHaveBeenCalledWith('Demo - NexTerm'));
  });

  it('falls back to the app name when the active session is removed', async () => {
    useSessionStore.setState({ sessions: [session()] });
    useWorkspaceStore.setState({ activeSessionId: 's1' });

    renderHook(() => useWindowTitle());
    await waitFor(() => expect(setTitle).toHaveBeenCalledWith('Demo - NexTerm'));

    act(() => {
      useSessionStore.setState({ sessions: [] });
    });

    await waitFor(() => expect(setTitle).toHaveBeenLastCalledWith('NexTerm'));
  });
});
