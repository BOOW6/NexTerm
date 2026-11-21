/**
 * Remote (SFTP) path helpers. The panel used to inline three different
 * join/split behaviors; these are the single definitions, pinned by tests.
 */

/** Join a remote directory path and an entry name, tolerating a trailing
 * slash on the directory (so `/` + `etc` gives `/etc`, not `//etc`). */
export function joinRemotePath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

/** Last segment of a remote path. Windows-style separators are split too
 * because local upload paths can arrive with backslashes; trailing
 * separators are ignored instead of yielding an empty segment. */
export function remoteBaseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  if (!trimmed) {
    return 'file';
  }
  return trimmed.split(/[\\/]/).pop() ?? 'file';
}

/** Parent directory of a remote absolute path; the root's parent is the
 * root itself. */
export function remoteParentPath(path: string): string {
  if (path === '/') {
    return '/';
  }
  const parent = path.replace(/\/+$/, '').split('/').slice(0, -1).join('/');
  return parent || '/';
}
