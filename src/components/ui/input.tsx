import { forwardRef, type InputHTMLAttributes, type LabelHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

type InputSize = 'md' | 'compact' | 'sm';

const inputSizes: Record<InputSize, string> = {
  md: 'h-7 text-xs',
  compact: 'h-7 text-[11px]',
  sm: 'h-5 text-[11px]'
};

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: InputSize;
  width?: string | number;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, size = 'md', width, style, ...props }, ref) => (
    <input
      ref={ref}
      autoComplete="off"
      spellCheck={false}
      style={{ width: typeof width === 'number' ? `${width}px` : width, ...style }}
      className={cn(
        'app-input rounded-sm border border-border-strong bg-surface px-2 text-foreground shadow-inset',
        inputSizes[size],
        width === undefined && 'w-full',
        'placeholder:text-muted-foreground',
        'focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
);

Input.displayName = 'Input';

export const Label = forwardRef<HTMLLabelElement, LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    <label
      ref={ref}
      className={cn('mb-1 block text-[11px] font-medium text-muted', className)}
      {...props}
    />
  )
);

Label.displayName = 'Label';
