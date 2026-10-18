import { forwardRef, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/cn';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <div className="relative">
      <select
        ref={ref}
        className={cn(
          'h-7 w-full appearance-none rounded-sm border border-border-strong bg-surface px-2 pr-7 text-xs text-foreground shadow-inset',
          'focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
    </div>
  )
);

Select.displayName = 'Select';
