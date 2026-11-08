import { create } from 'zustand';

export type ToastVariant = 'default' | 'success' | 'error' | 'warning';

export interface ToastOptions {
  title: string;
  description?: string;
  variant?: ToastVariant;
  duration?: number;
}

interface ToastItem extends Required<Pick<ToastOptions, 'title'>> {
  id: string;
  description?: string;
  variant: ToastVariant;
}

interface ToastState {
  toasts: ToastItem[];
  push: (options: ToastOptions) => void;
  dismiss: (id: string) => void;
}

const DEFAULT_DURATION = 4000;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: ({ title, description, variant = 'default', duration = DEFAULT_DURATION }) => {
    const id = crypto.randomUUID();
    set((state) => ({ toasts: [...state.toasts, { id, title, description, variant }] }));
    window.setTimeout(() => get().dismiss(id), duration);
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) }))
}));

export function toast(options: ToastOptions): void {
  useToastStore.getState().push(options);
}
