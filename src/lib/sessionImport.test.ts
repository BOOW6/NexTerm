import { describe, expect, it } from 'vitest';
import {
  importKey,
  parseMobaXterm,
  parseNexTermBackup,
  parsePuTTY,
  parseSshConfig,
  serializeSessionBackup
} from './sessionImport';
import type { Session } from '../types/session';

describe('parseSshConfig', () => {
  it('parses hosts, aliases and key paths', () => {
    const sessions = parseSshConfig(`
      Host *
        ServerAliveInterval 30

      Host prod
        HostName 10.0.0.10
        User root
        Port 2222
        IdentityFile ~/.ssh/id_ed25519

      Host staging staging.example.com
        HostName staging.example.com
        User deploy
    `);

    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      title: 'prod',
      host: '10.0.0.10',
      port: 2222,
      username: 'root',
      authMethod: 'key',
      keyPath: '~/.ssh/id_ed25519'
    });
    expect(sessions[1]).toMatchObject({
      title: 'staging',
      host: 'staging.example.com',
      username: 'deploy',
      authMethod: 'password'
    });
  });

  it('skips wildcard-only host blocks and deduplicates', () => {
    const sessions = parseSshConfig(`
      Host *.example.com
        User root
      Host same
        HostName 10.0.0.1
        User root
      Host same-again
        HostName 10.0.0.1
        User root
    `);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].title).toBe('same');
  });
});

describe('parseMobaXterm', () => {
  it('parses bookmarks and nested SubRep folders', () => {
    const sessions = parseMobaXterm(`
[Bookmarks]
0=1

[Bookmarks_1]
BookmarkName=Prod
Host=10.0.0.20
Port=22
UserName=admin
Protocol=SSH
SubRep=Servers\\Linux
`);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      title: 'Prod',
      host: '10.0.0.20',
      username: 'admin',
      group: 'MobaXterm/Servers/Linux'
    });
  });
});

describe('parsePuTTY', () => {
  it('parses registry exports', () => {
    const sessions = parsePuTTY(`
Windows Registry Editor Version 5.00

[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\Lab%2Fdb]
"HostName"="10.0.0.30"
"UserName"="deploy"
"PortNumber"=dword:00000016
"Protocol"="ssh"
"PublicKeyFile"="C:\\\\keys\\\\id_rsa"
`);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      title: 'db',
      host: '10.0.0.30',
      port: 22,
      username: 'deploy',
      authMethod: 'key',
      group: 'PuTTY/Lab'
    });
  });
});

describe('NexTerm backup', () => {
  const session: Session = {
    id: 'a',
    kind: 'ssh',
    title: 'Prod',
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    authMethod: 'password',
    group: 'Servers/Prod',
    favorite: true,
    status: 'idle',
    createdAt: 1,
    lastUsed: 2
  };

  it('round-trips sessions without ids or credentials', () => {
    const backup = serializeSessionBackup([session]);
    expect(backup).not.toContain('"id"');
    expect(backup).not.toContain('passwords');
    const imported = parseNexTermBackup(backup);
    expect(imported[0]).toMatchObject({
      title: 'Prod',
      host: '10.0.0.1',
      group: 'Servers/Prod',
      favorite: true
    });
    expect(importKey(imported[0])).toBe('ssh|10.0.0.1|22|root');
  });

  it('rejects unrelated JSON', () => {
    expect(() => parseNexTermBackup('{"hello":true}')).toThrow();
  });
});
