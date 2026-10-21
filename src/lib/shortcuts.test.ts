import { describe, expect, it } from 'vitest';
import { formatShortcutFromEvent, matchesShortcut, parseShortcut } from './shortcuts';

function keyEvent(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', init);
}

describe('parseShortcut', () => {
  it('parses modifiers and key case-insensitively', () => {
    expect(parseShortcut('Ctrl+Shift+K')).toEqual({
      ctrl: true,
      shift: true,
      alt: false,
      meta: false,
      key: 'k'
    });
  });

  it('supports aliases and optional whitespace', () => {
    expect(parseShortcut(' control + option + cmd + Space ')).toEqual({
      ctrl: true,
      shift: false,
      alt: true,
      meta: true,
      key: 'space'
    });
  });

  it('rejects empty or modifier-only values', () => {
    expect(parseShortcut('')).toBeNull();
    expect(parseShortcut('Ctrl+Shift')).toBeNull();
  });
});

describe('matchesShortcut', () => {
  it('matches only when the full modifier set and key agree', () => {
    const event = keyEvent({ key: 'k', ctrlKey: true, shiftKey: true });
    expect(matchesShortcut(event, 'Ctrl+Shift+K')).toBe(true);
    expect(matchesShortcut(event, 'Ctrl+K')).toBe(false);
    expect(matchesShortcut(event, 'Ctrl+Shift+J')).toBe(false);
  });

  it('normalizes key case and space', () => {
    expect(matchesShortcut(keyEvent({ key: 'K', ctrlKey: true }), 'ctrl+k')).toBe(true);
    expect(matchesShortcut(keyEvent({ key: ' ', altKey: true }), 'Alt+Space')).toBe(true);
  });

  it('returns false for invalid shortcut definitions', () => {
    expect(matchesShortcut(keyEvent({ key: 'k', ctrlKey: true }), 'Ctrl+')).toBe(false);
  });
});

describe('formatShortcutFromEvent', () => {
  it('serializes modifiers in a stable order', () => {
    expect(
      formatShortcutFromEvent(
        keyEvent({ key: 'k', ctrlKey: true, altKey: true, shiftKey: true, metaKey: true })
      )
    ).toBe('Ctrl+Alt+Shift+Meta+K');
  });

  it('ignores modifier-only presses and plain keys', () => {
    expect(formatShortcutFromEvent(keyEvent({ key: 'Control', ctrlKey: true }))).toBeNull();
    expect(formatShortcutFromEvent(keyEvent({ key: 'k' }))).toBeNull();
  });

  it('renders named keys and space', () => {
    expect(formatShortcutFromEvent(keyEvent({ key: ' ', ctrlKey: true }))).toBe('Ctrl+Space');
    expect(formatShortcutFromEvent(keyEvent({ key: 'F5', ctrlKey: true }))).toBe('Ctrl+F5');
  });
});
