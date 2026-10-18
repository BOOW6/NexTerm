import type { ITheme } from '@xterm/xterm';

function readHsl(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const raw = styles.getPropertyValue(name).trim();
  if (!raw) {
    return fallback;
  }
  const parts = raw.split(/\s+/);
  return parts.length === 3 ? `hsl(${parts[0]}, ${parts[1]}, ${parts[2]})` : raw;
}

/**
 * Build an xterm theme from the active CSS variables so the terminal follows
 * light/dark (and future custom themes) without hard-coded colors.
 */
export function getTerminalTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);

  return {
    background: readHsl(styles, '--terminal-background', '#16202b'),
    foreground: readHsl(styles, '--terminal-foreground', '#dce6f2'),
    cursor: readHsl(styles, '--terminal-cursor', '#5b9bd5'),
    cursorAccent: readHsl(styles, '--terminal-background', '#16202b'),
    selectionBackground:
      styles.getPropertyValue('--terminal-selection').trim() || 'rgba(91,155,213,0.35)',
    black: '#1b2632',
    red: '#d9534f',
    green: '#4caf70',
    yellow: '#e0a030',
    blue: '#5b9bd5',
    magenta: '#b07cc6',
    cyan: '#4bb3c4',
    white: '#dce6f2',
    brightBlack: '#5a6b7b',
    brightRed: '#ef7a76',
    brightGreen: '#6fd394',
    brightYellow: '#f0c060',
    brightBlue: '#7fb2e5',
    brightMagenta: '#c79bd8',
    brightCyan: '#6fd0df',
    brightWhite: '#f4f8fc'
  };
}
