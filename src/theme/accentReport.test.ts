import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { accentVars } from './accent';

/**
 * Prints the accent derivation against the real built-in palettes.
 * Skipped by default; run with `ACCENT_REPORT=1 npx vitest run src/theme/accentReport.test.ts`
 * to inspect the numbers behind a preset without a browser.
 */
const CSS = readFileSync(resolve(__dirname, 'tokens.css'), 'utf8');

function block(id: string): Record<string, string> {
  const match = new RegExp(`\\[data-theme='${id}'\\]\\s*\\{([\\s\\S]*?)\\n\\}`).exec(CSS);
  const out: Record<string, string> = {};
  if (!match) {
    return out;
  }
  for (const decl of match[1].matchAll(/(--[a-z0-9-]+):\s*([\d.]+\s+[\d.]+%\s+[\d.]+%)/g)) {
    out[decl[1]] = decl[2];
  }
  return out;
}

describe.skipIf(!process.env.ACCENT_REPORT)('accent derivation report', () => {
  it('prints slate-dark with several presets', () => {
    const t = block('slate-dark');
    const base = {
      accent: t['--accent'],
      background: t['--background'],
      backgroundAlt: t['--background-alt'],
      surface: t['--surface'],
      surfaceElevated: t['--surface-elevated'],
      surfaceHeader: t['--surface-header'],
      surfaceHover: t['--surface-hover'],
      surfaceActive: t['--surface-active'],
      border: t['--border'],
      borderMuted: t['--border-muted'],
      borderStrong: t['--border-strong'],
      foreground: t['--foreground'],
      muted: t['--muted'],
      mutedForeground: t['--muted-foreground'],
      tableHeader: t['--table-header'],
      rowHover: t['--row-hover'],
      success: t['--success'],
      warning: t['--warning'],
      error: t['--error'],
      terminalCursor: t['--terminal-cursor']
    };
    const presets: Array<[string, string, string | undefined]> = [
      ['teal', '#2dd4bf', undefined],
      ['blue', '#3b82f6', undefined],
      ['rose', '#bf3989', undefined],
      ['muted', '#64748b', '#94a3b8'],
      ['black', '#1f2937', '#6b7280'],
      ['white', '#e5e7eb', '#d1d5db']
    ];
    console.log(`base success=${base.success} error=${base.error} cursor=${base.terminalCursor}`);
    const probe = accentVars({ accent: '#2dd4bf', variant: 'dark', base });
    console.log(
      'probe keys:',
      Object.keys(probe)
        .filter(
          (k) =>
            k.startsWith('--s') || k.startsWith('--e') || k.startsWith('--w') || k.startsWith('--t')
        )
        .join(',')
    );
    // Manual replay of the mapping with the values the report uses, so a
    // mismatch between the helper and the reported tokens is obvious.
    const hueDelta = (from: number, to: number) => ((to - from + 540) % 360) - 180;
    const accentHue = 172;
    const baseHue = 212;
    for (const [label, original] of [
      ['success', 137],
      ['error', 355]
    ] as const) {
      const delta = hueDelta(baseHue, accentHue);
      const dist = Math.abs(hueDelta(baseHue, original));
      const influence = Math.max(0.35, 1 + (0.5 - 1) * Math.min(dist / 120, 1));
      console.log(
        `replay ${label}: base=${original} accentDelta=${delta} dist=${dist} => ${(original + delta * influence).toFixed(1)}`
      );
    }
    for (const [name, accent, neutral] of presets) {
      const vars = accentVars({ accent, neutral, variant: 'dark', base });
      console.log(
        [
          name.padEnd(6),
          `accent=${vars['--accent']}`,
          `onAccent=${vars['--accent-foreground']}`,
          `surface=${vars['--surface'] ?? '(theme)'}`,
          `fg=${vars['--foreground'] ?? '(theme)'}`,
          `ok=${vars['--success']}`,
          `err=${vars['--error']}`,
          `cursor=${vars['--terminal-cursor']}`
        ].join('  ')
      );
    }
  });
});
