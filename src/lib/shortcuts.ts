export interface ParsedShortcut {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string;
}

const MODIFIER_KEYS = new Set([
  'control',
  'shift',
  'alt',
  'meta',
  'os',
  'altgraph'
]);

function normalizeKey(key: string): string {
  if (key === ' ') {
    return 'space';
  }
  return key.toLowerCase();
}

export function parseShortcut(value: string): ParsedShortcut | null {
  const parts = value
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  const parsed: ParsedShortcut = {
    ctrl: false,
    shift: false,
    alt: false,
    meta: false,
    key: ''
  };

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') {
      parsed.ctrl = true;
    } else if (lower === 'shift') {
      parsed.shift = true;
    } else if (lower === 'alt' || lower === 'option') {
      parsed.alt = true;
    } else if (lower === 'meta' || lower === 'cmd' || lower === 'super') {
      parsed.meta = true;
    } else {
      parsed.key = normalizeKey(part);
    }
  }

  return parsed.key ? parsed : null;
}

export function formatShortcutFromEvent(event: KeyboardEvent): string | null {
  const key = event.key;
  if (!key || MODIFIER_KEYS.has(key.toLowerCase())) {
    return null;
  }

  if (!event.ctrlKey && !event.altKey && !event.metaKey) {
    return null;
  }

  const parts: string[] = [];
  if (event.ctrlKey) {
    parts.push('Ctrl');
  }
  if (event.altKey) {
    parts.push('Alt');
  }
  if (event.shiftKey) {
    parts.push('Shift');
  }
  if (event.metaKey) {
    parts.push('Meta');
  }

  const displayKey =
    key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key;
  parts.push(displayKey);

  return parts.join('+');
}

export function matchesShortcut(event: KeyboardEvent, value: string): boolean {
  const parsed = parseShortcut(value);
  if (!parsed) {
    return false;
  }

  return (
    event.ctrlKey === parsed.ctrl &&
    event.shiftKey === parsed.shift &&
    event.altKey === parsed.alt &&
    event.metaKey === parsed.meta &&
    normalizeKey(event.key) === parsed.key
  );
}
