import { forwardRef, type InputHTMLAttributes, type LabelHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      autoComplete="off"
      spellCheck={false}
      className={cn(
        'h-7 w-full rounded-sm border border-border-strong bg-surface px-2 text-xs text-foreground shadow-inset',
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
