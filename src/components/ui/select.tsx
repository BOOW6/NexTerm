import { forwardRef, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/cn';

type SelectSize = 'md' | 'sm';

const selectSizes: Record<SelectSize, string> = {
  md: 'h-7 text-xs',
  sm: 'h-5 text-meta'
};

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: SelectSize;
  width?: string | number;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, size = 'md', width, style, children, ...props }, ref) => (
    <div className="relative">
      <select
        ref={ref}
        style={{ width: typeof width === 'number' ? `${width}px` : width, ...style }}
        className={cn(
          'app-select appearance-none rounded-sm border border-border-strong bg-surface px-2 pr-7 text-foreground shadow-inset',
          selectSizes[size],
          width === undefined && 'w-full',
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
