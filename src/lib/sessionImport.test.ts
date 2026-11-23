import { beforeEach, describe, expect, it } from 'vitest';
import {
  importKey,
  importSessionsIntoStore,
  parseMobaXterm,
  parseNexTermBackup,
  parsePuTTY,
  parseSshConfig,
  serializeSessionBackup
} from './sessionImport';
import { useSessionStore } from '../stores/sessionStore';
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

  it('preserves hashes inside quoted values', () => {
    const sessions = parseSshConfig(`
      Host prod
        HostName 10.0.0.10
        IdentityFile "/keys/with #hash/id"
    `);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].keyPath).toBe('/keys/with #hash/id');
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

  it('round-trips every session kind with all v2 fields', () => {
    // Regression: v1 backups silently dropped Telnet and Serial kinds,
    // coerced certificate auth to password and lost ProxyJump, custom shell
    // and serial settings on restore.
    const sessions: Session[] = [
      {
        ...session,
        id: 'tel',
        kind: 'telnet',
        title: 'Legacy box',
        host: 'bbs.example.com',
        port: 23,
        authMethod: 'password',
        username: undefined
      },
      {
        ...session,
        id: 'ser',
        kind: 'serial',
        title: 'Console',
        host: undefined,
        port: undefined,
        serialPort: 'COM3',
        serialBaud: 115200
      },
      {
        ...session,
        id: 'cert',
        kind: 'ssh',
        title: 'Cert hop',
        authMethod: 'certificate',
        keyPath: '/keys/id_ed25519',
        certPath: '/keys/id_ed25519-cert.pub'
      },
      {
        ...session,
        id: 'jump',
        kind: 'sftp',
        title: 'Files via bastion',
        jumpSessionId: 'cert',
        username: 'files'
      },
      {
        ...session,
        id: 'local',
        kind: 'local',
        title: 'pwsh',
        host: undefined,
        port: undefined,
        shellCommand: 'pwsh.exe',
        shellArgs: ['-NoLogo', '-WorkingDirectory', 'C:\\dev']
      }
    ];

    const imported = parseNexTermBackup(serializeSessionBackup(sessions));

    const byTitle = new Map(imported.map((item) => [item.title, item]));
    const telnet = byTitle.get('Legacy box');
    expect(telnet).toMatchObject({ kind: 'telnet', host: 'bbs.example.com', port: 23 });
    const serial = byTitle.get('Console');
    expect(serial).toMatchObject({
      kind: 'serial',
      serialPort: 'COM3',
      serialBaud: 115200,
      host: undefined,
      port: undefined
    });
    expect(byTitle.get('Cert hop')).toMatchObject({
      kind: 'ssh',
      authMethod: 'certificate',
      keyPath: '/keys/id_ed25519',
      certPath: '/keys/id_ed25519-cert.pub'
    });
    expect(byTitle.get('Files via bastion')).toMatchObject({
      kind: 'sftp',
      jumpSessionId: 'cert',
      username: 'files'
    });
    expect(byTitle.get('pwsh')).toMatchObject({
      kind: 'local',
      shellCommand: 'pwsh.exe',
      shellArgs: ['-NoLogo', '-WorkingDirectory', 'C:\\dev']
    });
  });

  it('keeps importing v1 backups that only carry the old fields', () => {
    const v1 = JSON.stringify({
      app: 'NexTerm',
      version: 1,
      exportedAt: '2025-01-01T00:00:00.000Z',
      sessions: [
        {
          kind: 'ssh',
          title: 'Old',
          host: '10.0.0.9',
          port: 2200,
          username: 'root',
          authMethod: 'key',
          keyPath: '/keys/id_rsa',
          group: 'Legacy',
          favorite: false
        },
        // v1 writers emitted serial/telnet kinds, but the old importer
        // coerced them to ssh: restoring them as their real kind is the fix.
        { kind: 'telnet', title: 'Old bbs', host: 'bbs.example.com', port: 23, group: 'Legacy' }
      ]
    });

    const imported = parseNexTermBackup(v1);
    expect(imported[0]).toMatchObject({
      kind: 'ssh',
      authMethod: 'key',
      keyPath: '/keys/id_rsa',
      port: 2200
    });
    expect(imported[1]).toMatchObject({ kind: 'telnet', host: 'bbs.example.com', port: 23 });
  });

  it('rejects unrelated JSON', () => {
    expect(() => parseNexTermBackup('{"hello":true}')).toThrow();
  });

  it('clamps out-of-range backup ports to the default', () => {
    const backup = serializeSessionBackup([{ ...session, port: 99999 }]);
    const imported = parseNexTermBackup(backup);
    expect(imported[0].port).toBe(22);
  });
});

describe('ProxyJump remap on import', () => {
  const jump: Session = {
    id: 'old-jump-id',
    kind: 'ssh',
    title: 'Bastion',
    host: '10.0.0.1',
    port: 22,
    username: 'ops',
    authMethod: 'key',
    keyPath: '/keys/id_ed25519',
    group: 'Infra',
    favorite: false,
    status: 'idle',
    createdAt: 1,
    lastUsed: 2
  };
  const target: Session = {
    id: 'old-target-id',
    kind: 'sftp',
    title: 'Files',
    host: '10.0.0.2',
    port: 22,
    username: 'files',
    authMethod: 'key',
    jumpSessionId: 'old-jump-id',
    group: 'Infra',
    favorite: false,
    status: 'idle',
    createdAt: 3,
    lastUsed: 4
  };

  beforeEach(() => {
    useSessionStore.setState({ sessions: [] });
  });

  it('restores ProxyJump onto the ids the store assigns in a fresh environment', () => {
    // Round-trip through the real v2 backup format, then import through the
    // real store pipeline: the old ids do not exist here, so the reference
    // must be rewritten to the newly created bastion.
    const imported = parseNexTermBackup(serializeSessionBackup([jump, target]));
    const { created, skipped } = importSessionsIntoStore(imported, { defaultUsername: 'root' });

    expect(skipped).toBe(0);
    expect(created).toHaveLength(2);

    const sessions = useSessionStore.getState().sessions;
    const bastion = sessions.find((session) => session.title === 'Bastion');
    const files = sessions.find((session) => session.title === 'Files');
    expect(bastion).toBeDefined();
    expect(files).toBeDefined();
    // The jump reference points at the NEW bastion id, not at the source id.
    expect(files?.jumpSessionId).toBe(bastion?.id);
    expect(files?.jumpSessionId).not.toBe('old-jump-id');
  });

  it('drops dangling jump references instead of keeping a source-environment id', () => {
    // A backup whose jump target was not exported (hand-edited file).
    const backup = JSON.stringify({
      app: 'NexTerm',
      version: 2,
      sessions: [
        {
          sourceId: 'still-here',
          kind: 'sftp',
          title: 'Orphan',
          host: '10.0.0.3',
          port: 22,
          authMethod: 'password',
          jumpSessionId: 'not-in-this-file',
          group: 'Infra'
        }
      ]
    });
    const imported = parseNexTermBackup(backup);
    importSessionsIntoStore(imported, { defaultUsername: 'root' });

    const session = useSessionStore.getState().sessions[0];
    expect(session?.title).toBe('Orphan');
    expect(session?.jumpSessionId).toBeUndefined();
  });

  it('keeps v1 imports working without proxy references', () => {
    const v1 = JSON.stringify({
      app: 'NexTerm',
      version: 1,
      sessions: [
        {
          kind: 'ssh',
          title: 'Legacy',
          host: '10.0.0.9',
          port: 2200,
          username: 'root',
          authMethod: 'key',
          keyPath: '/keys/id_rsa',
          group: 'Legacy'
        }
      ]
    });
    const imported = parseNexTermBackup(v1);
    importSessionsIntoStore(imported, { defaultUsername: 'root' });
    const session = useSessionStore.getState().sessions[0];
    expect(session?.host).toBe('10.0.0.9');
    expect(session?.jumpSessionId).toBeUndefined();
  });
});
