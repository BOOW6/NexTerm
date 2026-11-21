import { describe, expect, it } from 'vitest';
import { joinRemotePath, remoteBaseName, remoteParentPath } from './remotePath';

describe('joinRemotePath', () => {
  it('avoids double slashes when the directory ends with one', () => {
    expect(joinRemotePath('/', 'etc')).toBe('/etc');
    expect(joinRemotePath('/var/', 'log')).toBe('/var/log');
  });

  it('joins with a slash otherwise', () => {
    expect(joinRemotePath('/var', 'log')).toBe('/var/log');
  });
});

describe('remoteBaseName', () => {
  it('returns the last segment', () => {
    expect(remoteBaseName('/var/log/syslog')).toBe('syslog');
    expect(remoteBaseName('/etc/')).toBe('etc');
  });

  it('splits Windows-style separators from local upload paths', () => {
    expect(remoteBaseName('C:\\Users\\me\\notes.txt')).toBe('notes.txt');
  });

  it('falls back for empty input', () => {
    expect(remoteBaseName('')).toBe('file');
  });
});

describe('remoteParentPath', () => {
  it('strips the last segment', () => {
    expect(remoteParentPath('/var/log')).toBe('/var');
    expect(remoteParentPath('/var/log/')).toBe('/var');
  });

  it('collapses to the root at the first level', () => {
    expect(remoteParentPath('/var')).toBe('/');
  });

  it('keeps the root stable', () => {
    expect(remoteParentPath('/')).toBe('/');
  });
});
