import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TERMINAL_COLOR_SCHEME,
  getTerminalColorScheme,
  normalizeTerminalColorSchemeId,
  TERMINAL_COLOR_SCHEMES
} from './terminalColorSchemes';
import { useCustomThemesStore } from './customThemesStore';
import type { CustomThemeDefinition } from './customThemes';

const NIGHTFALL: CustomThemeDefinition = {
  id: 'nightfall',
  name: 'Nightfall',
  variant: 'dark',
  description: 'a custom theme',
  extends: 'dim',
  source: 'json',
  colors: {},
  terminal: {
    background: '#0c0c0c',
    foreground: '#cccccc',
    cursor: '#ffffff',
    selectionBackground: '#ffffff80',
    palette: [
      '#000000',
      '#c50f1f',
      '#13a10e',
      '#c19c00',
      '#0037da',
      '#881798',
      '#3a96dd',
      '#cccccc',
      '#767676',
      '#e74856',
      '#16c60c',
      '#f9f1a5',
      '#3b78ff',
      '#b4009e',
      '#61d6d6',
      '#f2f2f2'
    ]
  }
};

const NO_TERMINAL: CustomThemeDefinition = {
  ...NIGHTFALL,
  id: 'bare',
  terminal: null
};

describe('normalizeTerminalColorSchemeId', () => {
  it('keeps the follow-theme sentinel and builtin ids', () => {
    expect(normalizeTerminalColorSchemeId('theme')).toBe(DEFAULT_TERMINAL_COLOR_SCHEME);
    expect(normalizeTerminalColorSchemeId(TERMINAL_COLOR_SCHEMES[0].id)).toBe(
      TERMINAL_COLOR_SCHEMES[0].id
    );
  });

  it('keeps custom theme id shapes and rejects garbage', () => {
    expect(normalizeTerminalColorSchemeId('nightfall')).toBe('nightfall');
    expect(normalizeTerminalColorSchemeId('Not A Theme!')).toBe(DEFAULT_TERMINAL_COLOR_SCHEME);
    expect(normalizeTerminalColorSchemeId(undefined)).toBe(DEFAULT_TERMINAL_COLOR_SCHEME);
  });
});

describe('getTerminalColorScheme', () => {
  afterEach(() => {
    useCustomThemesStore.setState({ themes: [], errors: [], loading: false, loaded: false });
  });

  it('resolves custom themes that define a terminal section', () => {
    useCustomThemesStore.setState({ themes: [NIGHTFALL, NO_TERMINAL], loaded: true });
    const scheme = getTerminalColorScheme('nightfall');
    expect(scheme).toBeDefined();
    expect(scheme?.name).toBe('Nightfall');
    expect(scheme?.variant).toBe('dark');
    expect(scheme?.background).toBe('#0c0c0c');
    expect(scheme?.cursor).toBe('#ffffff');
    expect(scheme?.selectionBackground).toBe('#ffffff80');
    expect(Object.values(scheme?.colors ?? {})).toHaveLength(16);
    // Themes without a terminal section do not register a scheme.
    expect(getTerminalColorScheme('bare')).toBeUndefined();
  });

  it('falls back to the builtin palette for partial custom schemes', () => {
    useCustomThemesStore.setState({
      themes: [{ ...NIGHTFALL, id: 'partial', terminal: { background: '#101010' } }],
      loaded: true
    });
    const scheme = getTerminalColorScheme('partial');
    expect(scheme?.background).toBe('#101010');
    expect(scheme?.foreground).toBeDefined();
    expect(Object.values(scheme?.colors ?? {})).toHaveLength(16);
  });
});
