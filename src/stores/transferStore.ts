import { create } from 'zustand';
import type {
  SftpProgressPayload,
  SftpTransferDonePayload
} from '../hooks/useTauriSsh';

export type TransferDirection = 'upload' | 'download';
export type TransferStatus = 'running' | 'done' | 'error';

export interface TransferItem {
  id: string;
  name: string;
  direction: TransferDirection;
  status: TransferStatus;
  transferred: number;
  total: number;
  error?: string;
  startedAt: number;
  updatedAt: number;
  speed: number;
}

interface TransferState {
  transfers: TransferItem[];
  applyProgress: (payload: SftpProgressPayload) => void;
  finish: (payload: SftpTransferDonePayload) => void;
  clearFinished: () => void;
  remove: (id: string) => void;
}

function directionOf(value: string): TransferDirection {
  return value === 'upload' ? 'upload' : 'download';
}

export const useTransferStore = create<TransferState>((set) => ({
  transfers: [],

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
      const speed =
        elapsed > 0 && delta >= 0 ? delta / elapsed : current.speed;

      transfers[index] = {
        ...current,
        status: 'running',
        transferred: payload.transferred,
        total: payload.total,
        updatedAt: now,
        speed
      };

      return { transfers };
    }),

  finish: (payload) =>
    set((state) => {
      const now = Date.now();
      const index = state.transfers.findIndex((item) => item.id === payload.transfer_id);
      const next: TransferItem = {
        id: payload.transfer_id,
        name: payload.name,
        direction: directionOf(payload.direction),
        status: payload.success ? 'done' : 'error',
        transferred: payload.transferred,
        total: payload.total,
        error: payload.error ?? undefined,
        startedAt: index === -1 ? now : state.transfers[index].startedAt,
        updatedAt: now,
        speed: 0
      };

      if (index === -1) {
        return { transfers: [next, ...state.transfers] };
      }

      const transfers = [...state.transfers];
      transfers[index] = next;
      return { transfers };
    }),

  clearFinished: () =>
    set((state) => ({
      transfers: state.transfers.filter((item) => item.status === 'running')
    })),

  remove: (id) =>
    set((state) => ({
      transfers: state.transfers.filter((item) => item.id !== id)
    }))
}));
