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
import { useWorkspace } from '../../features/workspace/WorkspaceContext';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Tooltip } from '../ui/tooltip';
import { toast } from '../ui/toast';
import { showNativeContextMenu } from '../../lib/appWindows';
import { readText as readClipboardText } from '@tauri-apps/plugin-clipboard-manager';
import {
  TERMINAL_ACTION_EVENT,
  type TerminalAction
} from '../../lib/terminalCommands';

const PANEL_PREFIX = 'session-';
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 20;

export default function TerminalTab(props: IDockviewPanelProps) {
  const params = props.params as { sessionId?: string } | undefined;
  const sessionId = params?.sessionId ?? props.api.id.replace(PANEL_PREFIX, '');

  const session = useSessionStore((state) =>
    state.sessions.find((item) => item.id === sessionId)
  );
  const password = useCredentialStore((state) =>
    session ? state.passwords[session.id] ?? '' : ''
  );
  const passphrase = useCredentialStore((state) =>
    session ? state.passphrases[session.id] ?? '' : ''
  );
  const authorized = useCredentialStore((state) =>
    session ? Boolean(state.authorizations[session.id]) : false
  );
  const clearCredentials = useCredentialStore((state) => state.clearCredentials);

  const { reconnectSession } = useWorkspace();

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
      if (action === 'copy') {
        void terminalRef.current?.copySelection().then((copied) => {
          toast({
            title: copied ? '已复制选中内容' : '没有选中内容',
            variant: copied ? 'success' : 'default'
          });
        });
      } else if (action === 'paste') {
        void readClipboardText()
          .then((text) => {
            if (text) {
              terminalRef.current?.paste(text);
            }
          })
          .catch(() => toast({ title: '无法读取剪贴板', variant: 'error' }));
      } else if (action === 'select-all') {
        terminalRef.current?.selectAll();
      } else if (action === 'find') {
        setSearchOpen(true);
      } else if (action === 'clear') {
        terminalRef.current?.clear();
      } else if (action === 'zoom-in') {
        setFontSize((current) => Math.min(MAX_FONT_SIZE, current + 1));
      } else if (action === 'zoom-out') {
        setFontSize((current) => Math.max(MIN_FONT_SIZE, current - 1));
      } else if (action === 'zoom-reset') {
        setFontSize(defaultFontSize);
      }
    };

    window.addEventListener(TERMINAL_ACTION_EVENT, handler);
    return () => window.removeEventListener(TERMINAL_ACTION_EVENT, handler);
  }, [defaultFontSize, props.api]);

  if (!session) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-background text-center">
        <p className="text-sm font-medium text-foreground">会话不存在</p>
        <p className="text-xs text-muted">该会话可能已被删除。</p>
      </div>
    );
  }

  const isLocal = session.kind === 'local';
  const authMethod = session.authMethod ?? 'password';
  const keyPath = session.keyPath ?? '';
  const needsAuth =
    !isLocal && (authMethod === 'password' ? !password : !authorized);

  if (needsAuth) {
    return <SshConnectForm session={session} />;
  }

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
      title: copied ? '已复制选中内容' : '没有选中内容',
      variant: copied ? 'success' : 'default'
    });
  };

  const adjustFont = (delta: number) => {
    setFontSize((current) =>
      Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, current + delta))
    );
  };

  const openTerminalMenu = async () => {
    const hasSelection = Boolean(terminalRef.current?.hasSelection());
    const index = await showNativeContextMenu([
      { label: '复制', enabled: hasSelection },
      { label: '粘贴' },
      { label: '全选' },
      { label: '查找', separatorBefore: true },
      { label: '清屏' },
      { label: '重新连接', separatorBefore: true }
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
        .catch(() => toast({ title: '无法读取剪贴板', variant: 'error' }));
    } else if (index === 2) {
      terminalRef.current?.selectAll();
    } else if (index === 3) {
      setSearchOpen(true);
    } else if (index === 4) {
      terminalRef.current?.clear();
    } else if (index === 5) {
      reconnectSession(session.id);
      toast({ title: '正在重连会话…' });
    }
  };

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="flex h-7 shrink-0 items-center gap-0.5 border-b border-border bg-surface px-1">
        <Tooltip label="查找">
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5"
            aria-label="查找"
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
              placeholder="查找..."
              className="h-5 w-36 text-[11px]"
              aria-label="查找内容"
            />
            <Button
              size="icon"
              variant="ghost"
              className="h-5 w-5"
              aria-label="上一个"
              onClick={() => runSearch('previous')}
            >
              <ChevronUp className="h-3 w-3" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-5 w-5"
              aria-label="下一个"
              onClick={() => runSearch('next')}
            >
              <ChevronDown className="h-3 w-3" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-5 w-5"
              aria-label="关闭查找"
              onClick={() => setSearchOpen(false)}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        ) : null}

        <div className="flex-1" />

        <Tooltip label="清屏">
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5"
            aria-label="清屏"
            onClick={() => terminalRef.current?.clear()}
          >
            <Eraser className="h-3 w-3" />
          </Button>
        </Tooltip>

        <Tooltip label="复制选中">
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5"
            aria-label="复制选中"
            onClick={() => void handleCopy()}
          >
            <Copy className="h-3 w-3" />
          </Button>
        </Tooltip>

        <span className="mx-0.5 h-3 w-px bg-border" />

        <Tooltip label="缩小字号">
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5"
            aria-label="缩小字号"
            onClick={() => adjustFont(-1)}
          >
            <ZoomOut className="h-3 w-3" />
          </Button>
        </Tooltip>
        <span className="w-7 text-center text-[10px] tabular-nums text-muted">{fontSize}px</span>
        <Tooltip label="放大字号">
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5"
            aria-label="放大字号"
            onClick={() => adjustFont(1)}
          >
            <ZoomIn className="h-3 w-3" />
          </Button>
        </Tooltip>

        <span className="mx-0.5 h-3 w-px bg-border" />

        {!isLocal ? (
          <Tooltip label="重新认证">
            <Button
              size="icon"
              variant="ghost"
              className="h-5 w-5"
              aria-label="重新认证"
              onClick={() => clearCredentials(session.id)}
            >
              <KeyRound className="h-3 w-3" />
            </Button>
          </Tooltip>
        ) : null}

        <Tooltip label="重连">
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5"
            aria-label="重连"
            onClick={() => {
              reconnectSession(session.id);
              toast({ title: '正在重连会话…' });
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
          transport={isLocal ? 'local' : 'ssh'}
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
                  passphrase
                }
          }
        />
      </div>
    </div>
  );
}
