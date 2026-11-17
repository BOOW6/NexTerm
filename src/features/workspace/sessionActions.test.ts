import { describe, expect, it } from 'vitest';
import { toSessionDraft } from './sessionActions';
import type { Session } from '../../types/session';

const SESSION: Session = {
  id: 's1',
  kind: 'ssh',
  title: 'prod',
  host: 'example.com',
  port: 2222,
  username: 'deploy',
  authMethod: 'certificate',
  keyPath: '/keys/id_ed25519',
  certPath: '/keys/id_ed25519-cert.pub',
  jumpSessionId: 'jump-1',
  group: 'prod',
  favorite: true,
  status: 'idle',
  createdAt: 1,
  lastUsed: 2
};

describe('toSessionDraft', () => {
  it('carries every connection field, including certPath', () => {
    const draft = toSessionDraft(SESSION);
    expect(draft.kind).toBe('ssh');
    expect(draft.certPath).toBe('/keys/id_ed25519-cert.pub');
    expect(draft.keyPath).toBe('/keys/id_ed25519');
    expect(draft.jumpSessionId).toBe('jump-1');
    expect(draft.group).toBe('prod');
  });

  it('maps the full SessionDraft shape (guards against forgotten fields when Session grows)', () => {
    const draft = toSessionDraft(SESSION);
    const draftFields = [
      'kind',
      'title',
      'host',
      'port',
      'username',
      'authMethod',
      'keyPath',
      'certPath',
      'jumpSessionId',
      'shellCommand',
      'shellArgs',
      'serialPort',
      'serialBaud',
      'group',
      'favorite'
    ] as const;
    for (const field of draftFields) {
      expect(draft, `SessionDraft.${field} must be mapped from Session`).toHaveProperty(field);
    }
  });

  it('keeps the kind-specific shell and serial configuration', () => {
    const draft = toSessionDraft({
      ...SESSION,
      kind: 'serial',
      serialPort: 'COM3',
      serialBaud: 115200
    });
    expect(draft.serialPort).toBe('COM3');
    expect(draft.serialBaud).toBe(115200);

    const local = toSessionDraft({
      ...SESSION,
      kind: 'local',
      shellCommand: 'C:\\Program Files\\Git\\bin\\bash.exe',
      shellArgs: ['-l']
    });
    expect(local.shellCommand).toContain('bash.exe');
    expect(local.shellArgs).toEqual(['-l']);
  });
});
