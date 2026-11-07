/**
 * File naming for session output logs. One log file is decided per terminal
 * activation (panel mount) so auto-reconnects keep appending to the same
 * file instead of scattering timestamped fragments.
 */

const ILLEGAL_CHARACTERS = /[/\\*?:"<>|]/g;

export function sanitizeLogTitle(title: string): string {
  const cleaned = title.replace(ILLEGAL_CHARACTERS, '_').trim();
  // A title made entirely of separators (e.g. "///") sanitizes to only
  // underscores; fall back to a stable name instead.
  return cleaned && !/^_+$/.test(cleaned) ? cleaned : 'session';
}

export function sessionLogFileName(title: string, at: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(
    at.getHours()
  )}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${sanitizeLogTitle(title)}-${stamp}.log`;
}

export function sessionLogPath(dir: string, title: string, at: Date = new Date()): string {
  const trimmed = dir.trim();
  if (!trimmed) {
    return '';
  }
  // Keep the platform flavor of the chosen directory path.
  const separator = trimmed.endsWith('\\') || trimmed.endsWith('/') ? '' : trimmed.includes('\\') ? '\\' : '/';
  return `${trimmed}${separator}${sessionLogFileName(title, at)}`;
}
