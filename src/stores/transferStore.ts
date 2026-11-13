import { create } from 'zustand';
import type {
  SftpConflictPolicy,
  SftpProgressPayload,
  SftpTransferDonePayload
} from '../hooks/useTauriSsh';

export type TransferDirection = 'upload' | 'download';
export type TransferStatus = 'running' | 'paused' | 'done' | 'error' | 'cancelled' | 'interrupted';

// Stored as the transfer's error value; the panel translates the key at render.
export const INTERRUPTED_MESSAGE_KEY = 'transfer.interruptedReason';

export interface TransferRequest {
  /** Session-store id the transfer is bound to; sshId is resolved fresh on
   * every (re)start so retries and auto-resume survive reconnects. */
  sessionId: string;
  localPath: string;
  remotePath: string;
  recursive: boolean;
  resume: boolean;
  conflict: SftpConflictPolicy;
}

export interface TransferItem {
  id: string;
  name: string;
  direction: TransferDirection;
  status: TransferStatus;
  transferred: number;
  total: number;
  filesDone: number;
  filesTotal: number;
  paused: boolean;
  error?: string;
  startedAt: number;
  updatedAt: number;
  speed: number;
  request?: TransferRequest;
}

export interface BeginTransferPayload {
  id: string;
  name: string;
  direction: TransferDirection;
  request: TransferRequest;
}

interface TransferState {
  transfers: TransferItem[];
  begin: (payload: BeginTransferPayload) => void;
  applyProgress: (payload: SftpProgressPayload) => void;
  finish: (payload: SftpTransferDonePayload) => void;
  setPaused: (id: string, paused: boolean) => void;
  /** Mark a session's active transfers as interrupted (connection dropped). */
  markSessionDisconnected: (sessionId: string) => void;
  /** Drop every transfer bound to a session (the session itself is gone —
   * retries could never succeed again). */
  removeSessionTransfers: (sessionId: string) => void;
  clearFinished: () => void;
  remove: (id: string) => void;
}

function directionOf(value: string): TransferDirection {
  return value === 'upload' ? 'upload' : 'download';
}

function isActive(status: TransferStatus): boolean {
  return status === 'running' || status === 'paused';
}

export const useTransferStore = create<TransferState>((set) => ({
  transfers: [],

  begin: (payload) =>
    set((state) => {
      const index = state.transfers.findIndex((item) => item.id === payload.id);

      if (index === -1) {
        const now = Date.now();
        return {
          transfers: [
            {
              id: payload.id,
              name: payload.name,
              direction: payload.direction,
              status: 'running',
              transferred: 0,
              total: 0,
              filesDone: 0,
              filesTotal: 0,
              paused: false,
              startedAt: now,
              updatedAt: now,
              speed: 0,
              request: payload.request
            },
            ...state.transfers
          ]
        };
      }

      const transfers = [...state.transfers];
      transfers[index] = {
        ...transfers[index],
        name: payload.name,
        direction: payload.direction,
        request: payload.request
      };
      return { transfers };
    }),

  applyProgress: (payload) =>
    set((state) => {
      const now = Date.now();
      const index = state.transfers.findIndex((item) => item.id === payload.transfer_id);

      if (index === -1) {
        return {
          transfers: [
            {
              id: payload.transfer_id,
              name: payload.name,
              direction: directionOf(payload.direction),
              status: 'running',
              transferred: payload.transferred,
              total: payload.total,
              filesDone: payload.files_done,
              filesTotal: payload.files_total,
              paused: false,
              startedAt: now,
              updatedAt: now,
              speed: 0
            },
            ...state.transfers
          ]
        };
      }

      const transfers = [...state.transfers];
      const current = transfers[index];
      const elapsed = (now - current.updatedAt) / 1000;
      const delta = payload.transferred - current.transferred;
      const speed = elapsed > 0 && delta >= 0 ? delta / elapsed : current.speed;

      transfers[index] = {
        ...current,
        status: current.paused ? 'paused' : 'running',
        transferred: payload.transferred,
        total: payload.total,
        filesDone: payload.files_done,
        filesTotal: payload.files_total,
        updatedAt: now,
        speed
      };

      return { transfers };
    }),

  finish: (payload) =>
    set((state) => {
      const now = Date.now();
      const index = state.transfers.findIndex((item) => item.id === payload.transfer_id);
      const current = index === -1 ? undefined : state.transfers[index];
      const status: TransferStatus = payload.cancelled
        ? 'cancelled'
        : payload.success
          ? 'done'
          : payload.disconnected
            ? 'interrupted'
            : 'error';
      const next: TransferItem = {
        id: payload.transfer_id,
        name: payload.name,
        direction: directionOf(payload.direction),
        status,
        transferred: payload.transferred,
        total: payload.total,
        filesDone: payload.files_done,
        filesTotal: payload.files_total,
        paused: false,
        error: payload.success
          ? undefined
          : payload.disconnected
            ? INTERRUPTED_MESSAGE_KEY
            : (payload.error ?? undefined),
        startedAt: current?.startedAt ?? now,
        updatedAt: now,
        speed: 0,
        request: current?.request
      };

      if (index === -1) {
        return { transfers: [next, ...state.transfers] };
      }

      const transfers = [...state.transfers];
      transfers[index] = next;
      return { transfers };
    }),

  setPaused: (id, paused) =>
    set((state) => ({
      transfers: state.transfers.map((item) => {
        if (item.id !== id || !isActive(item.status)) {
          return item;
        }
        return {
          ...item,
          paused,
          status: paused ? 'paused' : 'running',
          updatedAt: Date.now()
        };
      })
    })),

  markSessionDisconnected: (sessionId) =>
    set((state) => ({
      transfers: state.transfers.map((item) => {
        if (item.request?.sessionId !== sessionId || !isActive(item.status)) {
          return item;
        }
        return {
          ...item,
          status: 'interrupted',
          paused: false,
          speed: 0,
          error: INTERRUPTED_MESSAGE_KEY,
          updatedAt: Date.now()
        };
      })
    })),

  removeSessionTransfers: (sessionId) =>
    set((state) => ({
      transfers: state.transfers.filter((item) => item.request?.sessionId !== sessionId)
    })),

  clearFinished: () =>
    set((state) => ({
      transfers: state.transfers.filter((item) => isActive(item.status))
    })),

  remove: (id) =>
    set((state) => ({
      transfers: state.transfers.filter((item) => item.id !== id)
    }))
}));
