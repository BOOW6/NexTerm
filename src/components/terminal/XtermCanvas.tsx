import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Terminal, type IDisposable } from '@xterm/xterm';
import { writeText as writeClipboardText } from '@tauri-apps/plugin-clipboard-manager';
import { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import {
  closePtySession,
  createPtySession,
  getPtyPlatformInfo,
  listenPtyOutput,
  resizePty,
  writePty
} from '../../hooks/useTauriPty';
import {
  connectSsh,
  disconnectSsh,
  listenSshClosed,
  listenSshOutput,
  resizeSsh,
  writeSsh
} from '../../hooks/useTauriSsh';
import { useConnectionStore } from '../../stores/connectionStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useTheme } from '../../theme/ThemeProvider';
import { getTerminalTheme } from '../../theme/terminalTheme';
import { NativeLigaturesAddon } from '../../theme/nativeLigaturesAddon';

export interface XtermHandle {
  clear: () => void;
  copySelection: () => Promise<boolean>;
  hasSelection: () => boolean;
  paste: (data: string) => void;
  selectAll: () => void;
  findNext: (query: string) => void;
  findPrevious: (query: string) => void;
  focus: () => void;
  reset: () => void;
}

export type TerminalTransport = 'local' | 'ssh';

export interface SshTarget {
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'key' | 'agent';
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
}

interface XtermCanvasProps {
  sessionId: string;
  fontSize?: number;
  transport?: TerminalTransport;
  ssh?: SshTarget;
  visible?: boolean;
}

const WRITE_BATCH_INTERVAL_MS = 16;
const MAX_WRITE_CHUNK = 256 * 1024;
const MAX_PENDING_OUTPUT = 4 * 1024 * 1024;

/**
 * VS Code's TerminalResizeDebouncer applies vertical resizes immediately and
 * delays the expensive horizontal reflow. The delay must also give the shell
 * enough time to finish its SIGWINCH prompt redraw before the next resize;
 * 300ms is the value proposed in microsoft/vscode#334532 for that issue.
 */
const RESIZE_X_DEBOUNCE_MS = 300;
const LARGE_RESIZE_PX = 200;
const SMALL_BUFFER_LINES = 200;

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
 * xterm.write parses asynchronously if a chunk exceeds its time slice. Never
 * let a resize wait forever on a write callback that belongs to a disposed
 * renderer.
 */
const RESIZE_PARSE_FALLBACK_MS = 250;

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

const XtermCanvas = forwardRef<XtermHandle, XtermCanvasProps>(
  ({ sessionId, fontSize = 13, transport = 'local', ssh, visible = true }, ref) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const searchRef = useRef<SearchAddon | null>(null);
    const loadSearchRef = useRef<(() => Promise<SearchAddon | null>) | null>(null);
    const visibleRef = useRef(visible);
    const fontSizeRef = useRef(fontSize);
    const startRef = useRef<(() => void) | null>(null);
    const resumeRef = useRef<(() => void) | null>(null);
    const refitRef = useRef<(() => void) | null>(null);
    const flushResizeRef = useRef<(() => void) | null>(null);
    const ligaturesRef = useRef<((enabled: boolean, featureSettings: string) => void) | null>(null);
    const { themeId } = useTheme();

    const terminalFontFamily = useSettingsStore((state) => state.terminalFontFamily);
    const terminalFontLigatures = useSettingsStore((state) => state.terminalFontLigatures);
    const terminalFontFeatureSettings = useSettingsStore(
      (state) => state.terminalFontFeatureSettings
    );
    const terminalColorScheme = useSettingsStore((state) => state.terminalColorScheme);
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
    const passphrase = ssh?.passphrase ?? '';

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
      let backendId = '';
      let unlistenOutput: (() => void) | undefined;
      let unlistenClosed: (() => void) | undefined;
      let dataDisposable: IDisposable | undefined;
      let resizeDisposable: IDisposable | undefined;

      let terminal: Terminal | null = null;
      let fitAddon: FitAddon | null = null;
      let searchAddon: SearchAddon | null = null;
      let ligaturesAddon: NativeLigaturesAddon | null = null;
      let ligaturesEnabled = false;
      let ligatureFeatureSettings = '';
      let webglAddon: WebglAddon | null = null;

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

      let latestDimensions: { cols: number; rows: number; id: number } | null = null;
      let desiredDimensions: { cols: number; rows: number; id: number } | null = null;
      let resizeRequestId = 0;
      let applyInProgress = false;

      let resizeTarget: { id: string; transport: TerminalTransport } | null = null;
      let pendingBackendResize: { cols: number; rows: number } | null = null;
      let backendResizeInFlight = false;

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
        writesIssued += 1;
        terminal.write(data, () => {
          writesParsed += 1;
          resolveParseWaiters();
        });
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
        issueWrite(takeQueuedData());
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
        issueWrite(data);
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

      // Keep at most one resize command in flight and always converge on the
      // newest requested dimensions. Separate async IPC invokes can otherwise
      // be delivered out of order, leaving the PTY at a stale size.
      const sendBackendResize = (cols: number, rows: number) => {
        if (!resizeTarget) {
          return;
        }
        pendingBackendResize = { cols, rows };
        if (backendResizeInFlight) {
          return;
        }

        const flush = () => {
          const target = resizeTarget;
          const next = pendingBackendResize;
          pendingBackendResize = null;
          if (!target || !next) {
            backendResizeInFlight = false;
            return;
          }
          backendResizeInFlight = true;
          const request =
            target.transport === 'ssh'
              ? resizeSsh(target.id, next.cols, next.rows)
              : resizePty(target.id, next.cols, next.rows);
          void request
            .catch((error) => {
              logResizeError(
                target.transport === 'ssh' ? 'SSH PTY' : 'PTY',
                next.cols,
                next.rows,
                error
              );
            })
            .finally(() => {
              if (pendingBackendResize && resizeTarget) {
                flush();
              } else {
                backendResizeInFlight = false;
              }
            });
        };

        flush();
      };

      const run = async (instance: Terminal) => {
        try {
          if (isSsh) {
            if (!host || !username) {
              throw new Error('缺少主机或用户名');
            }
            if (authMethod === 'password' && !password) {
              throw new Error('缺少密码');
            }
            if (authMethod === 'key' && !privateKeyPath) {
              throw new Error('缺少私钥文件');
            }

            useSessionStore.getState().setStatus(sessionId, 'connecting');

            const id = await connectSsh({
              host,
              port,
              username,
              authMethod,
              password,
              privateKeyPath: privateKeyPath || undefined,
              passphrase: passphrase || undefined,
              cols: instance.cols,
              rows: instance.rows
            });

            if (disposed) {
              void disconnectSsh(id);
              return;
            }

            backendId = id;
            resizeTarget = { id, transport: 'ssh' };
            useConnectionStore
              .getState()
              .setConnection(sessionId, { sshId: id, status: 'connected' });
            useSessionStore.getState().setStatus(sessionId, 'connected');

            // Register size sync before the async listener setup so a fit
            // that settles during that window is not lost.
            dataDisposable = instance.onData((data) => {
              void writeSsh(id, data);
            });
            resizeDisposable = instance.onResize(({ cols, rows }) => {
              sendBackendResize(cols, rows);
            });

            const stopOutput = await listenSshOutput(id, ({ data }) => {
              enqueueWrite(data);
            });
            if (disposed) {
              stopOutput();
              return;
            }
            unlistenOutput = stopOutput;

            const stopClosed = await listenSshClosed(id, () => {
              enqueueWrite('\r\n\x1b[33m[SSH 连接已断开]\x1b[0m\r\n');
              useConnectionStore.getState().removeConnection(sessionId, id);
              useSessionStore.getState().setStatus(sessionId, 'idle');
            });
            if (disposed) {
              stopClosed();
              return;
            }
            unlistenClosed = stopClosed;

            instance.focus();
          } else {
            const id = await createPtySession(instance.cols, instance.rows);
            if (disposed) {
              void closePtySession(id);
              return;
            }

            backendId = id;
            resizeTarget = { id, transport: 'local' };
            useSessionStore.getState().setStatus(sessionId, 'connected');

            // Register size sync before the async listener setup so a fit
            // that settles during that window is not lost.
            dataDisposable = instance.onData((data) => {
              void writePty(id, data);
            });
            resizeDisposable = instance.onResize(({ cols, rows }) => {
              sendBackendResize(cols, rows);
            });

            const stopOutput = await listenPtyOutput(id, ({ data }) => {
              enqueueWrite(data);
            });
            if (disposed) {
              stopOutput();
              return;
            }
            unlistenOutput = stopOutput;

            instance.focus();
          }
        } catch (error) {
          if (!disposed) {
            useSessionStore.getState().setStatus(sessionId, 'error');
            if (isSsh) {
              useConnectionStore.getState().removeConnection(sessionId);
            }
            enqueueWrite(
              `\r\n\x1b[31m${isSsh ? 'SSH 连接失败' : '无法创建 PTY 会话'}：${errorMessage(
                error
              )}\x1b[0m\r\n`
            );
          }
        }
      };

      const initialize = () => {
        initFrame = null;
        if (disposed || initializing) {
          return;
        }
        initializing = true;

        void (async () => {
          try {
            const platform = isSsh ? null : await getPtyPlatformInfo();
            if (disposed || !visibleRef.current) {
              return;
            }

            const settings = useSettingsStore.getState();
            const instance = new Terminal({
              allowProposedApi: true,
              cursorBlink: settings.terminalCursorBlink,
              cursorStyle: settings.terminalCursorStyle,
              fontFamily: settings.terminalFontFamily,
              fontSize: fontSizeRef.current,
              lineHeight: settings.terminalLineHeight,
              scrollback: settings.terminalScrollback,
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
              theme: getTerminalTheme(settings.terminalColorScheme)
            });
            terminal = instance;

            const fit = new FitAddon();
            instance.loadAddon(fit);
            fitAddon = fit;

            instance.open(container);

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

            scheduleFlush();
            void run(instance);
          } catch (error) {
            if (!disposed) {
              console.error('[terminal] initialization failed', error);
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

      // Serialize resizes and coalesce bursts to the newest target. The write
      // queue is frozen while resizing so no output is parsed against a
      // half-changed geometry, and xterm.resize() only runs after every
      // previously issued write has reached the parser.
      const applyResize = (cols: number, rows: number, id: number) => {
        if (disposed || !terminal) {
          return;
        }
        desiredDimensions = { cols, rows, id };
        if (applyInProgress) {
          return;
        }

        const runResize = () => {
          if (disposed || !terminal) {
            applyInProgress = false;
            desiredDimensions = null;
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
            issueWrite(queued);
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
            if (
              !disposed &&
              instance &&
              next.id === resizeRequestId &&
              (instance.cols !== next.cols || instance.rows !== next.rows)
            ) {
              try {
                const scrollback =
                  typeof instance.options.scrollback === 'number'
                    ? instance.options.scrollback
                    : 1000;
                syncEmptyBufferCapacity(instance, next.rows, scrollback);
                instance.resize(next.cols, next.rows);
              } catch (error) {
                console.warn('[terminal] resize failed', error);
              }
            }

            writeFrozen = false;
            applyInProgress = false;
            scheduleFlush();

            if (desiredDimensions && !disposed) {
              runResize();
            }
          };

          fallbackTimer = window.setTimeout(finish, RESIZE_PARSE_FALLBACK_MS);
          whenWritesParsed(finish);
        };

        runResize();
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
          return;
        }

        latestDimensions = { cols, rows, id };

        // Explicit/discrete changes and small buffers resize immediately; the
        // horizontal reflow is cheap enough there.
        const bufferLines = terminal.buffer.normal.length;
        if (immediate || bufferLines < SMALL_BUFFER_LINES) {
          cancelResizeTimer();
          applyResize(cols, rows, id);
          return;
        }

        // Vertical resize is cheap and does not reflow: apply it immediately so
        // the grid never lags the DOM and the PTY sees the new height promptly.
        if (rows !== currentRows) {
          applyResize(currentCols, rows, id);
        }

        // Horizontal resize reflows the scrollback and causes the shell to
        // redraw its prompt. Debounce it so consecutive SIGWINCHes cannot leave
        // duplicated prompt lines behind.
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

      const observer = new ResizeObserver((entries) => {
        if (disposed || !visibleRef.current) {
          return;
        }
        const entry = entries[entries.length - 1];
        const width = entry.contentRect.width;
        const height = entry.contentRect.height;
        if (width === lastWidth && height === lastHeight) {
          return;
        }
        const largeMutation =
          lastWidth > 0 &&
          lastHeight > 0 &&
          (Math.abs(width - lastWidth) > LARGE_RESIZE_PX ||
            Math.abs(height - lastHeight) > LARGE_RESIZE_PX);
        lastWidth = width;
        lastHeight = height;
        refit(largeMutation);
      });
      observer.observe(container);

      return () => {
        // Flush a pending debounced resize before teardown so the final
        // geometry still reaches the PTY instead of being silently dropped.
        if (resizeTimer !== null && latestDimensions && terminal) {
          window.clearTimeout(resizeTimer);
          resizeTimer = null;
          const latest = latestDimensions;
          if (terminal.cols !== latest.cols || terminal.rows !== latest.rows) {
            try {
              const scrollback =
                typeof terminal.options.scrollback === 'number'
                  ? terminal.options.scrollback
                  : 1000;
              syncEmptyBufferCapacity(terminal, latest.rows, scrollback);
              terminal.resize(latest.cols, latest.rows);
            } catch {
              /* terminal is being torn down */
            }
          }
        }
        cancelResizeTimer();

        disposed = true;
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

        unlistenOutput?.();
        unlistenClosed?.();
        dataDisposable?.dispose();
        resizeDisposable?.dispose();

        if (backendId) {
          if (isSsh) {
            useConnectionStore.getState().removeConnection(sessionId, backendId);
            void disconnectSsh(backendId);
          } else {
            void closePtySession(backendId);
          }
        }

        resizeTarget = null;
        pendingBackendResize = null;

        terminalRef.current = null;
        searchRef.current = null;
        loadSearchRef.current = null;
        ligaturesRef.current = null;

        fitAddon?.dispose();
        searchAddon?.dispose();
        ligaturesAddon?.dispose();
        webglAddon?.dispose();
        terminal?.dispose();
      };
    }, [
      sessionId,
      transport,
      host,
      port,
      username,
      authMethod,
      privateKeyPath,
      password,
      passphrase
    ]);

    useEffect(() => {
      if (terminalRef.current) {
        terminalRef.current.options.theme = getTerminalTheme(terminalColorScheme);
      }
    }, [terminalColorScheme, themeId]);

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

    useImperativeHandle(
      ref,
      () => ({
        clear: () => {
          const terminal = terminalRef.current;
          if (terminal) {
            terminal.clear();
            terminal.focus();
          }
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
        reset: () => terminalRef.current?.reset()
      }),
      []
    );

    return <div ref={containerRef} className="h-full w-full" />;
  }
);

XtermCanvas.displayName = 'XtermCanvas';

export default XtermCanvas;
