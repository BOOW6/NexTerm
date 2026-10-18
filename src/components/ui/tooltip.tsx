import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface TooltipProps {
  label: string;
  children: ReactNode;
  className?: string;
}

export function Tooltip({ label, children, className }: TooltipProps) {
  return (
    <span className={cn('group relative inline-flex', className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute left-1/2 top-full z-50 mt-1 -translate-x-1/2 whitespace-nowrap',
          'rounded-sm border border-border-strong bg-surface px-1.5 py-0.5 text-[11px] text-foreground shadow-popup',
          'opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100'
        )}
      >
        {label}
      </span>
    </span>
  );
}
