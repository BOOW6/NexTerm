import { useEffect, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import {
  ChevronDown,
  ChevronUp,
  Copy,
  Eraser,
  KeyRound,
  RotateCw,
  Search,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react';
import XtermCanvas, { type XtermHandle } from './XtermCanvas';
import SshConnectForm from './SshConnectForm';
import { useSessionStore } from '../../stores/sessionStore';
import { useCredentialStore } from '../../stores/credentialStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Tooltip } from '../ui/tooltip';
import { toast } from '../ui/toast';
import { showNativeContextMenu } from '../../lib/appWindows';
import { readText as readClipboardText } from '@tauri-apps/plugin-clipboard-manager';
import { TERMINAL_ACTION_EVENT, type TerminalAction } from '../../lib/terminalCommands';
import { useI18n } from '../../i18n';

const PANEL_PREFIX = 'session-';
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 20;

export default function TerminalTab(props: IDockviewPanelProps) {
  const params = props.params as { sessionId?: string } | undefined;
  const sessionId = params?.sessionId ?? props.api.id.replace(PANEL_PREFIX, '');

  const session = useSessionStore((state) => state.sessions.find((item) => item.id === sessionId));
  const jumpSession = useSessionStore((state) =>
    session?.jumpSessionId
      ? state.sessions.find((item) => item.id === session.jumpSessionId)
      : undefined
  );
  const password = useCredentialStore((state) =>
    session ? (state.passwords[session.id] ?? '') : ''
  );
  const passphrase = useCredentialStore((state) =>
    session ? (state.passphrases[session.id] ?? '') : ''
  );
  const authorized = useCredentialStore((state) =>
    session ? Boolean(state.authorizations[session.id]) : false
  );
  const jumpPassword = useCredentialStore((state) =>
    jumpSession ? (state.passwords[jumpSession.id] ?? '') : ''
  );
  const jumpPassphrase = useCredentialStore((state) =>
    jumpSession ? (state.passphrases[jumpSession.id] ?? '') : ''
  );
  const clearCredentials = useCredentialStore((state) => state.clearCredentials);

  const { t } = useI18n();

  const defaultFontSize = useSettingsStore((state) => state.terminalFontSize);
  const terminalRef = useRef<XtermHandle>(null);
  const [isVisible, setIsVisible] = useState(props.api.isVisible);
  const [fontSize, setFontSize] = useState(defaultFontSize);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    setIsVisible(props.api.isVisible);
    const disposable = props.api.onDidVisibilityChange((event) => {
      setIsVisible(event.isVisible);
    });
    return () => disposable.dispose();
  }, [props.api]);

  useEffect(() => {
    setFontSize(defaultFontSize);
  }, [defaultFontSize]);

  useEffect(() => {
    if (session) {
      props.api.setTitle(session.title);
    }
  }, [props.api, session]);

  useEffect(() => {
    const handler = (event: Event) => {
      if (!props.api.isActive) {
        return;
      }
      const action = (event as CustomEvent<TerminalAction>).detail;
      if (action.type === 'copy') {
        void terminalRef.current?.copySelection().then((copied) => {
          toast({
            title: copied ? t('terminal.copied') : t('terminal.nothingSelected'),
            variant: copied ? 'success' : 'default'
          });
        });
      } else if (action.type === 'paste') {
        void readClipboardText()
          .then((text) => {
            if (text) {
              terminalRef.current?.paste(text);
            }
          })
          .catch(() => toast({ title: t('terminal.clipboardFailed'), variant: 'error' }));
      } else if (action.type === 'send-text') {
        terminalRef.current?.sendText(action.text, action.execute);
      } else if (action.type === 'select-all') {
        terminalRef.current?.selectAll();
      } else if (action.type === 'find') {
        setSearchOpen(true);
      } else if (action.type === 'clear') {
        terminalRef.current?.clear();
      } else if (action.type === 'zoom-in') {
        setFontSize((current) => Math.min(MAX_FONT_SIZE, current + 1));
      } else if (action.type === 'zoom-out') {
        setFontSize((current) => Math.max(MIN_FONT_SIZE, current - 1));
      } else if (action.type === 'zoom-reset') {
        setFontSize(defaultFontSize);
      }
    };

    window.addEventListener(TERMINAL_ACTION_EVENT, handler);
    return () => window.removeEventListener(TERMINAL_ACTION_EVENT, handler);
  }, [defaultFontSize, props.api, t]);

  if (!session) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-background text-center">
        <p className="text-sm font-medium text-foreground">{t('terminal.missing')}</p>
        <p className="text-xs text-muted">{t('terminal.missingHint')}</p>
      </div>
    );
  }

  const isLocal = session.kind === 'local';
  const authMethod = session.authMethod ?? 'password';
  const keyPath = session.keyPath ?? '';
  const needsAuth = !isLocal && (authMethod === 'password' ? !password : !authorized);

  if (needsAuth) {
    return <SshConnectForm session={session} />;
  }

  // The jump session tunnels this connection; its credentials come from the
  // same in-memory store the jump session itself authenticates with. Missing
  // jump credentials surface as a connect error naming the jump session.
  const jumpTarget = jumpSession
    ? {
        host: jumpSession.host ?? '',
        port: jumpSession.port ?? 22,
        username: jumpSession.username ?? '',
        authMethod: jumpSession.authMethod ?? 'password',
        password: jumpPassword,
        privateKeyPath: jumpSession.keyPath ?? '',
        certPath: jumpSession.certPath ?? '',
        passphrase: jumpPassphrase
      }
    : undefined;

  const runSearch = (direction: 'next' | 'previous') => {
    if (!query) {
      return;
    }
    if (direction === 'next') {
      terminalRef.current?.findNext(query);
    } else {
      terminalRef.current?.findPrevious(query);
    }
  };

  const handleCopy = async () => {
    const copied = await terminalRef.current?.copySelection();
    toast({
      title: copied ? t('terminal.copied') : t('terminal.nothingSelected'),
      variant: copied ? 'success' : 'default'
    });
  };

  const adjustFont = (delta: number) => {
    setFontSize((current) => Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, current + delta)));
  };

  const openTerminalMenu = async () => {
    const hasSelection = Boolean(terminalRef.current?.hasSelection());
    const index = await showNativeContextMenu([
      { label: t('terminal.copyAction'), enabled: hasSelection },
      { label: t('terminal.paste') },
      { label: t('terminal.selectAll') },
      { label: t('terminal.find'), separatorBefore: true },
      { label: t('terminal.clear') },
      { label: t('terminal.reconnect'), separatorBefore: true }
    ]);

    if (index === 0) {
      void handleCopy();
    } else if (index === 1) {
      void readClipboardText()
        .then((text) => {
          if (text) {
            terminalRef.current?.paste(text);
          }
        })
        .catch(() => toast({ title: t('terminal.clipboardFailed'), variant: 'error' }));
    } else if (index === 2) {
      terminalRef.current?.selectAll();
    } else if (index === 3) {
      setSearchOpen(true);
    } else if (index === 4) {
      terminalRef.current?.clear();
    } else if (index === 5) {
      terminalRef.current?.reconnect();
      toast({ title: t('terminal.reconnectToast') });
    }
  };

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="flex h-7 shrink-0 items-center gap-0.5 border-b border-border bg-surface px-1">
        <Tooltip label={t('terminal.find')}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('terminal.find')}
            onClick={() => setSearchOpen((value) => !value)}
          >
            <Search className="h-3 w-3" />
          </Button>
        </Tooltip>

        {searchOpen ? (
          <div className="flex items-center gap-0.5">
            <Input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  runSearch(event.shiftKey ? 'previous' : 'next');
                }
                if (event.key === 'Escape') {
                  setSearchOpen(false);
                }
              }}
              placeholder={t('terminal.searchPlaceholder')}
              size="sm"
              width={144}
              aria-label={t('terminal.find')}
            />
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('terminal.prevMatch')}
              onClick={() => runSearch('previous')}
            >
              <ChevronUp className="h-3 w-3" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('terminal.nextMatch')}
              onClick={() => runSearch('next')}
            >
              <ChevronDown className="h-3 w-3" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('terminal.closeSearch')}
              onClick={() => setSearchOpen(false)}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        ) : null}

        <div className="flex-1" />

        <Tooltip label={t('terminal.clear')}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('terminal.clear')}
            onClick={() => terminalRef.current?.clear()}
          >
            <Eraser className="h-3 w-3" />
          </Button>
        </Tooltip>

        <Tooltip label={t('terminal.copy')}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('terminal.copy')}
            onClick={() => void handleCopy()}
          >
            <Copy className="h-3 w-3" />
          </Button>
        </Tooltip>

        <span className="mx-0.5 h-3 w-px bg-border" />

        <Tooltip label={t('terminal.fontDown')}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('terminal.fontDown')}
            onClick={() => adjustFont(-1)}
          >
            <ZoomOut className="h-3 w-3" />
          </Button>
        </Tooltip>
        <span className="w-7 text-center text-[10px] tabular-nums text-muted">{fontSize}px</span>
        <Tooltip label={t('terminal.fontUp')}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('terminal.fontUp')}
            onClick={() => adjustFont(1)}
          >
            <ZoomIn className="h-3 w-3" />
          </Button>
        </Tooltip>

        <span className="mx-0.5 h-3 w-px bg-border" />

        {!isLocal ? (
          <Tooltip label={t('terminal.clearAuth')}>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('terminal.clearAuth')}
              onClick={() => {
                // Clearing flips the render branch to the auth form, which
                // would unmount the terminal and kill a live connection.
                if (session.status === 'connected' || session.status === 'connecting') {
                  toast({
                    title: t('terminal.clearAuthBlocked'),
                    variant: 'warning'
                  });
                  return;
                }
                clearCredentials(session.id);
              }}
            >
              <KeyRound className="h-3 w-3" />
            </Button>
          </Tooltip>
        ) : null}

        <Tooltip label={t('terminal.reconnect')}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('terminal.reconnect')}
            onClick={() => {
              terminalRef.current?.reconnect();
              toast({ title: t('terminal.reconnectToast') });
            }}
          >
            <RotateCw className="h-3 w-3" />
          </Button>
        </Tooltip>
      </div>

      <div
        data-native-context-menu
        onContextMenu={(event) => {
          event.preventDefault();
          void openTerminalMenu();
        }}
        className="min-h-0 flex-1 p-1"
      >
        <XtermCanvas
          ref={terminalRef}
          sessionId={session.id}
          fontSize={fontSize}
          visible={isVisible}
          transport={session.kind === 'telnet' ? 'telnet' : isLocal ? 'local' : 'ssh'}
          logTitle={session.title}
          ssh={
            isLocal
              ? undefined
              : {
                  host: session.host ?? '',
                  port: session.port ?? 22,
                  username: session.username ?? '',
                  authMethod,
                  password,
                  privateKeyPath: keyPath,
                  certPath: session.certPath ?? '',
                  passphrase,
                  jump: jumpTarget
                }
          }
        />
      </div>
    </div>
  );
}
