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
