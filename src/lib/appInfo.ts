import { getVersion } from '@tauri-apps/api/app';

const FALLBACK_VERSION = '0.1.0';
let cached: string | null = null;

/**
 * App version from the Tauri runtime. The single source of truth is
 * `tauri.conf.json` (mirrored by package.json for tooling); UI copies must
 * read it here instead of hardcoding, or releases drift. The fallback keeps
 * the pure web preview (no IPC) rendering instead of throwing.
 */
export async function appVersion(): Promise<string> {
  if (cached) {
    return cached;
  }
  try {
    cached = (await getVersion()) || FALLBACK_VERSION;
  } catch {
    cached = FALLBACK_VERSION;
  }
  return cached;
}
