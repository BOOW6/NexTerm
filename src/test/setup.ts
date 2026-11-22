import { afterEach } from 'vitest';

function fallbackRandomUUID(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

if (typeof globalThis.crypto?.randomUUID !== 'function') {
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    configurable: true,
    value: fallbackRandomUUID
  });
}

// jsdom has no canvas implementation, so importing xterm (its color
// machinery probes 2D contexts) emitted "Not implemented" noise from every
// terminal-related test. That noise drowned real errors; a stub keeps the
// failures clean. Tests that need real canvas behavior must mock deeper.
HTMLCanvasElement.prototype.getContext = function getContext() {
  return null;
};

afterEach(() => {
  window.localStorage.clear();
});
