import { useI18n } from '../../i18n';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent
} from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface EditableSelectOption {
  label: string;
  value: string;
}

interface EditableSelectProps {
  id?: string;
  value: string;
  options: EditableSelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
}

export function EditableSelect({
  id,
  value,
  options,
  onChange,
  placeholder,
  ariaLabel,
  className
}: EditableSelectProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    width: number;
    openUp: boolean;
  } | null>(null);
  const listId = useId();

  const visibleOptions = useMemo(() => {
    // A complete CSS font stack is not a useful search term, but a plain
    // family name is. This keeps the picker usable with hundreds of fonts.
    if (value.includes(',') || value.includes('"') || value.includes("'")) {
      return options;
    }
    const query = value.trim().toLowerCase();
    if (!query) {
      return options;
    }
    const matches = options.filter(
      (option) =>
        option.label.toLowerCase().includes(query) || option.value.toLowerCase().includes(query)
    );
    return matches.length > 0 ? matches : options;
  }, [options, value]);

  const activeIndex = Math.min(highlight, Math.max(0, visibleOptions.length - 1));

  const updatePosition = () => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    const rect = input.getBoundingClientRect();
    const openUp = window.innerHeight - rect.bottom < 190 && rect.top > 190;
    setPosition({
      left: rect.left,
      top: openUp ? rect.top - 4 : rect.bottom + 4,
      width: rect.width,
      openUp
    });
  };

  const openMenu = () => {
    updatePosition();
    setHighlight(
      Math.max(
        0,
        options.findIndex((option) => option.value === value)
      )
    );
    setOpen(true);
  };

  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onScroll = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onResize = () => updatePosition();

    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    setHighlight(0);
    onChange(event.target.value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) {
        openMenu();
      } else {
        setHighlight(Math.min(visibleOptions.length - 1, activeIndex + 1));
      }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        openMenu();
      } else {
        setHighlight(Math.max(0, activeIndex - 1));
      }
    } else if (event.key === 'Enter') {
      if (open && visibleOptions[activeIndex]) {
        event.preventDefault();
        choose(visibleOptions[activeIndex].value);
      }
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <input
        id={id}
        ref={inputRef}
        value={value}
        onChange={handleChange}
        onFocus={openMenu}
        onClick={() => {
          if (!open) {
            openMenu();
          }
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        role="combobox"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        autoComplete="off"
        spellCheck={false}
        className={cn(
          'app-input h-7 w-full rounded-sm border border-border-strong bg-surface px-2 pr-8 text-xs text-foreground shadow-inset',
          'placeholder:text-muted-foreground',
          'focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring'
        )}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={t('ui.selectPreset')}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => (open ? setOpen(false) : openMenu())}
        className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted hover:bg-surface-hover hover:text-foreground"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>

      {open && position
        ? createPortal(
            <div
              ref={menuRef}
              id={listId}
              role="listbox"
              style={{
                left: position.left,
                top: position.top,
                width: position.width,
                transform: position.openUp ? 'translateY(-100%)' : undefined
              }}
              className="app-popup fixed z-[80] max-h-56 overflow-y-auto rounded-sm border border-border-strong bg-surface-elevated p-1 shadow-popup"
            >
              {visibleOptions.map((option, index) => (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => choose(option.value)}
                  className={cn(
                    'flex w-full flex-col items-start gap-0.5 rounded-sm px-2 py-1 text-left',
                    index === activeIndex
                      ? 'bg-accent text-accent-foreground'
                      : 'text-foreground hover:bg-surface-hover'
                  )}
                >
                  <span className="text-meta font-medium">{option.label}</span>
                  <span
                    className={cn(
                      'w-full truncate text-tiny',
                      index === activeIndex ? 'opacity-75' : 'text-muted-foreground'
                    )}
                  >
                    {option.value}
                  </span>
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
