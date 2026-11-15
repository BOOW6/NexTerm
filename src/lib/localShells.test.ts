import { describe, expect, it } from 'vitest';
import {
  buildShellCatalog,
  formatShellArgs,
  matchLocalShellPreset,
  normalizeShellCommand,
  splitShellArgs,
  type LocalShellCatalog,
  type LocalShellPreset
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

describe('buildShellCatalog', () => {
  const presets: LocalShellPreset[] = [
    { id: 'default', labelKey: 'localShell.default' },
    { id: 'powershell', labelKey: 'localShell.powershell', command: 'powershell.exe' },
    { id: 'pwsh', labelKey: 'localShell.pwsh', command: 'pwsh.exe' },
    { id: 'wsl', labelKey: 'localShell.wsl', command: 'wsl.exe', args: ['--cd', '~'] },
    {
      id: 'gitbash',
      labelKey: 'localShell.gitbash',
      probeCandidates: ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Git\\bin\\bash.exe']
    },
    { id: 'cmd', labelKey: 'localShell.cmd', command: 'cmd.exe' }
  ];

  it('does not shift probe results when the default preset has no command', () => {
    // Regression: the empty candidate the default preset used to contribute
    // shifted every later slice by one, so Git Bash resolved to wsl.exe.
    const resolved = [
      'powershell.exe',
      'pwsh.exe',
      'wsl.exe',
      'C:\\Git\\bin\\bash.exe',
      null,
      'cmd.exe'
    ];
    const catalog = buildShellCatalog(presets, resolved);

    expect(catalog.commands.gitbash).toEqual({ command: 'C:\\Git\\bin\\bash.exe', args: [] });
    expect(catalog.commands.powershell).toEqual({ command: 'powershell.exe', args: [] });
    expect(catalog.commands.cmd).toEqual({ command: 'cmd.exe', args: [] });
    expect(catalog.presets.find((preset) => preset.id === 'default')?.available).toBe(true);
  });

  it('reports each preset availability from its own probe result', () => {
    const catalog = buildShellCatalog(presets, [
      'powershell.exe',
      null,
      'wsl.exe',
      null,
      null,
      null
    ]);
    const availability = Object.fromEntries(
      catalog.presets.map((preset) => [preset.id, preset.available])
    );
    expect(availability).toEqual({
      default: true,
      powershell: true,
      pwsh: false,
      wsl: true,
      gitbash: false,
      cmd: false
    });
  });

  it('keeps fixed-command presets usable when the probe fails', () => {
    const catalog = buildShellCatalog(presets, null);
    const availability = Object.fromEntries(
      catalog.presets.map((preset) => [preset.id, preset.available])
    );
    // Probe-only presets must not be guessed (that is how Git Bash ran WSL).
    expect(availability.gitbash).toBe(false);
    expect(availability.default).toBe(true);
    expect(availability.powershell).toBe(true);
    expect(availability.cmd).toBe(true);
    expect(catalog.commands.gitbash).toBeUndefined();
    expect(catalog.commands.wsl).toEqual({ command: 'wsl.exe', args: ['--cd', '~'] });
  });
});
