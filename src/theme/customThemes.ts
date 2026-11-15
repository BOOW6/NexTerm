import { invoke } from '@tauri-apps/api/core';
import type { BuiltinThemeId, ThemeVariant } from './themes';

/** Where a custom theme came from (also decides conversion specifics). */
export type CustomThemeSource = 'json' | 'windows-terminal' | 'iterm2';

export interface CustomTerminalColors {
  background?: string;
  foreground?: string;
  cursor?: string;
  selectionBackground?: string;
  palette?: string[];
}

export interface CustomThemeDefinition {
  id: string;
  name: string;
  variant: ThemeVariant;
  description: string;
  /** Built-in base theme supplying every color not overridden. */
  extends: BuiltinThemeId;
  source: CustomThemeSource;
  /** Semantic color key -> hex, validated on the backend. */
  colors: Record<string, string>;
  terminal: CustomTerminalColors | null;
  /**
   * Optional structure overrides, already flattened to CSS values by the
   * backend (e.g. `{ radiusSm: '4px', panelWeight: '600' }`). Keys mirror the
   * structure tokens in tokens.css.
   */
  structure?: Record<string, string>;
}

export interface ThemeScanError {
  file: string;
  message: string;
}

export interface ThemesScan {
  themes: CustomThemeDefinition[];
  errors: ThemeScanError[];
  dir: string | null;
}

export async function loadCustomThemes(): Promise<ThemesScan> {
  return invoke<ThemesScan>('themes_list');
}
