import { describe, expect, it } from 'vitest';
import { commandBasename, resolveCursorLineResizeMode } from './terminalResizePolicy';

describe('commandBasename', () => {
  it('extracts the executable from Windows and Unix paths', () => {
    expect(commandBasename('C:\\Windows\\System32\\cmd.exe')).toBe('cmd.exe');
    expect(commandBasename('/bin/bash')).toBe('bash');
    expect(commandBasename('C:\\Program Files\\Git\\bin\\bash.exe')).toBe('bash.exe');
  });

  it('handles quoted commands and empty input', () => {
    expect(commandBasename('"C:\\Program Files\\Git\\bin\\bash.exe"')).toBe('bash.exe');
    expect(commandBasename('   ')).toBe('');
    expect(commandBasename(undefined)).toBe('');
  });
});

describe('resolveCursorLineResizeMode', () => {
  it('lets cmd reflow locally', () => {
    expect(
      resolveCursorLineResizeMode({
        transport: 'local',
        shellCommand: 'C:\\Windows\\System32\\cmd.exe',
        backend: 'conpty'
      })
    ).toBe('local-reflow');
    expect(
      resolveCursorLineResizeMode({ transport: 'local', shellCommand: 'cmd', backend: 'conpty' })
    ).toBe('local-reflow');
  });

  it('treats the default ConPTY shell as cmd', () => {
    expect(resolveCursorLineResizeMode({ transport: 'local', backend: 'conpty' })).toBe(
      'local-reflow'
    );
    expect(resolveCursorLineResizeMode({ transport: 'local', backend: null })).toBe(
      'shell-repaint'
    );
  });

  it.each(['cmd.exe', 'powershell.exe', 'pwsh.exe'])('lets %s reflow locally', (shellCommand) => {
    expect(resolveCursorLineResizeMode({ transport: 'local', shellCommand })).toBe('local-reflow');
  });

  it.each(['wsl.exe', 'bash', 'zsh', 'fish'])(
    'leaves %s to repaint its own prompt',
    (shellCommand) => {
      expect(resolveCursorLineResizeMode({ transport: 'local', shellCommand })).toBe(
        'shell-repaint'
      );
    }
  );

  it.each(['ssh', 'telnet', 'serial'] as const)('never reflows a %s cursor line', (transport) => {
    expect(
      resolveCursorLineResizeMode({
        transport,
        shellCommand: 'cmd.exe',
        backend: 'conpty'
      })
    ).toBe('shell-repaint');
  });

  it('defaults custom local shells to repainting', () => {
    expect(
      resolveCursorLineResizeMode({
        transport: 'local',
        shellCommand: 'C:\\tools\\my-shell.exe',
        backend: 'conpty'
      })
    ).toBe('shell-repaint');
  });
});
