import { tStatic } from '../i18n';

/**
 * Localized renderings for backend error strings.
 *
 * Backend errors are normalized lowercase English diagnostics (anyhow
 * context chains, joined with ": "). Most of them are meant to be read as
 * technical detail; the small closed set a user hits regularly (connection,
 * authentication, transfers, vault state) gets a localized rendering here.
 *
 * Matching is exact-string first, then stable prefixes whose remainder is
 * interpolated as {message}. Anything unmatched displays as-is, so a backend
 * string drift never renders a raw i18n key, only the readable diagnostic.
 */

const EXACT: Record<string, string> = {
  'password required': 'backendErrors.passwordRequired',
  'SSH authentication failed, check the username or password': 'backendErrors.sshAuthFailed',
  'SSH key authentication failed, check the private key or username':
    'backendErrors.sshKeyAuthFailed',
  'SSH certificate authentication failed, check the certificate, private key or username':
    'backendErrors.sshCertAuthFailed',
  'SSH agent authentication failed': 'backendErrors.sshAgentAuthFailed',
  'handshake timed out': 'backendErrors.handshakeTimeout',
  'SSH session is already connecting': 'backendErrors.sessionConnecting',
  'SSH connection cancelled': 'backendErrors.connectionCancelled',
  'SSH session is disconnected or missing, reconnect and try again':
    'backendErrors.sessionDisconnected',
  'transfer task not found': 'backendErrors.transferNotFound',
  'transfer task terminated abnormally': 'backendErrors.transferAborted',
  'ZMODEM transfer interrupted': 'backendErrors.zmodemInterrupted',
  'ZMODEM transfer does not support pausing': 'backendErrors.zmodemNoPause',
  'target is a directory, enable recursive download': 'backendErrors.targetIsDirectoryDownload',
  'target is a directory, enable recursive upload': 'backendErrors.targetIsDirectoryUpload',
  'target host is required': 'backendErrors.targetHostRequired',
  'select a private key file': 'backendErrors.selectPrivateKey',
  'select a certificate file': 'backendErrors.selectCertificate',
  'no usable identities in the SSH agent': 'backendErrors.agentNoIdentities',
  'credential vault is locked': 'backendErrors.vaultLocked',
  'credential vault already exists': 'backendErrors.vaultAlreadyExists',
  'current master password is incorrect': 'backendErrors.vaultWrongMasterPassword',
  'master password must be at least 8 characters': 'backendErrors.vaultWeakPassword',
  'unsupported credential vault version': 'backendErrors.vaultUnsupportedVersion',
  'file too large (limit 8 MiB)': 'backendErrors.fileTooLarge',
  'log path must be inside the configured log directory': 'backendErrors.logPathOutsideRoot',
  'serial port name must not be empty': 'backendErrors.serialPortRequired',
  'remote path must not be empty': 'backendErrors.remotePathRequired',
  'cannot edit a directory': 'backendErrors.cannotEditDirectory'
};

const PREFIXED: Array<{ prefix: string; key: string }> = [
  { prefix: 'failed to connect to ', key: 'backendErrors.connectFailed' },
  { prefix: 'connection timed out: ', key: 'backendErrors.connectionTimedOut' },
  {
    prefix: 'SSH agent authentication failed: ',
    key: 'backendErrors.sshAgentAuthFailedDetail'
  },
  { prefix: 'failed to load private key: ', key: 'backendErrors.loadPrivateKeyFailed' },
  { prefix: 'failed to load certificate: ', key: 'backendErrors.loadCertificateFailed' },
  { prefix: 'unsupported KDF algorithm: ', key: 'backendErrors.vaultUnsupportedKdf' },
  {
    prefix: 'remote target is a directory, cannot overwrite with a file: ',
    key: 'backendErrors.remoteTargetIsDirectory'
  }
];

/** Render a backend error string in the active language, falling back to the
 * raw diagnostic for anything without a localized rendering. */
export function localizeBackendError(raw: string): string {
  const exact = EXACT[raw];
  if (exact) {
    return tStatic(exact);
  }
  for (const rule of PREFIXED) {
    if (raw.startsWith(rule.prefix)) {
      return tStatic(rule.key, { message: raw.slice(rule.prefix.length) });
    }
  }
  return raw;
}
