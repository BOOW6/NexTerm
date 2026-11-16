import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger';
type Size = 'xs' | 'sm' | 'md' | 'icon' | 'icon-sm' | 'icon-md';

const variants: Record<Variant, string> = {
  primary:
    'border-accent-strong bg-button-primary text-accent-foreground shadow-panel hover:brightness-105 active:shadow-pressed',
  secondary:
    'border-border-strong bg-button text-foreground shadow-panel hover:bg-button-hover active:shadow-pressed',
  ghost:
    'border-transparent bg-transparent text-muted hover:bg-surface-hover hover:text-foreground',
  outline:
    'border-border-strong bg-transparent text-foreground hover:bg-surface-hover active:shadow-pressed',
  danger: 'border-error bg-error text-white hover:brightness-110 active:shadow-pressed'
};

const sizes: Record<Size, string> = {
  xs: 'h-5 px-1.5 text-tiny',
  sm: 'h-6 px-2 text-meta',
  md: 'h-7 px-2.5 text-xs',
  icon: 'h-7 w-7 p-0',
  'icon-sm': 'h-5 w-5 p-0',
  'icon-md': 'h-6 w-6 p-0'
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'secondary', size = 'md', type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      data-variant={variant}
      className={cn(
        'app-button inline-flex select-none items-center justify-center gap-1.5 rounded-sm border font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring',
        'disabled:pointer-events-none disabled:opacity-50',
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    />
  )
);

Button.displayName = 'Button';
