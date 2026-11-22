import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Terminal, type IDisposable } from '@xterm/xterm';
import { writeText as writeClipboardText } from '@tauri-apps/plugin-clipboard-manager';
import { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { openUrl } from '@tauri-apps/plugin-opener';
import '@xterm/xterm/css/xterm.css';
import {
  closePtySession,
  createPtySession,
  getPtyPlatformInfo,
  listenPtyClosed,
  listenPtyOutput,
  resizePty,
  writePty,
  type PtyClosedPayload
} from '../../hooks/useTauriPty';
import {
  connectSsh,
  disconnectSsh,
  listenSshClosed,
  listenSshOutput,
  resizeSsh,
  type SshClosedPayload,
  setSessionLog,
  writeSsh
} from '../../hooks/useTauriSsh';
import {
  connectTelnet,
  disconnectTelnet,
  listenTelnetClosed,
  listenTelnetOutput,
  resizeTelnet,
  writeTelnet,
  type TelnetClosedPayload
} from '../../hooks/useTauriTelnet';
import { useConnectionStore } from '../../stores/connectionStore';
import { broadcastInput } from '../../stores/broadcastStore';
import { toast } from '../ui/toastStore';
import { Button } from '../ui/button';
import { recordKeystroke } from '../../stores/macroStore';
import {
  connectSerial,
  disconnectSerial,
  listenSerialClosed,
  listenSerialOutput,
  writeSerial,
  type SerialClosedPayload
} from '../../hooks/useTauriSerial';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useTransferStore } from '../../stores/transferStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useI18n } from '../../i18n';
import { resumeInterruptedTransfers } from '../../lib/sftpTransfer';
import { sessionLogPath } from '../../lib/sessionLog';
import { useTheme } from '../../theme/useTheme';
import { getTerminalTheme } from '../../theme/terminalTheme';
import { useCustomThemesStore } from '../../theme/customThemesStore';
import { NativeLigaturesAddon } from '../../theme/nativeLigaturesAddon';
import {
  clearTerminalSnapshot,
  readTerminalSnapshot,
  writeTerminalSnapshot
} from '../../lib/terminalSnapshot';
import {
  MAX_RECONNECT_ATTEMPTS,
  nextReconnectDelay,
  registerTerminalReconnect,
  shouldResetBackoff
} from '../../lib/terminalReconnect';
import {
  endBarDropped,
  endBarExhausted,
  endBarReconnecting,
  endBlockText,
  localExitEndBar,
  serialCloseEndBar,
  sessionEndShortcutAction,
  sshExitEndBar,
  telnetCloseEndBar,
  type SessionEndAction,
  type SessionEndBarState
} from '../../lib/terminalEndState';
import { SessionEndBar } from './SessionEndBar';
import { terminalTranscript, transcriptFileName } from '../../lib/terminalTranscript';
import { ResizeRepaintFilter } from '../../lib/terminalResizeRepaint';
import { shouldCommitConptyPendingWrap } from '../../lib/terminalResizePendingWrap';
import { logResizeDebug } from '../../lib/terminalResizeDebug';
import { BackendResizeSender } from '../../lib/terminalBackendResize';
import {
  resolveCursorLineResizeMode,
  type CursorLineResizeMode
} from '../../lib/terminalResizePolicy';
import { localizeBackendError } from '../../lib/backendErrors';
import {
  NOTICE_RESET_PLACE_AT_BOTTOM,
  buildNoticeScrollSequence,
  buildNoticeWriteSequence,
  computeNoticePlacement
} from '../../lib/terminalNotice';

export interface XtermHandle {
  clear: () => void;
  copySelection: () => Promise<boolean>;
  hasSelection: () => boolean;
  paste: (data: string) => void;
  /** Inject text as if typed; with `execute` also send a newline. */
  sendText: (text: string, execute?: boolean) => void;
  selectAll: () => void;
  findNext: (query: string) => void;
  findPrevious: (query: string) => void;
  reconnect: () => void;
  focus: () => void;
  reset: () => void;
}

export type TerminalTransport = 'local' | 'ssh' | 'telnet' | 'serial';

export interface SshTarget {
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'key' | 'agent' | 'certificate';
  password?: string;
  privateKeyPath?: string;
  certPath?: string;
  passphrase?: string;
  jump?: SshTarget;
}

interface XtermCanvasProps {
  sessionId: string;
  fontSize?: number;
  transport?: TerminalTransport;
  ssh?: SshTarget;
  visible?: boolean;
  /** Session title used for the session-log file name. */
  logTitle?: string;
  /** Local PTY shell executable; selects the cursor-line resize policy. */
  localShellCommand?: string;
  /** Close the hosting panel; the end-state shortcuts use it for the Enter
   * action. */
  onRequestClose?: () => void;
}

const WRITE_BATCH_INTERVAL_MS = 16;
const MAX_WRITE_CHUNK = 256 * 1024;
const MAX_PENDING_OUTPUT = 4 * 1024 * 1024;

/**
 * Vertical resizes apply immediately; horizontal reflow is delayed. VS Code
 * main still uses 100ms and skips the debounce when the normal buffer is
 * under 200 lines (terminalResizeDebouncer.ts). 300ms is the delay proposed
 * in microsoft/vscode#334532 so a shell can finish its SIGWINCH redraw before
 * the next one. Continuous drags always wait here, including small buffers:
 * a per-frame resize interleaves xterm reflow with ConPTY's cursor-line repaint.
 */
const RESIZE_X_DEBOUNCE_MS = 300;

/**
 * xterm.write invokes its callback only when the whole chunk has been parsed.
 * Slice large flushes so a resize stall-detector sees intermediate progress
 * instead of reflowing mid-parse after one silent 250ms window.
 */
const PARSE_SLICE_CHARS = 16 * 1024;

/** Primary DA1 reply. ConPTY 1.22+ waits on this before the first prompt. */
const CONPTY_DA1_REPLY = '\x1b[?61;4c';

/** How long the resize HUD stays after the last applied grid change. */
const RESIZE_HUD_HIDE_MS = 1000;

interface XtermBufferLineList {
  length: number;
  maxLength: number;
}

interface XtermCoreLike {
  _bufferService?: {
    buffers?: {
      normal?: { lines: XtermBufferLineList };
      alt?: { lines: XtermBufferLineList };
    };
  };
}

/**
 * xterm.js only shrinks `lines.maxLength` for non-empty buffers. An empty
 * alternate buffer therefore keeps the old row capacity after a shrink, and a
 * later grow pulls those phantom rows back into view (xtermjs/xterm.js#6163).
 * Keep both empty buffers in sync with the target grid before resizing.
 */
function syncEmptyBufferCapacity(terminal: Terminal, rows: number, scrollback: number): void {
  try {
    const core = (terminal as unknown as { _core?: XtermCoreLike })._core;
    const buffers = core?._bufferService?.buffers;
    if (!buffers) {
      return;
    }
    if (buffers.normal && buffers.normal.lines.length === 0) {
      buffers.normal.lines.maxLength = Math.max(rows + scrollback, rows);
    }
    if (buffers.alt && buffers.alt.lines.length === 0) {
      buffers.alt.lines.maxLength = Math.max(rows, 1);
    }
  } catch {
    /* xterm internals changed; resizing still works */
  }
}

/**
 * xterm.write parses asynchronously if a chunk exceeds its time slice. A
 * resize waits for issued writes to finish parsing, but a callback can be
 * lost (e.g. a disposed renderer). The fallback is re-armed while the parser
 * still makes progress; only a full window without any progress may proceed.
 */
const RESIZE_PARSE_FALLBACK_MS = 250;

/**
 * A local-reflow resize reflows only after the backend acknowledged the new
 * grid. A lost IPC reply must not park every later resize (and direct-write
 * notices) behind `applyInProgress` forever, so the wait falls back after
 * this window — noisily, because reflowing early reintroduces the old-CUP
 * misplacement the wait exists to prevent.
 */
const RESIZE_BACKEND_ACK_TIMEOUT_MS = 500;

function logResizeError(target: string, cols: number, rows: number, error: unknown): void {
  console.warn(`[terminal] failed to resize ${target} to ${cols}x${rows}`, error);
}

function errorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Fire-and-forget a disconnect. A rejection means the backend handle leaked
 * (open COM port / stale session) after the pane is already gone, so there is
 * no UI left to report it in; surface it on the developer console instead.
 */
function disconnectQuietly(promise: Promise<unknown>): void {
  promise.catch((error) => console.warn('[terminal] disconnect failed', error));
}

const XtermCanvas = forwardRef<XtermHandle, XtermCanvasProps>(
  (
    {
      sessionId,
      fontSize = 13,
      transport = 'local',
      ssh,
      visible = true,
      logTitle = '',
      localShellCommand,
      onRequestClose
    },
    ref
  ) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const backendIdRef = useRef('');
    const reconnectRef = useRef<(() => void) | null>(null);
    const cancelReconnectRef = useRef<(() => void) | null>(null);
    const searchRef = useRef<SearchAddon | null>(null);
    const loadSearchRef = useRef<(() => Promise<SearchAddon | null>) | null>(null);
    const visibleRef = useRef(visible);
    const fontSizeRef = useRef(fontSize);
    const startRef = useRef<(() => void) | null>(null);
    const resumeRef = useRef<(() => void) | null>(null);
    const refitRef = useRef<(() => void) | null>(null);
    const flushResizeRef = useRef<(() => void) | null>(null);
    const ligaturesRef = useRef<((enabled: boolean, featureSettings: string) => void) | null>(null);
    // Centre overlay that reports the applied grid; it is driven by real
    // resize results, not by ResizeObserver intents, so it never shows a size
    // the PTY has not been told about yet.
    const [resizeHud, setResizeHud] = useState<{ cols: number; rows: number } | null>(null);
    const [initError, setInitError] = useState<string | null>(null);
    // End state: an in-buffer block for terminal kinds, a floating chip for
    // the live reconnect countdown. The transport closures below call the
    // setter directly; both renders are DOM overlays outside the write queue.
    // The ref mirrors the state for the once-registered key handler.
    const [endState, setEndBarState] = useState<SessionEndBarState | null>(null);
    const endStateRef = useRef<SessionEndBarState | null>(null);
    const onRequestCloseRef = useRef(onRequestClose);
    onRequestCloseRef.current = onRequestClose;
    const resizeHudTimerRef = useRef<number | null>(null);
    const resizeHudValueRef = useRef<{ cols: number; rows: number } | null>(null);
    const { themeId } = useTheme();
    const { t } = useI18n();

    const terminalFontFamily = useSettingsStore((state) => state.terminalFontFamily);
    const terminalFontLigatures = useSettingsStore((state) => state.terminalFontLigatures);
    const terminalFontFeatureSettings = useSettingsStore(
      (state) => state.terminalFontFeatureSettings
    );
    const terminalColorScheme = useSettingsStore((state) => state.terminalColorScheme);
    const customThemes = useCustomThemesStore((state) => state.themes);
    const terminalCursorStyle = useSettingsStore((state) => state.terminalCursorStyle);
    const terminalCursorBlink = useSettingsStore((state) => state.terminalCursorBlink);
    const terminalScrollback = useSettingsStore((state) => state.terminalScrollback);
    const terminalLineHeight = useSettingsStore((state) => state.terminalLineHeight);

    const host = ssh?.host ?? '';
    const port = ssh?.port ?? 22;
    const username = ssh?.username ?? '';
    const password = ssh?.password ?? '';
    const authMethod = ssh?.authMethod ?? 'password';
    const privateKeyPath = ssh?.privateKeyPath ?? '';
    const certPath = ssh?.certPath ?? '';
    const passphrase = ssh?.passphrase ?? '';

    const jump = ssh?.jump;
    const jumpHost = jump?.host ?? '';
    const jumpPort = jump?.port ?? 22;
    const jumpUsername = jump?.username ?? '';
    const jumpPassword = jump?.password ?? '';
    const jumpAuthMethod = jump?.authMethod ?? 'password';
    const jumpKeyPath = jump?.privateKeyPath ?? '';
    const jumpCertPath = jump?.certPath ?? '';
    const jumpPassphrase = jump?.passphrase ?? '';

    const sessionLogEnabled = useSettingsStore((state) => state.sessionLogEnabled);
    const sessionLogDir = useSettingsStore((state) => state.sessionLogDir);

    // Dump the settled buffer to a user-chosen file. The backend opens the
    // save dialog and writes the file itself; the path never crosses IPC.
    const saveTranscript = (): void => {
      const instance = terminalRef.current;
      if (!instance) {
        return;
      }
      invoke<boolean>('export_terminal_transcript', {
        contents: terminalTranscript(instance.buffer),
        fileName: transcriptFileName(logTitle, new Date()),
        title: t('terminal.exportTranscriptTitle')
      })
        .then((saved) => {
          if (saved) {
            toast({ title: t('terminal.exportTranscriptOk'), variant: 'success' });
          }
        })
        .catch((error: unknown) =>
          toast({
            title: t('terminal.exportTranscriptFailed'),
            description: localizeBackendError(errorMessage(error)),
            variant: 'error'
          })
        );
    };

    const dispatchEndAction = (action: SessionEndAction): void => {
      if (action === 'reconnect' || action === 'reconnectNow') {
        reconnectRef.current?.();
      } else if (action === 'cancelReconnect') {
        cancelReconnectRef.current?.();
      } else if (action === 'saveOutput') {
        saveTranscript();
      } else {
        onRequestCloseRef.current?.();
      }
      // Keys and chip buttons both land here; return focus to the grid so
      // the next shortcut works without an extra click.
      terminalRef.current?.focus();
    };
    const dispatchEndActionRef = useRef(dispatchEndAction);
    dispatchEndActionRef.current = dispatchEndAction;

    useEffect(() => {
      const backendId = backendIdRef.current;
      if (!backendId) {
        return;
      }
      void setSessionLog(
        backendId,
        sessionLogEnabled ? sessionLogPath(sessionLogDir, logTitle) : null
      ).catch(
        // The id may reference a connection that just dropped; logging
        // simply stays off for it.
        () => {}
      );
      // The path is intentionally not re-derived on `logTitle` changes; only
      // a logging setting flip re-points the file of a live session.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionLogEnabled, sessionLogDir]);

    useEffect(() => {
      fontSizeRef.current = fontSize;
    }, [fontSize]);

    useEffect(() => {
      if (!visible) {
        // Commit any pending debounced resize while the geometry is still
        // meaningful, otherwise the PTY can be left at a stale size while
        // the tab is hidden.
        flushResizeRef.current?.();
      }
      visibleRef.current = visible;
      if (!visible) {
        return;
      }
      startRef.current?.();
      resumeRef.current?.();
    }, [visible]);

    useEffect(() => {
      const container = containerRef.current;
      if (!container) {
        return;
      }

      let disposed = false;
      // Shared setter for every transport closure: keeps the ref mirror in
      // lockstep so the once-registered key handler always reads the current
      // end state.
      const setEndBar = (state: SessionEndBarState | null) => {
        endStateRef.current = state;
        setEndBarState(state);
      };
      let backendId = '';
      // Id of a connect attempt still in its handshake (typically waiting
      // for a host-key decision). Closing the panel cancels it explicitly.
      let pendingConnectId: string | null = null;
      // One log file per terminal activation: auto-reconnects keep appending
      // to the same file instead of scattering timestamped fragments.
      // Computed at connect time so a settings flip during a (re)connect is
      // not silently ignored for that session.
      const sessionLogTarget = (): string => {
        const logSettings = useSettingsStore.getState();
        return logSettings.sessionLogEnabled
          ? sessionLogPath(logSettings.sessionLogDir, logTitle)
          : '';
      };
      let unlistenOutput: (() => void) | undefined;
      let unlistenClosed: (() => void) | undefined;
      let dataDisposable: IDisposable | undefined;
      let resizeDisposable: IDisposable | undefined;

      let terminal: Terminal | null = null;
      // Decided after the first platform probe: cmd must reflow its own
      // cursor line, every readline-family shell must be left alone.
      let cursorLineResizeMode: CursorLineResizeMode = 'shell-repaint';
      let fitAddon: FitAddon | null = null;
      let searchAddon: SearchAddon | null = null;
      let ligaturesAddon: NativeLigaturesAddon | null = null;
      let ligaturesEnabled = false;
      let ligatureFeatureSettings = '';
      let webglAddon: WebglAddon | null = null;
      let unicode11Addon: Unicode11Addon | null = null;
      let webLinksAddon: WebLinksAddon | null = null;
      let serializeAddon: SerializeAddon | null = null;
      let selectionDisposable: IDisposable | undefined;
      let snapshotCleanup: (() => void) | null = null;
      let snapshotSave: (() => void) | null = null;

      const loadWebgl = () => {
        const instance = terminal;
        if (!instance || disposed || webglAddon) {
          return;
        }
        try {
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => {
            webgl.dispose();
            if (webglAddon === webgl) {
              webglAddon = null;
            }
          });
          instance.loadAddon(webgl);
          webglAddon = webgl;
        } catch {
          webglAddon = null;
        }
      };

      const applyLigatures = (enabled: boolean, featureSettings: string) => {
        const instance = terminal;
        if (!instance || disposed) {
          ligaturesEnabled = enabled;
          ligatureFeatureSettings = featureSettings;
          return;
        }
        if (
          enabled === ligaturesEnabled &&
          (!enabled || featureSettings === ligatureFeatureSettings)
        ) {
          return;
        }

        const hadWebgl = Boolean(webglAddon);
        ligaturesEnabled = enabled;
        ligatureFeatureSettings = featureSettings;
        webglAddon?.dispose();
        webglAddon = null;
        ligaturesAddon?.dispose();
        ligaturesAddon = null;

        if (enabled) {
          try {
            const addon = new NativeLigaturesAddon({ featureSettings });
            instance.loadAddon(addon);
            ligaturesAddon = addon;
          } catch {
            ligaturesAddon = null;
          }
        }

        // VS Code recreates WebGL after ligatures change so the texture atlas
        // picks up the new font feature styles.
        if (hadWebgl) {
          loadWebgl();
        }
      };

      ligaturesRef.current = applyLigatures;

      let initFrame: number | null = null;
      let initializing = false;
      let resizeTimer: number | null = null;

      const writeQueue: string[] = [];
      let pendingChars = 0;
      let flushTimer: number | null = null;

      // xterm.write parses in time-sliced chunks. Track issued/parsed writes
      // so a resize can wait for a clean parse boundary instead of reflowing
      // a buffer that still has bytes pending at the old geometry.
      let writesIssued = 0;
      let writesParsed = 0;
      let parseWaiters: Array<() => void> = [];
      let writeFrozen = false;
      let unfreezeWaiters: Array<() => void> = [];
      let repaintFilter: ResizeRepaintFilter | null = null;

      let latestDimensions: { cols: number; rows: number; id: number } | null = null;
      let desiredDimensions: { cols: number; rows: number; id: number } | null = null;
      let resizeRequestId = 0;
      let applyInProgress = false;
      // Depth of direct-to-xterm write sequences (snapshot restore, notices).
      // While active, resizes must not start: they would issue queued output
      // between the sequence's writes and reflow a half-written buffer.
      let directWriteDepth = 0;

      let resizeTarget: { id: string; transport: TerminalTransport } | null = null;
      let da1Disposable: IDisposable | undefined;
      const pendingPtyReplies: string[] = [];

      const isPrimaryDa1 = (params: (number | number[])[]): boolean => {
        if (params.length === 0) {
          return true;
        }
        if (params.length !== 1) {
          return false;
        }
        const first = params[0];
        if (typeof first === 'number') {
          return first === 0;
        }
        return first.length === 0 || first[0] === 0;
      };

      const replyToLocalPty = (data: string): void => {
        const target = resizeTarget;
        if (target?.transport === 'local' && target.id) {
          writePty(target.id, data).catch(() => undefined);
          return;
        }
        pendingPtyReplies.push(data);
      };

      const flushPtyReplies = (): void => {
        const target = resizeTarget;
        if (!target || target.transport !== 'local' || pendingPtyReplies.length === 0) {
          return;
        }
        const queued = pendingPtyReplies.splice(0, pendingPtyReplies.length);
        for (const data of queued) {
          writePty(target.id, data).catch(() => undefined);
        }
      };

      const armConptyDa1 = (instance: Terminal): void => {
        da1Disposable?.dispose();
        // `{ final: 'c' }` matches primary DA only. `CSI > c` carries a prefix
        // and does not hit this handler, so secondary DA is left to xterm.
        da1Disposable = instance.parser.registerCsiHandler({ final: 'c' }, (params) => {
          if (!isPrimaryDa1(params)) {
            return false;
          }
          replyToLocalPty(CONPTY_DA1_REPLY);
          return true;
        });
      };

      let maximized: boolean | null = null;
      let maximizeTimer: number | null = null;
      let unlistenWindowResize: (() => void) | undefined;

      let searchAddonPromise: Promise<SearchAddon | null> | null = null;

      const ensureSearchAddon = (): Promise<SearchAddon | null> => {
        if (searchAddon) {
          return Promise.resolve(searchAddon);
        }
        if (!terminal || disposed) {
          return Promise.resolve(null);
        }
        if (!searchAddonPromise) {
          searchAddonPromise = import('@xterm/addon-search')
            .then(({ SearchAddon: SearchAddonImpl }) => {
              const activeTerminal = terminal;
              if (disposed || !activeTerminal) {
                return null;
              }
              const addon = new SearchAddonImpl();
              activeTerminal.loadAddon(addon);
              searchAddon = addon;
              searchRef.current = addon;
              return addon;
            })
            .catch((error) => {
              console.warn('[terminal] failed to load search addon', error);
              searchAddonPromise = null;
              return null;
            });
        }
        return searchAddonPromise;
      };

      loadSearchRef.current = ensureSearchAddon;

      const cancelScheduledFlush = () => {
        if (flushTimer !== null) {
          window.clearTimeout(flushTimer);
          flushTimer = null;
        }
      };

      const resolveParseWaiters = () => {
        if (writesParsed < writesIssued || parseWaiters.length === 0) {
          return;
        }
        const waiters = parseWaiters;
        parseWaiters = [];
        for (const waiter of waiters) {
          waiter();
        }
      };

      const issueWrite = (data: string) => {
        if (disposed || !terminal || !data) {
          return;
        }
        let offset = 0;
        while (offset < data.length) {
          let end = Math.min(offset + PARSE_SLICE_CHARS, data.length);
          // Keep a UTF-16 surrogate pair in one write. The parser is stateful
          // across writes, so splitting an escape sequence is fine; splitting
          // a surrogate is not.
          if (end < data.length) {
            const tail = data.charCodeAt(end - 1);
            if (tail >= 0xd800 && tail <= 0xdbff) {
              end -= 1;
            }
          }
          if (end <= offset) {
            end = Math.min(offset + 1, data.length);
          }
          const slice = data.slice(offset, end);
          offset = end;
          writesIssued += 1;
          terminal.write(slice, () => {
            writesParsed += 1;
            resolveParseWaiters();
          });
        }
      };

      const flushRepaintCarry = (): void => {
        // A waiter from the previous window can run after arm() has opened the
        // next one. Leave that window's held prefix alone.
        if (repaintFilter?.isPending) {
          return;
        }
        const carry = repaintFilter?.takeCarry() ?? '';
        if (carry) {
          issueWrite(carry);
        }
      };

      let repaintWaitArmed = false;

      const armResizeRepaintFilter = (): void => {
        if (!repaintFilter) {
          repaintFilter = new ResizeRepaintFilter();
        }
        const leftover = repaintFilter.arm();
        if (leftover) {
          issueWrite(leftover);
        }
        logResizeDebug('repaint-arm');
        repaintFilter.whenSettled(flushRepaintCarry);
      };

      const releaseRepaintFilter = (): string => {
        repaintWaitArmed = false;
        return repaintFilter?.cancel() ?? '';
      };

      const takeQueuedData = () => {
        if (writeQueue.length === 0) {
          return '';
        }
        const data = writeQueue.join('');
        writeQueue.length = 0;
        pendingChars = 0;
        return data;
      };

      // Commit everything queued so far in one ordered write. Used before a
      // resize so old-size output is fully parsed before the reflow and
      // before ConPTY emits its resize repaint.
      const flushPendingWrites = () => {
        cancelScheduledFlush();
        if (disposed || !terminal || writeFrozen) {
          return;
        }
        const data = takeQueuedData();
        if (data) {
          issueWrite(repaintFilter ? repaintFilter.consume(data) : data);
        }
      };

      const flushWrites = () => {
        flushTimer = null;
        if (
          disposed ||
          !terminal ||
          writeFrozen ||
          !visibleRef.current ||
          writeQueue.length === 0
        ) {
          return;
        }
        let size = 0;
        let count = 0;
        while (count < writeQueue.length && size < MAX_WRITE_CHUNK) {
          size += writeQueue[count].length;
          count += 1;
        }
        const data = writeQueue.splice(0, count).join('');
        pendingChars -= size;
        // The first post-resize batch is ConPTY's cursor-line repaint. Strip
        // only its trailing padding: legitimate text may still wrap at the
        // last column, and killing autowrap for the whole batch corrupts it.
        issueWrite(repaintFilter ? repaintFilter.consume(data) : data);
        if (writeQueue.length > 0) {
          scheduleFlush();
        }
      };

      const scheduleFlush = () => {
        if (disposed || flushTimer !== null || !visibleRef.current) {
          return;
        }
        flushTimer = window.setTimeout(flushWrites, WRITE_BATCH_INTERVAL_MS);
      };

      const enqueueWrite = (data: string) => {
        if (disposed || !data) {
          return;
        }
        writeQueue.push(data);
        pendingChars += data.length;

        // Never drop output. If a background tab accumulates too much data,
        // flush it into xterm to bound memory usage.
        if (pendingChars >= MAX_PENDING_OUTPUT) {
          flushPendingWrites();
          return;
        }

        scheduleFlush();
      };

      const isSsh = transport === 'ssh';

      // Keep at most one resize command in flight, converge on the newest
      // requested dimensions, and let a caller await the backend ack before
      // reflowing xterm (see the two-phase path in finish()).
      const backendResize = new BackendResizeSender<{
        id: string;
        transport: TerminalTransport;
      }>({
        getTarget: () => resizeTarget,
        send: (target, cols, rows) => {
          logResizeDebug('backend-send', { cols, rows, target: target.transport });
          return target.transport === 'ssh'
            ? resizeSsh(target.id, cols, rows)
            : target.transport === 'telnet'
              ? resizeTelnet(target.id, cols, rows)
              : resizePty(target.id, cols, rows);
        },
        onError: (target, cols, rows, error) => {
          logResizeDebug('backend-error', { cols, rows, target: target.transport });
          logResizeError(
            target.transport === 'ssh'
              ? 'SSH PTY'
              : target.transport === 'telnet'
                ? 'Telnet'
                : 'PTY',
            cols,
            rows,
            error
          );
        }
      });

      /**
       * Called when a transport registers its resize target: deliver a resize
       * that arrived while nothing was connected (session creation, reconnect
       * window), else sync the current grid so the shell and xterm agree
       * before the first prompt.
       */
      const flushQueuedBackendResize = (instance: Terminal): void => {
        logResizeDebug('backend-flush-queued', {
          cols: instance.cols,
          rows: instance.rows
        });
        backendResize.flushQueued(instance.cols, instance.rows);
      };

      let reconnectAttempts = 0;
      let reconnectTimer: number | null = null;
      let manualDisconnect = false;
      let connectedAt = 0;
      // The last drop reason (an i18n key) feeds the dropped bar after the
      // user cancels the auto-reconnect ladder.
      let lastReconnectReasonKey = 'terminal.sshDisconnected';
      // Whether this session ever had a working connection. A scheduled
      // reconnect that fails must keep the chain going, so the retry
      // decision cannot rely on the current attempt's local flag.
      let everEstablished = false;
      // Invalidates callbacks from superseded connection attempts.
      let transportGeneration = 0;

      const clearTransportListeners = () => {
        unlistenOutput?.();
        unlistenOutput = undefined;
        unlistenClosed?.();
        unlistenClosed = undefined;
        dataDisposable?.dispose();
        dataDisposable = undefined;
        resizeDisposable?.dispose();
        resizeDisposable = undefined;
      };

      /**
       * Append a divider after the historical output, then push the divider
       * itself into scrollback so the new shell gets a clean screen.
       *
       * For restore/reconnect (`placeAtBottom`) the resulting buffer is
       * `[...history][notice][current screen]`: the notice is the last
       * scrollback line and the line above it is the historical output. It is
       * only visible when the user scrolls up.
       *
       * Retry notices (`placeAtBottom === false`) stay on the current screen so
       * the user can see reconnection progress.
       *
       * The cursor position is never trusted: after replaying a serialized
       * snapshot it is wherever the snapshot's tail left it, and `\x1b[?1049l`
       * restores a stale saved cursor. Both paths therefore position the
       * cursor absolutely (CUP) after deriving the target row from the buffer
       * itself. The whole sequence is frozen against the 16ms flush queue so
       * concurrently enqueued output cannot interleave between the writes.
       */
      const writeScrollbackNotice = async (
        instance: Terminal,
        notice: string,
        placeAtBottom: boolean,
        keepVisible = false
      ): Promise<void> => {
        if (disposed) {
          return;
        }
        // A resize freeze is holding the write queue: the queued old-size
        // output must reach xterm BEFORE the divider, or the notice would
        // appear above history that is still pending.
        // Re-check in a loop: finish() resolves the waiters and then
        // synchronously re-enters runResize(), which re-freezes the queue
        // before this continuation runs — a single-shot wait would let the
        // notice sequence interleave with that resize's reflow.
        while (writeFrozen || applyInProgress) {
          await new Promise<void>((resolve) => {
            unfreezeWaiters.push(resolve);
          });
          if (disposed) {
            return;
          }
        }
        if (disposed) {
          return;
        }
        // A direct write sequence must never be mistaken for ConPTY's resize
        // repaint. Write any split prefix the filter was holding first.
        const repaintCarry = releaseRepaintFilter();
        if (repaintCarry) {
          issueWrite(repaintCarry);
        }
        flushPendingWrites();
        // Hold the queue for the whole sequence and block new resizes: the
        // notice spans several asynchronous writes and interleaved output or
        // a mid-sequence reflow would corrupt the placement.
        directWriteDepth += 1;
        writeFrozen = true;
        cancelScheduledFlush();
        // Exit the alternate buffer and reset modes/scroll region. DECSTBM
        // homes the cursor; every subsequent position is absolute so the
        // clobbered cursor state is irrelevant.
        const reset = placeAtBottom
          ? NOTICE_RESET_PLACE_AT_BOTTOM
          : '\x1b[?1049l\x1b[0m\x1b[?6l\x1b[4l\x1b[?1l\x1b[?7h\x1b[?25h';
        return new Promise<void>((resolve) => {
          const finishSequence = () => {
            if (disposed) {
              resolve();
              return;
            }
            directWriteDepth = Math.max(0, directWriteDepth - 1);
            writeFrozen = false;
            const unfreezeWaiterList = unfreezeWaiters;
            unfreezeWaiters = [];
            unfreezeWaiterList.forEach((unfreezeWaiter) => unfreezeWaiter());
            scheduleFlush();
            resumePendingResize();
            resolve();
          };
          // Exit the alternate buffer first. Only then is the normal buffer's
          // cursor/scroll state final, so scroll to its live bottom.
          instance.write(reset, () => {
            if (disposed) {
              resolve();
              return;
            }
            instance.scrollToBottom();

            if (!placeAtBottom) {
              instance.write(`${notice}\r\n`, finishSequence);
              return;
            }

            // Derive the notice row from the buffer, not the cursor: the
            // notice must land on the first row below ALL content. A
            // multi-line block reserves room for all of its rows.
            const noticeRows = notice.split('\r\n').length;
            const buffer = instance.buffer.active;
            const placement = computeNoticePlacement(
              (row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '',
              buffer.cursorY,
              instance.rows,
              noticeRows
            );
            instance.write(buildNoticeWriteSequence(notice, placement, instance.rows), () => {
              if (disposed) {
                resolve();
                return;
              }
              if (keepVisible) {
                // End-state blocks stay on screen: park the cursor on the
                // row below the block instead of scrolling it into
                // scrollback like the record notices.
                instance.write(`\x1b[${placement.targetRow + noticeRows};1H\r\n`, finishSequence);
                return;
              }
              // Scroll exactly the lines that contain history + the divider.
              // The rows below the divider are blank and stay in the viewport,
              // so they never become empty scrollback lines.
              instance.write(
                buildNoticeScrollSequence(placement.targetRow, instance.rows, noticeRows),
                () => finishSequence()
              );
            });
          });
        });
      };
      /**
       * Terminal end state (exit / loss / exhaustion): write the MobaXterm-style
       * block into the buffer where it stays visible below the last output, and
       * mirror the state for the key handler and screen readers.
       */
      const writeEndBlock = (instance: Terminal, state: SessionEndBarState): void => {
        const tone = state.kind === 'ended' ? 'default' : 'warn';
        void writeScrollbackNotice(
          instance,
          endBlockText(
            t(state.messageKey, state.messageParams),
            t('terminal.endBlockHints'),
            instance.cols,
            tone
          ),
          true,
          true
        );
        setEndBar(state);
      };

      /** Same block for the SSH `exit` path, which must not replay
       * `\x1b[?1049l` (the shell already restored the normal buffer). */
      const appendEndBlock = (instance: Terminal, state: SessionEndBarState): void => {
        const tone = state.kind === 'ended' ? 'default' : 'warn';
        enqueueWrite(
          `\r\n${endBlockText(
            t(state.messageKey, state.messageParams),
            t('terminal.endBlockHints'),
            instance.cols,
            tone
          )}\r\n`
        );
        setEndBar(state);
      };

      let connectSshTransport: (instance: Terminal) => Promise<void> = async () => {};

      // A rejected keystroke write means the backend session is gone while no
      // closed event reached this pane (zombie transport). Throttle to one
      // notice per burst so continuous typing does not spam the buffer.
      let lastWriteFailureAt = 0;
      const reportWriteFailure = (instance: Terminal): void => {
        const now = Date.now();
        if (disposed || now - lastWriteFailureAt < 5_000) {
          return;
        }
        lastWriteFailureAt = now;
        void writeScrollbackNotice(instance, `\x1b[33m[${t('terminal.writeFailed')}]\x1b[0m`, true);
      };

      // ---- transport attempt skeleton ----
      // Shared by all four transports: the generation guard, listener
      // registration (which must precede the backend connect, because Tauri
      // drops events with no listener) and stale teardown are identical
      // everywhere and only the endpoints differ. Per-attempt flags live in
      // one object so these helpers can guard the closed handlers.
      interface TransportAttempt {
        established: boolean;
        closedEarly: boolean;
      }

      const beginTransportAttempt = (disposeStale: (backendId: string) => void): number => {
        clearTransportListeners();
        const generation = ++transportGeneration;
        if (backendId) {
          disposeStale(backendId);
          backendId = '';
          backendIdRef.current = '';
          resizeTarget = null;
        }
        return generation;
      };

      const attachOutputListener = async (
        listen: (id: string, handler: (payload: { data: string }) => void) => Promise<() => void>,
        id: string,
        generation: number
      ): Promise<boolean> => {
        const stop = await listen(id, ({ data }) => {
          if (generation === transportGeneration && !disposed) {
            enqueueWrite(data);
          }
        });
        if (disposed || generation !== transportGeneration) {
          stop();
          return false;
        }
        unlistenOutput = stop;
        return true;
      };

      const attachClosedListener = async <P,>(
        listen: (id: string, handler: (payload: P) => void) => Promise<() => void>,
        id: string,
        generation: number,
        attempt: TransportAttempt,
        onEstablishedClosed: (payload: P) => void
      ): Promise<boolean> => {
        const stop = await listen(id, (payload) => {
          if (disposed || generation !== transportGeneration) {
            return;
          }
          // A closed event racing the connect promise must not tear down a
          // registration still in flight; the connect epilogue rolls the
          // attempt back once it sees the flag.
          if (!attempt.established) {
            attempt.closedEarly = true;
            return;
          }
          onEstablishedClosed(payload);
        });
        if (disposed || generation !== transportGeneration) {
          stop();
          return false;
        }
        unlistenClosed = stop;
        return true;
      };

      const attachInputOutput = (
        instance: Terminal,
        write: (data: string) => Promise<void>,
        withResize: boolean
      ): void => {
        dataDisposable = instance.onData((data) => {
          write(data).catch(() => reportWriteFailure(instance));
          broadcastInput(sessionId, data);
          recordKeystroke(data);
        });
        if (withResize) {
          resizeDisposable = instance.onResize(({ cols, rows }) => {
            void backendResize.send(cols, rows);
          });
        }
      };

      const focusIfActive = (instance: Terminal): void => {
        // A background pane's connect must not steal focus from the pane the
        // user is typing in.
        if (useWorkspaceStore.getState().activeSessionId === sessionId) {
          instance.focus();
        }
      };

      /**
       * Mark a connection attempt as failed. With `terminalState` the failure
       * is final (no retry ladder): the end block itself carries the message,
       * so no extra red line is written. Returns false when the attempt was
       * superseded, so callers skip their transport bookkeeping.
       */
      const failAttempt = (
        instance: Terminal,
        generation: number,
        messageKey: string,
        error: unknown,
        terminalState?: SessionEndBarState
      ): boolean => {
        if (disposed || generation !== transportGeneration) {
          return false;
        }
        clearTransportListeners();
        useSessionStore.getState().setStatus(sessionId, 'error');
        const detail = localizeBackendError(errorMessage(error));
        if (terminalState) {
          writeEndBlock(instance, {
            ...terminalState,
            messageParams: { message: detail, ...(terminalState.messageParams ?? {}) }
          });
          return true;
        }
        enqueueWrite(`\r\n\x1b[31m${t(messageKey, { message: detail })}\x1b[0m\r\n`);
        setEndBar(endBarDropped(messageKey, { message: detail }));
        return true;
      };

      /**
       * Shared reconnect ladder (SSH and Telnet): backoff, exhaustion and the
       * end-state bar transitions. `reasonKey` names the drop for the bar;
       * the progress countdown lives in the bar and ticks locally, instead of
       * writing one buffer line per attempt.
       */
      const scheduleReconnect = (
        instance: Terminal,
        reasonKey: string,
        connect: (instance: Terminal) => Promise<void>,
        autoReconnect: () => boolean
      ) => {
        if (disposed || manualDisconnect || reconnectTimer !== null) {
          return;
        }
        lastReconnectReasonKey = reasonKey;
        if (!autoReconnect()) {
          useSessionStore.getState().setStatus(sessionId, 'disconnected');
          writeEndBlock(instance, endBarDropped(reasonKey));
          return;
        }
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          useSessionStore.getState().setStatus(sessionId, 'error');
          writeEndBlock(instance, endBarExhausted());
          return;
        }

        const attempt = reconnectAttempts + 1;
        reconnectAttempts = attempt;
        const delay = nextReconnectDelay(attempt);
        useSessionStore.getState().setStatus(sessionId, 'connecting');
        setEndBar(endBarReconnecting(t(reasonKey), attempt, delay));
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          if (disposed) {
            return;
          }
          if (!autoReconnect()) {
            useSessionStore.getState().setStatus(sessionId, 'disconnected');
            writeEndBlock(instance, endBarDropped(reasonKey));
            return;
          }
          void connect(instance);
        }, delay);
      };

      const cancelAutoReconnect = () => {
        if (reconnectTimer !== null) {
          window.clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        reconnectAttempts = 0;
        useSessionStore.getState().setStatus(sessionId, 'disconnected');
        if (terminal) {
          writeEndBlock(terminal, endBarDropped(lastReconnectReasonKey));
        } else {
          setEndBar(endBarDropped(lastReconnectReasonKey));
        }
      };

      connectSshTransport = async (instance: Terminal) => {
        if (disposed) {
          return;
        }
        const generation = beginTransportAttempt((staleId) => {
          // A previous attempt may have established a connection but failed
          // while registering listeners. Do not leak it on the next attempt.
          useConnectionStore.getState().removeConnection(sessionId, staleId);
          disconnectQuietly(disconnectSsh(staleId));
        });

        const id = crypto.randomUUID();
        const attempt: TransportAttempt = { established: false, closedEarly: false };

        try {
          if (!host || !username) {
            throw new Error(t('terminal.missingHost'));
          }
          if (authMethod === 'password' && !password) {
            throw new Error(t('terminal.missingPassword'));
          }
          if (authMethod === 'key' && !privateKeyPath) {
            throw new Error(t('terminal.missingKeyFile'));
          }
          if (authMethod === 'certificate' && (!privateKeyPath || !certPath)) {
            throw new Error(t('terminal.missingKeyOrCert'));
          }
          if (jumpHost) {
            if (!jumpUsername) {
              throw new Error(t('terminal.jumpMissingUsername'));
            }
            if (jumpAuthMethod === 'password' && !jumpPassword) {
              throw new Error(t('terminal.jumpMissingPassword'));
            }
            if (jumpAuthMethod === 'key' && !jumpKeyPath) {
              throw new Error(t('terminal.jumpMissingKeyFile'));
            }
            if (jumpAuthMethod === 'certificate' && (!jumpKeyPath || !jumpCertPath)) {
              throw new Error(t('terminal.jumpMissingKeyOrCert'));
            }
          }

          useSessionStore.getState().setStatus(sessionId, 'connecting');

          // Attach listeners before the backend opens the shell. The first
          // prompt can be emitted before connectSsh resolves, and events that
          // arrive without a listener are dropped by Tauri.
          if (!(await attachOutputListener(listenSshOutput, id, generation))) {
            return;
          }

          const closedHandled = await attachClosedListener<SshClosedPayload>(
            listenSshClosed,
            id,
            generation,
            attempt,
            (closed) => {
              const uptime = connectedAt > 0 ? Date.now() - connectedAt : 0;
              clearTransportListeners();
              backendId = '';
              backendIdRef.current = '';
              resizeTarget = null;
              useConnectionStore.getState().removeConnection(sessionId, id);
              // Another split pane of this session may still be connected;
              // only reset the status once no connection remains.
              if (useConnectionStore.getState().connections[sessionId] === undefined) {
                useSessionStore.getState().setStatus(sessionId, 'disconnected');
              }
              useTransferStore.getState().markSessionDisconnected(sessionId);

              // The remote shell ended on its own (`exit`, logout, a killed
              // login shell). Re-opening a shell the user just closed is wrong,
              // so show the exit and stop here instead of scheduling a retry;
              // the end block offers a manual reconnect via R instead.
              if (closed.reason === 'exit') {
                // No `\x1b[?1049l` here: the shell already restored the normal
                // buffer, and re-issuing the switch rewinds the viewport (the
                // notice landed above the login banner). Just append the block.
                appendEndBlock(instance, sshExitEndBar(closed));
                return;
              }

              // Only treat a connection as healthy once it survived a while;
              // otherwise a server that accepts and immediately drops would
              // reset the backoff and reconnect forever.
              if (shouldResetBackoff(uptime)) {
                reconnectAttempts = 0;
              }

              if (useSettingsStore.getState().sshAutoReconnect) {
                void writeScrollbackNotice(
                  instance,
                  `\x1b[33m[${t('terminal.sshDisconnected')}]\x1b[0m`,
                  true
                ).then(() => {
                  if (disposed || generation !== transportGeneration) {
                    return;
                  }
                  scheduleReconnect(
                    instance,
                    'terminal.sshDisconnected',
                    connectSshTransport,
                    () => useSettingsStore.getState().sshAutoReconnect
                  );
                });
              } else {
                // No auto-reconnect: the block is final. writeScrollbackNotice
                // performs the alt-buffer exit with absolute repositioning; a
                // raw `\x1b[?1049l` here would restore a stale viewport and
                // jump the view to the top of the scrollback.
                writeEndBlock(instance, endBarDropped('terminal.sshDisconnected'));
              }
            }
          );
          if (!closedHandled) {
            return;
          }

          pendingConnectId = id;
          const connectedId = await connectSsh({
            id,
            host,
            port,
            username,
            authMethod,
            password,
            privateKeyPath: privateKeyPath || undefined,
            certPath: certPath || undefined,
            passphrase: passphrase || undefined,
            jump: jumpHost
              ? {
                  host: jumpHost,
                  port: jumpPort,
                  username: jumpUsername,
                  authMethod: jumpAuthMethod,
                  password: jumpPassword,
                  privateKeyPath: jumpKeyPath || undefined,
                  certPath: jumpCertPath || undefined,
                  passphrase: jumpPassphrase || undefined
                }
              : undefined,
            logPath: sessionLogTarget() || undefined,
            cols: instance.cols,
            rows: instance.rows
          });
          if (pendingConnectId === id) {
            pendingConnectId = null;
          }

          if (disposed || generation !== transportGeneration || attempt.closedEarly) {
            disconnectQuietly(disconnectSsh(connectedId));
            if (attempt.closedEarly && !disposed && generation === transportGeneration) {
              clearTransportListeners();
              useSessionStore.getState().setStatus(sessionId, 'error');
              useConnectionStore.getState().removeConnection(sessionId, connectedId);
              writeEndBlock(instance, endBarDropped('terminal.sshClosedByServer'));
            }
            return;
          }

          attempt.established = true;
          everEstablished = true;
          backendId = connectedId;
          backendIdRef.current = connectedId;
          connectedAt = Date.now();
          resizeTarget = { id: connectedId, transport: 'ssh' };
          useConnectionStore
            .getState()
            .setConnection(sessionId, { sshId: connectedId, status: 'connected' });
          useSessionStore.getState().setStatus(sessionId, 'connected');
          setEndBar(null);
          // Resume transfers interrupted by an earlier drop of this session;
          // the backend picks up from the .part files via their fingerprints.
          void resumeInterruptedTransfers(sessionId);

          // A fit may have happened while the connection was being
          // established. Sync the final grid to the remote PTY — or the
          // queued request if one arrived before the target existed.
          flushQueuedBackendResize(instance);

          attachInputOutput(instance, (data) => writeSsh(connectedId, data), true);

          focusIfActive(instance);
        } catch (error) {
          if (pendingConnectId === id) {
            pendingConnectId = null;
          }
          // Retry whenever this session had a working connection before:
          // either the attempt that just dropped, or a previous one whose
          // scheduled retry itself failed (e.g. the network is still down).
          // Never-connected sessions (auth/host-key failures) surface
          // immediately as a terminal block instead of looping.
          const handled = failAttempt(
            instance,
            generation,
            'terminal.sshConnectFailed',
            error,
            everEstablished ? undefined : endBarDropped('terminal.sshConnectFailed')
          );
          if (handled) {
            useConnectionStore.getState().removeConnection(sessionId, id);
            if (everEstablished) {
              scheduleReconnect(
                instance,
                'terminal.sshDisconnected',
                connectSshTransport,
                () => useSettingsStore.getState().sshAutoReconnect
              );
            }
          }
        }
      };

      const connectLocalTransport = async (instance: Terminal) => {
        if (disposed) {
          return;
        }
        const generation = beginTransportAttempt((staleId) => {
          void closePtySession(staleId);
        });

        const id = crypto.randomUUID();
        const attempt: TransportAttempt = { established: false, closedEarly: false };

        try {
          useSessionStore.getState().setStatus(sessionId, 'connecting');

          if (!(await attachOutputListener(listenPtyOutput, id, generation))) {
            return;
          }

          const closedHandled = await attachClosedListener<PtyClosedPayload>(
            listenPtyClosed,
            id,
            generation,
            attempt,
            (payload) => {
              clearTransportListeners();
              useConnectionStore.getState().removeTransport(sessionId, 'pty', id);
              backendId = '';
              backendIdRef.current = '';
              resizeTarget = null;
              // Another split pane of this session may still hold its own PTY;
              // only the last one going away marks the session ended.
              if (useConnectionStore.getState().connections[sessionId] === undefined) {
                useSessionStore.getState().setStatus(sessionId, 'disconnected');
              }
              writeEndBlock(instance, localExitEndBar(payload.exitStatus));
            }
          );
          if (!closedHandled) {
            return;
          }

          // Read the shell override from the store at connect time so an edit
          // applied after the session list rendered still takes effect.
          const sessionRecord = useSessionStore.getState().getSession(sessionId);
          const localShell =
            sessionRecord?.kind === 'local' && sessionRecord.shellCommand
              ? { command: sessionRecord.shellCommand, args: sessionRecord.shellArgs ?? [] }
              : undefined;
          const createdId = await createPtySession(
            id,
            instance.cols,
            instance.rows,
            sessionLogTarget() || undefined,
            localShell
          );
          if (disposed || generation !== transportGeneration || attempt.closedEarly) {
            useConnectionStore.getState().removeTransport(sessionId, 'pty', createdId);
            void closePtySession(createdId);
            if (attempt.closedEarly && !disposed && generation === transportGeneration) {
              clearTransportListeners();
              useSessionStore.getState().setStatus(sessionId, 'disconnected');
              writeEndBlock(instance, localExitEndBar(null));
            }
            return;
          }

          attempt.established = true;
          backendId = createdId;
          backendIdRef.current = createdId;
          resizeTarget = { id: createdId, transport: 'local' };
          flushPtyReplies();
          useConnectionStore.getState().addTransport(sessionId, 'pty', createdId);
          useSessionStore.getState().setStatus(sessionId, 'connected');
          setEndBar(null);

          // A fit may have happened while the PTY was being created. Sync the
          // final grid so the shell and xterm agree before the first prompt —
          // a resize that arrived before the target existed takes precedence.
          flushQueuedBackendResize(instance);

          attachInputOutput(instance, (data) => writePty(createdId, data), true);

          focusIfActive(instance);
        } catch (error) {
          // A local PTY has no reconnect ladder: creation failure is final.
          failAttempt(
            instance,
            generation,
            'terminal.ptyCreateFailed',
            error,
            endBarDropped('terminal.ptyCreateFailed')
          );
        }
      };

      const connectTelnetTransport = async (instance: Terminal) => {
        if (disposed) {
          return;
        }
        const generation = beginTransportAttempt((staleId) => {
          disconnectQuietly(disconnectTelnet(staleId));
        });

        const id = crypto.randomUUID();
        const attempt: TransportAttempt = { established: false, closedEarly: false };

        try {
          if (!host) {
            throw new Error(t('terminal.missingHostAddress'));
          }
          useSessionStore.getState().setStatus(sessionId, 'connecting');

          if (!(await attachOutputListener(listenTelnetOutput, id, generation))) {
            return;
          }

          const closedHandled = await attachClosedListener<TelnetClosedPayload>(
            listenTelnetClosed,
            id,
            generation,
            attempt,
            (closed) => {
              clearTransportListeners();
              useConnectionStore.getState().removeTransport(sessionId, 'telnet', id);
              backendId = '';
              backendIdRef.current = '';
              resizeTarget = null;
              // Same rule as the local path: keep the status when a sibling
              // split pane still has a live Telnet transport.
              if (useConnectionStore.getState().connections[sessionId] === undefined) {
                useSessionStore.getState().setStatus(sessionId, 'disconnected');
              }
              // A deliberate disconnect (`closed`) never retries; a dropped
              // stream retries under the same ladder as SSH when enabled.
              if (closed.reason === 'closed') {
                writeEndBlock(instance, telnetCloseEndBar(closed));
                return;
              }
              if (shouldResetBackoff(connectedAt > 0 ? Date.now() - connectedAt : 0)) {
                reconnectAttempts = 0;
              }
              if (useSettingsStore.getState().telnetAutoReconnect) {
                void writeScrollbackNotice(
                  instance,
                  `\x1b[33m[${t('terminal.telnetDisconnected')}]\x1b[0m`,
                  true
                );
                scheduleReconnect(
                  instance,
                  'terminal.telnetDisconnected',
                  connectTelnetTransport,
                  () => useSettingsStore.getState().telnetAutoReconnect
                );
              } else {
                writeEndBlock(instance, telnetCloseEndBar(closed));
              }
            }
          );
          if (!closedHandled) {
            return;
          }

          const connectedId = await connectTelnet({
            id,
            host,
            port,
            logPath: sessionLogTarget() || undefined
          });
          if (disposed || generation !== transportGeneration || attempt.closedEarly) {
            useConnectionStore.getState().removeTransport(sessionId, 'telnet', connectedId);
            disconnectQuietly(disconnectTelnet(connectedId));
            if (attempt.closedEarly && !disposed && generation === transportGeneration) {
              clearTransportListeners();
              useSessionStore.getState().setStatus(sessionId, 'disconnected');
              writeEndBlock(instance, endBarDropped('terminal.telnetDisconnected'));
            }
            return;
          }

          attempt.established = true;
          backendId = connectedId;
          backendIdRef.current = connectedId;
          connectedAt = Date.now();
          resizeTarget = { id: connectedId, transport: 'telnet' };
          useConnectionStore.getState().addTransport(sessionId, 'telnet', connectedId);
          useSessionStore.getState().setStatus(sessionId, 'connected');
          setEndBar(null);
          // Drain a resize queued while connecting, then report the real grid
          // once: the server assumes 80x24 until NAWS is negotiated, and the
          // dedup in backendResize would skip an unchanged size.
          flushQueuedBackendResize(instance);
          resizeTelnet(connectedId, instance.cols, instance.rows).catch(() => undefined);

          attachInputOutput(instance, (data) => writeTelnet(connectedId, data), true);

          focusIfActive(instance);
        } catch (error) {
          // Telnet connect failures are terminal: only established streams
          // that drop feed the reconnect ladder.
          failAttempt(
            instance,
            generation,
            'terminal.telnetConnectFailed',
            error,
            endBarDropped('terminal.telnetConnectFailed')
          );
        }
      };

      const connectSerialTransport = async (instance: Terminal) => {
        if (disposed) {
          return;
        }
        const generation = beginTransportAttempt((staleId) => {
          disconnectQuietly(disconnectSerial(staleId));
        });

        const id = crypto.randomUUID();
        const attempt: TransportAttempt = { established: false, closedEarly: false };

        try {
          // Read the port config at connect time so an edit applied after
          // the session list rendered still takes effect.
          const sessionRecord = useSessionStore.getState().getSession(sessionId);
          const portName = sessionRecord?.serialPort ?? '';
          if (!portName) {
            throw new Error(t('terminal.missingSerialPort'));
          }
          useSessionStore.getState().setStatus(sessionId, 'connecting');

          if (!(await attachOutputListener(listenSerialOutput, id, generation))) {
            return;
          }

          const closedHandled = await attachClosedListener<SerialClosedPayload>(
            listenSerialClosed,
            id,
            generation,
            attempt,
            (payload) => {
              clearTransportListeners();
              useConnectionStore.getState().removeTransport(sessionId, 'serial', id);
              backendId = '';
              backendIdRef.current = '';
              resizeTarget = null;
              // No auto-reconnect: unplugged adapters stay unplugged until the
              // user explicitly reconnects. Same sibling rule as the local and
              // Telnet paths: only the last transport going away marks the
              // session ended.
              if (useConnectionStore.getState().connections[sessionId] === undefined) {
                useSessionStore.getState().setStatus(sessionId, 'disconnected');
              }
              writeEndBlock(instance, serialCloseEndBar(payload));
            }
          );
          if (!closedHandled) {
            return;
          }

          const connectedId = await connectSerial({
            id,
            portName,
            baud: sessionRecord?.serialBaud ?? 115200,
            logPath: sessionLogTarget() || undefined
          });
          if (disposed || generation !== transportGeneration || attempt.closedEarly) {
            useConnectionStore.getState().removeTransport(sessionId, 'serial', connectedId);
            disconnectQuietly(disconnectSerial(connectedId));
            if (attempt.closedEarly && !disposed && generation === transportGeneration) {
              clearTransportListeners();
              useSessionStore.getState().setStatus(sessionId, 'disconnected');
              writeEndBlock(instance, endBarDropped('terminal.serialDisconnected'));
            }
            return;
          }

          attempt.established = true;
          backendId = connectedId;
          backendIdRef.current = connectedId;
          // Serial has no window-size negotiation: no resizeTarget.
          useConnectionStore.getState().addTransport(sessionId, 'serial', connectedId);
          useSessionStore.getState().setStatus(sessionId, 'connected');
          setEndBar(null);

          attachInputOutput(instance, (data) => writeSerial(connectedId, data), false);

          focusIfActive(instance);
        } catch (error) {
          // Serial has no reconnect ladder: connect failure is final.
          failAttempt(
            instance,
            generation,
            'terminal.serialConnectFailed',
            error,
            endBarDropped('terminal.serialConnectFailed')
          );
        }
      };

      const run = async (instance: Terminal) => {
        if (isSsh) {
          await connectSshTransport(instance);
        } else if (transport === 'telnet') {
          await connectTelnetTransport(instance);
        } else if (transport === 'serial') {
          await connectSerialTransport(instance);
        } else {
          await connectLocalTransport(instance);
        }
      };

      const reconnect = (instance: Terminal) => {
        if (disposed) {
          return;
        }
        if (reconnectTimer !== null) {
          window.clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        reconnectAttempts = 0;
        useSessionStore.getState().setStatus(sessionId, 'connecting');
        setEndBar(null);
        void writeScrollbackNotice(
          instance,
          `\x1b[33m[${t('terminal.reconnectNotice')}]\x1b[0m`,
          true
        ).then(() => {
          if (disposed) {
            return;
          }
          if (isSsh) {
            void connectSshTransport(instance);
          } else if (transport === 'telnet') {
            void connectTelnetTransport(instance);
          } else if (transport === 'serial') {
            void connectSerialTransport(instance);
          } else {
            void connectLocalTransport(instance);
          }
        });
      };

      reconnectRef.current = () => {
        if (terminal) {
          reconnect(terminal);
        }
      };
      cancelReconnectRef.current = cancelAutoReconnect;
      const unregisterReconnect = registerTerminalReconnect(sessionId, () => {
        if (!terminal) {
          return false;
        }
        reconnect(terminal);
        return true;
      });

      const initialize = () => {
        initFrame = null;
        if (disposed || initializing) {
          return;
        }
        initializing = true;

        void (async () => {
          try {
            // Only a local PTY is backed by ConPTY. SSH/telnet/serial keep
            // xterm's default buffer semantics: injecting `windowsPty` would
            // make xterm stop pulling scrollback rows back into the viewport
            // on grow, which only makes sense when the backend repaints.
            const platform = transport === 'local' ? await getPtyPlatformInfo() : null;
            if (disposed || !visibleRef.current) {
              return;
            }

            // The bundled ConPTY re-joins its own wrapped rows and emits a
            // cursor-line repaint; the OS ConPTY reprints the whole screen
            // and echoes without re-anchoring CUPs. Falling back silently
            // changes the resize contract, so make it visible.
            if (platform?.backend === 'conpty' && platform.bundled === false) {
              console.warn(
                '[terminal] bundled ConPTY unavailable; using the system ConPTY ' +
                  '(full-screen reprint on resize, see doc/terminal-resize-plan.md)'
              );
            }

            cursorLineResizeMode = resolveCursorLineResizeMode({
              transport,
              shellCommand: localShellCommand,
              backend: platform?.backend ?? null
            });

            const settings = useSettingsStore.getState();
            const instance = new Terminal({
              allowProposedApi: true,
              cursorBlink: settings.terminalCursorBlink,
              cursorStyle: settings.terminalCursorStyle,
              fontFamily: settings.terminalFontFamily,
              fontSize: fontSizeRef.current,
              lineHeight: settings.terminalLineHeight,
              scrollback: settings.terminalScrollback,
              // cmd under ConPTY never repaints the prompt rows, so xterm
              // must reflow the cursor group itself. readline-family shells
              // repaint from the cursor row they believe is current; touching
              // it there duplicates the prompt or overwrites the line above.
              reflowCursorLine: cursorLineResizeMode === 'local-reflow',
              // ConPTY has different resize semantics than a Unix PTY. Without
              // this, xterm removes rows from the scrollback when the viewport
              // grows (maximize/restore), which is what made `help` output lose
              // lines. The build number also enables native reflow on Win11.
              windowsPty: platform?.backend
                ? {
                    backend: platform.backend,
                    buildNumber: platform.buildNumber ?? undefined
                  }
                : undefined,
              theme: getTerminalTheme(settings.terminalColorScheme, themeId)
            });
            terminal = instance;
            if (platform?.backend === 'conpty') {
              armConptyDa1(instance);
            }

            // End-state keyboard shortcuts (MobaXterm-style single keys).
            // Registered once; the handler reads the mirrored end state and
            // swallows only the mapped keys, so live-session typing and IME
            // composition pass through untouched.
            instance.attachCustomKeyEventHandler((event) => {
              const state = endStateRef.current;
              if (!state || event.type !== 'keydown') {
                return true;
              }
              if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey) {
                return true;
              }
              const action = sessionEndShortcutAction(state.kind, event.key);
              if (!action) {
                return true;
              }
              dispatchEndActionRef.current(action);
              return false;
            });

            const fit = new FitAddon();
            instance.loadAddon(fit);
            fitAddon = fit;

            instance.open(container);

            try {
              const unicode11 = new Unicode11Addon();
              instance.loadAddon(unicode11);
              instance.unicode.activeVersion = '11';
              unicode11Addon = unicode11;
            } catch {
              unicode11Addon = null;
            }

            try {
              const webLinks = new WebLinksAddon((event, uri) => {
                event.preventDefault();
                void openUrl(uri).catch(() =>
                  toast({ title: t('terminal.openUrlFailed'), description: uri, variant: 'error' })
                );
              });
              instance.loadAddon(webLinks);
              webLinksAddon = webLinks;
            } catch {
              webLinksAddon = null;
            }

            try {
              const serialize = new SerializeAddon();
              instance.loadAddon(serialize);
              serializeAddon = serialize;
            } catch {
              serializeAddon = null;
            }

            let copyTimer: number | null = null;
            selectionDisposable = instance.onSelectionChange(() => {
              if (!useSettingsStore.getState().terminalCopyOnSelect) {
                return;
              }
              if (copyTimer !== null) {
                window.clearTimeout(copyTimer);
              }
              copyTimer = window.setTimeout(() => {
                copyTimer = null;
                const selection = instance.getSelection();
                if (selection) {
                  void writeClipboardText(selection).catch(() => undefined);
                }
              }, 80);
            });
            const clearCopyTimer = () => {
              if (copyTimer !== null) {
                window.clearTimeout(copyTimer);
                copyTimer = null;
              }
            };
            const saveSnapshot = () => {
              if (!serializeAddon || !useSettingsStore.getState().terminalRestoreScrollback) {
                return;
              }
              // Full-screen programs use the alternate buffer; restoring that
              // state into a fresh shell is confusing and often broken. Skip
              // the save AND drop the previous snapshot, otherwise the next
              // open would restore history unrelated to this session.
              if (instance.buffer.active.type === 'alternate') {
                clearTerminalSnapshot(sessionId);
                return;
              }
              try {
                writeTerminalSnapshot(
                  sessionId,
                  // Modes include DECOM (origin mode); addon-serialize writes
                  // them after placing the cursor, and enabling origin mode
                  // homes the cursor to the top-left (xtermjs/xterm.js#6233).
                  serializeAddon.serialize({
                    scrollback: 2000,
                    excludeModes: true,
                    excludeAltBuffer: true
                  })
                );
              } catch {
                /* terminal is being disposed */
              }
            };
            const onBeforeUnload = () => saveSnapshot();
            window.addEventListener('beforeunload', onBeforeUnload);
            window.addEventListener('pagehide', onBeforeUnload);
            snapshotSave = saveSnapshot;
            snapshotCleanup = () => {
              clearCopyTimer();
              window.removeEventListener('beforeunload', onBeforeUnload);
              window.removeEventListener('pagehide', onBeforeUnload);
            };

            ligaturesEnabled = settings.terminalFontLigatures;
            ligatureFeatureSettings = settings.terminalFontFeatureSettings;
            if (ligaturesEnabled) {
              try {
                const addon = new NativeLigaturesAddon({
                  featureSettings: settings.terminalFontFeatureSettings
                });
                instance.loadAddon(addon);
                ligaturesAddon = addon;
              } catch {
                ligaturesAddon = null;
              }
            }

            loadWebgl();

            try {
              fit.fit();
              const scrollback =
                typeof instance.options.scrollback === 'number'
                  ? instance.options.scrollback
                  : 1000;
              syncEmptyBufferCapacity(instance, instance.rows, scrollback);
            } catch {
              /* container may be hidden during restore */
            }

            terminalRef.current = instance;
            setInitError(null);

            let restored = Promise.resolve();
            if (settings.terminalRestoreScrollback) {
              const snapshot = readTerminalSnapshot(sessionId);
              if (snapshot) {
                restored = new Promise<void>((resolve) => {
                  try {
                    // Hold resizes for the whole snapshot replay: the direct
                    // write is not tracked by writesIssued, so a resize would
                    // otherwise reflow the buffer mid-replay.
                    directWriteDepth += 1;
                    instance.write(snapshot, () => {
                      void writeScrollbackNotice(
                        instance,
                        `\x1b[90m[${t('terminal.scrollbackRestored')}]\x1b[0m`,
                        true
                      ).then(resolve);
                    });
                  } catch {
                    /* ignore malformed snapshot */
                    directWriteDepth = Math.max(0, directWriteDepth - 1);
                    resolve();
                  }
                });
              }
            }

            // Wait for the restored buffer to be fully parsed before starting
            // the shell. Otherwise ConPTY's first repaint can run before the
            // cursor has settled at the end of the snapshot.
            void restored.then(() => {
              if (disposed) {
                return;
              }
              directWriteDepth = Math.max(0, directWriteDepth - 1);
              resumePendingResize();
              scheduleFlush();
              void run(instance);
            });
          } catch (error) {
            if (!disposed) {
              console.error('[terminal] initialization failed', error);
              // A blank pane with no explanation is the worst outcome: give
              // the user the error and a way back into the session.
              setInitError(String(error));
            }
          } finally {
            initializing = false;
          }
        })();
      };

      const maybeStart = () => {
        if (
          disposed ||
          initializing ||
          initFrame !== null ||
          terminalRef.current ||
          !visibleRef.current
        ) {
          return;
        }
        initFrame = requestAnimationFrame(initialize);
      };

      let lastWidth = container.clientWidth;
      let lastHeight = container.clientHeight;

      const cancelResizeTimer = () => {
        if (resizeTimer !== null) {
          window.clearTimeout(resizeTimer);
          resizeTimer = null;
        }
      };

      const whenWritesParsed = (callback: () => void) => {
        if (writesParsed >= writesIssued) {
          callback();
          return;
        }
        parseWaiters.push(callback);
      };

      // Report a grid change. Intents (`applied: false`) are published too, so
      // the overlay tracks the measured size while a drag is still in flight;
      // the applied report then confirms the final grid. The initial fit runs
      // through `fit.fit()` during `initialize` and never reaches this path,
      // so opening a session does not flash the overlay and no "first apply"
      // latch is needed — a latch here would swallow the first real drag.
      const publishResizeHud = (cols: number, rows: number) => {
        if (!visibleRef.current) {
          return;
        }
        const shown = resizeHudValueRef.current;
        if (shown && shown.cols === cols && shown.rows === rows) {
          return;
        }
        resizeHudValueRef.current = { cols, rows };
        setResizeHud({ cols, rows });
        if (resizeHudTimerRef.current !== null) {
          window.clearTimeout(resizeHudTimerRef.current);
        }
        resizeHudTimerRef.current = window.setTimeout(() => {
          resizeHudTimerRef.current = null;
          resizeHudValueRef.current = null;
          setResizeHud(null);
        }, RESIZE_HUD_HIDE_MS);
      };

      // Apply one grid change: pending-wrap is decided from the pre-resize
      // cursor (resize clamps it), then the local-reflow repaint window opens.
      const applyGridResize = (
        instance: Terminal,
        cols: number,
        rows: number,
        armFilter: boolean
      ) => {
        const previousCols = instance.cols;
        const previousRows = instance.rows;
        const scrollback =
          typeof instance.options.scrollback === 'number' ? instance.options.scrollback : 1000;
        const commitWrap =
          cursorLineResizeMode === 'local-reflow' &&
          cols < previousCols &&
          shouldCommitConptyPendingWrap(instance.buffer.active, previousCols, previousRows, cols);
        logResizeDebug('grid-apply', {
          cols,
          rows,
          previousCols,
          previousRows,
          cursorX: instance.buffer.active.cursorX,
          cursorY: instance.buffer.active.cursorY,
          cursorLineResizeMode,
          commitWrap
        });
        syncEmptyBufferCapacity(instance, rows, scrollback);
        instance.resize(cols, rows);
        const normalBuffer = instance.buffer.active.type === 'normal';
        if (commitWrap && normalBuffer) {
          issueWrite('\n');
        }
        if (armFilter && cursorLineResizeMode === 'local-reflow' && normalBuffer) {
          armResizeRepaintFilter();
        }
      };

      // Serialize resizes and coalesce bursts to the newest target. The write
      // queue is frozen while resizing so no output is parsed against a
      // half-changed geometry, and xterm.resize() only runs after every
      // previously issued write has reached the parser. A previous ConPTY
      // repaint window must settle first: freezing early would hide that
      // repaint from the filter, and the next reflow would land on padding
      // that already scrolled the viewport.
      const applyResize = (cols: number, rows: number, id: number) => {
        if (disposed || !terminal) {
          return;
        }
        desiredDimensions = { cols, rows, id };
        // A restore or notice is writing directly to xterm: keep the request
        // pending in desiredDimensions and let resumePendingResize() apply it
        // once the sequence finishes, so the reflow cannot land mid-write.
        if (applyInProgress || directWriteDepth > 0) {
          return;
        }

        const runResize = () => {
          if (disposed || !terminal) {
            applyInProgress = false;
            desiredDimensions = null;
            repaintWaitArmed = false;
            return;
          }
          // A direct write sequence holds the buffer. Keep the request parked
          // in desiredDimensions; resumePendingResize() applies it afterwards.
          if (directWriteDepth > 0) {
            applyInProgress = false;
            return;
          }
          // Do not freeze while the previous repaint window is open. The 16ms
          // flush has to deliver that batch to the filter; freezing here is
          // what used to write the padding raw and then reflow on top of it.
          if (repaintFilter?.isPending) {
            applyInProgress = true;
            if (!repaintWaitArmed) {
              repaintWaitArmed = true;
              repaintFilter.whenSettled(() => {
                repaintWaitArmed = false;
                if (!disposed) {
                  runResize();
                }
              });
            }
            return;
          }
          const next = desiredDimensions;
          if (!next) {
            applyInProgress = false;
            return;
          }

          desiredDimensions = null;
          applyInProgress = true;
          writeFrozen = true;
          cancelScheduledFlush();

          const queued = takeQueuedData();
          if (queued) {
            issueWrite(repaintFilter ? repaintFilter.consume(queued) : queued);
          }

          let settled = false;
          let fallbackTimer: number | null = null;
          const finish = () => {
            if (settled) {
              return;
            }
            settled = true;
            if (fallbackTimer !== null) {
              window.clearTimeout(fallbackTimer);
              fallbackTimer = null;
            }

            const instance = terminal;
            // A newer request during the wait must not make this grid stale:
            // for local-reflow the backend already adopted `next`, so the
            // queued bytes belong to it and xterm must reflow to it before
            // the newest target applies. The exception is a no-op request
            // back to the current grid: it cleared desiredDimensions, so
            // applying `next` would move xterm away from the final intent.
            const canApply = () =>
              !disposed &&
              !!instance &&
              // Evaluated at call time: a newer request (or a no-op back to
              // the current grid) may arrive while the ack is pending.
              !(next.id !== resizeRequestId && desiredDimensions === null) &&
              (instance.cols !== next.cols || instance.rows !== next.rows);

            const finalize = () => {
              if (canApply()) {
                try {
                  applyGridResize(instance as Terminal, next.cols, next.rows, true);
                  publishResizeHud((instance as Terminal).cols, (instance as Terminal).rows);
                } catch (error) {
                  console.warn('[terminal] resize failed', error);
                }
              }

              writeFrozen = false;
              applyInProgress = false;
              const unfreezeWaiterList = unfreezeWaiters;
              unfreezeWaiters = [];
              unfreezeWaiterList.forEach((resolve) => resolve());
              scheduleFlush();

              if (desiredDimensions && !disposed) {
                runResize();
              }
            };

            // First drain complete: every byte produced at the old geometry
            // has been parsed. For local ConPTY the queue stays frozen across
            // the backend send; bytes that race the resize are therefore
            // parsed AFTER the reflow, i.e. against the new grid. The
            // cursor-line repaint (new geometry) then erases any stale copy
            // an old-geometry echo put below the cursor. Parsing those bytes
            // before the reflow would render the new-geometry repaint at the
            // old coordinates and corrupt the buffer.
            logResizeDebug('parse-drained', {
              cols: next.cols,
              rows: next.rows,
              localReflow: cursorLineResizeMode === 'local-reflow'
            });

            if (cursorLineResizeMode !== 'local-reflow') {
              // Remote/readline shells repaint themselves after SIGWINCH;
              // their terminal-side reflow does not race a silent ConPTY
              // buffer, and awaiting a network RTT per vertical change
              // would wreck responsiveness. Reflow immediately.
              finalize();
              return;
            }

            // Local ConPTY: it re-joins its own wrapped rows on resize and
            // only emits a cursor-line repaint. xterm must not reflow before
            // the PTY has adopted the new size — an echo CUP produced at the
            // old geometry would then land N rows below the re-joined prompt
            // (the duplicated-command bug). Send, await the ack while the
            // queue stays frozen, reflow, then release the queue. A hung IPC
            // must not stall resizes forever.
            let secondPhaseStarted = false;
            let ackTimer: number | null = null;
            const startSecondPhase = () => {
              if (secondPhaseStarted) {
                return;
              }
              secondPhaseStarted = true;
              if (ackTimer !== null) {
                window.clearTimeout(ackTimer);
                ackTimer = null;
              }
              finalize();
            };

            ackTimer = window.setTimeout(() => {
              logResizeDebug('backend-ack-timeout', { cols: next.cols, rows: next.rows });
              startSecondPhase();
            }, RESIZE_BACKEND_ACK_TIMEOUT_MS);
            void backendResize.send(next.cols, next.rows).then(startSecondPhase);
          };

          // Re-arm while the parser is still draining issued writes. Resizing
          // mid-parse splits the buffer into old-width and new-width halves;
          // only a silent window (no completed write callback at all) means
          // the callback is gone and waiting forever would stall resizes.
          const armFallback = () => {
            const parsedAtArmTime = writesParsed;
            fallbackTimer = window.setTimeout(() => {
              fallbackTimer = null;
              if (settled) {
                return;
              }
              if (writesParsed !== parsedAtArmTime) {
                armFallback();
                return;
              }
              finish();
            }, RESIZE_PARSE_FALLBACK_MS);
          };

          // Once every issued write is parsed, xterm can reflow. cmd sessions
          // enable reflowCursorLine so the cursor group itself is rewrapped;
          // shells that repaint keep xterm's stock skip/truncate behavior.
          const prepare = () => {
            if (!settled && !disposed && terminal) {
              finish();
            }
          };

          armFallback();
          whenWritesParsed(prepare);
        };

        runResize();
      };

      // Re-run the newest resize request that was parked while a direct
      // write sequence (snapshot restore, notice) held the buffer.
      const resumePendingResize = () => {
        if (
          disposed ||
          applyInProgress ||
          directWriteDepth > 0 ||
          !terminal ||
          !desiredDimensions
        ) {
          return;
        }
        const next = desiredDimensions;
        applyResize(next.cols, next.rows, next.id);
      };

      const flushPendingResize = () => {
        if (resizeTimer === null && desiredDimensions === null && !applyInProgress) {
          return;
        }
        cancelResizeTimer();
        if (!latestDimensions) {
          return;
        }
        const current = terminal;
        if (
          current &&
          latestDimensions.cols === current.cols &&
          latestDimensions.rows === current.rows
        ) {
          // The newest request matches the grid; cancel any older in-flight
          // target instead of letting it apply after the fact.
          desiredDimensions = null;
          return;
        }
        applyResize(latestDimensions.cols, latestDimensions.rows, latestDimensions.id);
      };

      const requestResize = (cols: number, rows: number, immediate: boolean) => {
        if (disposed || !terminal) {
          return;
        }

        const id = ++resizeRequestId;
        const currentCols = terminal.cols;
        const currentRows = terminal.rows;
        if (cols === currentCols && rows === currentRows) {
          // Never send a resize/SIGWINCH for a layout event that did not change
          // the grid, and cancel any superseded in-flight target
          // (microsoft/vscode#334532).
          cancelResizeTimer();
          latestDimensions = { cols, rows, id };
          desiredDimensions = null;
          // The grid is unchanged in xterm, but the PTY may already have
          // adopted an in-flight target (the two-phase path keeps xterm at
          // the old grid until the ack). Re-sending the current grid is
          // deduped unless the backend really is at a different size, so the
          // no-op cannot strand the PTY at a stale size.
          if (backendResize.lastSentDiffers(cols, rows)) {
            void backendResize.send(cols, rows);
          }
          return;
        }

        latestDimensions = { cols, rows, id };
        // Show the target grid while the drag is still running; the applied
        // report confirms it once xterm and the PTY agree.
        publishResizeHud(cols, rows);
        logResizeDebug('request', { cols, rows, immediate, currentCols, currentRows });

        // Discrete one-shot changes (maximize/restore, tab activation, font
        // changes) apply immediately; their reflow runs once and cannot
        // interleave with itself.
        if (immediate) {
          cancelResizeTimer();
          applyResize(cols, rows, id);
          return;
        }

        // Vertical resize is cheap and does not reflow: apply it immediately so
        // the grid never lags the DOM and the PTY sees the new height promptly.
        if (rows !== currentRows) {
          applyResize(currentCols, rows, id);
        }

        // Horizontal resize reflows the scrollback and makes the shell redraw
        // its prompt. Continuous layout changes (panel drag, window drag
        // resize) fire the observer every frame, and resizing per frame makes
        // xterm's reflow and ConPTY's repaint interleave into overwritten
        // text — cols changes are always debounced here and converge on the
        // trailing fire after the movement stops.
        if (cols !== currentCols) {
          cancelResizeTimer();
          resizeTimer = window.setTimeout(() => {
            resizeTimer = null;
            const latest = latestDimensions;
            if (latest) {
              applyResize(latest.cols, latest.rows, latest.id);
            }
          }, RESIZE_X_DEBOUNCE_MS);
        } else {
          cancelResizeTimer();
        }
      };

      const refit = (immediate: boolean) => {
        if (disposed || !visibleRef.current || !terminal || !fitAddon) {
          return;
        }
        if (container.clientWidth === 0 || container.clientHeight === 0) {
          return;
        }
        const dimensions = fitAddon.proposeDimensions();
        if (!dimensions || !Number.isFinite(dimensions.cols) || !Number.isFinite(dimensions.rows)) {
          return;
        }
        requestResize(dimensions.cols, dimensions.rows, immediate);
      };

      const scheduleMaximizeCheck = () => {
        if (disposed) {
          return;
        }
        if (maximizeTimer !== null) {
          window.clearTimeout(maximizeTimer);
        }
        maximizeTimer = window.setTimeout(() => {
          maximizeTimer = null;
          void getCurrentWindow()
            .isMaximized()
            .then((value) => {
              if (disposed) {
                return;
              }
              const changed = maximized !== null && value !== maximized;
              maximized = value;
              if (!changed) {
                return;
              }
              // Maximize/restore is a discrete layout change and must never
              // be debounced. Wait two frames so the webview has committed
              // the final geometry before FitAddon measures it.
              window.requestAnimationFrame(() => {
                window.requestAnimationFrame(() => {
                  if (!disposed) {
                    refit(true);
                  }
                });
              });
            })
            .catch(() => {
              /* window APIs unavailable */
            });
        }, 60);
      };

      startRef.current = maybeStart;
      resumeRef.current = () => {
        if (disposed || !terminal) {
          return;
        }
        flushPendingResize();
        refit(true);
        scheduleFlush();
      };
      refitRef.current = () => {
        window.requestAnimationFrame(() => {
          if (!disposed) {
            refit(true);
          }
        });
      };
      flushResizeRef.current = flushPendingResize;

      void getCurrentWindow()
        .isMaximized()
        .then((value) => {
          if (!disposed) {
            maximized = value;
          }
        })
        .catch(() => {
          /* ignore */
        });
      void getCurrentWindow()
        .onResized(scheduleMaximizeCheck)
        .then((unlisten) => {
          if (disposed) {
            unlisten();
          } else {
            unlistenWindowResize = unlisten;
          }
        })
        .catch(() => {
          /* window APIs unavailable */
        });

      maybeStart();

      // Observer-driven changes are always continuous (panel drag, window
      // drag-resize, sidebar toggle): refit(false) keeps rows immediate while
      // the horizontal reflow lands on the debounce. Discrete geometry jumps
      // (maximize/restore) take the separate window-state path and call
      // refit(true) directly.
      const observer = new ResizeObserver((entries) => {
        if (disposed) {
          return;
        }
        const entry = entries[entries.length - 1];
        const width = entry.contentRect.width;
        const height = entry.contentRect.height;
        if (width === lastWidth && height === lastHeight) {
          return;
        }
        // Record the size even while hidden. ResizeObserver does not redeliver
        // an ignored notification, and resume() refits from the live container
        // when the tab is shown again.
        lastWidth = width;
        lastHeight = height;
        if (!visibleRef.current) {
          return;
        }
        refit(false);
      });
      observer.observe(container);

      return () => {
        // Write a split repaint prefix before dispose. issueWrite no-ops once
        // `disposed` is set, and cancel() would otherwise drop the carry.
        const repaintCarry = releaseRepaintFilter();
        if (repaintCarry && terminal) {
          try {
            issueWrite(repaintCarry);
          } catch {
            /* terminal is being torn down */
          }
        }
        // Flush a pending debounced resize before teardown so the final
        // geometry still reaches the PTY instead of being silently dropped.
        if (resizeTimer !== null && latestDimensions && terminal) {
          window.clearTimeout(resizeTimer);
          resizeTimer = null;
          const latest = latestDimensions;
          if (terminal.cols !== latest.cols || terminal.rows !== latest.rows) {
            try {
              // No new repaint window: the instance is about to be disposed,
              // but pending-wrap and onResize still have to match the PTY.
              applyGridResize(terminal, latest.cols, latest.rows, false);
            } catch {
              /* terminal is being torn down */
            }
          }
        }
        cancelResizeTimer();

        snapshotSave?.();
        snapshotCleanup?.();
        selectionDisposable?.dispose();
        selectionDisposable = undefined;

        unregisterReconnect();
        transportGeneration += 1;
        disposed = true;
        manualDisconnect = true;
        reconnectRef.current = null;
        cancelReconnectRef.current = null;
        if (reconnectTimer !== null) {
          window.clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        startRef.current = null;
        resumeRef.current = null;
        refitRef.current = null;
        flushResizeRef.current = null;
        observer.disconnect();

        if (maximizeTimer !== null) {
          window.clearTimeout(maximizeTimer);
        }
        unlistenWindowResize?.();

        if (initFrame !== null) {
          cancelAnimationFrame(initFrame);
        }
        if (flushTimer !== null) {
          window.clearTimeout(flushTimer);
        }
        parseWaiters = [];
        writeQueue.length = 0;
        repaintFilter?.cancel();
        repaintFilter = null;
        da1Disposable?.dispose();
        da1Disposable = undefined;

        unlistenOutput?.();
        unlistenClosed?.();
        dataDisposable?.dispose();
        resizeDisposable?.dispose();

        if (backendId) {
          if (isSsh) {
            useConnectionStore.getState().removeConnection(sessionId, backendId);
            disconnectQuietly(disconnectSsh(backendId));
          } else if (transport === 'telnet') {
            // The closed listener is already gone, so the backend's closed
            // event cannot clean the transport entry up: do it here.
            useConnectionStore.getState().removeTransport(sessionId, 'telnet', backendId);
            disconnectQuietly(disconnectTelnet(backendId));
          } else if (transport === 'serial') {
            // Serial has its own manager: closePtySession would report
            // "session not found" and leave the COM port open forever.
            useConnectionStore.getState().removeTransport(sessionId, 'serial', backendId);
            disconnectQuietly(disconnectSerial(backendId));
          } else {
            useConnectionStore.getState().removeTransport(sessionId, 'pty', backendId);
            void closePtySession(backendId);
          }
        } else if (isSsh && pendingConnectId) {
          // The attempt is still in its handshake (typically waiting for a
          // host-key decision); tell the backend to cancel it so it can't
          // finish into an unwatched session.
          disconnectQuietly(disconnectSsh(pendingConnectId));
        }

        // Closing the last terminal panel of a session clears its status
        // even when other panels (SFTP, forwards) of the session stay open.
        if (useConnectionStore.getState().connections[sessionId] === undefined) {
          useSessionStore.getState().setStatus(sessionId, 'idle');
        }

        resizeTarget = null;
        backendResize.reset();
        backendIdRef.current = '';

        terminalRef.current = null;
        searchRef.current = null;
        loadSearchRef.current = null;
        ligaturesRef.current = null;

        fitAddon?.dispose();
        searchAddon?.dispose();
        ligaturesAddon?.dispose();
        unicode11Addon?.dispose();
        webLinksAddon?.dispose();
        serializeAddon?.dispose();
        webglAddon?.dispose();
        terminal?.dispose();
      };
      // logTitle is intentionally fixed per terminal activation: the log
      // file name must not change (and the session must not re-connect) when
      // a rename lands mid-session. Re-deriving the enabled/dir state at
      // connect time (sessionLogTarget()) covers settings flips.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
      sessionId,
      transport,
      host,
      port,
      username,
      authMethod,
      privateKeyPath,
      certPath,
      password,
      passphrase,
      jumpHost,
      jumpPort,
      jumpUsername,
      jumpAuthMethod,
      jumpKeyPath,
      jumpCertPath,
      jumpPassword,
      jumpPassphrase,
      localShellCommand
    ]);

    useEffect(() => {
      if (terminalRef.current) {
        terminalRef.current.options.theme = getTerminalTheme(terminalColorScheme, themeId);
      }
      // customThemes in deps: a custom scheme becomes resolvable once the
      // folder scan lands, and must re-resolve when its files change.
    }, [terminalColorScheme, themeId, customThemes]);

    useEffect(() => {
      ligaturesRef.current?.(terminalFontLigatures, terminalFontFeatureSettings);
    }, [terminalFontLigatures, terminalFontFeatureSettings]);

    useEffect(() => {
      const terminal = terminalRef.current;
      if (!terminal) {
        return;
      }

      terminal.options.fontFamily = terminalFontFamily;
      terminal.options.cursorStyle = terminalCursorStyle;
      terminal.options.cursorBlink = terminalCursorBlink;
      terminal.options.scrollback = terminalScrollback;
      terminal.options.lineHeight = terminalLineHeight;

      refitRef.current?.();
    }, [
      terminalFontFamily,
      terminalCursorStyle,
      terminalCursorBlink,
      terminalScrollback,
      terminalLineHeight
    ]);

    useEffect(() => {
      const terminal = terminalRef.current;
      if (!terminal) {
        return;
      }
      terminal.options.fontSize = fontSize;
      refitRef.current?.();
    }, [fontSize]);

    useEffect(
      () => () => {
        // The hide timer lives outside the main terminal effect so a re-run
        // (font change) cannot leave the overlay stuck on screen.
        if (resizeHudTimerRef.current !== null) {
          window.clearTimeout(resizeHudTimerRef.current);
          resizeHudTimerRef.current = null;
        }
      },
      []
    );

    useImperativeHandle(
      ref,
      () => ({
        clear: () => {
          const terminal = terminalRef.current;
          if (terminal) {
            terminal.clear();
            terminal.focus();
          }
          clearTerminalSnapshot(sessionId);
        },
        copySelection: async () => {
          const terminal = terminalRef.current;
          const selection = terminal?.getSelection();
          if (!selection) {
            return false;
          }
          await writeClipboardText(selection);
          return true;
        },
        hasSelection: () => Boolean(terminalRef.current?.hasSelection()),
        paste: (data: string) => {
          terminalRef.current?.paste(data);
          terminalRef.current?.focus();
        },
        sendText: (text: string, execute = false) => {
          const terminal = terminalRef.current;
          if (!terminal) {
            return;
          }
          // `input()` routes through onData, so the text reaches the same
          // writeSsh/writePty path as real keystrokes.
          terminal.input(text);
          if (execute) {
            terminal.input('\r');
          }
          terminal.focus();
        },
        selectAll: () => {
          terminalRef.current?.selectAll();
          terminalRef.current?.focus();
        },
        findNext: (query: string) => {
          if (query) {
            void loadSearchRef.current?.().then((addon) => addon?.findNext(query));
          }
        },
        findPrevious: (query: string) => {
          if (query) {
            void loadSearchRef.current?.().then((addon) => addon?.findPrevious(query));
          }
        },
        focus: () => terminalRef.current?.focus(),
        reconnect: () => reconnectRef.current?.(),
        reset: () => terminalRef.current?.reset()
      }),
      [sessionId]
    );

    // overflow-hidden clips the not-yet-reflowed canvas during the horizontal
    // debounce window instead of letting it spill over the splitter. The HUD
    // is a sibling of the terminal host so React never reconciles around the
    // DOM nodes xterm.js appends itself.
    return (
      <div className="relative h-full w-full overflow-hidden">
        <div ref={containerRef} className="h-full w-full" />
        {endState?.kind === 'reconnecting' ? (
          <SessionEndBar
            state={endState}
            onAction={(action: SessionEndAction) => dispatchEndAction(action)}
          />
        ) : null}
        {endState && endState.kind !== 'reconnecting' ? (
          <span aria-live="polite" className="sr-only">
            {t(endState.messageKey, endState.messageParams)}
          </span>
        ) : null}
        {resizeHud ? (
          <div
            aria-live="polite"
            className="pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-border bg-surface-elevated px-2 py-1 text-meta tabular-nums text-foreground shadow-panel"
          >
            {resizeHud.cols} × {resizeHud.rows}
          </div>
        ) : null}
        {initError ? (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background px-4 text-center">
            <p className="text-meta font-emphasis text-foreground">{t('terminal.initFailed')}</p>
            <p className="max-w-md select-text break-all text-tiny text-muted-foreground">
              {initError}
            </p>
            <Button
              size="xs"
              variant="secondary"
              onClick={() => {
                setInitError(null);
                startRef.current?.();
              }}
            >
              {t('terminal.initRetry')}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }
);

XtermCanvas.displayName = 'XtermCanvas';

export default XtermCanvas;
