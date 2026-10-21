import { create } from 'zustand';
import { AlertTriangle, CheckCircle2, Info, X, XCircle, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';

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

const icons: Record<ToastVariant, LucideIcon> = {
  default: Info,
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle
};

const iconColors: Record<ToastVariant, string> = {
  default: 'text-accent',
  success: 'text-success',
  error: 'text-error',
  warning: 'text-warning'
};

const leftBorders: Record<ToastVariant, string> = {
  default: 'border-l-accent',
  success: 'border-l-success',
  error: 'border-l-error',
  warning: 'border-l-warning'
};

export function Toaster() {
  const toasts = useToastStore((state) => state.toasts);
  const dismiss = useToastStore((state) => state.dismiss);

  return (
    <div className="pointer-events-none fixed bottom-9 right-3 z-[60] flex w-80 flex-col gap-1.5">
      {toasts.map((item) => {
        const Icon = icons[item.variant];
        return (
          <div
            key={item.id}
            role="status"
            className={cn(
              'pointer-events-auto flex animate-slide-in items-start gap-2 rounded-sm border border-l-2 border-border-strong bg-surface-elevated p-2 shadow-popup',
              leftBorders[item.variant]
            )}
          >
            <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', iconColors[item.variant])} />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-foreground">{item.title}</p>
              {item.description ? (
                <p className="mt-0.5 text-[11px] text-muted">{item.description}</p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => dismiss(item.id)}
              className="rounded-sm p-0.5 text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
              aria-label="关闭通知"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
