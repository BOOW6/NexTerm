import { tStatic } from '../i18n';
import {
  DEFAULT_GROUP,
  SESSION_KIND_LABEL_KEY,
  type Session,
  type SessionAuthMethod,
  type SessionKind
} from '../types/session';

export type ImportFormat = 'ssh-config' | 'mobaxterm' | 'putty' | 'nexterm';

export interface ImportedSession {
  kind: SessionKind;
  title: string;
  host?: string;
  port?: number;
  username?: string;
  authMethod: SessionAuthMethod;
  keyPath?: string;
  certPath?: string;
  /** SSH/SFTP only: the session whose connection tunnels this one. */
  jumpSessionId?: string;
  /** Local sessions only. */
  shellCommand?: string;
  shellArgs?: string[];
  /** Serial sessions only. */
  serialPort?: string;
  serialBaud?: number;
  group: string;
  favorite?: boolean;
}

export interface ImportSummary {
  sessions: ImportedSession[];
  skipped: number;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function stripInlineComment(value: string): string {
  return value.replace(/\s+#.*$/, '').trim();
}

function normalizePort(value: string | undefined, fallback = 22): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function dedupeSessions(sessions: ImportedSession[]): ImportedSession[] {
  const seen = new Set<string>();
  const result: ImportedSession[] = [];
  for (const session of sessions) {
    const key =
      session.kind === 'local'
        ? `local|${session.title}`
        : `${session.kind}|${session.host ?? ''}|${session.port ?? 22}|${session.username ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(session);
  }
  return result;
}

export function parseSshConfig(text: string, group = 'SSH Config'): ImportedSession[] {
  const sessions: ImportedSession[] = [];
  let current: {
    patterns: string[];
    hostname?: string;
    user?: string;
    port?: number;
    identity?: string;
    certificate?: string;
  } | null = null;
  let inMatch = false;
  // Options from a `Host *` block apply to every concrete host below it
  // (IdentityFile and User live there in most real configs).
  let wildcardDefaults: {
    hostname?: string;
    user?: string;
    port?: number;
    identity?: string;
    certificate?: string;
  } = {};

  const flush = () => {
    if (!current || inMatch) {
      current = null;
      return;
    }
    if (current.patterns.length === 1 && current.patterns[0] === '*') {
      wildcardDefaults = {
        hostname: current.hostname ?? wildcardDefaults.hostname,
        user: current.user ?? wildcardDefaults.user,
        port: current.port ?? wildcardDefaults.port,
        identity: current.identity ?? wildcardDefaults.identity,
        certificate: current.certificate ?? wildcardDefaults.certificate
      };
      current = null;
      return;
    }
    const alias = current.patterns.find(
      (pattern) =>
        pattern && !pattern.includes('*') && !pattern.includes('?') && !pattern.startsWith('!')
    );
    if (!alias) {
      current = null;
      return;
    }
    const host = current.hostname || alias;
    const identity = current.identity ?? wildcardDefaults.identity;
    const certificate = current.certificate ?? wildcardDefaults.certificate;
    sessions.push({
      kind: 'ssh',
      title: alias,
      host,
      port: current.port ?? wildcardDefaults.port ?? 22,
      username: current.user ?? wildcardDefaults.user ?? '',
      authMethod: certificate ? 'certificate' : identity ? 'key' : 'password',
      keyPath: identity,
      certPath: certificate,
      group
    });
    current = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*(?:=|\s)\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const keyword = match[1].toLowerCase();
    // A quoted value may legitimately contain '#' (e.g. IdentityFile
    // "/path/with #hash") — only strip comments on unquoted values.
    const raw = match[2].trim();
    const value = unquote(raw.startsWith('"') ? raw : stripInlineComment(raw));

    if (keyword === 'host') {
      flush();
      inMatch = false;
      current = { patterns: value.split(/\s+/).filter(Boolean) };
      continue;
    }
    if (keyword === 'match') {
      flush();
      inMatch = true;
      continue;
    }
    if (!current || inMatch) {
      continue;
    }

    if (keyword === 'hostname') {
      current.hostname = value;
    } else if (keyword === 'user') {
      current.user = value;
    } else if (keyword === 'port') {
      current.port = normalizePort(value);
    } else if (keyword === 'identityfile' && !current.identity) {
      current.identity = value;
    } else if (keyword === 'certificatefile' && !current.certificate) {
      current.certificate = value;
    }
  }

  flush();
  return dedupeSessions(sessions);
}

export function parseMobaXterm(text: string, group = 'MobaXterm'): ImportedSession[] {
  const sessions: ImportedSession[] = [];
  let section = '';
  let fields: Record<string, string> = {};

  const flush = () => {
    if (!section.toLowerCase().startsWith('bookmarks')) {
      return;
    }
    const host = fields.host?.trim();
    if (!host) {
      return;
    }
    const protocol = (fields.protocol ?? 'ssh').toLowerCase();
    if (!protocol.includes('ssh') && !protocol.includes('sftp')) {
      return;
    }
    const subRep = (fields.subrep ?? '')
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '')
      .trim();
    sessions.push({
      kind: protocol.includes('sftp') ? 'sftp' : 'ssh',
      title: fields.bookmarkname?.trim() || host,
      host,
      port: normalizePort(fields.port),
      username: fields.username?.trim() ?? '',
      authMethod: fields.privatekey?.trim() ? 'key' : 'password',
      keyPath: fields.privatekey?.trim() || undefined,
      group: subRep ? `${group}/${subRep}` : group
    });
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) {
      continue;
    }
    const sectionMatch = /^\[(.+)\]$/.exec(line);
    if (sectionMatch) {
      flush();
      section = sectionMatch[1].trim();
      fields = {};
      continue;
    }
    const separator = line.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    fields[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }

  flush();
  return dedupeSessions(sessions);
}

function decodePuTTYName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

export function parsePuTTY(text: string, group = 'PuTTY'): ImportedSession[] {
  const sessions: ImportedSession[] = [];
  let section = '';
  let fields: Record<string, string> = {};

  const flush = () => {
    const match = /^HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\(.+)$/i.exec(
      section
    );
    if (!match) {
      return;
    }
    const name = decodePuTTYName(match[1]);
    if (!name || name.toLowerCase() === 'default settings') {
      return;
    }
    const rawHost = fields.hostname?.trim();
    if (!rawHost) {
      return;
    }
    // PuTTY stores `user@host` verbatim in the Host Name field.
    const atIndex = rawHost.lastIndexOf('@');
    const host = atIndex >= 0 ? rawHost.slice(atIndex + 1) : rawHost;
    const inlineUser = atIndex >= 0 ? rawHost.slice(0, atIndex) : '';
    if (!host) {
      return;
    }
    const protocol = (fields.protocol ?? 'ssh').toLowerCase();
    if (protocol !== 'ssh') {
      return;
    }
    const segments = name.split(/[\\/]/).filter(Boolean);
    const title = segments[segments.length - 1] ?? name;
    const parent = segments.slice(0, -1).join('/');
    sessions.push({
      kind: 'ssh',
      title,
      host,
      port: normalizePort(fields.portnumber),
      username: fields.username?.trim() || inlineUser,
      authMethod: fields.publickeyfile?.trim() ? 'key' : 'password',
      keyPath: fields.publickeyfile?.trim() || undefined,
      group: parent ? `${group}/${parent}` : group
    });
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const sectionMatch = /^\[(.+)\]$/.exec(line);
    if (sectionMatch) {
      flush();
      section = sectionMatch[1].trim();
      fields = {};
      continue;
    }
    const valueMatch = /^"([^"]+)"=(.*)$/.exec(line);
    if (!valueMatch) {
      continue;
    }
    const key = valueMatch[1].toLowerCase();
    const rawValue = valueMatch[2].trim();
    if (key === 'portnumber') {
      const dword = /^dword:([0-9a-f]+)$/i.exec(rawValue);
      fields[key] = dword ? String(Number.parseInt(dword[1], 16)) : unquote(rawValue);
    } else {
      fields[key] = unquote(rawValue);
    }
  }

  flush();
  return dedupeSessions(sessions);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asKind(value: unknown): SessionKind {
  return value === 'sftp' ||
    value === 'local' ||
    value === 'telnet' ||
    value === 'serial'
    ? value
    : 'ssh';
}

function asAuthMethod(value: unknown): SessionAuthMethod {
  return value === 'key' || value === 'agent' || value === 'certificate' ? value : 'password';
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? (value as string[])
    : undefined;
}

function asPort(value: unknown, kind: SessionKind): number | undefined {
  if (typeof value === 'number') {
    return normalizePort(String(value));
  }
  // Only remote kinds have a meaningful port default; forcing 22 onto local
  // or serial sessions would suggest a port they do not use.
  return kind === 'ssh' || kind === 'sftp' || kind === 'telnet' ? 22 : undefined;
}

export function parseNexTermBackup(text: string): ImportedSession[] {
  const parsed: unknown = JSON.parse(text);
  const list = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.sessions)
      ? parsed.sessions
      : null;
  if (!list) {
    throw new Error(tStatic('import.invalidBackup'));
  }

  const sessions: ImportedSession[] = [];
  for (const item of list) {
    if (!isRecord(item)) {
      continue;
    }
    const kind = asKind(item.kind);
    const host = asString(item.host);
    const title = asString(item.title);
    // Serial sessions have no host; every other remote kind needs one.
    if (kind !== 'local' && kind !== 'serial' && !host) {
      continue;
    }
    sessions.push({
      kind,
      title: title ?? (kind === 'local' ? tStatic(SESSION_KIND_LABEL_KEY.local) : (host ?? 'Session')),
      host,
      // NexTerm backups carry raw numbers; clamp to the valid port range
      // like the other parsers do instead of trusting the file.
      port: asPort(item.port, kind),
      username: asString(item.username),
      authMethod: asAuthMethod(item.authMethod),
      keyPath: asString(item.keyPath),
      certPath: asString(item.certPath),
      jumpSessionId: asString(item.jumpSessionId),
      shellCommand: asString(item.shellCommand),
      shellArgs: asStringArray(item.shellArgs),
      serialPort: asString(item.serialPort),
      serialBaud:
        typeof item.serialBaud === 'number' && Number.isFinite(item.serialBaud)
          ? item.serialBaud
          : undefined,
      group: asString(item.group) ?? DEFAULT_GROUP,
      favorite: Boolean(item.favorite)
    });
  }
  return dedupeSessions(sessions);
}

export function importSessionsFromText(format: ImportFormat, text: string): ImportedSession[] {
  switch (format) {
    case 'ssh-config':
      return parseSshConfig(text);
    case 'mobaxterm':
      return parseMobaXterm(text);
    case 'putty':
      return parsePuTTY(text);
    case 'nexterm':
      return parseNexTermBackup(text);
  }
}

/** Backup schema v2: every SessionDraft-relevant field is exported, so a
 * backup restores Telnet/Serial/ProxyJump/custom shell sessions losslessly.
 * Importers still accept v1 files (they simply lack the newer fields). */
export function serializeSessionBackup(sessions: Session[]): string {
  return JSON.stringify(
    {
      app: 'NexTerm',
      version: 2,
      exportedAt: new Date().toISOString(),
      sessions: sessions.map((session) => ({
        kind: session.kind,
        title: session.title,
        host: session.host,
        port: session.port,
        username: session.username,
        authMethod: session.authMethod,
        keyPath: session.keyPath,
        certPath: session.certPath,
        jumpSessionId: session.jumpSessionId,
        shellCommand: session.shellCommand,
        shellArgs: session.shellArgs,
        serialPort: session.serialPort,
        serialBaud: session.serialBaud,
        group: session.group,
        favorite: session.favorite
      }))
    },
    null,
    2
  );
}

export function importKey(
  session: Pick<ImportedSession, 'kind' | 'host' | 'port' | 'username' | 'title'>
): string {
  if (session.kind === 'local') {
    return `local|${session.title}`;
  }
  return `${session.kind}|${session.host ?? ''}|${session.port ?? 22}|${session.username ?? ''}`;
}
