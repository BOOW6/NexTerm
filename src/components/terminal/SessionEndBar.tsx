import { useEffect, useState } from 'react';
import { RotateCw } from 'lucide-react';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import {
  remainingSeconds,
  sessionEndActions,
  type SessionEndAction,
  type SessionEndBarState
} from '../../lib/terminalEndState';
import { Button } from '../ui/button';

const ACTION_LABEL_KEY: Record<SessionEndAction, string> = {
  reconnect: 'terminal.reconnect',
  reconnectNow: 'terminal.endBarReconnectNow',
  cancelReconnect: 'terminal.endBarCancelReconnect',
  closeTab: 'terminal.endBarCloseTab',
  saveOutput: 'terminal.endBarSaveOutput'
};

/** Single-key shortcuts surfaced on the chip buttons so the keyboard path is
 * discoverable; terminal states act entirely through keys and the tab menu. */
const ACTION_KEY_HINT: Partial<Record<SessionEndAction, string>> = {
  reconnectNow: 'R',
  cancelReconnect: 'Esc'
};

interface SessionEndBarProps {
  state: SessionEndBarState;
  onAction: (action: SessionEndAction) => void;
}

/**
 * Floating bottom-right chip for the live reconnect countdown: what dropped
 * and when the next attempt fires. A small corner overlay (like the resize
 * HUD) so it never covers the in-buffer end block or the first line.
 */
export function SessionEndBar({ state, onAction }: SessionEndBarProps) {
  const { t } = useI18n();

  // The countdown ticks locally from the deadline instead of writing one
  // buffer line per reconnect attempt.
  const [now, setNow] = useState(() => Date.now());
  const deadline = state.deadline;

  useEffect(() => {
    if (deadline === undefined) {
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);

  const messageParams =
    deadline !== undefined
      ? { ...state.messageParams, seconds: remainingSeconds(deadline, now) }
      : state.messageParams;

  return (
    <div
      className={cn(
        'absolute bottom-2 right-2 z-10 flex max-w-full items-center gap-2 rounded-sm',
        'border border-border bg-surface-elevated px-2 py-1 text-meta shadow-panel'
      )}
    >
      <RotateCw className="h-3 w-3 shrink-0 text-warning" aria-hidden="true" />
      <span aria-live="polite" className="min-w-0 flex-1 truncate text-foreground">
        {t(state.messageKey, messageParams)}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        {sessionEndActions(state.kind).map((action) => (
          <Button key={action} size="xs" variant="secondary" onClick={() => onAction(action)}>
            {t(ACTION_LABEL_KEY[action])}
            {ACTION_KEY_HINT[action] ? (
              <kbd className="ml-1 rounded-sm border border-border px-1 text-micro text-muted-foreground">
                {ACTION_KEY_HINT[action]}
              </kbd>
            ) : null}
          </Button>
        ))}
      </div>
    </div>
  );
}
