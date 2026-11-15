import { invoke } from '@tauri-apps/api/core';
import { getPtyPlatformInfo } from '../hooks/useTauriPty';

export interface LocalShellPreset {
  id: string;
  /** i18n key for the display name. */
  labelKey: string;
  /** Executable to spawn; `undefined` uses the platform default shell. */
  command?: string;
  args?: string[];
  /** Probe these candidates instead of `command` (first hit wins, e.g. Git Bash). */
  probeCandidates?: string[];
  /** False when the shell probe could not resolve the executable. */
  available?: boolean;
}

export interface LocalShellCatalog {
  presets: LocalShellPreset[];
  /** Resolved command per preset id (`undefined` = platform default). */
  commands: Record<string, { command: string; args: string[] } | undefined>;
}

/** Git for Windows installs bash in one of these locations. `%VAR%` segments
 * are expanded by the backend probe; the registry/PATH lookup
 * (`detect_git_bash`) runs first and covers installs on other drives. */
const GIT_BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  '%ProgramFiles%\\Git\\bin\\bash.exe',
  '%ProgramFiles(x86)%\\Git\\bin\\bash.exe',
  '%LOCALAPPDATA%\\Programs\\Git\\bin\\bash.exe'
];

const WINDOWS_PRESETS: LocalShellPreset[] = [
  { id: 'default', labelKey: 'localShell.default' },
  { id: 'powershell', labelKey: 'localShell.powershell', command: 'powershell.exe' },
  { id: 'pwsh', labelKey: 'localShell.pwsh', command: 'pwsh.exe' },
  { id: 'wsl', labelKey: 'localShell.wsl', command: 'wsl.exe', args: ['--cd', '~'] },
  { id: 'gitbash', labelKey: 'localShell.gitbash', probeCandidates: GIT_BASH_CANDIDATES },
  { id: 'cmd', labelKey: 'localShell.cmd', command: 'cmd.exe' }
];

const UNIX_PRESETS: LocalShellPreset[] = [
  { id: 'default', labelKey: 'localShell.default' },
  { id: 'bash', labelKey: 'localShell.bash', command: 'bash' },
  { id: 'zsh', labelKey: 'localShell.zsh', command: 'zsh' },
  { id: 'fish', labelKey: 'localShell.fish', command: 'fish' }
];

interface ProbeSlot {
  preset: LocalShellPreset;
  candidates: string[];
}

/** One probe entry list per preset, in preset order. Presets without a command
 * or candidates (the platform default) contribute nothing, so probe results
 * never shift between presets. */
function probeSlots(presets: LocalShellPreset[]): ProbeSlot[] {
  return presets.map((preset) => ({
    preset,
    candidates: preset.probeCandidates ?? (preset.command ? [preset.command] : [])
  }));
}

/**
 * Merge probe results into a catalog. `resolved === null` means the probe
 * itself failed: fixed-command presets stay selectable (spawn errors surface
 * in the terminal), while probe-based presets become unavailable — spawning a
 * guessed path is exactly how Git Bash used to launch WSL.
 */
export function buildShellCatalog(
  presets: LocalShellPreset[],
  resolved: Array<string | null> | null
): LocalShellCatalog {
  const commands: LocalShellCatalog['commands'] = {};
  let cursor = 0;
  const probed: LocalShellPreset[] = probeSlots(presets).map(({ preset, candidates }) => {
    if (candidates.length === 0) {
      return { ...preset, available: true };
    }
    if (resolved === null) {
      if (!preset.probeCandidates) {
        commands[preset.id] = { command: preset.command ?? '', args: preset.args ?? [] };
        return { ...preset, available: true };
      }
      return { ...preset, available: false };
    }
    const slice = resolved.slice(cursor, cursor + candidates.length);
    cursor += candidates.length;
    if (preset.probeCandidates) {
      const hit = slice.find((entry): entry is string => entry !== null);
      if (hit === undefined) {
        return { ...preset, available: false };
      }
      commands[preset.id] = { command: hit, args: preset.args ?? [] };
      return { ...preset, available: true };
    }
    commands[preset.id] = { command: preset.command ?? '', args: preset.args ?? [] };
    return { ...preset, available: slice[0] !== null };
  });

  return { presets: probed, commands };
}

/**
 * Probe the presets' executables and build the resolved command map.
 * A failed probe leaves fixed-command presets usable and hides probe-only
 * ones instead of inventing a path for them.
 */
async function probeAvailability(presets: LocalShellPreset[]): Promise<LocalShellCatalog> {
  const probeList = probeSlots(presets).flatMap((slot) => slot.candidates);
  let resolved: Array<string | null> | null = null;
  try {
    resolved = await invoke<Array<string | null>>('probe_shell_availability', {
      candidates: probeList
    });
  } catch {
    resolved = null;
  }
  return buildShellCatalog(presets, resolved);
}

/** Registry/PATH lookup for a Git for Windows install on any drive. Returns a
 * verified `bin\bash.exe` path, or null when Git Bash is not installed. */
async function detectGitBash(): Promise<string | null> {
  try {
    return await invoke<string | null>('detect_git_bash');
  } catch {
    return null;
  }
}

export async function loadLocalShellCatalog(): Promise<LocalShellCatalog> {
  const info = await getPtyPlatformInfo();
  const isWindows = info.backend === 'conpty';
  if (!isWindows) {
    return probeAvailability(UNIX_PRESETS);
  }

  const presets = WINDOWS_PRESETS.map((preset) => ({ ...preset }));
  const detected = await detectGitBash();
  if (detected) {
    const gitBash = presets.find((preset) => preset.id === 'gitbash');
    if (gitBash) {
      gitBash.probeCandidates = [
        detected,
        ...(gitBash.probeCandidates ?? []).filter(
          (candidate) => candidate.toLowerCase() !== detected.toLowerCase()
        )
      ];
    }
  }
  return probeAvailability(presets);
}

/** Map an existing session shell back to a preset id; `custom` when no match. */
export function matchLocalShellPreset(
  command: string,
  args: string[],
  catalog: LocalShellCatalog
): string {
  const normalized = command.trim().toLowerCase();
  const match = catalog.presets.find((preset) => {
    const resolved = catalog.commands[preset.id];
    if (!resolved) {
      return false;
    }
    return (
      resolved.command.toLowerCase() === normalized &&
      (resolved.args ?? []).join('\u0000') === args.join('\u0000')
    );
  });
  return match?.id ?? 'custom';
}

/** Split a user-typed argument line on whitespace, honoring double quotes. */
export function splitShellArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuotes = false;
  let hasToken = false;
  for (const char of input) {
    if (char === '"') {
      inQuotes = !inQuotes;
      hasToken = true;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
      if (hasToken) {
        args.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }
    current += char;
    hasToken = true;
  }
  if (hasToken) {
    args.push(current);
  }
  return args;
}

/** Inverse of `splitShellArgs`: quote tokens that contain whitespace. */
export function formatShellArgs(args: string[]): string {
  return args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(' ');
}

/** Trim whitespace and a single pair of wrapping quotes from a command. */
export function normalizeShellCommand(input: string): string {
  const trimmed = input.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}
