import { describe, expect, it } from 'vitest';
import {
  formatShellArgs,
  matchLocalShellPreset,
  normalizeShellCommand,
  splitShellArgs,
  type LocalShellCatalog
} from './localShells';

describe('splitShellArgs', () => {
  it('splits on whitespace', () => {
    expect(splitShellArgs('  --cd   ~ ')).toEqual(['--cd', '~']);
  });

  it('keeps quoted whitespace as one token', () => {
    expect(splitShellArgs('--exec "C:\\Program Files\\app.exe" -v')).toEqual([
      '--exec',
      'C:\\Program Files\\app.exe',
      '-v'
    ]);
  });

  it('returns an empty array for blank input', () => {
    expect(splitShellArgs('   ')).toEqual([]);
  });

  it('round-trips through formatShellArgs', () => {
    const args = ['--cd', '~', '--title', 'My Shell'];
    expect(splitShellArgs(formatShellArgs(args))).toEqual(args);
  });
});

describe('normalizeShellCommand', () => {
  it('trims whitespace', () => {
    expect(normalizeShellCommand('  wsl.exe  ')).toBe('wsl.exe');
  });

  it('strips one pair of wrapping quotes', () => {
    expect(normalizeShellCommand('"C:\\Program Files\\Git\\bin\\bash.exe"')).toBe(
      'C:\\Program Files\\Git\\bin\\bash.exe'
    );
  });

  it('keeps interior quotes', () => {
    expect(normalizeShellCommand('say "hello" world')).toBe('say "hello" world');
  });
});

describe('matchLocalShellPreset', () => {
  const catalog: LocalShellCatalog = {
    presets: [
      { id: 'default', labelKey: 'localShell.default', available: true },
      { id: 'wsl', labelKey: 'localShell.wsl', command: 'wsl.exe', args: ['--cd', '~'] },
      { id: 'pwsh', labelKey: 'localShell.pwsh', command: 'pwsh.exe' }
    ],
    commands: {
      default: undefined,
      wsl: { command: 'wsl.exe', args: ['--cd', '~'] },
      pwsh: { command: 'pwsh.exe', args: [] }
    }
  };

  it('matches a preset by command and args', () => {
    expect(matchLocalShellPreset('wsl.exe', ['--cd', '~'], catalog)).toBe('wsl');
  });

  it('matches case-insensitively', () => {
    expect(matchLocalShellPreset('WSL.EXE', ['--cd', '~'], catalog)).toBe('wsl');
  });

  it('falls back to custom when args differ', () => {
    expect(matchLocalShellPreset('wsl.exe', [], catalog)).toBe('custom');
  });

  it('falls back to custom for unknown commands', () => {
    expect(matchLocalShellPreset('fish', [], catalog)).toBe('custom');
  });
});
