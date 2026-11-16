import { useI18n } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  danger?: boolean;
  separatorBefore?: boolean;
  disabled?: boolean;
  shortcut?: string;
}

export interface DropdownMenuProps {
  items: MenuItem[];
  align?: 'start' | 'end';
  className?: string;
  label?: string;
}

export function DropdownMenu({ items, align = 'end', className, label }: DropdownMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const resolvedLabel = label ?? t('ui.moreActions');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={resolvedLabel}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        className={cn(
          'inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted transition-colors',
          'hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring',
          open && 'bg-surface-active text-foreground',
          className
        )}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>

      {open ? (
        <div
          role="menu"
          className={cn(
            'app-popup animate-zoom-in absolute top-full z-40 mt-0.5 min-w-40 border border-border-strong bg-surface-elevated',
            align === 'end' ? 'right-0' : 'left-0'
          )}
        >
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <div key={item.label}>
                {item.separatorBefore ? (
                  <div className="my-0.5 h-px bg-border" role="separator" />
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpen(false);
                    item.onSelect();
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-xs transition-colors',
                    'disabled:cursor-not-allowed disabled:opacity-40',
                    item.danger
                      ? 'text-error hover:bg-error hover:text-white'
                      : 'text-foreground hover:bg-accent hover:text-accent-foreground'
                  )}
                >
                  {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
                  <span className="flex-1">{item.label}</span>
                  {item.shortcut ? (
                    <span className="text-tiny opacity-60">{item.shortcut}</span>
                  ) : null}
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
