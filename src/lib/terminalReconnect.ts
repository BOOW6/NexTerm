type ReconnectHandler = () => boolean;

const handlers = new Map<string, Set<ReconnectHandler>>();

/**
 * Reconnect a live terminal in place. Recreating the dockview panel would
 * reorder tabs and drop the live terminal buffer, so panels register here and
 * the workspace asks them to reconnect themselves.
 */
export function registerTerminalReconnect(
  sessionId: string,
  handler: ReconnectHandler
): () => void {
  const existing = handlers.get(sessionId) ?? new Set<ReconnectHandler>();
  existing.add(handler);
  handlers.set(sessionId, existing);

  return () => {
    const current = handlers.get(sessionId);
    if (!current) {
      return;
    }
    current.delete(handler);
    if (current.size === 0) {
      handlers.delete(sessionId);
    }
  };
}

export function requestTerminalReconnect(sessionId: string): boolean {
  const current = handlers.get(sessionId);
  if (!current || current.size === 0) {
    return false;
  }
  let handled = false;
  for (const handler of current) {
    if (handler()) {
      handled = true;
    }
  }
  return handled;
}

/** Backoff attempts before the SSH reconnect ladder gives up. */
export const MAX_RECONNECT_ATTEMPTS = 5;

/** A connection must survive this long to count as healthy; otherwise a
 * server that accepts and immediately drops would reset the backoff and
 * reconnect forever. */
export const RECONNECT_HEALTHY_UPTIME_MS = 10_000;

/** Delay before the nth reconnect attempt (1-based): 1s, 2s, 4s, 8s, capped
 * at 16s. */
export function nextReconnectDelay(attempt: number): number {
  return Math.min(16_000, 1_000 * 2 ** (Math.max(1, attempt) - 1));
}

/** Whether a connection that lived for uptimeMs should reset the backoff. */
export function shouldResetBackoff(uptimeMs: number): boolean {
  return uptimeMs > RECONNECT_HEALTHY_UPTIME_MS;
}
